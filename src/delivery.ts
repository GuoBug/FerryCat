/**
 * FerryCat exec stdout delivery parser (REQ-ENG-04: anti-guessing delivery contract).
 *
 * Before this module, `executeTaskAndFulfill` treated ANY JSON object printed on stdout as the
 * contract's `structured_output`. A child that happened to log `{"level":"info",...}` as its
 * last act would have that log line submitted as the deliverable. This parser makes the
 * accepted shapes explicit and deterministic:
 *
 *   1. ENVELOPE (preferred, explicit opt-in):
 *        { "ferrycat_delivery": { "result_summary"?: string, "structured_output"?: object,
 *                                 "artifacts_pointers"?: [...] } }
 *      Either the whole stdout, or exactly ONE stdout line carrying that object. All other
 *      lines are treated as logs and ignored, so handlers may log freely to stdout.
 *      Envelope contents are validated strictly (unknown keys are rejected to catch typos).
 *
 *   2. LEGACY_KEYS (auto mode only, backward compatible):
 *      The whole stdout is one JSON object with a string `result_summary` and/or an object
 *      `structured_output`. Only those two keys are lifted; the rest of the object is NOT
 *      promoted to structured_output any more.
 *
 *   3. RAW_TEXT (auto mode only):
 *      Anything else (plain text, or JSON without recognized keys) becomes `result_summary`
 *      text only. It is never guessed into `structured_output`.
 *
 * In `envelope` mode only shape 1 is accepted; anything else is rejected as DELIVERY_MISSING.
 */

export type DeliveryMode = 'auto' | 'envelope';

export const DELIVERY_ENVELOPE_KEY = 'ferrycat_delivery';

export type DeliverySource = 'ENVELOPE' | 'LEGACY_KEYS' | 'RAW_TEXT';

export type DeliveryErrorCode = 'DELIVERY_MALFORMED' | 'DELIVERY_AMBIGUOUS' | 'DELIVERY_MISSING';

export interface ParsedDelivery {
  ok: true;
  source: DeliverySource;
  result_summary?: string;
  structured_output?: Record<string, unknown>;
  artifacts_pointers?: Array<{ path: string; description: string }>;
  warnings: string[];
}

export interface RejectedDelivery {
  ok: false;
  code: DeliveryErrorCode;
  message: string;
}

export type DeliveryParseResult = ParsedDelivery | RejectedDelivery;

