import * as os from 'os';
import * as vscode from 'vscode';
import * as path from 'path';
import { parseResource } from './parseResource.ts';
import { containingWorkspaceFolder } from './vscodeUtils.ts';

export const REMOVE_FROM_HISTORY_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('close'),
  tooltip: 'Remove from history',
};

const ROOT_LABEL_SEPARATOR = ' \u2022 ';

export interface PickerDescriptionContext {
  /** fd-group root from `N/{}`. Omitted for recents that are not also fzf hits. */
  root?: string;
}

function formatRelativeDir(relativeDir: string): string {
  const normalized = relativeDir.replace(/\\/g, '/');
  if (!normalized || normalized === '.') {
    return '';
  }
  return normalized;
}

/** Absolute dir for display: `~` when the path is under home (non-Windows). */
function formatAbsoluteDir(dir: string): string {
  if (process.platform !== 'win32') {
    const home = os.homedir();
    if (home) {
      const dirNorm = path.normalize(dir);
      const homeNorm = path.normalize(home);
      if (dirNorm.startsWith(homeNorm + path.sep)) {
        return `~${dirNorm.slice(homeNorm.length).replace(/\\/g, '/')}`;
      }
    }
  }
  return capitalizeWindowsDriveLetter(formatRelativeDir(dir));
}

/** `c:/Users/...` → `C:/Users/...` so Windows abs paths have a stable drive letter. */
function capitalizeWindowsDriveLetter(displayPath: string): string {
  return displayPath.replace(
    /^([a-z]):/,
    (_match, letter: string) => `${letter.toUpperCase()}:`,
  );
}

function parentDir(filePath: string): string {
  return path.parse(filePath).dir;
}

function workspaceRelativeDescription(filePath: string): string {
  const folder = containingWorkspaceFolder(filePath);
  const dir = parentDir(filePath);
  if (!folder) {
    return formatAbsoluteDir(dir);
  }

  const relativeDir = formatRelativeDir(path.relative(folder.uri.fsPath, dir));
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 1) {
    return relativeDir
      ? `${folder.name}${ROOT_LABEL_SEPARATOR}${relativeDir}`
      : folder.name;
  }
  return relativeDir;
}

/**
 * Directory line shown under a QuickPick file name.
 * In-workspace files are relative to the containing workspace folder.
 * Multi-folder windows prefix `folder.name •`. Out-of-workspace dirs under
 * the user home directory use `~` on non-Windows (not for home itself).
 * Recents omit `root`.
 */
export function fileDescription(
  filePath: string,
  context?: PickerDescriptionContext,
): string {
  if (context?.root && !containingWorkspaceFolder(context.root)) {
    return formatAbsoluteDir(parentDir(filePath));
  }
  return workspaceRelativeDescription(filePath);
}

/**
 * QuickPick re-sorts items by `label` and there is no supported API to turn
 * that off. fzf already ranks results; alphabetical reordering breaks that.
 * Zero-width spaces between characters change the sort key without changing
 * what the user sees.
 */
export function labelForDisplay(text: string): string {
  return [...text].join('\u200B');
}

function filesystemPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file' || uri.scheme === 'vscode-userdata') {
    return uri.fsPath;
  }
  return undefined;
}

export default function resourceToQuickPickItem(
  resource: string,
  isRecent: boolean,
  context?: PickerDescriptionContext,
): vscode.QuickPickItem {
  const resourceUri = parseResource(resource);
  const filePath = filesystemPath(resourceUri);

  if (filePath !== undefined) {
    return {
      label: labelForDisplay(path.basename(filePath)),
      resourceUri,
      iconPath: vscode.ThemeIcon.File,
      description: fileDescription(filePath, context),
      buttons: isRecent ? [REMOVE_FROM_HISTORY_BUTTON] : undefined,
      alwaysShow: true,
    };
  }

  const normalizedPath = resourceUri.path.replace(/^\//, '');
  const basename = path.basename(normalizedPath) || normalizedPath;
  const parent = path.dirname(normalizedPath);
  const parentLabel = parent === '.' ? '' : parent;

  return {
    label: labelForDisplay(basename),
    resourceUri,
    iconPath: vscode.ThemeIcon.File,
    description: parentLabel,
    buttons: isRecent ? [REMOVE_FROM_HISTORY_BUTTON] : undefined,
    alwaysShow: true,
  };
}
