import * as path from 'path';
import * as vscode from 'vscode';
import { parseResource, uriKey } from './helpers/parseResource.ts';

const MAX_RECENTS = 50;
const STORAGE_KEY = 'recents';

const TRACKABLE_SCHEMES = new Set(['file', 'vscode-userdata']);

interface RecentEntry {
  key: string;
  uri: string;
}

interface StoredRecentEntry {
  key?: string;
  uri?: string;
  filePath?: string;
}

function containingWorkspaceRoot(filePath: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders || [];
  const normalizedFile =
    process.platform === 'win32' ? filePath.toLowerCase() : filePath;
  const match = folders.find((folder) => {
    const root = folder.uri.fsPath;
    const normalizedRoot =
      process.platform === 'win32' ? root.toLowerCase() : root;
    return (
      normalizedFile === normalizedRoot
      || normalizedFile.startsWith(normalizedRoot + path.sep)
    );
  });
  return match?.uri.fsPath;
}

function formatRelativeDir(relativeDir: string): string {
  const normalized = relativeDir.replace(/\\/g, '/');
  if (!normalized || normalized === '.') {
    return '';
  }
  return normalized;
}

export function displayKey(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    const filePath = uri.fsPath;
    const root = containingWorkspaceRoot(filePath);
    const dir = path.parse(filePath).dir;
    const relativeDir = formatRelativeDir(
      root ? path.relative(root, dir) : dir,
    );
    const base = path.basename(filePath);
    return relativeDir ? `${relativeDir}/${base}` : base;
  }

  const normalizedPath = uri.path.replace(/^\//, '');
  return normalizedPath || uri.toString();
}

function parseStoredResource(value: string): vscode.Uri {
  return parseResource(value);
}

async function uriExistsAsFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) === 0;
  } catch {
    return false;
  }
}

function isTrackableUri(uri: vscode.Uri): boolean {
  if (!TRACKABLE_SCHEMES.has(uri.scheme)) {
    return false;
  }
  if (uri.scheme === 'file') {
    return !uri.path.endsWith('/');
  }
  return true;
}

function uriFromTab(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  return undefined;
}

export default class RecentFiles {
  private recentFiles: RecentEntry[] = [];
  private workspaceState: vscode.Memento | undefined;

  constructor(workspaceState?: vscode.Memento) {
    this.workspaceState = workspaceState;
    this.loadFromStorage();
  }

