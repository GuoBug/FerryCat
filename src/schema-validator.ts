import AjvModule, { type ErrorObject } from 'ajv';

type ValidateFn = {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
};

type AjvInstance = {
  compile: (schema: Record<string, unknown>) => ValidateFn;
};

// Handle ESM/CJS interop for Ajv across Node Next module resolution
const AjvCtor = (
  (AjvModule as unknown as { default?: unknown }).default ?? AjvModule
) as new (opts?: { allErrors?: boolean; strict?: boolean }) => AjvInstance;

const ajv = new AjvCtor({ allErrors: true, strict: false });
const compiledSchemaCache = new Map<string, ValidateFn>();

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateContractOutput(
  schema: Record<string, unknown>,
  data: unknown
): SchemaValidationResult {
  if (data === undefined || data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      errors: [
        '/: structured_output is required and must be a non-array JSON object when contract_schema is specified',
      ],
    };
  }

  try {
    const cacheKey = JSON.stringify(schema);
    let validate = compiledSchemaCache.get(cacheKey);
    if (!validate) {
      validate = ajv.compile(schema);
      compiledSchemaCache.set(cacheKey, validate);
    }

    const valid = validate(data);
    if (valid) {
      return { valid: true, errors: [] };
    }

    const flattened = (validate.errors ?? [])
      .slice(0, 10)
      .map((err: ErrorObject) => {
        const pathStr = err.instancePath || '/';
        const msg = err.message || 'validation failed';
        if (err.keyword === 'required' && err.params && 'missingProperty' in err.params) {
          return `${pathStr}: must have required property '${String(err.params.missingProperty)}'`;
        }
        return `${pathStr}: ${msg}`;
      });

    return {
      valid: false,
      errors: flattened.length > 0 ? flattened : ['/: schema validation failed'],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      errors: [`/: invalid contract_schema definition (${message})`],
    };
  }
}
