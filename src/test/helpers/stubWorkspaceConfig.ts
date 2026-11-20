import * as path from 'path';
import * as vscode from 'vscode';
import { createConfig } from '../../config.ts';

export interface StubbedSections {
  fastQuickOpen?: Record<string, unknown>;
  files?: Record<string, unknown>;
  search?: Record<string, unknown>;
}

function fakeConfiguration(
  values: Record<string, unknown>,
): vscode.WorkspaceConfiguration {
  return {
    get<T>(key: string, defaultValue?: T): T {
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        return values[key] as T;
      }
      return defaultValue as T;
    },
    has(key: string): boolean {
      return Object.prototype.hasOwnProperty.call(values, key);
    },
    inspect<T>(key: string) {
      return { key, defaultValue: undefined as T | undefined };
    },
    update(): Thenable<void> {
      return Promise.resolve();
    },
  } as vscode.WorkspaceConfiguration;
}

export type WorkspaceFolderInput = string | { fsPath: string; name?: string };

function resolveFolderStub(folder: WorkspaceFolderInput): {
  fsPath: string;
  name: string;
} {
  if (typeof folder === 'string') {
    return { fsPath: folder, name: path.basename(folder) };
  }
  return {
    fsPath: folder.fsPath,
    name: folder.name ?? path.basename(folder.fsPath),
  };
}

/** Replace `workspace.workspaceFolders` for the duration of a test. */
export function stubWorkspaceFolders(
  folderPaths: WorkspaceFolderInput[],
): () => void {
  const folders = folderPaths.map(resolveFolderStub);
  const original = Object.getOwnPropertyDescriptor(
    vscode.workspace,
    'workspaceFolders',
  );
  const originalAsRelativePath = vscode.workspace.asRelativePath;
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    configurable: true,
    get: () =>
      folders.map((folder, index) => ({
        uri: vscode.Uri.file(folder.fsPath),
        name: folder.name,
        index,
      })),
  });
  // asRelativePath does not honor a stubbed workspaceFolders getter alone;
  // stub it so anchored excludes resolve against the test folders.
  vscode.workspace.asRelativePath = ((
    pathOrUri: string | vscode.Uri,
    _includeWorkspaceFolder?: boolean,
  ): string => {
    const fsPath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    const normalized =
      process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
    for (const folder of folders) {
      const folderNorm =
        process.platform === 'win32'
          ? folder.fsPath.toLowerCase()
          : folder.fsPath;
      if (normalized === folderNorm) {
        return folder.name;
      }
      if (
        normalized.startsWith(folderNorm + path.sep)
        || normalized.startsWith(folderNorm + '/')
      ) {
        return path.relative(folder.fsPath, fsPath).replace(/\\/g, '/');
      }
    }
    return fsPath.replace(/\\/g, '/');
  }) as typeof vscode.workspace.asRelativePath;
  return () => {
    if (original) {
      Object.defineProperty(vscode.workspace, 'workspaceFolders', original);
    }
    vscode.workspace.asRelativePath = originalAsRelativePath;
  };
}

/**
 * Replace no-section `workspace.getConfiguration().get(key)` lookups
 * (as used by `${config:section.key}` expansion).
 */
export function stubConfigurationValues(
  values: Record<string, unknown>,
): () => void {
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = ((
    section?: string,
    scope?: vscode.ConfigurationScope | null,
  ) => {
    if (section === undefined || section === '') {
      return fakeConfiguration(values);
    }
    return original.call(vscode.workspace, section, scope);
  }) as typeof original;
  return () => {
    vscode.workspace.getConfiguration = original;
  };
}

/** Replace `workspace.getConfiguration` for the duration of a test. */
export function stubWorkspaceConfig(sections: StubbedSections): () => void {
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = ((
    section?: string,
    scope?: vscode.ConfigurationScope | null,
  ) => {
    if (section === undefined || section === '') {
      return fakeConfiguration({
        fastQuickOpen: sections.fastQuickOpen ?? {},
        files: sections.files ?? {},
        search: sections.search ?? {},
      });
    }
    if (section === 'fastQuickOpen') {
      return fakeConfiguration(sections.fastQuickOpen ?? {});
    }
    if (section === 'files') {
      return fakeConfiguration(sections.files ?? {});
    }
    if (section === 'search') {
      return fakeConfiguration(sections.search ?? {});
    }
    return original.call(vscode.workspace, section, scope);
  }) as typeof original;
  createConfig();
  return () => {
    vscode.workspace.getConfiguration = original;
    createConfig();
  };
}