  register(context: vscode.ExtensionContext): void {
    this.workspaceState = this.workspaceState ?? context.workspaceState;

    const bumpUri = (uri: vscode.Uri | undefined) => {
      if (!uri || !isTrackableUri(uri)) {
        return;
      }
      this.bumpUri(uri);
    };

    const ensureUri = (uri: vscode.Uri | undefined) => {
      if (!uri || !isTrackableUri(uri)) {
        return;
      }
      this.ensureUri(uri);
    };

    const bumpActiveEditor = (editor: vscode.TextEditor | undefined) => {
      if (!editor || editor.document.isUntitled) {
        return;
      }
      bumpUri(editor.document.uri);
    };

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(bumpActiveEditor),
    );
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.isUntitled) {
          return;
        }
        ensureUri(document.uri);
      }),
    );
    context.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs((event) => {
        for (const tab of event.opened) {
          ensureUri(uriFromTab(tab));
        }
      }),
    );

    bumpActiveEditor(vscode.window.activeTextEditor);
    this.ensureOpenTabsTracked();
  }

  /** Serialized URIs in recency order (most recent first). */
  uris(): string[] {
    return this.recentFiles.map((r) => r.uri);
  }

  /**
   * Drop recents whose files are gone from disk. Call only when Quick Open is
   * shown — a delete watcher would wipe entries that git rebase removes and
   * immediately restores. Resolves to true when something was removed.
   */
  async removeMissingFromDisk(): Promise<boolean> {
    const checks = await Promise.all(
      this.recentFiles.map(async (entry) => {
        const uri = parseStoredResource(entry.uri);
        return { key: uriKey(uri), exists: await uriExistsAsFile(uri) };
      }),
    );

    const missing = new Set(
      checks.filter((item) => !item.exists).map((item) => item.key),
    );
    if (missing.size === 0) {
      return false;
    }

    const before = this.recentFiles.length;
    this.recentFiles = this.recentFiles.filter(
      (entry) => !missing.has(uriKey(parseStoredResource(entry.uri))),
    );
    if (this.recentFiles.length === before) {
      return false;
    }
    this.persist();
    return true;
  }

  /** Add open tabs that are not yet in recents, without changing access order. */
  ensureOpenTabsTracked(): void {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = uriFromTab(tab);
        if (uri) {
          this.ensureUri(uri);
        }
      }
    }
  }

  /** Move to front — only the focused editor should call this (quick-open recency). */
  bumpUri(uri: vscode.Uri) {
    if (!isTrackableUri(uri)) {
      return;
    }

    const uriString = uri.toString();
    const key = uriKey(uri);
    const existing = this.recentFiles.find(
      (entry) => uriKey(parseStoredResource(entry.uri)) === key,
    );

    if (existing) {
      if (this.recentFiles[0] === existing) {
        return;
      }
      this.recentFiles = this.recentFiles.filter((entry) => entry !== existing);
      this.recentFiles.unshift({ ...existing, uri: uriString });
    } else {
      this.recentFiles.unshift({
        key: displayKey(uri),
        uri: uriString,
      });
    }

    this.recentFiles = this.recentFiles.slice(0, MAX_RECENTS);
    this.persist();
  }

  /** Append if missing; never changes position of existing entries. */
  ensureUri(uri: vscode.Uri) {
    if (!isTrackableUri(uri)) {
      return;
    }

    const key = uriKey(uri);
    const exists = this.recentFiles.some(
      (entry) => uriKey(parseStoredResource(entry.uri)) === key,
    );
    if (exists) {
      return;
    }

    this.recentFiles.push({
      key: displayKey(uri),
      uri: uri.toString(),
    });
    this.recentFiles = this.recentFiles.slice(0, MAX_RECENTS);
    this.persist();
  }

  addUri(uri: vscode.Uri) {
    this.bumpUri(uri);
  }

  addFile(filePath: string) {
    this.bumpUri(vscode.Uri.file(filePath));
  }

  includesResource(resource: string): boolean {
    const key = uriKey(parseStoredResource(resource));
    return this.recentFiles.some(
      (item) => uriKey(parseStoredResource(item.uri)) === key,
    );
  }

  removeUri(uri: vscode.Uri): boolean {
    const key = uriKey(uri);
    const before = this.recentFiles.length;
    this.recentFiles = this.recentFiles.filter(
      (entry) => uriKey(parseStoredResource(entry.uri)) !== key,
    );
    if (this.recentFiles.length === before) {
      return false;
    }
    this.persist();
    return true;
  }

  removeResource(resource: string): boolean {
    return this.removeUri(parseResource(resource));
  }

  private loadFromStorage(): void {
    if (!this.workspaceState) {
      return;
    }

    const stored = this.workspaceState.get<StoredRecentEntry[]>(
      STORAGE_KEY,
      [],
    );
    this.recentFiles = stored
      .map((entry) => {
        const raw = entry?.uri ?? entry?.filePath;
        if (!raw) {
          return undefined;
        }
        const uri = parseStoredResource(raw);
        if (!isTrackableUri(uri)) {
          return undefined;
        }
        return {
          key: entry.key || displayKey(uri),
          uri: uri.toString(),
        };
      })
      .filter((entry): entry is RecentEntry => entry !== undefined)
      .slice(0, MAX_RECENTS);
  }

  private persist(): void {
    if (!this.workspaceState) {
      return;
    }
    void this.workspaceState.update(STORAGE_KEY, this.recentFiles);
  }
}
