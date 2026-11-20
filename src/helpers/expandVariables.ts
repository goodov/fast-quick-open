import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLastQuery } from './lastQuery.ts';
import * as vscodeUtils from './vscodeUtils';

const INNERMOST_VARIABLE_RE = /\$\{([^{}]+)\}/g;
const WORKSPACE_FOLDER_LIST_RE = /\$\{workspaceFolderList\}/g;
const MAX_EXPAND_PASSES = 8;

export interface VariableExpansion<T> {
  value: T;
  configDependencies: Set<string>;
}

function resolveUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return (
      process.env.USER ?? process.env.USERNAME ?? process.env.LOGNAME ?? ''
    );
  }
}

/** This extension always represents paths with forward slashes, even on Windows. */
function toForwardSlash(value: string): string {
  return value.replace(/\\/g, '/');
}

/** VS Code's `dirname` variables return '' (not '.') for a file at the root. */
function dirnameOrEmpty(relativePath: string): string {
  const dir = path.dirname(relativePath);
  return dir === '.' ? '' : dir;
}

/** `undefined` means a workspace-folder token could not be resolved. */
function expandToken(
  name: string,
  token: string,
  configDependencies: Set<string>,
): string | undefined {
  if (name === 'workspaceFolderList') {
    // 1-to-N: cannot expand into a single string argument.
    return undefined;
  }
  if (name === 'workspaceFolderBasename') {
    return vscodeUtils.workspaceFolderBasename();
  }
  if (name.startsWith('workspaceFolderBasename:')) {
    return vscodeUtils.workspaceFolderBasename(
      name.slice('workspaceFolderBasename:'.length),
    );
  }
  if (name === 'workspaceFolder') {
    const folder = vscodeUtils.workspaceFolderPath();
    return folder === undefined ? undefined : toForwardSlash(folder);
  }
  if (name.startsWith('workspaceFolder:')) {
    const folder = vscodeUtils.workspaceFolderPath(
      name.slice('workspaceFolder:'.length),
    );
    return folder === undefined ? undefined : toForwardSlash(folder);
  }
  if (name === 'relativeFile') {
    return vscodeUtils.activeFilePath();
  }
  if (name === 'relativeFileDirname') {
    return dirnameOrEmpty(vscodeUtils.activeFilePath());
  }
  if (name === 'file') {
    return toForwardSlash(vscodeUtils.activeFileAbsolutePath());
  }
  if (name === 'fileWorkspaceFolder') {
    return toForwardSlash(vscodeUtils.activeFileWorkspaceFolder());
  }
  if (name === 'fileBasename') {
    const file = vscodeUtils.activeFileAbsolutePath();
    return file ? path.basename(file) : '';
  }
  if (name === 'fileBasenameNoExtension') {
    const file = vscodeUtils.activeFileAbsolutePath();
    return file ? path.basename(file, path.extname(file)) : '';
  }
  if (name === 'fileExtname') {
    const file = vscodeUtils.activeFileAbsolutePath();
    return file ? path.extname(file) : '';
  }
  if (name === 'fileDirname') {
    const file = vscodeUtils.activeFileAbsolutePath();
    return file ? toForwardSlash(path.dirname(file)) : '';
  }
  if (name === 'fileDirnameBasename') {
    const file = vscodeUtils.activeFileAbsolutePath();
    return file ? path.basename(path.dirname(file)) : '';
  }
  if (name === 'lineNumber') {
    return vscodeUtils.activeLineNumber();
  }
  if (name === 'columnNumber') {
    return vscodeUtils.activeColumnNumber();
  }
  if (name === 'selectedText') {
    return vscodeUtils.activeSelectedText();
  }
  if (name === 'selectedFilePath') {
    return vscodeUtils.activeSelectionPathQuery();
  }
  if (name === 'lastQuery') {
    return getLastQuery();
  }
  if (name === 'cwd') {
    return toForwardSlash(process.cwd());
  }
  if (name === 'execPath') {
    return toForwardSlash(process.execPath);
  }
  if (name === 'userHome') {
    return toForwardSlash(os.homedir());
  }
  if (name === 'tmpdir') {
    return toForwardSlash(os.tmpdir());
  }
  if (name === 'pathSeparator' || name === '/') {
    return '/';
  }
  if (name === 'platform') {
    return process.platform;
  }
  if (name === 'arch') {
    return process.arch;
  }
  if (name === 'hostname') {
    return os.hostname();
  }
  if (name === 'username') {
    return resolveUsername();
  }
  if (name.startsWith('env:')) {
    return process.env[name.slice(4)] ?? '';
  }
  if (name.startsWith('config:')) {
    const key = name.slice(7);
    configDependencies.add(key);
    const value = vscode.workspace.getConfiguration().get(key);
    return value === undefined ? '' : String(value);
  }
  return token;
}

