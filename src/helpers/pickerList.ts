import type * as vscode from 'vscode';
import { uriKey } from './parseResource.ts';

export function quickPickItemKey(
  item: vscode.QuickPickItem | undefined,
): string | undefined {
  const uri = item?.resourceUri;
  return uri ? uriKey(uri) : undefined;
}

function itemSnapshot(item: vscode.QuickPickItem): string {
  return `${quickPickItemKey(item) ?? ''}\0${item.buttons?.length ?? 0}`;
}

/** Same files in the same order, with the same history-button state. */
export function pickerItemsEqual(
  current: readonly vscode.QuickPickItem[],
  next: readonly vscode.QuickPickItem[],
): boolean {
  if (current.length !== next.length) {
    return false;
  }
  for (let i = 0; i < current.length; i++) {
    if (itemSnapshot(current[i]!) !== itemSnapshot(next[i]!)) {
      return false;
    }
  }
  return true;
}

export function activeItemIndex(
  items: readonly vscode.QuickPickItem[],
  active: vscode.QuickPickItem | undefined,
): number | undefined {
  if (!active) {
    return undefined;
  }
  const byRef = items.indexOf(active);
  if (byRef >= 0) {
    return byRef;
  }
  const key = quickPickItemKey(active);
  if (!key) {
    return undefined;
  }
  const idx = items.findIndex((item) => quickPickItemKey(item) === key);
  return idx >= 0 ? idx : undefined;
}

export function itemAtIndex(
  items: readonly vscode.QuickPickItem[],
  index: number | undefined,
): vscode.QuickPickItem | undefined {
  if (index === undefined || index < 0 || items.length === 0) {
    return undefined;
  }
  return items[Math.min(index, items.length - 1)];
}

/** URI when present, otherwise label. */
export function itemKey(
  item: vscode.QuickPickItem | undefined,
): string | undefined {
  if (!item) {
    return undefined;
  }
  return quickPickItemKey(item) ?? item.label;
}

/** Same item if it still exists, otherwise the same (clamped) index. */
export function pickRestoredItem(
  items: readonly vscode.QuickPickItem[],
  lastKey: string | undefined,
  lastIndex: number | undefined,
): vscode.QuickPickItem | undefined {
  if (lastKey) {
    const match = items.find((item) => itemKey(item) === lastKey);
    if (match) {
      return match;
    }
  }
  return itemAtIndex(items, lastIndex);
}

/**
 * Owns QuickPick `items` and keeps the highlighted row across list updates
 * while the user is navigating. After a refresh, the same item is selected
 * when it still exists; otherwise the same index. The default first row is
 * not followed (a recent may float there). Typing resets to first.
 */
export default class PickerList {
  private items: vscode.QuickPickItem[] = [];
  private lastIndex: number | undefined;
  private lastKey: string | undefined;
  private swallowReset = false;
  private restoring = false;
  /** The last input change should pin the highlight to the first row. */
  private pinToFirst = false;

  constructor(
    private readonly quickPick: vscode.QuickPick<vscode.QuickPickItem>,
  ) {
    this.quickPick.onDidChangeActive((active) => {
      this.onActiveChange(active[0]);
    });
    this.quickPick.onDidChangeValue(() => {
      this.onValueChange();
    });
  }

  setItems(items: vscode.QuickPickItem[], options?: { force?: boolean }): void {
    if (!options?.force && pickerItemsEqual(this.items, items)) {
      return;
    }
    if (!this.pinToFirst) {
      this.remember(this.quickPick.activeItems[0]);
    }
    this.pinToFirst = false;
    this.swallowReset = this.items.length > 0;
    this.items = items;
    this.quickPick.items = items;

    if (options?.force) {
      this.lastIndex = undefined;
      this.lastKey = undefined;
      this.activateFirst();
    }
  }

  /** Forget a pinned row so the next list starts on the first item. */
  reset(): void {
    this.lastIndex = undefined;
    this.lastKey = undefined;
    this.pinToFirst = false;
    this.swallowReset = false;
    this.activateFirst();
  }

  private activateFirst(): void {
    const first = this.items[0];
    if (!first || this.quickPick.activeItems[0] === first) {
      return;
    }
    this.restoring = true;
    try {
      this.quickPick.activeItems = [first];
    } finally {
      this.restoring = false;
    }
  }

  private onValueChange(): void {
    this.lastIndex = 0;
    this.lastKey = undefined;
    this.pinToFirst = true;
    this.swallowReset = false;
    this.restore();
  }

  selectNext(): void {
    if (this.items.length === 0) {
      return;
    }
    const idx =
      activeItemIndex(this.items, this.quickPick.activeItems[0]) ?? -1;
    this.remember(this.items[(idx + 1) % this.items.length]);
    this.pinToFirst = false;
    this.restore();
  }

  private remember(active: vscode.QuickPickItem | undefined): void {
    const idx = activeItemIndex(this.items, active);
    if (idx === undefined) {
      return;
    }
    this.lastIndex = idx;
    // Index 0 is the widget default. Remembering it would follow that file
    // when a recent later floats to the top.
    this.lastKey = idx === 0 ? undefined : itemKey(active);
  }

  private restore(): void {
    const match = pickRestoredItem(this.items, this.lastKey, this.lastIndex);
    if (!match || this.quickPick.activeItems[0] === match) {
      return;
    }
    this.restoring = true;
    try {
      this.quickPick.activeItems = [match];
    } finally {
      this.restoring = false;
    }
  }

  private onActiveChange(active: vscode.QuickPickItem | undefined): void {
    if (this.restoring) {
      return;
    }
    // Empty active is the first half of a value-reset. Do not save it and do
    // not consume a pending items-replace swallow.
    if (!active) {
      return;
    }
    if (this.swallowReset) {
      this.swallowReset = false;
      const idx = activeItemIndex(this.items, active);
      // Only the widget's reset-to-first is swallowed. A real arrow move wins.
      if (idx === 0 || idx === undefined) {
        this.restore();
        return;
      }
      this.remember(active);
      return;
    }
    this.remember(active);
  }
}
