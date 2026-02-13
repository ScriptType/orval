import { resolveExampleRefs, resolveValue } from '../resolvers';
import { resolveObject } from '../resolvers/object';
import {
  type ContextSpec,
  type GeneratorImport,
  type OpenApiReferenceObject,
  type OpenApiSchemaObject,
  PropertySortOrder,
  type ScalarValue,
  type StrictSchemaObject,
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
function getPropertyNamesEnum(item: StrictSchemaObject): string[] | undefined {
  if (
    'propertyNames' in item &&
    item.propertyNames &&
    typeof item.propertyNames === 'object' &&
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
function getIndexSignatureKey(item: StrictSchemaObject): string {
  const enumValues = getPropertyNamesEnum(item);
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((val) => `'${val}'`).join(' | ');
  }
  return 'string';
}

function getPropertyNamesRecordType(
  item: StrictSchemaObject,
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
  item: StrictSchemaObject;
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
    // isReference() confirms item has $ref; cast to access reference properties
    const ref = item as unknown as OpenApiReferenceObject;
    const { name } = getRefInfo(ref.$ref as string, context);
    return {
      value: name + nullable,
      imports: [{ name }],
      schemas: [],
      isEnum: false,
      type: 'object',
      isRef: true,
      hasReadonlyProps: (ref.readOnly as boolean | undefined) ?? false,
      dependencies: [name],
      example: ref.example as unknown,
      examples: resolveExampleRefs(
        ref.examples as
          | Record<string, OpenApiReferenceObject | { value?: unknown }>
          | undefined,
        context,
      ),
    };
  }

  // Bridge: isReference() typeguard narrows item to never due to structural overlap.
  // Re-assert the type after the reference guard since we know item is a schema object here.
  const schemaObj = item as StrictSchemaObject;

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
    const typeArray = schemaObj.type;
    return combineSchemas({
      schema: {
        anyOf: typeArray.map(
          (type) => ({ ...schemaObj, type }) as StrictSchemaObject,
        ),
      } as StrictSchemaObject,
      name,
      separator: 'anyOf',
      context,
      nullable,
    });
  }

  const itemProperties = schemaObj.properties;

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
      type: 'object',
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
    const itemRequired = schemaObj.required;
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
        schemaObj.readOnly ??
        ((schema as OpenApiSchemaObject).readOnly as boolean | undefined);
      if (!index) {
        acc.value += '{';
      }

      // Bridge: schema from properties is OpenApiSchemaObject | OpenApiReferenceObject;
      // jsDoc expects a simple object shape. Cast to StrictSchemaObject since
      // property schemas are never boolean literals.
      const doc = jsDoc(schema as StrictSchemaObject, true, context);

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
        const additionalProps = schemaObj.additionalProperties;
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
            // After isBoolean() guard, additionalProps is SchemaObject | ReferenceObject
            const resolvedValue = resolveValue({
              schema: additionalProps as
                | OpenApiSchemaObject
                | OpenApiReferenceObject,
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

  const outerAdditionalProps = schemaObj.additionalProperties;
  const readOnlyFlag = schemaObj.readOnly;
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
    // After isBoolean() guard, outerAdditionalProps is SchemaObject | ReferenceObject
    const resolvedValue = resolveValue({
      schema: outerAdditionalProps as
        | OpenApiSchemaObject
        | OpenApiReferenceObject,
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
