import { isDereferenced } from '@scalar/openapi-types/helpers';
import { prop } from 'remeda';

import { getRefInfo, type RefInfo } from '../getters/ref';
import type {
  ContextSpec,
  GeneratorImport,
  NonBooleanSchemaObject,
  OpenApiComponentsObject,
  OpenApiExampleObject,
  OpenApiExamples,
  OpenApiReferenceObject,
  OpenApiSchemaObject,
} from '../types';
import { isReference } from '../utils';

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- TSchema constrains return type for callers (e.g. resolveRef<OpenApiExampleObject>) */

export function resolveRef<TSchema extends object = OpenApiComponentsObject>(
  schema: object,
  context: ContextSpec,
  imports: GeneratorImport[] = [],
): {
  schema: TSchema;
  imports: GeneratorImport[];
} {
  // the schema is referring to another object
  if ('schema' in schema) {
    const nested = (schema as { schema?: { $ref?: string } }).schema;
    if (nested?.$ref) {
      const resolvedRef = resolveRef<TSchema>(
        nested as object,
        context,
        imports,
      );
      if ('examples' in schema) {
        (schema as { examples: OpenApiExamples }).examples = resolveExampleRefs(
          (schema as { examples: OpenApiExamples }).examples,
          context,
        );
      }
      if ('examples' in resolvedRef.schema) {
        const schemaWithExamples = resolvedRef.schema as {
          examples: OpenApiExamples;
        };
        schemaWithExamples.examples = resolveExampleRefs(
          schemaWithExamples.examples,
          context,
        );
      }
      return {
        schema: {
          ...schema,
          schema: resolvedRef.schema,
        } as TSchema,
        imports,
      };
    }
  }

  if (isDereferenced(schema)) {
    if ('examples' in schema) {
      (schema as { examples: OpenApiExamples }).examples = resolveExampleRefs(
        (schema as { examples: OpenApiExamples }).examples,
        context,
      );
    }
    return { schema: schema as TSchema, imports };
  }

  const refSchema = schema as OpenApiReferenceObject;
  const {
    currentSchema,
    refInfo: { name, originalName },
  } = getSchema(refSchema, context);

  if (!currentSchema) {
    throw new Error(`Oops... 🍻. Ref not found: ${refSchema.$ref}`);
  }

  return resolveRef<TSchema>(currentSchema, { ...context }, [
    ...imports,
    { name, schemaName: originalName },
  ]);
}

function getSchema<TSchema extends object = OpenApiComponentsObject>(
  schema: OpenApiReferenceObject,
  context: ContextSpec,
): {
  refInfo: RefInfo;
  currentSchema: TSchema | undefined;
} {
  const refInfo = getRefInfo(schema.$ref, context);

  const { refPaths } = refInfo;

  let schemaByRefPaths = Array.isArray(refPaths)
    ? (prop(
        context.spec,
        // @ts-expect-error: [ts2556] refPaths are not guaranteed to be valid keys of the spec
        ...refPaths,
      ) as OpenApiSchemaObject | OpenApiReferenceObject)
    : undefined;

  schemaByRefPaths ??= context.spec;

  if (isReference(schemaByRefPaths)) {
    return getSchema(schemaByRefPaths, context);
  }

  let currentSchema: OpenApiSchemaObject | OpenApiReferenceObject =
    schemaByRefPaths || context.spec;

  // Handle OpenAPI 3.0 nullable property
  // Bridge assertion: schema properties are `any` due to AnyOtherAttribute
  if ('nullable' in schema) {
    const nullable = schema.nullable as boolean | undefined;
    currentSchema = { ...currentSchema, nullable } as typeof currentSchema;
  }

  // Handle OpenAPI 3.1 type array (e.g., type: ["object", "null"])
  // This preserves nullable information when using direct $ref with types array
  if ('type' in schema && Array.isArray(schema.type)) {
    const type = schema.type as string[];
    currentSchema = { ...currentSchema, type } as typeof currentSchema;
  }

  return {
    currentSchema,
    refInfo,
  };
}

/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

export function resolveExampleRefs(
  examples: OpenApiExamples,
  context: ContextSpec,
): OpenApiExamples {
  if (!examples) {
    return undefined;
  }
  return Array.isArray(examples)
    ? examples.map((example) => {
        if (isReference(example)) {
          const { schema } = resolveRef<OpenApiExampleObject>(example, context);
          // Bridge assertion: ExampleObject.value is typed as `any`
          return schema.value as OpenApiExampleObject | OpenApiReferenceObject;
        }
        return example;
      })
    : (() => {
        const result: Record<string, unknown> = {};
        for (const [key, example] of Object.entries(examples)) {
          // Bridge assertion: ExampleObject.value is typed as `any`
          result[key] = isReference(example)
            ? (resolveRef<OpenApiExampleObject>(example, context).schema
                .value as unknown)
            : example;
        }
        return result;
      })();
}
