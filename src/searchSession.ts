import * as vscode from 'vscode';
import { config } from './config.ts';
import { type FzfHit, type SearchResultMeta } from './fzfIndex.ts';
import {
  extractRangeFromFilter,
  QueryRange,
  toEditorRange,
} from './helpers/extractRange.ts';
import type { FastQuickOpenArgs } from './helpers/fastQuickOpenArgs.ts';
import resourceToQuickPickItem, {
  REMOVE_FROM_HISTORY_BUTTON,
} from './helpers/filePathToQuickPickItem.ts';
import { setLastQuery } from './helpers/lastQuery.ts';
import mergeResults, { isRecentResource } from './helpers/mergeResults.ts';
import { resolvePathCandidates } from './helpers/pathCandidates.ts';
import PickerList from './helpers/pickerList.ts';
import { resolvePrefill, type PrefillRequest } from './helpers/prefill.ts';
import { shouldReplacePickerHits } from './helpers/searchHits.ts';
import RecentFiles from './recentFiles.ts';
import Search, { prepareSearchQuery } from './search.ts';

const BUSY_DELAY_MS = 50;

export type SearchHost = Pick<
  Search,
  'onData' | 'searchNormalized' | 'cancelActiveSearch'
>;

/** One show/hide cycle of the picker, with its own quick pick widget. */
class Picker implements vscode.Disposable {
  readonly quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
  private currentQuery = '';
  private currentValue = '';
  private pendingRange: QueryRange | undefined;
  private lastSearchedFilter: string | undefined;
  private lastSearchedQuery: string | undefined;
  private lastFzfHits: FzfHit[] = [];
  private pathCandidates: string[] = [];
  private resultGeneration = 0;
  private openingPrefill = '';
  private disposed = false;
  private readonly dataSub: vscode.Disposable;
  private readonly editorSub: vscode.Disposable;
  private busyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pickerList: PickerList;

  constructor(
    private readonly search: SearchHost,
    private readonly recentFiles: RecentFiles,
    private readonly initialPrefill: string,
    private readonly onClose: () => void,
  ) {
    this.quickPick.placeholder = 'Quick Open with Fzf';
    this.quickPick.matchOnDescription = false;
    this.quickPick.matchOnDetail = false;
    this.quickPick.keepScrollPosition = true;
    this.pickerList = new PickerList(this.quickPick);

    this.quickPick.onDidChangeValue((value) => {
      this.onDidChangeValue(value);
    });
    this.quickPick.onDidAccept(() => {
      this.onAccept();
    });
    this.quickPick.onDidTriggerItemButton((event) => {
      if (event.button !== REMOVE_FROM_HISTORY_BUTTON) {
        return;
      }
      const uri = event.item.resourceUri;
      if (!uri || !this.recentFiles.removeUri(uri)) {
        return;
      }
      this.applyResults();
    });
    this.quickPick.onDidHide(() => {
      this.close();
    });

    this.dataSub = this.search.onData((searchItems, meta) => {
      this.onSearchData(searchItems, meta);
    });
    this.editorSub = vscode.window.onDidChangeActiveTextEditor(() => {
      if (this.currentQuery.length === 0) {
        this.setFzfHits([]);
      }
    });

    if (initialPrefill) {
      this.openingPrefill = initialPrefill;
      this.quickPick.value = initialPrefill;
      // Setting value before show() does not always fire onDidChangeValue.
      this.find(initialPrefill);
    } else {
      this.setFzfHits([]);
    }
    this.quickPick.show();
    setTimeout(() => {
      void this.afterShow();
    }, 0);
  }

  selectNext(): void {
    this.pickerList.selectNext();
  }

  setValueAndFind(value: string): void {
    this.quickPick.value = value;
    this.find(value);
  }

  onAccept(): void {
    const selectedItem =
      this.quickPick.activeItems[0] ?? this.quickPick.selectedItems[0];
    const selectedUri = selectedItem?.resourceUri;
    const range = this.pendingRange;
    if (selectedUri) {
      this.recentFiles.addUri(selectedUri);
      void this.openAtPosition(selectedUri, range);
    }
    this.quickPick.hide();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.dataSub.dispose();
    this.editorSub.dispose();
    this.clearBusy();
    this.search.cancelActiveSearch();
    this.quickPick.dispose();
  }

  private close(): void {
    if (this.disposed) {
      return;
    }
    this.dispose();
    this.onClose();
  }

  private async afterShow(): Promise<void> {
    if (this.disposed) {
      return;
    }

    this.recentFiles.ensureOpenTabsTracked();

    if (this.quickPick.value === '') {
      if (this.initialPrefill) {
        // show() can race with the constructor's synchronous value assignment.
        this.openingPrefill = this.initialPrefill;
        this.quickPick.value = this.initialPrefill;
        this.find(this.initialPrefill);
      } else if (this.currentQuery.length === 0) {
        this.setFzfHits([]);
      }
    }
    await this.pruneDeletedRecents();
  }

  private async pruneDeletedRecents(): Promise<void> {
    const removed = await this.recentFiles.removeMissingFromDisk();
    if (!removed || this.disposed) {
      return;
    }
    this.applyResults();
  }

  private onSearchData(searchItems: FzfHit[], meta?: SearchResultMeta): void {
    const generation = this.resultGeneration;
    try {
      if (generation !== this.resultGeneration) {
        return;
      }
      if (this.quickPick.value !== this.currentValue) {
        return;
      }
      if (!shouldReplacePickerHits(searchItems, meta)) {
        return;
      }
      this.setFzfHits(searchItems);
    } finally {
      if (generation === this.resultGeneration && !meta?.indexing) {
        this.clearBusy();
      }
    }
  }

