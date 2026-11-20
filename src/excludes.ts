import * as fs from 'fs';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
import * as path from 'path';
import * as vscode from 'vscode';
import { config } from './config.ts';
import Log from './log.ts';

// --- Path helpers ---

function normalizeFsPathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathEqualOrUnder(child: string, parent: string): boolean {
  const c = normalizeFsPathKey(child);
  const p = normalizeFsPathKey(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** True for Windows drive paths, UNC, or POSIX absolute paths. */
export function isAbsolutePathLike(p: string): boolean {
  const norm = p.replace(/\\/g, '/').trim();
  if (!norm) {
    return false;
  }
  if (path.isAbsolute(p) || path.isAbsolute(norm)) {
    return true;
  }
  return /^[a-zA-Z]:/.test(norm) || norm.startsWith('//');
}

// --- Glob matching ---

function normalizeRelative(fsPath: string): string {
  const relative = vscode.workspace.asRelativePath(fsPath, false);
  return relative.replace(/\\/g, '/');
}

const MINIMATCH_OPTS = { dot: true };

/**
 * fd `--exclude` uses gitignore syntax. `./dir` is fd-anchored the same as
 * `/dir`; `ignore` does not treat `./` as an anchor, so rewrite it.
 */
function toGitignorePattern(pattern: string): string | undefined {
  let p = pattern.replace(/\\/g, '/').trim();
  if (p.startsWith('./')) {
    p = `/${p.slice(2)}`;
  }
  if (!p || p === '/') {
    return undefined;
  }
  return p;
}

/** Drive / UNC paths are not gitignore; they only appear in watcher excludes. */
function isFilesystemPathPattern(pattern: string): boolean {
  const norm = pattern.replace(/\\/g, '/').trim();
  if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('//')) {
    return true;
  }
  // On win32 a leading `/` is a root-anchored glob, not an absolute path.
  return process.platform !== 'win32' && path.isAbsolute(norm);
}

/**
 * Match a `/`-separated path against globs. `relativePath` is relative to the
 * search root (workspace folder), which is what anchored patterns apply to.
 */
export function relativePathMatchesGlobs(
  relativePath: string,
  globs: string[],
): boolean {
  const rules = globs
    .map(toGitignorePattern)
    .filter((p): p is string => p !== undefined);
  if (rules.length === 0) {
    return false;
  }
  const rel = relativePath.replace(/\\/g, '/');
  if (!rel || !ignore.isPathValid(rel)) {
    return false;
  }
  return ignore().add(rules).ignores(rel);
}

function pathMatchesGlobs(fsPath: string, globs: string[]): boolean {
  if (globs.length === 0) {
    return false;
  }

  if (relativePathMatchesGlobs(normalizeRelative(fsPath), globs)) {
    return true;
  }

  // `files.watcherExclude` entries may be absolute paths rather than globs.
  const pathLike = globs.filter(isFilesystemPathPattern);
  if (pathLike.length === 0) {
    return false;
  }
  const absolute = path.normalize(fsPath).replace(/\\/g, '/');
  for (const pattern of pathLike) {
    const norm = pattern.replace(/\\/g, '/').trim().replace(/\/+$/, '');
    if (
      minimatch(absolute, norm, MINIMATCH_OPTS)
      || (!norm.endsWith('/**')
        && minimatch(absolute, `${norm}/**`, MINIMATCH_OPTS))
    ) {
      return true;
    }
  }
  return false;
}

function pathMatchesGlobsFromBase(
  fsPath: string,
  base: string,
  globs: string[],
): boolean {
  const relative = path.relative(base, fsPath).replace(/\\/g, '/');
  if (relativePathMatchesGlobs(relative, globs)) {
    return true;
  }

  const absolute = path.normalize(fsPath).replace(/\\/g, '/');
  return globs.filter(isFilesystemPathPattern).some((pattern) => {
    const norm = pattern.replace(/\\/g, '/').trim().replace(/\/+$/, '');
    return (
      minimatch(absolute, norm, MINIMATCH_OPTS)
      || (!norm.endsWith('/**')
        && minimatch(absolute, `${norm}/**`, MINIMATCH_OPTS))
    );
  });
}

/** True if the absolute path matches any enabled exclude glob. */
export function isExcludedPath(fsPath: string, patterns?: string[]): boolean {
  return pathMatchesGlobs(
    fsPath,
    patterns ?? config.resolveIndexScope(null)?.excludePatterns ?? [],
  );
}

// --- Search roots for fd ---

/**
 * Resolve paths to absolute directories that exist on disk.
 * Relative entries are resolved against each workspace folder.
 */
export function resolveSearchPaths(
  roots: string[],
  entries: string[],
): string[] {
  if (entries.length === 0) {
    return [];
  }

  const candidates = new Set<string>();

  for (const entry of entries) {
    const norm = entry.replace(/\\/g, '/');
    if (isAbsolutePathLike(norm)) {
      candidates.add(path.normalize(entry));
      continue;
    }
    const relative = norm.replace(/^\.\//, '').replace(/\/$/, '');
    for (const root of roots) {
      candidates.add(path.join(root, relative.replace(/\//g, path.sep)));
    }
  }

  const resolved: string[] = [];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        Log.trace?.('include path resolved', candidate);
        resolved.push(candidate);
      } else {
        Log.trace?.('include path not found', candidate);
      }
    } catch {
      // ignore inaccessible paths
    }
  }
  return resolved;
}

export function getIncludeSearchPaths(): string[] {
  const scope = config.resolveIndexScope(null);
  if (!scope) {
    return [];
  }
  return resolveSearchPaths(scope.roots, scope.includeEntries).filter(
    (includePath) => {
      const base = mostSpecificRoot(includePath, scope.roots);
      return (
        base !== undefined
        && pathMatchesGlobsFromBase(includePath, base, scope.excludePatterns)
      );
    },
  );
}

/** True when `fsPath` is equal to or under any of the given roots. */
export function isPathUnderAnyRoot(fsPath: string, roots: string[]): boolean {
  return roots.some((root) => isPathEqualOrUnder(fsPath, root));
}

function isStrictlyUnder(child: string, parent: string): boolean {
  return (
    isPathEqualOrUnder(child, parent)
    && normalizeFsPathKey(child) !== normalizeFsPathKey(parent)
  );
}

function mostSpecificRoot(fsPath: string, roots: string[]): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const root of roots) {
    if (!isPathEqualOrUnder(fsPath, root)) {
      continue;
    }
    const len = normalizeFsPathKey(root).length;
    if (len > bestLen) {
      best = root;
      bestLen = len;
    }
  }
  return best;
}

