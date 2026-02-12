import { resolveExampleRefs, resolveValue } from '../resolvers';
import { resolveObject } from '../resolvers/object';
import {
  type ContextSpec,
  type GeneratorImport,
  type NonBooleanSchemaObject,
  type OpenApiReferenceObject,
  type OpenApiSchemaObject,
  PropertySortOrder,
  type ScalarValue,
  SchemaType,
} from '../types';
import {
  escape,
  isBoolean,
  isReference,
  isString,
  jsDoc,
  pascal,
} from '../utils';
import { combineSchemas } from './combine';
import { getAliasedImports, getImportAliasForRefOrValue } from './imports';
import { getKey } from './keys';
import { getRefInfo } from './ref';

/**
 * Extract enum values from propertyNames schema (OpenAPI 3.1)
 * Returns undefined if propertyNames doesn't have an enum
 */
function getPropertyNamesEnum(
  item: NonBooleanSchemaObject,
): string[] | undefined {
  if (
    'propertyNames' in item &&
    item.propertyNames &&
    'enum' in item.propertyNames
  ) {
    const propertyNames = item.propertyNames as { enum?: unknown[] };
    if (Array.isArray(propertyNames.enum)) {
      return propertyNames.enum.filter((val): val is string => isString(val));
    }
  }
  return undefined;
}

/**
 * Generate index signature key type based on propertyNames enum
 * Returns union type string like "'foo' | 'bar'" or 'string' if no enum
 */
function getIndexSignatureKey(item: NonBooleanSchemaObject): string {
  const enumValues = getPropertyNamesEnum(item);
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((val) => `'${val}'`).join(' | ');
  }
  return 'string';
}

function getPropertyNamesRecordType(
  item: NonBooleanSchemaObject,
  valueType: string,
): string | undefined {
  const enumValues = getPropertyNamesEnum(item);
  if (!enumValues || enumValues.length === 0) {
    return undefined;
  }

  const keyType = enumValues.map((val) => `'${val}'`).join(' | ');
  return `Partial<Record<${keyType}, ${valueType}>>`;
}

/**
 * Context for multipart/form-data type generation.
 * Discriminated union with two states:
 *
 * 1. `{ atPart: false, encoding }` - At form-data root, before property iteration
 *    - May traverse through allOf/anyOf/oneOf to reach properties
 *    - Carries encoding map so getObject can look up `encoding[key]`
 *
 * 2. `{ atPart: true, partContentType }` - At a multipart part (top-level property)
 *    - `partContentType` = Encoding Object's `contentType` for this part
 *    - Used by getScalar for file type detection (precedence over contentMediaType)
 *    - Arrays pass this through to items; combiners inside arrays also get context
 *
 * `undefined` means not in form-data context (or nested inside plain object field = JSON)
 */
export type FormDataContext =
  | { atPart: false; encoding: Record<string, { contentType?: string }> }
  | { atPart: true; partContentType?: string };

interface GetObjectOptions {
  item: NonBooleanSchemaObject;
  name?: string;
  context: ContextSpec;
  nullable: string;
  /**
   * Multipart/form-data context for file type handling.
   * @see FormDataContext
   */
  formDataContext?: FormDataContext;
}

/**
 * Return the output type from an object
 *
 * @param item item with type === "object"
 */