const ENVELOPE_ALLOWED_KEYS = new Set(['result_summary', 'structured_output', 'artifacts_pointers']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function reject(code: DeliveryErrorCode, message: string): RejectedDelivery {
  return { ok: false, code, message };
}

function validateEnvelope(outer: Record<string, unknown>, warnings: string[]): DeliveryParseResult {
  const inner = outer[DELIVERY_ENVELOPE_KEY];
  if (!isPlainObject(inner)) {
    return reject('DELIVERY_MALFORMED', `"${DELIVERY_ENVELOPE_KEY}" must be a JSON object.`);
  }

  const extraOuter = Object.keys(outer).filter((k) => k !== DELIVERY_ENVELOPE_KEY);
  if (extraOuter.length > 0) {
    warnings.push(`Ignored keys outside "${DELIVERY_ENVELOPE_KEY}": ${extraOuter.join(', ')}`);
  }

  const unknownKeys = Object.keys(inner).filter((k) => !ENVELOPE_ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return reject(
      'DELIVERY_MALFORMED',
      `Unknown key(s) inside "${DELIVERY_ENVELOPE_KEY}": ${unknownKeys.join(', ')}. Allowed: ${[...ENVELOPE_ALLOWED_KEYS].join(', ')}.`
    );
  }

  const { result_summary, structured_output, artifacts_pointers } = inner;

  if (result_summary !== undefined && (typeof result_summary !== 'string' || result_summary.trim() === '')) {
    return reject('DELIVERY_MALFORMED', '"result_summary" must be a non-empty string when provided.');
  }
  if (structured_output !== undefined && !isPlainObject(structured_output)) {
    return reject('DELIVERY_MALFORMED', '"structured_output" must be a JSON object when provided.');
  }
  if (result_summary === undefined && structured_output === undefined) {
    return reject(
      'DELIVERY_MALFORMED',
      `"${DELIVERY_ENVELOPE_KEY}" must contain at least one of "result_summary" or "structured_output".`
    );
  }

  let artifacts: Array<{ path: string; description: string }> | undefined;
  if (artifacts_pointers !== undefined) {
    if (
      !Array.isArray(artifacts_pointers) ||
      !artifacts_pointers.every(
        (a) =>
          isPlainObject(a) &&
          typeof a.path === 'string' &&
          typeof a.description === 'string' &&
          Object.keys(a).every((k) => k === 'path' || k === 'description')
      )
    ) {
      return reject(
        'DELIVERY_MALFORMED',
        '"artifacts_pointers" must be an array of { path: string, description: string } with no extra keys.'
      );
    }
    artifacts = artifacts_pointers as Array<{ path: string; description: string }>;
  }

  return {
    ok: true,
    source: 'ENVELOPE',
    result_summary: result_summary as string | undefined,
    structured_output: structured_output as Record<string, unknown> | undefined,
    artifacts_pointers: artifacts,
    warnings,
  };
}

export function parseExecDelivery(stdout: string, mode: DeliveryMode = 'auto'): DeliveryParseResult {
  const text = stripBom(stdout).trim();
  const warnings: string[] = [];

  // 1. Whole stdout is a single JSON object (pretty-printed output is allowed here).
  const whole = tryParseObject(text);
  if (whole) {
    if (DELIVERY_ENVELOPE_KEY in whole) {
      return validateEnvelope(whole, warnings);
    }
    if (mode === 'envelope') {
      return reject(
        'DELIVERY_MISSING',
        `stdout is JSON but has no "${DELIVERY_ENVELOPE_KEY}" envelope (delivery mode "envelope" accepts nothing else).`
      );
    }
    const hasSummary = typeof whole.result_summary === 'string' && whole.result_summary.trim() !== '';
    const hasStructured = isPlainObject(whole.structured_output);
    if (hasSummary || hasStructured) {
      return {
        ok: true,
        source: 'LEGACY_KEYS',
        result_summary: hasSummary ? (whole.result_summary as string) : undefined,
        structured_output: hasStructured ? (whole.structured_output as Record<string, unknown>) : undefined,
        warnings,
      };
    }
    warnings.push(
      `stdout JSON has no "${DELIVERY_ENVELOPE_KEY}", "result_summary" or "structured_output"; delivered as plain text only (not promoted to structured_output).`
    );
    return { ok: true, source: 'RAW_TEXT', result_summary: text, warnings };
  }

  // 2. Mixed logs: look for exactly one envelope line.
  const envelopeLines: Record<string, unknown>[] = [];
  let hasOtherJsonObjectLine = false;
  for (const line of text.split(/\r?\n/)) {
    const obj = tryParseObject(line.trim());
    if (!obj) continue;
    if (DELIVERY_ENVELOPE_KEY in obj) {
      envelopeLines.push(obj);
    } else {
      hasOtherJsonObjectLine = true;
    }
  }
  if (envelopeLines.length > 1) {
    return reject(
      'DELIVERY_AMBIGUOUS',
      `stdout contains ${envelopeLines.length} "${DELIVERY_ENVELOPE_KEY}" envelope lines; exactly one is allowed.`
    );
  }
  if (envelopeLines.length === 1) {
    return validateEnvelope(envelopeLines[0], warnings);
  }

  // 2b. The key is present in object-key position ("ferrycat_delivery": ...) but never as a
  // parseable single line: a multi-line / pretty-printed envelope interleaved with logs.
  // Refuse it loudly instead of silently degrading to RAW_TEXT, while allowing prose logs
  // that merely mention the word `ferrycat_delivery` without a colon.
  const ENVELOPE_KEY_PATTERN = new RegExp(`["']?${DELIVERY_ENVELOPE_KEY}["']?\\s*:`);
  if (ENVELOPE_KEY_PATTERN.test(text)) {
    return reject(
      'DELIVERY_MALFORMED',
      `"${DELIVERY_ENVELOPE_KEY}" appears on stdout but not as one parseable JSON line; emit it with JSON.stringify(envelope) (no indentation) on a single line.`
    );
  }

  // 3. No envelope at all.
  if (mode === 'envelope') {
    return reject(
      'DELIVERY_MISSING',
      `No "${DELIVERY_ENVELOPE_KEY}" envelope found on stdout (delivery mode "envelope").`
    );
  }
  if (hasOtherJsonObjectLine) {
    warnings.push(
      `stdout contains JSON object line(s) without "${DELIVERY_ENVELOPE_KEY}"; delivered as plain text only (not promoted to structured_output).`
    );
  }
  return { ok: true, source: 'RAW_TEXT', result_summary: text || undefined, warnings };
}
