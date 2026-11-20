import { config } from '../config.ts';
import ConfigObserver from './configObserver.ts';

export const RELOAD_DEBOUNCE_MS = 10_000;

export interface ReloadSchedulerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const defaultClock: ReloadSchedulerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as NodeJS.Timeout),
};

/** Coalesce reloads and preserve queued work while a flush is in flight. */
export default class ReloadScheduler extends ConfigObserver {
  private dirty = false;
  private inFlight = false;
  private immediatePending = false;
  private timer: unknown;
  private disposed = false;
  private debounceMs: number;

  constructor(
    private readonly flush: () => Promise<void>,
    private readonly clock: ReloadSchedulerClock = defaultClock,
    debounceMs?: number,
  ) {
    super();
    this.debounceMs =
      debounceMs ?? config.settings().reloadDebounceSeconds * 1000;
  }

  protected onConfigurationChanged(): void {
    this.setDebounceMs(config.settings().reloadDebounceSeconds * 1000);
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get isInFlight(): boolean {
    return this.inFlight;
  }

  schedule(immediate = false): void {
    if (this.disposed) {
      return;
    }

    this.dirty = true;
    if (immediate) {
      this.immediatePending = true;
    }
    if (this.inFlight) {
      return;
    }

    this.clearTimer();
    if (this.immediatePending) {
      void this.flushNow();
      return;
    }

    if (this.debounceMs <= 0) {
      return;
    }

    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.flushNow();
    }, this.debounceMs);
  }

  async flushNow(immediate = false): Promise<void> {
    if (this.disposed || !this.dirty) {
      return;
    }
    if (immediate) {
      this.immediatePending = true;
    }
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    this.dirty = false;
    this.immediatePending = false;
    this.clearTimer();

    try {
      await this.flush();
    } finally {
      this.inFlight = false;
      if (!this.disposed && this.dirty) {
        this.schedule(this.immediatePending);
      }
    }
  }

  setDebounceMs(debounceMs: number): void {
    this.debounceMs =
      Number.isFinite(debounceMs) && debounceMs >= 0
        ? debounceMs
        : RELOAD_DEBOUNCE_MS;
    if (this.disposed || this.inFlight || !this.dirty) {
      return;
    }
    this.schedule(this.immediatePending);
  }

  dispose(): void {
    super.dispose();
    this.disposed = true;
    this.dirty = false;
    this.immediatePending = false;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
