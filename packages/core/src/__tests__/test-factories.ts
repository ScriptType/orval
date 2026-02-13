import type {
  ContextSpec,
  NormalizedOutputOptions,
  NormalizedOverrideOutput,
  OpenApiDocument,
} from '../types';
import { EnumGeneration, NamingConvention, PropertySortOrder } from '../types';

/**
 * Recursive partial type that stops at function types, Date, RegExp, and arrays.
 */
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends Date | RegExp
    ? T
    : T extends (infer U)[]
      ? DeepPartial<U>[]
      : T extends object
        ? { [P in keyof T]?: DeepPartial<T[P]> }
        : T;

/**
 * Deep-merges overrides into base. Recurses into plain objects only
 * (not arrays, null, functions, Date, RegExp).
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overrides: DeepPartial<T>,
): T {
  const result = { ...base };
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const val = overrides[key as keyof DeepPartial<T>];
    if (val === undefined) {
      continue;
    }
    result[key] =
      typeof val === 'object' &&
      val !== null &&
      !Array.isArray(val) &&
      !(val instanceof Date) &&
      !(val instanceof RegExp) &&
      typeof val !== 'function' &&
      typeof base[key] === 'object' &&
      base[key] !== null &&
      !Array.isArray(base[key])
        ? (deepMerge(
            base[key] as Record<string, unknown>,
            val as DeepPartial<Record<string, unknown>>,
          ) as T[keyof T])
        : (val as T[keyof T]);
  }
  return result;
}

/**
 * Creates a complete NormalizedOverrideOutput with minimal defaults.
 * Accepts deep partial overrides for nested fields.
 */
export function createNormalizedOverrideOutput(
  overrides: DeepPartial<NormalizedOverrideOutput> = {},
): NormalizedOverrideOutput {
  const base: NormalizedOverrideOutput = {
    operations: {},
    tags: {},
    header: false,
    formData: { disabled: true, arrayHandling: 'serialize' },
    formUrlEncoded: false,
    namingConvention: {},
    components: {
      schemas: { suffix: '', itemSuffix: '' },
      responses: { suffix: '' },
      parameters: { suffix: '' },
      requestBodies: { suffix: '' },
    },
    hono: { compositeRoute: '', validator: false, validatorOutputPath: '' },
    query: {},
    angular: { provideIn: 'root' },
    swr: {},
    zod: {
      strict: {
        param: false,
        query: false,
        header: false,
        body: false,
        response: false,
      },
      generate: {
        param: true,
        query: true,
        header: true,
        body: true,
        response: true,
      },
      coerce: {
        param: false,
        query: false,
        header: false,
        body: false,
        response: false,
      },
      generateEachHttpStatus: false,
      dateTimeOptions: {},
      timeOptions: {},
    },
    fetch: {
      includeHttpResponseReturnType: false,
      forceSuccessResponse: false,
      runtimeValidation: false,
    },
    requestOptions: true,
    enumGenerationType: EnumGeneration.ENUM,
    jsDoc: {},
    aliasCombinedTypes: false,
  };

  return deepMerge(
    base as unknown as Record<string, unknown>,
    overrides as DeepPartial<Record<string, unknown>>,
  ) as unknown as NormalizedOverrideOutput;
}

/**
 * Creates a complete NormalizedOutputOptions with minimal defaults.
 * Accepts deep partial overrides; nested `override` is built via createNormalizedOverrideOutput.
 */
export function createNormalizedOutputOptions(
  overrides: DeepPartial<NormalizedOutputOptions> = {},
): NormalizedOutputOptions {
  const base: NormalizedOutputOptions = {
    target: '',
    namingConvention: NamingConvention.CAMEL_CASE,
    fileExtension: '.ts',
    mode: 'single',
    client: 'axios',
    httpClient: 'axios',
    clean: false,
    docs: false,
    prettier: false,
    biome: false,
    headers: false,
    indexFiles: false,
    allParamsOptional: false,
    urlEncodeParameters: false,
    unionAddMissingProperties: false,
    optionsParamRequired: false,
    propertySortOrder: PropertySortOrder.SPECIFICATION,
    override: createNormalizedOverrideOutput(overrides.override),
  };

  // Build a copy without `override` in overrides to avoid double-applying
  const { override: _override, ...restOverrides } = overrides;

  return deepMerge(
    base as unknown as Record<string, unknown>,
    restOverrides as DeepPartial<Record<string, unknown>>,
  ) as unknown as NormalizedOutputOptions;
}

/**
 * Creates a complete ContextSpec with minimal defaults.
 * Accepts deep partial overrides; `spec` defaults to `{} as OpenApiDocument`.
 * The `as OpenApiDocument` cast is the only type assertion in this file.
 */
export function createContextSpec(
  overrides: DeepPartial<ContextSpec> = {},
): ContextSpec {
  const base: ContextSpec = {
    target: 'typescript',
    workspace: '',
    spec: (overrides.spec ?? {}) as OpenApiDocument,
    output: createNormalizedOutputOptions(overrides.output),
  };

  // Build a copy without `spec` and `output` in overrides to avoid double-applying
  const { spec: _spec, output: _output, ...restOverrides } = overrides;

  return deepMerge(
    base as unknown as Record<string, unknown>,
    restOverrides as DeepPartial<Record<string, unknown>>,
  ) as unknown as ContextSpec;
}
