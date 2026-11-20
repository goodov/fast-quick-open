import * as vscode from 'vscode';
import { config } from './config.ts';
import {
  type FdInvocation,
  getIndexFdInvocations,
  isPathUnderAnyRoot,
} from './excludes.ts';
import Log from './log.ts';
import { workspaceFolderPaths } from './helpers/vscodeUtils.ts';

export interface OnDemandScope {
  /** Config key the user typed (e.g. `out`). */
  key: string;
  /** Query passed to fzf after stripping the scope prefix. */
  fzfQuery: string;
  /** Out-of-workspace scope; uses a separate on-demand index only. */
  isExternal: boolean;
}

/**
 * If the query scopes to an on-demand dir, return scope info.
 *
 * Matches:
 * - `out`, `out/foo`, `out foo` (key at the start)
 * - `foo out`, `foo bar out`, `foo out/bar` (key as the last space-separated term)
 */
function fzfQueryForMatch(
  normalized: string,
  keyNorm: string,
  keepKeyInQuery: boolean,
  kind: 'exact' | 'slash' | 'space',
): string {
  if (keepKeyInQuery) {
    return normalized;
  }
  if (kind === 'exact') {
    return '';
  }
  if (kind === 'slash') {
    return normalized.slice(keyNorm.length + 1);
  }
  return normalized.slice(keyNorm.length + 1);
}

/** Key as the last space-separated term: `foo out` or `foo out/bar`. */
function matchLastTerm(
  normalized: string,
  keyNorm: string,
): { prefix: string; pathRemainder: string } | null {
  const lastSpace = normalized.lastIndexOf(' ');
  if (lastSpace < 0) {
    return null;
  }
  const prefix = normalized.slice(0, lastSpace);
  const last = normalized.slice(lastSpace + 1);
  if (!prefix || !last) {
    return null;
  }
  if (last === keyNorm) {
    return { prefix, pathRemainder: '' };
  }
  const withSlash = `${keyNorm}/`;
  if (last.startsWith(withSlash)) {
    return { prefix, pathRemainder: last.slice(withSlash.length) };
  }
  return null;
}

function fzfQueryForLastTerm(
  normalized: string,
  keepKeyInQuery: boolean,
  prefix: string,
  pathRemainder: string,
): string {
  if (keepKeyInQuery) {
    return normalized;
  }
  if (!pathRemainder) {
    return prefix;
  }
  return `${prefix} ${pathRemainder}`;
}

function isOnDemandScopeExternal(invocations: FdInvocation[]): boolean {
  if (invocations.length === 0) {
    return false;
  }
  const roots = workspaceFolderPaths();
  return invocations.every(
    (invocation) => !isPathUnderAnyRoot(invocation.base, roots),
  );
}

/** True when `term` is an on-demand key or `key/remainder` (last-term scope). */
export function isOnDemandLastTerm(term: string): boolean {
  if (!term) {
    return false;
  }
  const last = term.replace(/\\/g, '/');
  const keys = Object.keys(config.onDemandEntries());
  for (const key of keys) {
    const keyNorm = key.replace(/\\/g, '/').replace(/\/$/, '');
    if (last === keyNorm || last.startsWith(`${keyNorm}/`)) {
      return true;
    }
  }
  return false;
}

export function resolveOnDemandScope(query: string): OnDemandScope | null {
  const normalized = query.replace(/\\/g, '/');
  const entries = config.onDemandEntries();
  const keys = Object.keys(entries).sort((a, b) => b.length - a.length);

  const scopeFor = (
    key: string,
    fzfQuery: string,
    keepKeyInQuery: boolean,
    matchKind: string,
    extra?: Record<string, unknown>,
  ): OnDemandScope => {
    const invocations = getOnDemandFdInvocations(key);
    const external = isOnDemandScopeExternal(invocations);
    Log.trace?.('[onDemand]', `matched (${matchKind})`, {
      key,
      fzfQuery,
      keepKeyInQuery,
      external,
      ...extra,
    });
    return { key, fzfQuery, isExternal: external };
  };

  for (const key of keys) {
    const entry = entries[key];
    const keepKeyInQuery = entry.keepKeyInQuery ?? false;
    const keyNorm = key.replace(/\\/g, '/').replace(/\/$/, '');

    if (normalized === keyNorm) {
      return scopeFor(
        key,
        fzfQueryForMatch(normalized, keyNorm, keepKeyInQuery, 'exact'),
        keepKeyInQuery,
        'exact',
      );
    }

    const withSlash = `${keyNorm}/`;
    if (normalized.startsWith(withSlash)) {
      return scopeFor(
        key,
        fzfQueryForMatch(normalized, keyNorm, keepKeyInQuery, 'slash'),
        keepKeyInQuery,
        'prefix/',
      );
    }

    if (normalized.startsWith(`${keyNorm} `)) {
      return scopeFor(
        key,
        fzfQueryForMatch(normalized, keyNorm, keepKeyInQuery, 'space'),
        keepKeyInQuery,
        'prefix space',
      );
    }

    const lastTerm = matchLastTerm(normalized, keyNorm);
    if (lastTerm) {
      return scopeFor(
        key,
        fzfQueryForLastTerm(
          normalized,
          keepKeyInQuery,
          lastTerm.prefix,
          lastTerm.pathRemainder,
        ),
        keepKeyInQuery,
        'last term',
        { pathRemainder: lastTerm.pathRemainder },
      );
    }
  }

  return null;
}

/** fd invocations for an on-demand key. */
export function getOnDemandFdInvocations(key: string): FdInvocation[] {
  const scope = config.resolveIndexScope(key);
  if (!scope) {
    return [];
  }
  const invocations = getIndexFdInvocations(
    scope.roots,
    scope.includeEntries,
    scope.excludePatterns,
  );

  Log.trace?.('[onDemand]', 'fd invocations', {
    key,
    include: scope.includeEntries,
    external: isOnDemandScopeExternal(invocations),
    invocations,
  });
  return invocations;
}