export function getObject({
  item,
  name,
  context,
  nullable,
  formDataContext,
}: GetObjectOptions): ScalarValue {
  if (isReference(item)) {
    const { name } = getRefInfo(item.$ref as string, context);
    return {
      value: name + nullable,
      imports: [{ name }],
      schemas: [],
      isEnum: false,
      type: 'object',
      isRef: true,
      hasReadonlyProps: (item.readOnly as boolean | undefined) ?? false,
      dependencies: [name],
      example: item.example as unknown,
      examples: resolveExampleRefs(
        item.examples as
          | Record<string, OpenApiReferenceObject | { value?: unknown }>
          | undefined,
        context,
      ),
    };
  }

  // Bridge: isReference() typeguard narrows item to never due to AnyOtherAttribute
  // intersection making NonBooleanSchemaObject structurally overlap with OpenApiReferenceObject.
  // Re-assert the type after the reference guard since we know item is a schema object here.
  const schemaObj = item as NonBooleanSchemaObject;

  if (schemaObj.allOf || schemaObj.oneOf || schemaObj.anyOf) {
    const separator = schemaObj.allOf
      ? 'allOf'
      : schemaObj.oneOf
        ? 'oneOf'
        : 'anyOf';

    return combineSchemas({
      schema: schemaObj,
      name,
      separator,
      context,
      nullable,
      formDataContext,
    });
  }

  if (Array.isArray(schemaObj.type)) {
    const typeArray = schemaObj.type as string[];
    // Bridge: schemaObj is NonBooleanSchemaObject which includes AnyOtherAttribute index signature.
    // Spreading it directly would carry `any` into the result. Cast to break the chain.
    const baseItem = schemaObj as NonBooleanSchemaObject;
    return combineSchemas({
      schema: {
        anyOf: typeArray.map(
          (type) => ({ ...baseItem, type }) as NonBooleanSchemaObject,
        ),
      } as NonBooleanSchemaObject,
      name,
      separator: 'anyOf',
      context,
      nullable,
    });
  }

  // Bridge assertion: properties is typed as { [name: string]: ReferenceObject | SchemaObject }
  // but AnyOtherAttribute index signature infects all property access to return `any`
  const itemProperties = schemaObj.properties as
    | Record<string, OpenApiSchemaObject | OpenApiReferenceObject>
    | undefined;

  if (itemProperties && Object.entries(itemProperties).length > 0) {
    const entries = Object.entries(itemProperties);
    if (context.output.propertySortOrder === PropertySortOrder.ALPHABETICAL) {
      entries.sort((a, b) => {
        return a[0].localeCompare(b[0]);
      });
    }
    const acc: ScalarValue = {
      imports: [],
      schemas: [],
      value: '',
      isEnum: false,
      type: 'object' as SchemaType,
      isRef: false,
      hasReadonlyProps: false,
      useTypeAlias: false,
      dependencies: [],
      example: schemaObj.example as unknown,
      examples: resolveExampleRefs(
        schemaObj.examples as
          | Record<string, OpenApiReferenceObject | { value?: unknown }>
          | undefined,
        context,
      ),
    };
    const itemRequired = schemaObj.required as string[] | undefined;
    for (const [index, [key, schema]] of entries.entries()) {
      const isRequired = (
        Array.isArray(itemRequired) ? itemRequired : []
      ).includes(key);

      let propName = '';

      if (name) {
        const isKeyStartWithUnderscore = key.startsWith('_');

        propName += pascal(
          `${isKeyStartWithUnderscore ? '_' : ''}${name}_${key}`,
        );
      }

      const allSpecSchemas = context.spec.components?.schemas ?? {};

      const isNameAlreadyTaken = Object.keys(allSpecSchemas).some(
        (schemaName) => pascal(schemaName) === propName,
      );

      if (isNameAlreadyTaken) {
        propName = propName + 'Property';
      }

      // Transition multipart context: atPart: false → atPart: true
      // Look up encoding[key].contentType and pass to property resolution
      const propertyFormDataContext: FormDataContext | undefined =
        formDataContext && !formDataContext.atPart
          ? {
              atPart: true,
              partContentType: formDataContext.encoding[key]?.contentType, // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- Record index access can return undefined at runtime
            }
          : undefined;

      const resolvedValue = resolveObject({
        schema,
        propName,
        context,
        formDataContext: propertyFormDataContext,
      });

      const isReadOnly =
        (schemaObj.readOnly as boolean | undefined) ??
        ((schema as OpenApiSchemaObject).readOnly as boolean | undefined);
      if (!index) {
        acc.value += '{';
      }

      // Bridge: schema from properties is OpenApiSchemaObject | OpenApiReferenceObject;
      // jsDoc expects a simple object shape. Cast to NonBooleanSchemaObject since
      // property schemas are never boolean literals.
      const doc = jsDoc(schema as NonBooleanSchemaObject, true, context);

      if (isReadOnly ?? false) {
        acc.hasReadonlyProps = true;
      }

      const constValue =
        'const' in schema ? (schema.const as unknown) : undefined;
      const hasConst = constValue !== undefined;
      let constLiteral: string | undefined;

      if (!hasConst) {
        constLiteral = undefined;
      } else if (isString(constValue)) {
        constLiteral = `'${escape(constValue)}'`;
      } else {
        constLiteral = JSON.stringify(constValue);
      }

      const needsValueImport =
        hasConst && (resolvedValue.isEnum || resolvedValue.type === 'enum');

      const aliasedImports: GeneratorImport[] = needsValueImport
        ? resolvedValue.imports.map((imp) => ({ ...imp, isConstant: true }))
        : hasConst
          ? []
          : getAliasedImports({ name, context, resolvedValue });

      if (aliasedImports.length > 0) {
        acc.imports.push(...aliasedImports);
      }

      const alias = getImportAliasForRefOrValue({
        context,
        resolvedValue,
        imports: aliasedImports,
      });

      const propValue = needsValueImport ? alias : (constLiteral ?? alias);

      const finalPropValue = isRequired
        ? propValue
        : context.output.override.useNullForOptional === true
          ? `${propValue} | null`
          : propValue;

      acc.value += `\n  ${doc ? `${doc}  ` : ''}${
        isReadOnly && !context.output.override.suppressReadonlyModifier
          ? 'readonly '
          : ''
      }${getKey(key)}${isRequired ? '' : '?'}: ${finalPropValue};`;
      acc.schemas.push(...resolvedValue.schemas);
      acc.dependencies.push(...resolvedValue.dependencies);

      if (entries.length - 1 === index) {
        // Bridge assertion: additionalProperties is boolean | ReferenceObject | SchemaObject
        // but AnyOtherAttribute infects property access
        const additionalProps = schemaObj.additionalProperties as
          | boolean
          | OpenApiSchemaObject
          | OpenApiReferenceObject
          | undefined;
        if (additionalProps) {
          if (isBoolean(additionalProps)) {
            const recordType = getPropertyNamesRecordType(schemaObj, 'unknown');
            if (recordType) {
              acc.value += '\n}';
              acc.value += ` & ${recordType}`;
              acc.useTypeAlias = true;
            } else {
              const keyType = getIndexSignatureKey(schemaObj);
              acc.value += `\n  [key: ${keyType}]: unknown;\n }`;
            }
          } else {
            // After isBoolean() guard, additionalProps is SchemaObject | ReferenceObject (boolean excluded)
            const nonBoolAdditionalProps = additionalProps as
              | NonBooleanSchemaObject
              | OpenApiReferenceObject;
            const resolvedValue = resolveValue({
              schema: nonBoolAdditionalProps,
              name,
              context,
            });
            const recordType = getPropertyNamesRecordType(
              schemaObj,
              resolvedValue.value,
            );
            if (recordType) {
              acc.value += '\n}';
              acc.value += ` & ${recordType}`;
              acc.useTypeAlias = true;
            } else {
              const keyType = getIndexSignatureKey(schemaObj);
              acc.value += `\n  [key: ${keyType}]: ${resolvedValue.value};\n}`;
            }
            acc.dependencies.push(...resolvedValue.dependencies);
          }
        } else {
          acc.value += '\n}';
        }

        acc.value += nullable;
      }
    }
    return acc;
  }

  // Bridge assertion: additionalProperties is boolean | ReferenceObject | SchemaObject
  const outerAdditionalProps = schemaObj.additionalProperties as
    | boolean
    | OpenApiSchemaObject
    | OpenApiReferenceObject
    | undefined;
  const readOnlyFlag = schemaObj.readOnly as boolean | undefined;
  if (outerAdditionalProps) {
    if (isBoolean(outerAdditionalProps)) {
      const recordType = getPropertyNamesRecordType(schemaObj, 'unknown');
      if (recordType) {
        return {
          value: recordType + nullable,
          imports: [],
          schemas: [],
          isEnum: false,
          type: 'object',
          isRef: false,
          hasReadonlyProps: readOnlyFlag ?? false,
          useTypeAlias: true,
          dependencies: [],
        };
      }
      const keyType = getIndexSignatureKey(schemaObj);
      return {
        value: `{ [key: ${keyType}]: unknown }` + nullable,
        imports: [],
        schemas: [],
        isEnum: false,
        type: 'object',
        isRef: false,
        hasReadonlyProps: readOnlyFlag ?? false,
        useTypeAlias: false,
        dependencies: [],
      };
    }
    // After isBoolean() guard, outerAdditionalProps is SchemaObject | ReferenceObject (boolean excluded)
    const nonBoolOuterAdditionalProps = outerAdditionalProps as
      | NonBooleanSchemaObject
      | OpenApiReferenceObject;
    const resolvedValue = resolveValue({
      schema: nonBoolOuterAdditionalProps,
      name,
      context,
    });
    const recordType = getPropertyNamesRecordType(
      schemaObj,
      resolvedValue.value,
    );
    if (recordType) {
      return {
        value: recordType + nullable,
        imports: resolvedValue.imports,
        schemas: resolvedValue.schemas,
        isEnum: false,
        type: 'object',
        isRef: false,
        hasReadonlyProps: resolvedValue.hasReadonlyProps,
        useTypeAlias: true,
        dependencies: resolvedValue.dependencies,
      };
    }
    const keyType = getIndexSignatureKey(schemaObj);
    return {
      value: `{[key: ${keyType}]: ${resolvedValue.value}}` + nullable,
      imports: resolvedValue.imports,
      schemas: resolvedValue.schemas,
      isEnum: false,
      type: 'object',
      isRef: false,
      hasReadonlyProps: resolvedValue.hasReadonlyProps,
      useTypeAlias: false,
      dependencies: resolvedValue.dependencies,
    };
  }

  const constValue = schemaObj.const as string | undefined;
  if (constValue) {
    return {
      value: `'${constValue}'`,
      imports: [],
      schemas: [],
      isEnum: false,
      type: 'string',
      isRef: false,
      hasReadonlyProps: readOnlyFlag ?? false,
      dependencies: [],
    };
  }

  const keyType =
    schemaObj.type === 'object' ? getIndexSignatureKey(schemaObj) : 'string';
  const recordType = getPropertyNamesRecordType(schemaObj, 'unknown');
  if (schemaObj.type === 'object' && recordType) {
    return {
      value: recordType + nullable,
      imports: [],
      schemas: [],
      isEnum: false,
      type: 'object',
      isRef: false,
      hasReadonlyProps: readOnlyFlag ?? false,
      useTypeAlias: true,
      dependencies: [],
    };
  }
  return {
    value:
      (schemaObj.type === 'object'
        ? `{ [key: ${keyType}]: unknown }`
        : 'unknown') + nullable,
    imports: [],
    schemas: [],
    isEnum: false,
    type: 'object',
    isRef: false,
    hasReadonlyProps: readOnlyFlag ?? false,
    useTypeAlias: false,
    dependencies: [],
  };
}
