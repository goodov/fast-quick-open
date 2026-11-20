import * as vscode from 'vscode';
import { config } from './config.ts';
import { isExcludedPath, isForceIndexedPath } from './excludes.ts';
import { resolveOnDemandScope } from './onDemand.ts';
import FzfIndex, { FzfHit, SearchResultMeta } from './fzfIndex.ts';
import FdCommandBuilder, { IndexBuild } from './fdCommand.ts';
import ConfigObserver from './helpers/configObserver.ts';
import ReloadScheduler from './helpers/reloadScheduler.ts';
import { workspaceFolderPaths } from './helpers/vscodeUtils.ts';
import IndexSlot from './indexSlot.ts';
import Log from './log.ts';

interface DataResultCallback {
  (hits: FzfHit[], meta?: SearchResultMeta): void;
}

function normalizeQuery(text: string): string {
  return text.replace(/\\/g, '/');
}

export interface PreparedSearchQuery {
  query: string;
  rewrite?: { from: string; to: string };
}

/** Normalize input for fzf search (trim, first line, slashes; optional lowercasing). */
export function prepareSearchQuery(text: string): PreparedSearchQuery {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let query = normalizeQuery(firstLine.replace(/::/g, '').trim());
  if (config.settings().lowercaseQuery) {
    query = query.toLowerCase();
  }
  const replaced = config.queryReplacer().apply(query);
  return {
    query: replaced,
    rewrite: replaced === query ? undefined : { from: query, to: replaced },
  };
}

export function normalizeSearchQuery(text: string): string {
  return prepareSearchQuery(text).query;
}

/**
 * Long-lived default fzf index plus optional per-scope on-demand instances.
 */
export default class Search extends ConfigObserver {
  private readonly extensionPath: string;
  private readonly fdCommand: FdCommandBuilder;
  private defaultSlot: IndexSlot<FzfIndex>;
  private readonly onDemandSlots = new Map<string, IndexSlot<FzfIndex>>();
  private onDataListeners: DataResultCallback[] = [];
  private generation = 0;
  private requestId = 0;
  private disposed = false;
  private lastQuery = '';
  private pendingFsEvents = 0;
  private readonly reloadScheduler: ReloadScheduler;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(extensionPath: string) {
    super();
    this.extensionPath = extensionPath;
    this.fdCommand = new FdCommandBuilder(extensionPath);
    const initial = this.fdCommand.forScope(null);
    if (!initial) {
      const roots = config.resolveIndexScope(null)?.roots ?? [];
      if (roots.length === 0 && workspaceFolderPaths().length === 0) {
        Log.debug?.('no index roots, default index not created');
      } else {
        Log.error?.('no default index spec, default index not created');
      }
    }
    this.defaultSlot = new IndexSlot(this.createIndex, initial);
    this.reloadScheduler = new ReloadScheduler(async () => {
      this.pendingFsEvents = 0;
      await this.replaceDefaultIndex();
    });
    this.setupWatchers();
  }

  private readonly createIndex = (built: IndexBuild): FzfIndex =>
    new FzfIndex(this.extensionPath, built);

  private get ready(): Promise<void> {
    return this.defaultSlot.ready;
  }

