import * as assert from 'assert';

import { type IndexBuild } from '../fdCommand.ts';
import IndexSlot, { type SlotIndex } from '../indexSlot.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function build(label: string): IndexBuild {
  return {
    scope: {
      scopeKey: label,
      label,
      roots: [],
      includeEntries: [],
      excludePatterns: [],
      fdOptions: {
        hidden: false,
        noIgnore: false,
        extraFlags: [],
        pattern: '.',
      },
      fzfExtraFlags: [],
      maxItems: 50,
      lifecycle: 'active',
    },
    specs: [],
    filterLabels: false,
  };
}

class FakeIndex implements SlotIndex {
  readonly id: string;
  isDisposed = false;
  waitUntilLoadedCalls = 0;
  private readonly readyDeferred = deferred();
  private readonly loadedDeferred = deferred();

  constructor(id: string, alreadyReady = false) {
    this.id = id;
    if (alreadyReady) {
      this.readyDeferred.resolve();
    }
  }

  get ready(): Promise<void> {
    return this.readyDeferred.promise;
  }

  resolveReady(): void {
    this.readyDeferred.resolve();
  }

  resolveLoaded(): void {
    this.readyDeferred.resolve();
    this.loadedDeferred.resolve();
  }

  async waitUntilLoaded(isCancelled?: () => boolean): Promise<void> {
    this.waitUntilLoadedCalls += 1;
    await this.ready;
    while (!this.isDisposed && !isCancelled?.()) {
      const winner = await Promise.race([
        this.loadedDeferred.promise.then(() => 'loaded' as const),
        delay(5).then(() => 'poll' as const),
      ]);
      if (winner === 'loaded') {
        return;
      }
    }
  }

  dispose(): void {
    this.isDisposed = true;
    this.readyDeferred.resolve();
    this.loadedDeferred.resolve();
  }
}

suite('IndexSlot', () => {
  test('first fill exposes live before waitUntilLoaded', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label);
      created.push(index);
      return index;
    });

    const pending = slot.replace(build('a'));
    const first = created[0];
    assert.ok(first);
    assert.strictEqual(slot.live, first);
    assert.strictEqual(first.waitUntilLoadedCalls, 0);

    first.resolveReady();
    await pending;
    assert.strictEqual(slot.live, first);
    assert.strictEqual(first.waitUntilLoadedCalls, 0);
    assert.ok(!first.isDisposed);
  });

  test('constructor initial is live immediately and does not waitUntilLoaded', () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, true);
      created.push(index);
      return index;
    }, build('a'));

    assert.strictEqual(slot.live, created[0]);
    assert.strictEqual(created[0]!.waitUntilLoadedCalls, 0);
  });

  test('hot-swap keeps live identity until the replacement is loaded', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, b.scope.label === 'a');
      created.push(index);
      return index;
    }, build('a'));

    const live = created[0]!;
    const pending = slot.replace(build('b'));
    const next = created[1]!;

    assert.strictEqual(slot.live, live);
    assert.ok(!live.isDisposed);
    assert.strictEqual(next.waitUntilLoadedCalls, 1);

    next.resolveLoaded();
    await pending;

    assert.strictEqual(slot.live, next);
    assert.ok(live.isDisposed);
    assert.ok(!next.isDisposed);
  });

  test('newer replace disposes the previous pending; live stays until the newest loads', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, b.scope.label === 'a');
      created.push(index);
      return index;
    }, build('a'));

    const live = created[0]!;
    const firstReplace = slot.replace(build('b'));
    const discarded = created[1]!;
    const secondReplace = slot.replace(build('c'));
    const newest = created[2]!;

    assert.ok(discarded.isDisposed);
    assert.strictEqual(slot.live, live);
    assert.ok(!live.isDisposed);

    newest.resolveLoaded();
    await secondReplace;
    await firstReplace;

    assert.strictEqual(slot.live, newest);
    assert.ok(live.isDisposed);
    assert.ok(!newest.isDisposed);
  });

  test('beforeSwap runs while live is still the old instance', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, b.scope.label === 'a');
      created.push(index);
      return index;
    }, build('a'));

    const live = created[0]!;
    let seenLive: FakeIndex | undefined;
    let seenNext: FakeIndex | undefined;

    const pending = slot.replace(build('b'), {
      beforeSwap: async (next) => {
        seenLive = slot.live as FakeIndex;
        seenNext = next;
      },
    });
    const next = created[1]!;
    next.resolveLoaded();
    await pending;

    assert.strictEqual(seenLive, live);
    assert.strictEqual(seenNext, next);
    assert.strictEqual(slot.live, next);
    assert.ok(live.isDisposed);
  });

  test('throwing beforeSwap does not swap', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, b.scope.label === 'a');
      created.push(index);
      return index;
    }, build('a'));

    const live = created[0]!;
    const pending = slot.replace(build('b'), {
      beforeSwap: async () => {
        throw new Error('prime failed');
      },
    });
    const next = created[1]!;
    next.resolveLoaded();
    await pending;

    assert.strictEqual(slot.live, live);
    assert.ok(!live.isDisposed);
    assert.ok(next.isDisposed);
  });

  test('cancelled beforeSwap does not swap', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, b.scope.label === 'a');
      created.push(index);
      return index;
    }, build('a'));

    const live = created[0]!;
    const hookStarted = deferred();
    const firstReplace = slot.replace(build('b'), {
      beforeSwap: async (_next, isCancelled) => {
        hookStarted.resolve();
        while (!isCancelled()) {
          await delay(5);
        }
      },
    });
    created[1]!.resolveLoaded();
    await hookStarted.promise;

    const secondReplace = slot.replace(build('c'));
    await firstReplace;

    assert.strictEqual(slot.live, live);
    assert.ok(!live.isDisposed);
    assert.ok(created[1]!.isDisposed);

    created[2]!.resolveLoaded();
    await secondReplace;
    assert.strictEqual(slot.live, created[2]);
  });

  test('dispose tears down live and pending', async () => {
    const created: FakeIndex[] = [];
    const slot = new IndexSlot((b) => {
      const index = new FakeIndex(b.scope.label, b.scope.label === 'a');
      created.push(index);
      return index;
    }, build('a'));

    void slot.replace(build('b'));
    await delay(10);

    const live = created[0]!;
    const pending = created[1]!;
    slot.dispose();

    assert.ok(slot.isDisposed);
    assert.strictEqual(slot.live, undefined);
    assert.ok(live.isDisposed);
    assert.ok(pending.isDisposed);
  });
});