  private setFzfHits(fzfHits: FzfHit[]): void {
    this.lastFzfHits = fzfHits;
    this.applyResults();
  }

  private applyResults(): void {
    const recentResources = this.recentFiles.uris();
    const merged = mergeResults(
      this.currentQuery,
      this.lastFzfHits,
      recentResources,
      this.pathCandidates,
    );
    const items = merged.map((item) =>
      resourceToQuickPickItem(
        item.path,
        isRecentResource(item.path, recentResources),
        { root: item.root },
      ),
    );
    this.pickerList.setItems(items);
  }

  private onDidChangeValue(_value: string): void {
    if (this.disposed) {
      return;
    }
    this.find(this.quickPick.value);
  }

  private find(rawValue: string): void {
    const fromSelection =
      this.openingPrefill !== '' && rawValue === this.openingPrefill;
    if (fromSelection) {
      this.openingPrefill = '';
    }

    this.currentValue = rawValue;
    setLastQuery(rawValue);
    const extracted = extractRangeFromFilter(rawValue);
    const filter = extracted?.filter ?? rawValue;
    this.pendingRange = extracted?.range;
    this.currentQuery = filter;

    if (filter === this.lastSearchedFilter) {
      return;
    }
    this.lastSearchedFilter = filter;

    const prepared = prepareSearchQuery(filter);
    const shouldSearch = prepared.query !== this.lastSearchedQuery;
    if (shouldSearch) {
      this.lastSearchedQuery = prepared.query;
    }

    this.resultGeneration += 1;
    const generation = this.resultGeneration;
    this.pathCandidates = [];
    if (filter.length > 0) {
      void resolvePathCandidates(filter).then((candidates) => {
        if (
          this.disposed
          || generation !== this.resultGeneration
          || filter !== this.currentQuery
        ) {
          return;
        }
        if (candidates.length === 0) {
          return;
        }
        this.pathCandidates = candidates;
        this.applyResults();
      });
    }

    if (prepared.query.length === 0) {
      // Empty query: recents only — no need to wait on fzf.
      this.setFzfHits([]);
      this.clearBusy();
      if (shouldSearch) {
        this.search.searchNormalized(
          prepared.query,
          undefined,
          prepared.rewrite,
        );
      }
      return;
    }

    if (!shouldSearch) {
      this.applyResults();
      return;
    }

    this.scheduleBusy();
    this.search.searchNormalized(
      prepared.query,
      { fromSelection },
      prepared.rewrite,
    );
  }

  private scheduleBusy(): void {
    if (this.busyTimer !== undefined) {
      return;
    }
    this.busyTimer = setTimeout(() => {
      this.busyTimer = undefined;
      if (!this.disposed) {
        this.quickPick.busy = true;
      }
    }, BUSY_DELAY_MS);
  }

  private clearBusy(): void {
    if (this.busyTimer !== undefined) {
      clearTimeout(this.busyTimer);
      this.busyTimer = undefined;
    }
    this.quickPick.busy = false;
  }

  private async openAtPosition(
    uri: vscode.Uri,
    range: QueryRange | undefined,
  ): Promise<void> {
    const selection = range ? toEditorRange(range) : undefined;
    try {
      if (selection) {
        await vscode.commands.executeCommand('vscode.open', uri, {
          selection,
        });
      } else {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const label = uri.scheme === 'file' ? uri.fsPath : uri.toString(true);
      void vscode.window.showErrorMessage(`Failed to open ${label}: ${detail}`);
    }
  }
}

/** Creates a fresh {@link Picker} (and quick pick widget) for every open. */
export default class SearchSession implements vscode.Disposable {
  private current: Picker | undefined;
  private lastArgs: FastQuickOpenArgs | undefined;
  private disposed = false;

  constructor(
    private readonly search: SearchHost,
    private readonly recentFiles: RecentFiles,
  ) {}

  /**
   * If the picker is already shown and `args` match the ones from the call
   * that opened/refilled it, selects the next row. Otherwise, opens (or
   * refills) with `args.prefill` if given, else the configured default prefill.
   */
  toggle(args?: FastQuickOpenArgs): void {
    if (this.current && sameArgs(args, this.lastArgs)) {
      this.current.selectNext();
      return;
    }
    this.lastArgs = args;
    const prefill =
      args?.prefill !== undefined
        ? resolvePrefill(args as PrefillRequest)
        : resolvePrefill({ ...args, prefill: config.settings().prefill });
    this.openWithPrefill(prefill);
  }

  isVisible(): boolean {
    return this.current !== undefined;
  }

  /** Exposed for tests: the widget backing the picker currently on screen. */
  get quickPick(): vscode.QuickPick<vscode.QuickPickItem> | undefined {
    return this.current?.quickPick;
  }

  onAccept(): void {
    this.current?.onAccept();
  }

  dispose(): void {
    this.disposed = true;
    this.current?.dispose();
    this.current = undefined;
  }

  private openWithPrefill(prefill: string): void {
    if (this.current) {
      this.current.setValueAndFind(prefill);
      return;
    }
    this.openNew(prefill);
  }

  private openNew(prefill: string): void {
    if (this.disposed) {
      return;
    }
    this.current = new Picker(this.search, this.recentFiles, prefill, () => {
      this.current = undefined;
      this.lastArgs = undefined;
    });
  }
}

/** Structural equality for command args (order-independent key comparison). */
function sameArgs(
  a: FastQuickOpenArgs | undefined,
  b: FastQuickOpenArgs | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  return arraysEqual(a.prefill, b.prefill);
}

function arraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a.length !== b.length) {
    return false;
  }
  return a.every((item, index) => item === b[index]);
}
