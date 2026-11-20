import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { looksLikeUriString } from './parseResource.ts';

async function isFile(filePath: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return (stat.type & vscode.FileType.Directory) === 0;
  } catch {
    return false;
  }
}

function expandHome(value: string): string {
  const home = os.homedir();
  if (value === '~') {
    return home;
  }
  if (home && value.startsWith(`~${path.sep}`)) {
    return path.join(home, value.slice(2));
  }
  return value;
}

/** Existing files addressed exactly by an absolute or workspace-relative query. */
export async function resolvePathCandidates(query: string): Promise<string[]> {
  const value = query.trim();
  if (!value || looksLikeUriString(value)) {
    return [];
  }

  const normalized = expandHome(
    process.platform === 'win32' ? value.replace(/\//g, path.sep) : value,
  );
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates = path.isAbsolute(normalized)
    ? [path.normalize(normalized)]
    : folders.map((folder) => path.resolve(folder.uri.fsPath, normalized));
  const existing = await Promise.all(
    candidates.map(async (filePath) => ({
      filePath,
      exists: await isFile(filePath),
    })),
  );

  const seen = new Set<string>();
  return existing
    .filter(({ exists }) => exists)
    .map(({ filePath }) => filePath)
    .filter((filePath) => {
      const key =
        process.platform === 'win32' ? filePath.toLowerCase() : filePath;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}
