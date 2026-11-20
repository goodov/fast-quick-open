import { type FzfHit, type SearchResultMeta } from '../fzfIndex.ts';

/**
 * Empty in-flight fzf polls must not wipe the current picker rows (recents).
 * Apply when there are hits, or when the empty snapshot is complete.
 */
export function shouldReplacePickerHits(
  hits: readonly FzfHit[],
  meta?: SearchResultMeta,
): boolean {
  return hits.length > 0 || (meta !== undefined && !meta.indexing);
}
