import { type IndexBuild } from './fdCommand.ts';
import Log from './log.ts';

/** Process-chain handle that IndexSlot can hot-swap. */
export interface SlotIndex {
  readonly ready: Promise<void>;
  readonly isDisposed: boolean;
  waitUntilLoaded(isCancelled?: () => boolean): Promise<void>;
  dispose(): void;
}

/**
 * One live index plus an optional background replacement.
 * First fill exposes at listen-ready; later replace() swaps when fully loaded.
 */
export default class IndexSlot<T extends SlotIndex = SlotIndex> {
  private current: T | undefined;
  private pending: T | undefined;
  private replaceGeneration = 0;
  private disposed = false;

  constructor(
    private readonly createIndex: (build: IndexBuild) => T,
    initial?: IndexBuild,
  ) {
    if (initial) {
      this.current = this.createIndex(initial);
    }
  }

  get live(): T | undefined {
    return this.current;
  }

  get ready(): Promise<void> {
    return this.current?.ready ?? Promise.resolve();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * First fill assigns immediately and waits for listen-ready.
   * When live already exists, builds in the background and swaps when loaded.
   * `beforeSwap` runs after load and before the pointer swap; if it throws or
   * `isCancelled()` is then true, live is left unchanged.
   */
  async replace(
    build: IndexBuild,
    options?: {
      beforeSwap?: (next: T, isCancelled: () => boolean) => Promise<void>;
    },
  ): Promise<void> {
    if (this.disposed) {
      return;
    }

    const generation = ++this.replaceGeneration;
    this.disposePending();

    const next = this.createIndex(build);
    const isCancelled = () =>
      this.disposed || generation !== this.replaceGeneration;

    if (!this.current) {
      this.current = next;
      Log.debug?.('index slot first fill', { label: build.scope.label });
      try {
        await next.ready;
      } catch (err) {
        if (this.current === next) {
          next.dispose();
          this.current = undefined;
        }
        if (!this.disposed) {
          Log.error?.('index slot first fill failed', (err as Error).message);
        }
      }
      return;
    }

    this.pending = next;
    Log.debug?.('index slot replace started', { label: build.scope.label });

    try {
      await next.waitUntilLoaded(isCancelled);
    } catch (err) {
      this.dropPendingIf(next);
      if (!isCancelled() && !this.disposed) {
        Log.error?.('index slot replace failed', (err as Error).message);
      }
      return;
    }

    if (this.shouldDropPending(next, isCancelled)) {
      this.dropPendingIf(next);
      return;
    }

    if (options?.beforeSwap) {
      try {
        await options.beforeSwap(next, isCancelled);
      } catch (err) {
        this.dropPendingIf(next);
        if (!isCancelled() && !this.disposed) {
          Log.error?.('index slot beforeSwap failed', (err as Error).message);
        }
        return;
      }
    }

    if (this.shouldDropPending(next, isCancelled)) {
      this.dropPendingIf(next);
      return;
    }

    const old = this.current;
    this.current = next;
    this.pending = undefined;
    Log.debug?.('index slot swapped', { label: build.scope.label });
    old.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.replaceGeneration += 1;
    this.disposePending();
    this.current?.dispose();
    this.current = undefined;
  }

  private shouldDropPending(next: T, isCancelled: () => boolean): boolean {
    return isCancelled() || next.isDisposed || this.disposed;
  }

  private dropPendingIf(next: T): void {
    if (this.pending === next) {
      next.dispose();
      this.pending = undefined;
    }
  }

  private disposePending(): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.dispose();
  }
}