/** Configured roots that sit strictly inside `base` (need their own fd). */
export function nestedRootsUnder(base: string, roots: string[]): string[] {
  return roots.filter((root) => isStrictlyUnder(root, base));
}

/**
 * `--exclude` patterns that keep a parent fd from walking nested roots.
 * Anchored to the parent base (first path `.`).
 */
export function holePunchExcludePatterns(
  base: string,
  roots: string[],
): string[] {
  const patterns: string[] = [];
  for (const nested of nestedRootsUnder(base, roots)) {
    const rel = path.relative(base, nested).replace(/\\/g, '/');
    if (!rel || rel === '.' || rel.startsWith('..')) {
      continue;
    }
    patterns.push(`/${rel}`);
  }
  return patterns;
}

/** The base and positional search paths for one fd process. */
export interface FdInvocation {
  /** Absolute dir paths are emitted relative to; stored in FzfIndex.bases[i]. */
  base: string;
  /** Dirs under `base` to walk (workspace-relative, `/`-separated). */
  searchPaths: string[];
}

/**
 * Plan fd walks from configured roots and include directories.
 *
 * Every root gets its own fd invocation. An include adds an explicit search
 * path only when it is excluded beneath its most-specific root. Includes never
 * create invocations of their own. Nested roots remain separate invocations,
 * and the parent fd punches a hole via {@link holePunchExcludePatterns}.
 */
export function getIndexFdInvocations(
  roots: string[],
  includeEntries: string[],
  excludePatterns: string[],
): FdInvocation[] {
  const seen = new Set<string>();
  const invocations = new Map<string, FdInvocation>();

  const add = (fsPath: string, base: string) => {
    const key = normalizeFsPathKey(fsPath);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const baseKey = normalizeFsPathKey(base);
    let invocation = invocations.get(baseKey);
    if (!invocation) {
      invocation = { base, searchPaths: [] };
      invocations.set(baseKey, invocation);
    }

    if (key === baseKey) {
      invocation.searchPaths.push('.');
      return;
    }
    const rel = path.relative(base, fsPath).replace(/\\/g, '/');
    if (rel && rel !== '.' && !rel.startsWith('..')) {
      invocation.searchPaths.push(`./${rel}`);
    }
  };

  for (const root of roots) {
    add(root, root);
  }

  for (const includePath of resolveSearchPaths(roots, includeEntries)) {
    const base = mostSpecificRoot(includePath, roots);
    const excluded =
      base !== undefined
      && pathMatchesGlobsFromBase(includePath, base, excludePatterns);
    Log.trace?.('include path', {
      includePath,
      base,
      excluded,
    });
    if (base !== undefined && excluded) {
      add(includePath, base);
    }
  }

  return [...invocations.values()].map((invocation) => ({
    base: invocation.base,
    // fd anchors `--exclude /pattern` to the first positional path.
    searchPaths: [...new Set(invocation.searchPaths)].sort((a, b) =>
      a === '.' ? -1 : b === '.' ? 1 : 0,
    ),
  }));
}

/** True if the path is under a configured include directory. */
function isIncludedPath(fsPath: string): boolean {
  return getIncludeSearchPaths().some((includePath) =>
    isPathEqualOrUnder(fsPath, includePath),
  );
}

/**
 * True if the default index walks this path despite a parent exclude:
 * `include` dirs, or a configured root that is nested under another root
 * (hole-punched) / whose own path is excluded.
 * The FS watcher uses this so create/delete still reloads the index.
 */
export function isForceIndexedPath(fsPath: string): boolean {
  if (isIncludedPath(fsPath)) {
    return true;
  }
  const scope = config.resolveIndexScope(null);
  if (!scope) {
    return false;
  }
  for (const root of scope.roots) {
    if (!isPathEqualOrUnder(fsPath, root)) {
      continue;
    }
    const nested = scope.roots.some((other) => isStrictlyUnder(root, other));
    if (nested || isExcludedPath(root, scope.excludePatterns)) {
      return true;
    }
  }
  return false;
}
