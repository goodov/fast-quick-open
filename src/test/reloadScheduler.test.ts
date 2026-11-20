import * as assert from 'assert';
import * as vscode from 'vscode';

import ReloadScheduler, {
  RELOAD_DEBOUNCE_MS,
  type ReloadSchedulerClock,
} from '../helpers/reloadScheduler.ts';
import { stubWorkspaceConfig } from './helpers/stubWorkspaceConfig.ts';

const schedulers: ReloadScheduler[] = [];

setup(() => {
  schedulers.length = 0;
});

teardown(() => {
  for (const scheduler of schedulers) {
    scheduler.dispose();
  }
  schedulers.length = 0;
});

class FakeClock implements ReloadSchedulerClock {
  nowMs = 0;
  private nextId = 1;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.nowMs + ms, fn });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers
      .filter((timer) => timer.at <= this.nowMs)
      .sort((a, b) => a.at - b.at || a.id - b.id);
    this.timers = this.timers.filter((timer) => timer.at > this.nowMs);
    for (const timer of due) {
      timer.fn();
    }
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createScheduler(
  flush: () => Promise<void>,
  clock: ReloadSchedulerClock,
  debounceMs = RELOAD_DEBOUNCE_MS,
): ReloadScheduler {
  const scheduler = new ReloadScheduler(flush, clock, debounceMs);
  schedulers.push(scheduler);
  return scheduler;
}

suite('ReloadScheduler', () => {
  test('events 100ms apart before debounce coalesce into one flush', async () => {
    const clock = new FakeClock();
    let flushes = 0;
    const scheduler = createScheduler(async () => {
      flushes += 1;
    }, clock);

    scheduler.schedule();
    clock.advance(100);
    scheduler.schedule();
    clock.advance(100);
    scheduler.schedule();
    clock.advance(RELOAD_DEBOUNCE_MS - 1);
    await tick();
    assert.strictEqual(flushes, 0);

    clock.advance(1);
    await tick();
    assert.strictEqual(flushes, 1);
  });

  test('continuous events stay queued until the quiet period', async () => {
    const clock = new FakeClock();
    let flushes = 0;
    const scheduler = createScheduler(async () => {
      flushes += 1;
    }, clock);

    for (let t = 0; t < RELOAD_DEBOUNCE_MS + 1000; t += 100) {
      scheduler.schedule();
      clock.advance(100);
    }
    await tick();
    assert.strictEqual(flushes, 0);

    clock.advance(RELOAD_DEBOUNCE_MS);
    await tick();
    assert.strictEqual(flushes, 1);
  });

  test('zero debounce keeps background work queued', async () => {
    const clock = new FakeClock();
    let flushes = 0;
    const scheduler = createScheduler(
      async () => {
        flushes += 1;
      },
      clock,
      0,
    );

    scheduler.schedule();
    clock.advance(60_000);
    await tick();
    assert.strictEqual(flushes, 0);
    assert.ok(scheduler.isDirty);

    await scheduler.flushNow(true);
    assert.strictEqual(flushes, 1);
  });

  test('immediate flush bypasses the debounce', async () => {
    const clock = new FakeClock();
    let flushes = 0;
    const scheduler = createScheduler(async () => {
      flushes += 1;
    }, clock);

    scheduler.schedule();
    await scheduler.flushNow(true);
    assert.strictEqual(flushes, 1);
  });

  test('events while in flight do not start a second flush until the first completes', async () => {
    const clock = new FakeClock();
    let flushes = 0;
    const first = deferred();
    const scheduler = createScheduler(async () => {
      flushes += 1;
      if (flushes === 1) {
        await first.promise;
      }
    }, clock);

    scheduler.schedule();
    clock.advance(RELOAD_DEBOUNCE_MS);
    await tick();
    assert.strictEqual(flushes, 1);
    assert.ok(scheduler.isInFlight);

    scheduler.schedule();
    scheduler.schedule();
    clock.advance(RELOAD_DEBOUNCE_MS);
    await tick();
    assert.strictEqual(flushes, 1);

    first.resolve();
    await tick();
    assert.strictEqual(flushes, 1);
    assert.ok(scheduler.isDirty);
    assert.ok(!scheduler.isInFlight);

    clock.advance(RELOAD_DEBOUNCE_MS);
    await tick();
    assert.strictEqual(flushes, 2);
  });

  test('immediate work queued in flight flushes without another delay', async () => {
    const clock = new FakeClock();
    let flushes = 0;
    const first = deferred();
    const scheduler = createScheduler(async () => {
      flushes += 1;
      if (flushes === 1) {
        await first.promise;
      }
    }, clock);

    scheduler.schedule(true);
    await tick();
    assert.strictEqual(flushes, 1);
    assert.ok(scheduler.isInFlight);

    scheduler.schedule(true);
    first.resolve();
    await tick();
    assert.strictEqual(flushes, 2);
  });

  test('updates its debounce when configuration changes', async () => {
    const fastQuickOpen: Record<string, unknown> = {
      reloadDebounceSeconds: 1,
    };
    const restoreConfig = stubWorkspaceConfig({ fastQuickOpen });
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      vscode.workspace,
      'onDidChangeConfiguration',
    );
    let listener:
      ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    const original = vscode.workspace.onDidChangeConfiguration;
    Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', {
      configurable: true,
      value: (callback: (event: vscode.ConfigurationChangeEvent) => void) => {
        listener = callback;
        return new vscode.Disposable(() => {
          listener = undefined;
        });
      },
    });

    try {
      const clock = new FakeClock();
      let flushes = 0;
      const scheduler = createScheduler(async () => {
        flushes += 1;
      }, clock);

      scheduler.schedule();
      clock.advance(999);
      await tick();
      assert.strictEqual(flushes, 0);

      fastQuickOpen.reloadDebounceSeconds = 0;
      assert.ok(listener);
      listener({
        affectsConfiguration: (key) => key === 'fastQuickOpen',
      });
      clock.advance(10_000);
      await tick();
      assert.strictEqual(flushes, 0);
      assert.ok(scheduler.isDirty);
    } finally {
      restoreConfig();
      if (originalDescriptor) {
        Object.defineProperty(
          vscode.workspace,
          'onDidChangeConfiguration',
          originalDescriptor,
        );
      } else {
        Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', {
          configurable: true,
          value: original,
        });
      }
    }
  });
});
