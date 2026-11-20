import * as path from 'path';
import * as vscode from 'vscode';
import { pathQueryFromSelectionText } from './looksLikeFileQuery.ts';

let extensionDisplayName = '';

/** Cache `displayName` from the extension's package.json. */
export function activate(context: vscode.ExtensionContext): void {
  const name = context.extension.packageJSON.displayName;
  extensionDisplayName = typeof name === 'string' ? name.trim() : '';
}

function prefixMessage(message: string): string {
  return extensionDisplayName ? `${extensionDisplayName}: ${message}` : message;
}

/** `vscode.window.showErrorMessage` with the extension display name prepended. */
export function showErrorMessage(
  message: string,
  ...items: string[]
): Thenable<string | undefined> {
  return vscode.window.showErrorMessage(prefixMessage(message), ...items);
}

/** Absolute filesystem paths of currently open workspace folders. */
export function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders || []).map(
    (folder) => folder.uri.fsPath,
  );
}

export function workspaceFolderPath(name?: string): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (name === undefined) {
    return folders[0]?.uri.fsPath;
  }
  return folders.find((folder) => folder.name === name)?.uri.fsPath;
}

export function workspaceFolderBasename(name?: string): string | undefined {
  const folderPath = workspaceFolderPath(name);
  if (folderPath === undefined) {
    return undefined;
  }
  return path.basename(folderPath);
}

function pathKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Longest workspace folder that is `fsPath` or an ancestor of it. */
export function containingWorkspaceFolder(
  fsPath: string,
): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders || [];
  const key = pathKey(fsPath);
  let best: vscode.WorkspaceFolder | undefined;
  let bestLen = -1;
  for (const folder of folders) {
    const rootKey = pathKey(folder.uri.fsPath);
    if (key === rootKey || key.startsWith(rootKey + path.sep)) {
      if (rootKey.length > bestLen) {
        best = folder;
        bestLen = rootKey.length;
      }
    }
  }
  return best;
}

/** `fsPath` relative to its closest workspace folder, or absolute when outside one. */
export function workspaceRelativePath(fsPath: string): string {
  const folder = containingWorkspaceFolder(fsPath);
  const relative = folder ? path.relative(folder.uri.fsPath, fsPath) : fsPath;
  return relative.replace(/\\/g, '/');
}

/** Absolute path of the active editor's file, or '' if there is none. */
export function activeFileAbsolutePath(): string {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && uri.scheme === 'file' ? uri.fsPath : '';
}

/** Workspace-relative path of the active editor's file, or '' if there is none. */
export function activeFilePath(): string {
  const fsPath = activeFileAbsolutePath();
  return fsPath ? workspaceRelativePath(fsPath) : '';
}

/** Absolute path of the workspace folder containing the active file, or ''. */
export function activeFileWorkspaceFolder(): string {
  const fsPath = activeFileAbsolutePath();
  return fsPath ? (containingWorkspaceFolder(fsPath)?.uri.fsPath ?? '') : '';
}

/** Active editor selection, if it looks like a single-line file/path query. */
export function activeSelectionPathQuery(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return '';
  }
  return pathQueryFromSelectionText(editor.document.getText(editor.selection));
}

/** Raw text of the active editor's selection, or '' if there is none. */
export function activeSelectedText(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return '';
  }
  return editor.document.getText(editor.selection);
}

/** 1-based line number of the active editor's caret, or '' if there is none. */
export function activeLineNumber(): string {
  const editor = vscode.window.activeTextEditor;
  return editor ? String(editor.selection.active.line + 1) : '';
}

/** 1-based column number of the active editor's caret, or '' if there is none. */
export function activeColumnNumber(): string {
  const editor = vscode.window.activeTextEditor;
  return editor ? String(editor.selection.active.character + 1) : '';
}
