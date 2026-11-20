import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { type FzfHit, type SearchResultMeta } from '../fzfIndex.ts';
import { setLastQuery } from '../helpers/lastQuery.ts';
import { uriKey } from '../helpers/parseResource.ts';
import RecentFiles from '../recentFiles.ts';
import { normalizeSearchQuery } from '../search.ts';
import SearchSession, { type SearchHost } from '../searchSession.ts';
import { parseFastQuickOpenArgs } from '../helpers/fastQuickOpenArgs.ts';
import {
  stubWorkspaceConfig,
  stubWorkspaceFolders,
} from './helpers/stubWorkspaceConfig.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until `predicate()` is true. QuickPick's `onDidChangeValue` fires
 * asynchronously, so a fixed delay after setting `.value` is flaky under
 * load; poll for the actual side effect instead.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor timed out');
    }
    await delay(5);
  }
}

class FakeSearch implements SearchHost {
  searchCalls: string[] = [];
  cancelCount = 0;
  private listeners: Array<(hits: FzfHit[], meta?: SearchResultMeta) => void> =
    [];

  onData(
    callback: (hits: FzfHit[], meta?: SearchResultMeta) => void,
  ): vscode.Disposable {
    this.listeners.push(callback);
    return new vscode.Disposable(() => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    });
  }

  cancelActiveSearch(): void {
    this.cancelCount += 1;
  }

  searchNormalized(text: string): void {
    this.searchCalls.push(text);
  }

  emit(hits: FzfHit[], meta?: SearchResultMeta): void {
    for (const listener of this.listeners) {
      listener(hits, meta);
    }
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

function itemKeys(qp: vscode.QuickPick<vscode.QuickPickItem>): string[] {
  return qp.items
    .map((item) => (item.resourceUri ? uriKey(item.resourceUri) : undefined))
    .filter((key): key is string => key !== undefined);
}

function requirePicker(
  session: SearchSession,
): vscode.QuickPick<vscode.QuickPickItem> {
  const qp = session.quickPick;
  assert.ok(qp, 'expected a picker to be open');
  return qp;
}

suite('SearchSession fresh picker per open', function () {
  this.timeout(8000);

  let restoreConfig: (() => void) | undefined;
  let tmpDir: string | undefined;
  const sessions: SearchSession[] = [];

  setup(() => {
    restoreConfig = stubWorkspaceConfig({
      fastQuickOpen: { prefill: [] },
    });
    setLastQuery('');
  });

  teardown(() => {
    while (sessions.length > 0) {
      sessions.pop()?.dispose();
    }
    restoreConfig?.();
    restoreConfig = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function tempFile(name: string): string {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-session-'));
    }
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, '');
    return filePath;
  }

  function createSession(search: FakeSearch, files: string[]): SearchSession {
    const recentFiles = new RecentFiles();
    for (const filePath of files) {
      recentFiles.addFile(filePath);
    }
    const session = new SearchSession(search, recentFiles);
    sessions.push(session);
    return session;
  }

  test('default (empty) prefill stays empty even with an active selection', async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: 'alpha.ts',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 'alpha.ts'.length);

    // setup() stubs fastQuickOpen.prefill: [].
    const search = new FakeSearch();
    const session = createSession(search, []);

    session.toggle();
    await delay(20);
    assert.strictEqual(requirePicker(session).value, '');
  });

  test('hide then show creates a new picker with parked recents', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const beta = tempFile('beta.ts');
    const session = createSession(search, [alpha, beta]);
    // bumpUri unshifts, so the last file added is first in recents.
    const expected = [
      uriKey(vscode.Uri.file(beta)),
      uriKey(vscode.Uri.file(alpha)),
    ];

    session.toggle();
    await delay(50);
    const firstPicker = requirePicker(session);
    assert.strictEqual(firstPicker.value, '');
    assert.deepStrictEqual(itemKeys(firstPicker), expected);
    assert.strictEqual(search.listenerCount, 1);

    firstPicker.hide();
    await delay(50);
    assert.ok(!session.isVisible());
    assert.strictEqual(session.quickPick, undefined);
    assert.strictEqual(search.listenerCount, 0);
    assert.strictEqual(search.cancelCount, 1);

    session.toggle();
    await delay(50);
    assert.ok(session.isVisible());
    const secondPicker = requirePicker(session);
    assert.notStrictEqual(secondPicker, firstPicker);
    assert.strictEqual(secondPicker.value, '');
    assert.deepStrictEqual(itemKeys(secondPicker), expected);
    assert.strictEqual(search.listenerCount, 1);

    secondPicker.value = 'al';
    await waitFor(() => search.searchCalls.includes('al'));
    assert.ok(search.searchCalls.includes('al'));
  });

  test('empty in-flight hits do not wipe parked recents', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const session = createSession(search, [alpha]);
    const expected = [uriKey(vscode.Uri.file(alpha))];

    session.toggle();
    await delay(50);
    const qp = requirePicker(session);
    qp.value = 'zzz';
    await delay(20);
    assert.deepStrictEqual(itemKeys(qp), expected);

    search.emit([], { indexing: true });
    assert.deepStrictEqual(itemKeys(qp), expected);

    const hit = { path: alpha, root: path.dirname(alpha) };
    search.emit([hit], { indexing: false });
    assert.deepStrictEqual(itemKeys(qp), expected);
  });

  test('shows an existing absolute path when fzf omits it', async () => {
    const search = new FakeSearch();
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-session-'));
    }
    const target = path.join(tmpDir, 'ignored', 'absolute.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    const session = createSession(search, []);

    session.toggle();
    const qp = requirePicker(session);
    qp.value = target;
    await waitFor(() =>
      search.searchCalls.includes(normalizeSearchQuery(target)),
    );
    await waitFor(() => itemKeys(qp).includes(uriKey(vscode.Uri.file(target))));

    assert.deepStrictEqual(itemKeys(qp), [uriKey(vscode.Uri.file(target))]);
  });

  test('shows an existing home-relative path when fzf omits it', async () => {
    const search = new FakeSearch();
    const homeRoot = fs.mkdtempSync(path.join(os.homedir(), 'fqo-home-'));
    const target = path.join(homeRoot, 'ignored', 'home.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '');
    const homeRelative = `~/${path.relative(os.homedir(), target).replace(/\\/g, '/')}`;

    try {
      const session = createSession(search, []);
      session.toggle();
      const qp = requirePicker(session);
      qp.value = homeRelative;
      await waitFor(() =>
        search.searchCalls.includes(normalizeSearchQuery(homeRelative)),
      );
      await waitFor(() =>
        itemKeys(qp).includes(uriKey(vscode.Uri.file(target))),
      );

      assert.deepStrictEqual(itemKeys(qp), [uriKey(vscode.Uri.file(target))]);
    } finally {
      fs.rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  test('resolves a relative path in every workspace folder', async () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-root-a-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-root-b-'));
    const relativePath = path.join('ignored', 'relative.ts');
    const firstFile = path.join(firstRoot, relativePath);
    const secondFile = path.join(secondRoot, relativePath);
    fs.mkdirSync(path.dirname(firstFile), { recursive: true });
    fs.mkdirSync(path.dirname(secondFile), { recursive: true });
    fs.writeFileSync(firstFile, '');
    fs.writeFileSync(secondFile, '');
    const restoreFolders = stubWorkspaceFolders([firstRoot, secondRoot]);

    try {
      const search = new FakeSearch();
      const session = createSession(search, []);
      session.toggle();
      const qp = requirePicker(session);
      qp.value = relativePath;
      await waitFor(() => search.searchCalls.includes(relativePath));
      await waitFor(() => itemKeys(qp).length === 2);

      assert.deepStrictEqual(itemKeys(qp), [
        uriKey(vscode.Uri.file(firstFile)),
        uriKey(vscode.Uri.file(secondFile)),
      ]);
    } finally {
      restoreFolders();
      fs.rmSync(firstRoot, { recursive: true, force: true });
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  test('previous fzf hits stay until the next complete emit', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const session = createSession(search, [alpha]);
    const alphaKey = uriKey(vscode.Uri.file(alpha));

    session.toggle();
    await delay(50);
    const qp = requirePicker(session);
    qp.value = 'al';
    await waitFor(() => search.searchCalls.includes('al'));
    search.emit([{ path: alpha, root: path.dirname(alpha) }], {
      indexing: false,
    });
    assert.deepStrictEqual(itemKeys(qp), [alphaKey]);

    qp.value = 'alz';
    await waitFor(() => search.searchCalls.includes('alz'));
    assert.deepStrictEqual(itemKeys(qp), [alphaKey]);
    search.emit([], { indexing: true });
    assert.deepStrictEqual(itemKeys(qp), [alphaKey]);
    assert.ok(search.searchCalls.includes('alz'));
  });

  test('prefill from selection does not flash recents', async () => {
    restoreConfig?.();
    restoreConfig = stubWorkspaceConfig({
      fastQuickOpen: { prefill: ['${selectedFilePath}'] },
    });

    const doc = await vscode.workspace.openTextDocument({
      content: 'alpha.ts',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 'alpha.ts'.length);

    const search = new FakeSearch();
    const recent = tempFile('recent.ts');
    const session = createSession(search, [recent]);

    session.toggle();
    const qp = requirePicker(session);
    assert.strictEqual(qp.value, 'alpha.ts');
    assert.deepStrictEqual(itemKeys(qp), []);
    assert.ok(search.searchCalls.includes('alpha.ts'));
  });

  test('active file prefill uses the workspace-relative path', async () => {
    const active = tempFile('active.ts');
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(active),
    );
    await vscode.window.showTextDocument(doc);
    const restoreFolders = stubWorkspaceFolders([path.dirname(doc.uri.fsPath)]);

    try {
      const search = new FakeSearch();
      const session = createSession(search, []);

      session.toggle({ prefill: ['${relativeFile}'] });
      assert.strictEqual(requirePicker(session).value, 'active.ts');
      assert.ok(search.searchCalls.includes('active.ts'));
    } finally {
      restoreFolders();
    }
  });

  test('selection prefill ignores the prefill setting', async () => {
    const doc = await vscode.workspace.openTextDocument({
      content: 'alpha.ts',
    });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 'alpha.ts'.length);

    const search = new FakeSearch();
    const session = createSession(search, []);

    // setup() stubs prefill: [].
    session.toggle();
    assert.strictEqual(requirePicker(session).value, '');

    session.toggle({ prefill: ['${selectedFilePath}'] });
    assert.strictEqual(requirePicker(session).value, 'alpha.ts');
    assert.ok(search.searchCalls.includes('alpha.ts'));
  });

  test('the first template that resolves non-empty wins, mixing literal text and variables', async () => {
    const active = tempFile('fallback.ts');
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(active),
    );
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const restoreFolders = stubWorkspaceFolders([path.dirname(doc.uri.fsPath)]);

    try {
      const search = new FakeSearch();
      const session = createSession(search, []);

      session.toggle({
        prefill: ['${selectedFilePath}', 'literal-${relativeFile}-suffix'],
      });
      assert.strictEqual(
        requirePicker(session).value,
        'literal-fallback.ts-suffix',
      );
    } finally {
      restoreFolders();
    }
  });

  test('a template with an empty variable is skipped entirely, not used with blank literal text', async () => {
    const active = tempFile('fallback.ts');
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(active),
    );
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const restoreFolders = stubWorkspaceFolders([path.dirname(doc.uri.fsPath)]);

    try {
      const search = new FakeSearch();
      const session = createSession(search, []);

      // ${selectedFilePath} is empty, so "out ${selectedFilePath}" must not
      // win as "out "; it should fall through to the next template.
      session.toggle({
        prefill: ['out ${selectedFilePath}', 'out ${relativeFile}'],
      });
      assert.strictEqual(requirePicker(session).value, 'out fallback.ts');
    } finally {
      restoreFolders();
    }
  });

  test('ignores requireNonEmptyVariables from command args', async () => {
    const active = tempFile('fallback.ts');
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(active),
    );
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const restoreFolders = stubWorkspaceFolders([path.dirname(doc.uri.fsPath)]);

    try {
      const search = new FakeSearch();
      const session = createSession(search, []);

      session.toggle(
        parseFastQuickOpenArgs({
          prefill: ['out ${selectedFilePath}', 'out ${relativeFile}'],
          requireNonEmptyVariables: false,
        }),
      );
      assert.strictEqual(requirePicker(session).value, 'out fallback.ts');
    } finally {
      restoreFolders();
    }
  });

  test("${lastQuery} prefills with the previous session's typed value", async () => {
    const search = new FakeSearch();
    const session = createSession(search, []);

    session.toggle();
    await delay(50);
    const qp = requirePicker(session);
    qp.value = 'alpha';
    await waitFor(() => search.searchCalls.includes('alpha'));
    qp.hide();
    await delay(50);

    session.toggle({ prefill: ['${lastQuery}'] });
    assert.strictEqual(requirePicker(session).value, 'alpha');
  });

  test('does not search again when the normalized query is unchanged', async () => {
    const search = new FakeSearch();
    const session = createSession(search, []);

    session.toggle({ prefill: ['alpha'] });
    await waitFor(() => search.searchCalls.includes('alpha'));
    const callsAfterInitialSearch = search.searchCalls.length;

    requirePicker(session).value = 'ALPHA';
    await delay(50);

    assert.strictEqual(search.searchCalls.length, callsAfterInitialSearch);
  });

  test('toggle while visible selects the next row instead of reopening', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const beta = tempFile('beta.ts');
    const session = createSession(search, [alpha, beta]);

    session.toggle();
    await delay(50);
    const qp = requirePicker(session);

    session.toggle();
    await delay(20);
    assert.strictEqual(session.quickPick, qp);
  });

  test('toggle with a prefill override refills instead of cycling, even when visible', async () => {
    const active = tempFile('active.ts');
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(active),
    );
    await vscode.window.showTextDocument(doc);
    const restoreFolders = stubWorkspaceFolders([path.dirname(doc.uri.fsPath)]);

    try {
      const search = new FakeSearch();
      const session = createSession(search, []);

      session.toggle();
      await delay(50);
      const qp = requirePicker(session);
      assert.strictEqual(qp.value, '');

      session.toggle({ prefill: ['${relativeFile}'] });
      await delay(20);
      assert.strictEqual(session.quickPick, qp);
      assert.strictEqual(qp.value, 'active.ts');
    } finally {
      restoreFolders();
    }
  });

  test('toggle with the same prefill args as last time cycles instead of refilling', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const beta = tempFile('beta.ts');
    const session = createSession(search, [alpha, beta]);
    const args = { prefill: ['literal-prefill'] };

    session.toggle(args);
    await waitFor(() => search.searchCalls.includes('literal-prefill'));
    const qp = requirePicker(session);
    assert.strictEqual(qp.value, 'literal-prefill');
    const callsAfterOpen = search.searchCalls.length;

    session.toggle(args);
    await delay(20);
    assert.strictEqual(session.quickPick, qp);
    assert.strictEqual(qp.value, 'literal-prefill');
    assert.strictEqual(search.searchCalls.length, callsAfterOpen);
  });

  test('parseFastQuickOpenArgs reads a valid prefill template list and rejects the rest', () => {
    assert.deepStrictEqual(
      parseFastQuickOpenArgs({ prefill: ['${relativeFile}'] }),
      { prefill: ['${relativeFile}'] },
    );
    assert.deepStrictEqual(parseFastQuickOpenArgs({ prefill: [] }), {
      prefill: [],
    });
    assert.deepStrictEqual(parseFastQuickOpenArgs(undefined), {});
    assert.deepStrictEqual(parseFastQuickOpenArgs(null), {});
    assert.deepStrictEqual(parseFastQuickOpenArgs('${relativeFile}'), {});
    assert.deepStrictEqual(parseFastQuickOpenArgs({}), {});
    assert.deepStrictEqual(parseFastQuickOpenArgs({ prefill: [1, 2] }), {});
  });

  test('parseFastQuickOpenArgs ignores requireNonEmptyVariables', () => {
    assert.deepStrictEqual(
      parseFastQuickOpenArgs({ requireNonEmptyVariables: false }),
      {},
    );
    assert.deepStrictEqual(
      parseFastQuickOpenArgs({
        prefill: ['${relativeFile}'],
        requireNonEmptyVariables: false,
      }),
      { prefill: ['${relativeFile}'] },
    );
  });

  test('accept opens the selected uri with vscode.open', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const session = createSession(search, [alpha]);
    const alphaUri = vscode.Uri.file(alpha);

    session.toggle();
    await delay(50);
    const qp = requirePicker(session);
    const selected = qp.items.find(
      (item) =>
        item.resourceUri && uriKey(item.resourceUri) === uriKey(alphaUri),
    );
    assert.ok(selected);
    qp.activeItems = [selected];

    const { calls, restore } = stubExecuteCommand();
    try {
      session.onAccept();
      await delay(20);
    } finally {
      restore();
    }

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]![0], 'vscode.open');
    assert.strictEqual(uriKey(calls[0]![1] as vscode.Uri), uriKey(alphaUri));
    assert.strictEqual(calls[0]!.length, 2);
  });

  test('accept with :line passes a 0-based selection to vscode.open', async () => {
    const search = new FakeSearch();
    const alpha = tempFile('alpha.ts');
    const session = createSession(search, [alpha]);
    const alphaUri = vscode.Uri.file(alpha);

    session.toggle();
    await delay(50);
    const qp = requirePicker(session);
    qp.value = 'alpha.ts:12';
    await waitFor(() => search.searchCalls.includes('alpha.ts'));
    const selected = qp.items.find(
      (item) =>
        item.resourceUri && uriKey(item.resourceUri) === uriKey(alphaUri),
    );
    assert.ok(selected);
    qp.activeItems = [selected];

    const { calls, restore } = stubExecuteCommand();
    try {
      session.onAccept();
      await delay(20);
    } finally {
      restore();
    }

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]![0], 'vscode.open');
    assert.strictEqual(uriKey(calls[0]![1] as vscode.Uri), uriKey(alphaUri));
    const options = calls[0]![2] as { selection: vscode.Range };
    assert.strictEqual(options.selection.start.line, 11);
    assert.strictEqual(options.selection.start.character, 0);
    assert.strictEqual(options.selection.end.line, 11);
    assert.strictEqual(options.selection.end.character, 0);
  });
});

function stubExecuteCommand(): {
  calls: unknown[][];
  restore: () => void;
} {
  const original = vscode.commands.executeCommand;
  const calls: unknown[][] = [];
  vscode.commands.executeCommand = ((command: string, ...args: unknown[]) => {
    calls.push([command, ...args]);
    return Promise.resolve(undefined);
  }) as typeof vscode.commands.executeCommand;
  return {
    calls,
    restore() {
      vscode.commands.executeCommand = original;
    },
  };
}
