/** Map of pattern → enabled (same shape as search.exclude / files.exclude). */
export type PatternMap = Record<string, boolean | { when?: string }>;

/** Settings value: map with true/false or a list of enabled patterns (both accepted at runtime). */
export type PatternInput = PatternMap | string[] | undefined;

/** Normalize map or list syntax to a pattern map. */
export function normalizePatternMap(input: PatternInput): PatternMap {
  if (!input) {
    return {};
  }
  if (Array.isArray(input)) {
    const map: PatternMap = {};
    for (const item of input) {
      const trimmed = item.trim();
      if (trimmed) {
        map[trimmed] = true;
      }
    }
    return map;
  }
  return input;
}

/** Enabled pattern keys from map or list syntax. */
export function enabledPatterns(input: PatternInput): string[] {
  const map = normalizePatternMap(input);
  return Object.keys(map).filter((key) => {
    const value = map[key];
    return value === true || (typeof value === 'object' && value !== null);
  });
}

/** Enabled unconditional patterns from native VS Code exclusion settings. */
export function enabledBooleanPatterns(
  input: PatternMap | undefined,
): string[] {
  if (!input) {
    return [];
  }
  return Object.keys(input).filter((key) => input[key] === true);
}
