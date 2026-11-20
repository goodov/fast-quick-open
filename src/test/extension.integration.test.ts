import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { FastQuickOpenApi } from '../extension.ts';

const EXTENSION_ID = 'goodov.fast-quick-open';
const QUERY = 'integration-probe';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(10);
  }
}

function hasItem(
  quickPick: vscode.QuickPick<vscode.QuickPickItem>,
  fileName: string,
): boolean {
  return quickPick.items.some((item) =>
    item.resourceUri?.fsPath.endsWith(path.sep + fileName),
  );
}

suite('Fast Quick Open extension integration', function () {
  this.timeout(15000);

  let api: FastQuickOpenApi;
  let configuration: vscode.WorkspaceConfiguration;
  let previousDebounce: number | undefined;
  let createdFiles: string[] = [];

  setup(async () => {
    const extension =
      vscode.extensions.getExtension<FastQuickOpenApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not installed`);
    api = (await extension.activate()) as FastQuickOpenApi;

    configuration = vscode.workspace.getConfiguration('fastQuickOpen');
    previousDebounce = configuration.inspect<number>(
      'reloadDebounceSeconds',
    )?.globalValue;
    await configuration.update(
      'reloadDebounceSeconds',
      0,
      vscode.ConfigurationTarget.Global,
    );

    api.quickPick?.hide();
    await waitFor(() => api.quickPick === undefined);
  });

  teardown(async () => {
    api.quickPick?.hide();
    await waitFor(() => api.quickPick === undefined);
    await configuration.update(
      'reloadDebounceSeconds',
      previousDebounce,
      vscode.ConfigurationTarget.Global,
    );
    await Promise.all(createdFiles.map((filePath) => fs.rm(filePath)));
    createdFiles = [];
  });

  test('empty Quick Open does not flush a queued background reload', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'integration workspace is not open');

    await vscode.commands.executeCommand('extension.fastQuickOpen', {
      prefill: [QUERY],
    });
    const activeQuickPick = await waitForQuickPick(api);
    await waitFor(() => hasItem(activeQuickPick, 'integration-probe-seed.txt'));

    const activeFile = path.join(
      workspaceFolder.uri.fsPath,
      `${QUERY}-active.txt`,
    );
    createdFiles.push(activeFile);
    await fs.writeFile(activeFile, 'active\n');
    await waitFor(() => hasItem(activeQuickPick, path.basename(activeFile)));

    activeQuickPick.hide();
    await waitFor(() => api.quickPick === undefined);

    const queuedFile = path.join(
      workspaceFolder.uri.fsPath,
      `${QUERY}-queued.txt`,
    );
    createdFiles.push(queuedFile);
    await fs.writeFile(queuedFile, 'queued\n');
    await delay(300);

    await vscode.commands.executeCommand('extension.fastQuickOpen');
    const recentQuickPick = await waitForQuickPick(api);
    assert.strictEqual(recentQuickPick.value, '');
    assert.strictEqual(
      hasItem(recentQuickPick, path.basename(queuedFile)),
      false,
    );
    await delay(300);
    recentQuickPick.hide();
    await waitFor(() => api.quickPick === undefined);

    await vscode.commands.executeCommand('extension.fastQuickOpen', {
      prefill: [`${QUERY}-queued`],
    });
    const queuedSearchQuickPick = await waitForQuickPick(api);
    await delay(500);
    assert.strictEqual(
      hasItem(queuedSearchQuickPick, path.basename(queuedFile)),
      false,
    );
  });
});

async function waitForQuickPick(
  api: FastQuickOpenApi,
): Promise<vscode.QuickPick<vscode.QuickPickItem>> {
  await waitFor(() => api.quickPick !== undefined);
  return api.quickPick!;
}
