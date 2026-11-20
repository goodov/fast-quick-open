import { expandVariables } from './expandVariables.ts';

/**
 * A list of prefill templates for `extension.fastQuickOpen`. Each item may mix
 * literal text with variables (e.g. `${selectedFilePath}`, `${relativeFile}`); the
 * first item that expands to a non-empty string is used.
 */
export type PrefillTemplate = readonly string[];

/** Whether a value is a valid {@link PrefillTemplate} (e.g. from a command arg). */
export function isPrefillTemplate(value: unknown): value is PrefillTemplate {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export interface PrefillRequest {
  prefill: PrefillTemplate;
}

/**
 * Expands each template and returns the first non-empty result. A template is
 * skipped entirely if any of its `${...}` variables resolves empty, even when
 * surrounding literal text would otherwise make it non-empty.
 */
export function resolvePrefill(request: PrefillRequest): string {
  for (const template of request.prefill) {
    const trimmed = expandVariables(template, {
      requireNonEmptyVariables: true,
    })?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

/** Parses (and validates) a partial {@link PrefillRequest} from untrusted input (e.g. command args). */
export function parsePrefillRequest(value: unknown): Partial<PrefillRequest> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const { prefill } = value as {
    prefill?: unknown;
  };
  const result: Partial<PrefillRequest> = {};
  if (isPrefillTemplate(prefill)) {
    result.prefill = prefill;
  }
  return result;
}
