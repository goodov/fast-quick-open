import * as vscode from 'vscode';
import { createConfig } from './config.ts';
import SearchSession from './searchSession.ts';
import Log from './log.ts';
import { parseFastQuickOpenArgs } from './helpers/fastQuickOpenArgs.ts';
import RecentFiles from './recentFiles.ts';
import Search from './search.ts';
import { activate as activateVscodeUtils } from './helpers/vscodeUtils.ts';

export interface FastQuickOpenApi {
  readonly quickPick: vscode.QuickPick<vscode.QuickPickItem> | undefined;
}

export function activate(context: vscode.ExtensionContext): FastQuickOpenApi {
  Log.activate(context);
  activateVscodeUtils(context);
  Log.info?.('extension activated');

  createConfig();

  const recentFiles = new RecentFiles(context.workspaceState);
  recentFiles.register(context);

  const search = new Search(context.extensionUri.fsPath);
  const session = new SearchSession(search, recentFiles);
  context.subscriptions.push(search, session);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'extension.fastQuickOpen',
      (args?: unknown) => {
        session.toggle(parseFastQuickOpenArgs(args));
      },
    ),
  );

  return {
    get quickPick() {
      return session.quickPick;
    },
  };
}

export function deactivate() {}
