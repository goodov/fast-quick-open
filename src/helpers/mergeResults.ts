import { resolveOnDemandScope } from '../onDemand.ts';
import { config } from '../config.ts';
import { type FzfHit } from '../fzfIndex.ts';
import { normalizeSearchQuery } from '../search.ts';
import { parseResource, uriKey } from './parseResource.ts';

/** Picker row: fzf hits carry the fd-group root; recents-only rows omit it. */
export interface PickerHit {
  path: string;
  root?: string;
}

/** Among the top N fzf hits, prefer recent files (by recency) without pulling worse matches up. */
const RECENT_BOOST_WINDOW = 5;

function resourceKey(resource: string): string {
  return uriKey(parseResource(resource));
}

function maxItemsForQuery(query: string): number {
  const scope = resolveOnDemandScope(normalizeSearchQuery(query));
  return config.resolveIndexScope(scope?.key ?? null)?.maxItems ?? 100;
}

/**
 * Empty query → recents only (recency order).
 * Non-empty → explicit path candidates first, then fzf order; within the top
 * boost window, recents float up without pulling in files fzf ranked lower.
 */
export default function mergeResults(
  query: string,
  fzfHits: FzfHit[],
  recentResources: string[],
  pathCandidates: string[] = [],
): PickerHit[] {
  const maxResults = maxItemsForQuery(query);
  const recentKeys = new Set(recentResources.map(resourceKey));

  if (normalizeSearchQuery(query).length === 0) {
    return recentResources.slice(0, maxResults).map((path) => ({ path }));
  }

  // Dedupe fzf hits while preserving order.
  const seen = new Set<string>();
  const hits: FzfHit[] = [];
  for (const hit of fzfHits) {
    const key = resourceKey(hit.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push(hit);
  }

  const explicit = pathCandidates.flatMap((candidate) => {
    const key = resourceKey(candidate);
    const existingIndex = hits.findIndex(
      (hit) => resourceKey(hit.path) === key,
    );
    if (existingIndex < 0) {
      return [{ path: candidate }];
    }
    const [existing] = hits.splice(existingIndex, 1);
    return existing ? [existing] : [];
  });

  const head = hits.slice(0, RECENT_BOOST_WINDOW);
  const tail = hits.slice(RECENT_BOOST_WINDOW);

  // Keep fzf order within each group; float recents ahead of non-recents in the head window.
  const headRecent = head.filter((p) => recentKeys.has(resourceKey(p.path)));
  const headRest = head.filter((p) => !recentKeys.has(resourceKey(p.path)));

  return [...explicit, ...headRecent, ...headRest, ...tail].slice(
    0,
    maxResults,
  );
}

export function isRecentResource(
  resource: string,
  recentResources: string[],
): boolean {
  const key = resourceKey(resource);
  return recentResources.some((r) => resourceKey(r) === key);
}