  private setupWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*',
      false,
      true,
      false,
    );
    const onFsEvent = (kind: 'create' | 'delete', uri: vscode.Uri) => {
      if (!isForceIndexedPath(uri.fsPath)) {
        const excludes = config.resolveIndexScope(null)?.excludePatterns ?? [];
        if (isExcludedPath(uri.fsPath, excludes)) {
          Log.debug?.('fs watcher skip (exclude)', kind, uri.fsPath);
          return;
        }
        const watcherExcludes = config.watcherExcludePatterns();
        if (isExcludedPath(uri.fsPath, watcherExcludes)) {
          Log.debug?.('fs watcher skip (watcherExclude)', kind, uri.fsPath);
          return;
        }
      }
      this.pendingFsEvents += 1;
      Log.debug?.(
        'fs watcher',
        kind,
        uri.fsPath,
        `(pending=${this.pendingFsEvents})`,
      );
      this.scheduleReload();
    };
    watcher.onDidCreate(
      (uri) => onFsEvent('create', uri),
      this,
      this.subscriptions,
    );
    watcher.onDidDelete(
      (uri) => onFsEvent('delete', uri),
      this,
      this.subscriptions,
    );
    this.subscriptions.push(watcher);

    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        Log.debug?.('workspace folders changed');
        config.clearCache();
        this.scheduleReload();
        void this.replaceExistingOnDemandSlots();
      }),
    );
  }

  protected onConfigurationChanged(
    _event: vscode.ConfigurationChangeEvent,
  ): void {
    Log.debug?.('settings changed');
    void this.replaceDefaultIndex();
    void this.replaceExistingOnDemandSlots();
  }

  private scheduleReload(): void {
    if (this.disposed) {
      return;
    }
    this.reloadScheduler.schedule(this.hasActiveSearch());
  }

  private hasActiveSearch(): boolean {
    return this.lastQuery.length > 0 && this.onDataListeners.length > 0;
  }

  private resetDefaultSlot(): void {
    this.defaultSlot.dispose();
    this.defaultSlot = new IndexSlot(this.createIndex);
  }

  private async replaceDefaultIndex(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const built = this.fdCommand.forScope(null);
    if (!built) {
      this.resetDefaultSlot();
      return;
    }

    await this.replaceSlot(this.defaultSlot, built, null);
  }

  private async replaceExistingOnDemandSlots(): Promise<void> {
    if (this.disposed || this.onDemandSlots.size === 0) {
      return;
    }

    const replaced: string[] = [];
    const removed: string[] = [];

    for (const [key, slot] of [...this.onDemandSlots]) {
      const built = this.fdCommand.forScope(key);
      if (!built) {
        slot.dispose();
        this.onDemandSlots.delete(key);
        removed.push(key);
        continue;
      }
      replaced.push(key);
      void this.replaceSlot(slot, built, key);
    }

    if (replaced.length > 0) {
      Log.debug?.('replacing on-demand slots', { keys: replaced });
    }
    if (removed.length > 0) {
      Log.debug?.('removed on-demand slots (scope gone)', { keys: removed });
    }
  }

  private queryTargetsScope(scopeKey: string | null): boolean {
    const active = this.lastQuery ? resolveOnDemandScope(this.lastQuery) : null;
    if (scopeKey === null) {
      return !active;
    }
    return active?.key === scopeKey;
  }

  private sessionTargetsSlot(scopeKey: string | null): boolean {
    return (
      this.lastQuery.length > 0
      && this.onDataListeners.length > 0
      && this.queryTargetsScope(scopeKey)
    );
  }

  /**
   * Run the current query on `index` without emitting intermediate hits.
   * Re-primes if the user types a new query that still targets this scope.
   * Query/prime errors return undefined so a loaded pending index can still swap.
   */
  private async primeSettledQuery(
    index: FzfIndex,
    scopeKey: string | null,
    isCancelled: () => boolean,
  ): Promise<{ hits: FzfHit[]; query: string } | undefined> {
    while (!isCancelled() && this.sessionTargetsSlot(scopeKey)) {
      const query = this.lastQuery;
      const queryScope = resolveOnDemandScope(query);
      const indexScope = config.resolveIndexScope(queryScope?.key ?? null);
      const fzfQuery = queryScope ? queryScope.fzfQuery : query;
      let completeHits: FzfHit[] | undefined;

      try {
        await index.runQuery(
          fzfQuery,
          () =>
            isCancelled()
            || this.lastQuery !== query
            || this.onDataListeners.length === 0,
          (hits, meta) => {
            if (!meta.indexing) {
              completeHits = hits;
            }
          },
          indexScope?.maxItems
            ?? config.resolveIndexScope(null)?.maxItems
            ?? 100,
        );
      } catch (err) {
        if (
          isCancelled()
          || this.lastQuery !== query
          || this.onDataListeners.length === 0
        ) {
          continue;
        }
        // Do not throw: a failed prime must not discard a loaded pending index.
        Log.error?.('index prime failed', {
          scopeKey,
          query,
          error: (err as Error).message,
        });
        return undefined;
      }

      if (completeHits && this.lastQuery === query) {
        return { hits: completeHits, query };
      }
    }
    return undefined;
  }

  private async replaceSlot(
    slot: IndexSlot<FzfIndex>,
    built: IndexBuild,
    scopeKey: string | null,
  ): Promise<void> {
    let primed: { hits: FzfHit[]; query: string } | undefined;
    const previousLive = slot.live;
    try {
      await slot.replace(built, {
        beforeSwap: async (next, isCancelled) => {
          try {
            primed = await this.primeSettledQuery(next, scopeKey, isCancelled);
          } catch (err) {
            if (!isCancelled()) {
              Log.error?.(
                'index prime failed; swapping loaded index anyway',
                scopeKey ?? 'default',
                (err as Error).message,
              );
            }
          }
        },
      });
      if (this.disposed) {
        return;
      }

      const swapped = slot.live !== undefined && slot.live !== previousLive;
      if (!swapped) {
        return;
      }

      if (
        primed
        && primed.query === this.lastQuery
        && this.sessionTargetsSlot(scopeKey)
      ) {
        this.generation += 1;
        this.requestId += 1;
        Log.debug?.('index swap emit complete', {
          scopeKey,
          query: primed.query,
          hits: primed.hits.length,
        });
        this.emit(primed.hits, { indexing: false });
        return;
      }

      if (this.sessionTargetsSlot(scopeKey)) {
        this.searchNormalized(this.lastQuery);
      }
    } catch (err) {
      if (!this.disposed) {
        Log.error?.(
          'index replace failed',
          scopeKey ?? 'default',
          (err as Error).message,
        );
      }
    }
  }

  private async getOrCreateOnDemandIndex(
    scopeKey: string,
  ): Promise<FzfIndex | undefined> {
    const existing = this.onDemandSlots.get(scopeKey);
    if (existing && !existing.isDisposed) {
      await existing.ready;
      return existing.isDisposed ? undefined : existing.live;
    }
    if (existing) {
      this.onDemandSlots.delete(scopeKey);
    }

    const built = this.fdCommand.forScope(scopeKey);
    if (!built) {
      return undefined;
    }

    Log.debug?.('creating on-demand index', scopeKey);
    const slot = new IndexSlot(this.createIndex, built);
    this.onDemandSlots.set(scopeKey, slot);
    await slot.ready;
    if (slot.isDisposed || this.disposed) {
      this.onDemandSlots.delete(scopeKey);
      return undefined;
    }
    return slot.live;
  }

  private releaseOnDemandIndices(force = false): void {
    if (this.onDemandSlots.size === 0) {
      return;
    }

    const removed: string[] = [];
    const kept: string[] = [];

    for (const [key, slot] of this.onDemandSlots) {
      const lifecycle = config.resolveIndexScope(key)?.lifecycle ?? 'destroy';
      if (!force && lifecycle === 'active') {
        kept.push(key);
        continue;
      }
      slot.dispose();
      removed.push(key);
      this.onDemandSlots.delete(key);
    }

    if (removed.length > 0) {
      Log.debug?.('destroyed on-demand indices', { keys: removed, force });
    }
    if (kept.length > 0) {
      Log.debug?.('on-demand indices kept (lifecycle=active)', { keys: kept });
    }
  }

  private emit(hits: FzfHit[], meta: SearchResultMeta): void {
    this.onDataListeners.forEach((listener) => listener(hits, meta));
  }

  /** Cancel in-flight searches. */
  cancelActiveSearch(): void {
    this.lastQuery = '';
    this.generation += 1;
    this.requestId += 1;
  }

  search(text: string, options?: { fromSelection?: boolean }): void {
    const prepared = prepareSearchQuery(text);
    this.searchNormalized(prepared.query, options, prepared.rewrite);
  }

  searchNormalized(
    query: string,
    options?: { fromSelection?: boolean },
    rewrite?: PreparedSearchQuery['rewrite'],
  ): void {
    if (rewrite) {
      Log.debug?.('[queryReplace]', 'rewrote query', rewrite);
    }
    this.lastQuery = query;

    if (query.length === 0) {
      this.generation += 1;
      this.requestId += 1;
      Log.debug?.('search cleared (empty query)');
      this.emit([], { indexing: false });
      return;
    }

    const generation = ++this.generation;
    const requestId = ++this.requestId;
    Log.debug?.('search queued', {
      query,
      generation,
      requestId,
      fromSelection: options?.fromSelection,
    });
    const isCancelled = () =>
      this.disposed
      || generation !== this.generation
      || requestId !== this.requestId;

    void this.runQuery(query, generation, isCancelled);
  }

  private async runQuery(
    query: string,
    generation: number,
    isCancelled: () => boolean,
  ): Promise<void> {
    try {
      const queryScope = resolveOnDemandScope(query);
      const indexScope = config.resolveIndexScope(queryScope?.key ?? null);
      const fzfQuery = queryScope ? queryScope.fzfQuery : query;

      let index: FzfIndex | undefined;
      if (queryScope) {
        index = await this.getOrCreateOnDemandIndex(queryScope.key);
      } else {
        await this.ready;
        index = this.defaultSlot.live;
      }

      if (isCancelled()) {
        Log.debug?.('runQuery cancelled', { query, generation });
        return;
      }

      if (!index || index.isDisposed) {
        Log.debug?.('runQuery: no index for scope', queryScope?.key ?? null);
        this.emit([], { indexing: false });
        return;
      }

      Log.debug?.('runQuery', {
        query,
        fzfQuery,
        scopeKey: queryScope?.key ?? null,
        maxItems: indexScope?.maxItems,
        index: queryScope?.key ?? 'default',
      });

      await index.runQuery(
        fzfQuery,
        isCancelled,
        (hits, meta) => {
          if (!isCancelled()) {
            this.emit(hits, meta);
          }
        },
        indexScope?.maxItems ?? config.resolveIndexScope(null)?.maxItems ?? 100,
      );
    } catch (err) {
      if (isCancelled()) {
        Log.debug?.('runQuery aborted', { query, generation });
        return;
      }
      Log.error?.('runQuery failed', {
        query,
        generation,
        error: (err as Error).message,
      });
      this.emit([], { indexing: false });
    }
  }

  /** Register a results listener; dispose the return value when the picker closes. */
  onData(callback: DataResultCallback): vscode.Disposable {
    this.onDataListeners.push(callback);
    if (this.hasActiveSearch()) {
      void this.reloadScheduler.flushNow(true);
    }
    return new vscode.Disposable(() => {
      this.onDataListeners = this.onDataListeners.filter(
        (cb) => cb !== callback,
      );
      if (this.onDataListeners.length === 0) {
        this.releaseOnDemandIndices();
      }
    });
  }

  dispose(): void {
    Log.debug?.('dispose');
    this.disposed = true;
    this.requestId += 1;
    super.dispose();
    this.reloadScheduler.dispose();
    for (const sub of this.subscriptions) {
      try {
        sub.dispose();
      } catch {
        // ignore
      }
    }
    this.subscriptions.length = 0;
    this.onDataListeners = [];
    this.releaseOnDemandIndices(true);
    this.defaultSlot.dispose();
  }
}