/**
 * Expand path variables in a settings string.
 * Returns `undefined` when `${workspaceFolder}` / `${workspaceFolder:Name}`
 * (or the Basename forms) cannot be resolved, or when `${workspaceFolderList}`
 * appears (1-to-N; use {@link expandVariableList}). Unknown `${...}`
 * tokens are left unchanged. Innermost tokens expand first, so
 * `${config:myvars.var_${platform}}` resolves the key against this machine.
 *
 * With `requireNonEmptyVariables: true`, also returns `undefined` when any
 * `${...}` token expands to an empty string, even if literal text around it
 * would otherwise make the result non-empty (e.g. `"out ${selectedFilePath}"`
 * becomes unresolved, not `"out "`, when the selection is empty).
 */
function expandVariablesInto(
  value: string,
  configDependencies: Set<string>,
  requireNonEmptyVariables = false,
): string | undefined {
  let unresolved = false;
  let current = value;
  for (let pass = 0; pass < MAX_EXPAND_PASSES; pass++) {
    let replaced = false;
    const next = current.replace(
      INNERMOST_VARIABLE_RE,
      (token, name: string) => {
        if (unresolved) {
          return '';
        }
        const expanded = expandToken(name, token, configDependencies);
        if (
          expanded === undefined
          || (requireNonEmptyVariables && expanded === '')
        ) {
          unresolved = true;
          return '';
        }
        if (expanded !== token) {
          replaced = true;
        }
        return expanded;
      },
    );
    if (unresolved) {
      return undefined;
    }
    if (!replaced) {
      return next;
    }
    current = next;
  }
  return current;
}

export interface ExpandVariablesOptions {
  /**
   * Void the whole result if any `${...}` variable resolves to an empty
   * string, even when surrounding literal text would otherwise make the
   * result non-empty.
   */
  requireNonEmptyVariables?: boolean;
}

export function expandVariablesWithDependencies(
  value: string,
  options?: ExpandVariablesOptions,
): VariableExpansion<string | undefined> {
  const configDependencies = new Set<string>();
  return {
    value: expandVariablesInto(
      value,
      configDependencies,
      options?.requireNonEmptyVariables,
    ),
    configDependencies,
  };
}

export function expandVariables(
  value: string,
  options?: ExpandVariablesOptions,
): string | undefined {
  return expandVariablesWithDependencies(value, options).value;
}

/**
 * Expand each string; omit items with unresolved workspace folders or empty
 * results. `${workspaceFolderList}` expands 1-to-N (one path per open folder).
 */
export function expandVariableListWithDependencies(
  values: string[],
): VariableExpansion<string[]> {
  const result: string[] = [];
  const configDependencies = new Set<string>();
  for (const value of values) {
    if (value.includes('${workspaceFolderList}')) {
      const folders = vscodeUtils.workspaceFolderPaths();
      if (folders.length === 0) {
        continue;
      }
      for (const folder of folders) {
        const withRoot = value.replace(
          WORKSPACE_FOLDER_LIST_RE,
          toForwardSlash(folder),
        );
        const expanded = expandVariablesInto(withRoot, configDependencies);
        if (expanded === undefined) {
          continue;
        }
        const trimmed = expanded.trim();
        if (trimmed) {
          result.push(trimmed);
        }
      }
      continue;
    }

    const expanded = expandVariablesInto(value, configDependencies);
    if (expanded === undefined) {
      continue;
    }
    const trimmed = expanded.trim();
    if (trimmed) {
      result.push(trimmed);
    }
  }
  return { value: result, configDependencies };
}

export function expandVariableList(values: string[]): string[] {
  return expandVariableListWithDependencies(values).value;
}
