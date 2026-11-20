import { extractRangeFromFilter } from './extractRange.ts';

const MAX_PREFILL_LENGTH = 512;

/** Characters that are not path-like and/or change fzf query meaning. */
const PATH_DENYLIST = /[\x00-\x1f\x7f{}[\](),:;=<>|"*?!\t&]| {2,}/;

/**
 * `extractRangeFromFilter` also accepts a delimiter with no digits (`foo(`,
 * `foo:`), which would hide those characters from the denylist.
 */
const RANGE_DELIMITER_WITH_DIGITS = /[#:(](?:line )?\d/;

/** Leading `C:\` / `C:/`, the one colon a plain path may contain. */
const DRIVE_PREFIX = /^[a-zA-Z]:(?=[\\/])/;

function stripWrappingQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Return a Quick Open prefill string when `text` looks like a file/path query.
 * Multiline and code-like selections are ignored.
 */
export function pathQueryFromSelectionText(text: string): string {
  if (/[\r\n]/.test(text)) {
    return '';
  }

  const candidate = stripWrappingQuotes(text.trim());
  if (!candidate || candidate.length > MAX_PREFILL_LENGTH) {
    return '';
  }

  const extracted = RANGE_DELIMITER_WITH_DIGITS.test(candidate)
    ? extractRangeFromFilter(candidate)
    : undefined;
  const pathPart = extracted?.filter ?? candidate;
  if (!pathPart) {
    return '';
  }

  if (PATH_DENYLIST.test(pathPart.replace(DRIVE_PREFIX, ''))) {
    return '';
  }

  return candidate;
}
