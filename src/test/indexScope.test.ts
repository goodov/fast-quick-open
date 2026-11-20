import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { config } from '../config.ts';
import {
  getIndexFdInvocations,
  holePunchExcludePatterns,
  isForceIndexedPath,
} from '../excludes.ts';
import FdCommandBuilder, { type FdCommandSpec } from '../fdCommand.ts';
import {
  expandVariableList,
  expandVariables,
  expandVariablesWithDependencies,
} from '../helpers/expandVariables.ts';
import {
  stubConfigurationValues,
  stubWorkspaceConfig,
  stubWorkspaceFolders,
} from './helpers/stubWorkspaceConfig.ts';

const extensionPath = path.join(__dirname, '..', '..');

function normalize(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hasExclude(patterns: string[], glob: string): boolean {
  return patterns.includes(glob);
}

function argvHas(specs: FdCommandSpec[], value: string): boolean {
  return specs.some((spec) => spec.command.some((arg) => arg.includes(value)));
}

function formatArg(spec: FdCommandSpec): string {
  const index = spec.command.indexOf('--format');
  assert.ok(index >= 0, 'missing --format');
  return spec.command[index + 1]!;
}

function composeRestores(...restores: Array<() => void>): () => void {
  return () => {
    for (const restore of restores.reverse()) {
      restore();
    }
  };
}

suite('getIndexFdInvocations', () => {
  let root: string | undefined;
  let restoreFolders: (() => void) | undefined;

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-idx-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    // Anchored excludes (`/src`) need a workspace folder so asRelativePath works.
    restoreFolders = stubWorkspaceFolders([root]);
  });

  suiteTeardown(() => {
    restoreFolders?.();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('implicit roots are search paths for the default index', () => {
    const invocations = getIndexFdInvocations([root!], [], []);
    assert.deepStrictEqual(invocations, [{ base: root!, searchPaths: ['.'] }]);
  });

  test('empty roots ignore includes', () => {
    const out = path.join(root!, 'out');
    const invocations = getIndexFdInvocations([], [out], []);
    assert.deepStrictEqual(invocations, []);
  });

  test('an include under an implicit root is omitted unless excluded', () => {
    const src = path.join(root!, 'src');
    const included = getIndexFdInvocations([root!], [src], []);
    assert.deepStrictEqual(included, [{ base: root!, searchPaths: ['.'] }]);

    const withExclude = getIndexFdInvocations([root!], [src], ['/src']);
    assert.ok(withExclude[0]!.searchPaths.includes('./src'));
  });

  test('nested configured roots are both kept as search paths', () => {
    const src = path.join(root!, 'src');
    const invocations = getIndexFdInvocations([root!, src], [], []);
    assert.deepStrictEqual(
      invocations.map((invocation) => normalize(invocation.base)).sort(),
      [normalize(root!), normalize(src)].sort(),
    );
  });

  test('includes outside roots do not create invocations', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-plan-'));
    const a = path.join(temp, 'a');
    const b = path.join(temp, 'b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const invocations = getIndexFdInvocations([], [a, b], []);
    fs.rmSync(temp, { recursive: true, force: true });
    assert.deepStrictEqual(invocations, []);
  });

  test('relative includes resolve beneath each root', () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-inc-root-'));
    fs.mkdirSync(path.join(otherRoot, 'src'), { recursive: true });
    const invocations = getIndexFdInvocations(
      [root!, otherRoot],
      ['src'],
      ['/src'],
    );
    fs.rmSync(otherRoot, { recursive: true, force: true });
    assert.strictEqual(invocations.length, 2);
    for (const invocation of invocations) {
      assert.deepStrictEqual(invocation.searchPaths, ['.', './src']);
    }
  });

  test('excluded includes attach to their most-specific root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-plan-root-'));
    const src = path.join(root, 'src');
    fs.mkdirSync(src, { recursive: true });
    const invocations = getIndexFdInvocations([root], [src], [src]);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(invocations.length, 1);
    assert.strictEqual(normalize(invocations[0]!.base), normalize(root));
    assert.deepStrictEqual(invocations[0]!.searchPaths[0], '.');
    assert.ok(invocations[0]!.searchPaths.includes('./src'));
  });

  test('nested configured roots become separate invocations with .', () => {
    const root = path.join(os.tmpdir(), 'fqo-nested-root');
    const src = path.join(root, 'src');
    const invocations = getIndexFdInvocations([root, src], [], []);
    assert.strictEqual(invocations.length, 2);
    for (const invocation of invocations) {
      assert.deepStrictEqual(invocation.searchPaths, ['.']);
    }
    assert.deepStrictEqual(
      invocations.map((invocation) => normalize(invocation.base)).sort(),
      [normalize(root), normalize(src)].sort(),
    );
  });

  test('excluded includes under a nested root attach to that base', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-plan-nested-'));
    const src = path.join(root, 'src');
    const lib = path.join(src, 'lib');
    fs.mkdirSync(lib, { recursive: true });
    const invocations = getIndexFdInvocations([root, src], [lib], [lib]);
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(invocations.length, 2);
    const srcInvocation = invocations.find(
      (invocation) => normalize(invocation.base) === normalize(src),
    );
    const rootInvocation = invocations.find(
      (invocation) => normalize(invocation.base) === normalize(root),
    );
    assert.ok(srcInvocation);
    assert.ok(rootInvocation);
    assert.deepStrictEqual(rootInvocation.searchPaths, ['.']);
    assert.deepStrictEqual(srcInvocation.searchPaths[0], '.');
    assert.ok(srcInvocation.searchPaths.includes('./lib'));
  });

  test('holePunchExcludePatterns returns anchored relative paths', () => {
    const root = '/tmp/ws';
    const nested = '/tmp/ws/src';
    assert.deepStrictEqual(holePunchExcludePatterns(root, [root, nested]), [
      '/src',
    ]);
    assert.deepStrictEqual(
      holePunchExcludePatterns(nested, [root, nested]),
      [],
    );
  });
});

suite('isForceIndexedPath', () => {
  let restore: (() => void) | undefined;
  let root: string | undefined;

  suiteSetup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-watch-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'third_party', 'blink'), { recursive: true });
    fs.mkdirSync(path.join(root, 'third_party', 'other'), { recursive: true });
  });

  suiteTeardown(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('include dirs stay force-indexed; excluded siblings do not', () => {
    restore = composeRestores(
      stubWorkspaceFolders([root!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}'],
          include: { src: true },
          exclude: { '/src': true, '/lib': true },
          useSearchExclude: false,
        },
      }),
    );

    assert.strictEqual(
      isForceIndexedPath(path.join(root!, 'src', 'a.ts')),
      true,
    );
    assert.strictEqual(
      isForceIndexedPath(path.join(root!, 'lib', 'b.ts')),
      false,
    );
  });

  test('nested or excluded extra roots are force-indexed', () => {
    restore = composeRestores(
      stubWorkspaceFolders([root!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}', 'third_party/blink'],
          include: {},
          exclude: { '/third_party': true },
          useSearchExclude: false,
        },
      }),
    );

    assert.strictEqual(
      isForceIndexedPath(path.join(root!, 'third_party', 'blink', 'x.ts')),
      true,
    );
    assert.strictEqual(
      isForceIndexedPath(path.join(root!, 'third_party', 'other', 'y.ts')),
      false,
    );
    assert.strictEqual(
      isForceIndexedPath(path.join(root!, 'lib', 'z.ts')),
      false,
    );
  });
});

suite('expandVariableList / workspaceFolderList', () => {
  let restore: (() => void) | undefined;
  let folderA: string | undefined;
  let folderB: string | undefined;

  suiteSetup(() => {
    folderA = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-exp-a-'));
    folderB = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-exp-b-'));
    fs.mkdirSync(path.join(folderA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(folderB, 'src'), { recursive: true });
  });

  suiteTeardown(() => {
    if (folderA) {
      fs.rmSync(folderA, { recursive: true, force: true });
    }
    if (folderB) {
      fs.rmSync(folderB, { recursive: true, force: true });
    }
  });

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('${workspaceFolderList} expands 1-to-N in a list', () => {
    restore = stubWorkspaceFolders([folderA!, folderB!]);
    const expanded = expandVariableList(['${workspaceFolderList}']).map(
      normalize,
    );
    assert.deepStrictEqual(
      expanded.sort(),
      [normalize(folderA!), normalize(folderB!)].sort(),
    );
  });

  test('${workspaceFolderList}/src expands per folder', () => {
    restore = stubWorkspaceFolders([folderA!, folderB!]);
    const expanded = expandVariableList(['${workspaceFolderList}/src']).map(
      normalize,
    );
    assert.deepStrictEqual(
      expanded.sort(),
      [
        normalize(path.join(folderA!, 'src')),
        normalize(path.join(folderB!, 'src')),
      ].sort(),
    );
  });

  test('${workspaceFolderList} is unresolved in a single-string expand', () => {
    restore = stubWorkspaceFolders([folderA!]);
    assert.strictEqual(expandVariables('${workspaceFolderList}'), undefined);
  });

  test('unresolved ${workspaceFolder:name} drops that list item', () => {
    restore = stubWorkspaceFolders([folderA!]);
    const expanded = expandVariableList([
      '${workspaceFolderList}',
      '${workspaceFolder:missing}/subdir',
    ]);
    assert.deepStrictEqual(expanded.map(normalize), [normalize(folderA!)]);
  });
});

suite('expandVariables / config', () => {
  let restore: (() => void) | undefined;

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('${config:section.key} expands a string setting', () => {
    restore = stubConfigurationValues({
      'fastQuickOpen.fdPattern': 'src/**/*.ts',
    });
    assert.strictEqual(
      expandVariables('${config:fastQuickOpen.fdPattern}'),
      'src/**/*.ts',
    );
  });

  test('${config:} stringifies numbers and booleans', () => {
    restore = stubConfigurationValues({
      'editor.tabSize': 4,
      'editor.insertSpaces': true,
    });
    assert.strictEqual(expandVariables('${config:editor.tabSize}'), '4');
    assert.strictEqual(
      expandVariables('${config:editor.insertSpaces}'),
      'true',
    );
  });

  test('missing ${config:} key expands to empty', () => {
    restore = stubConfigurationValues({});
    assert.strictEqual(
      expandVariables('prefix-${config:does.not.exist}-suffix'),
      'prefix--suffix',
    );
  });

  test('empty ${config:} list item is dropped', () => {
    restore = stubConfigurationValues({});
    assert.deepStrictEqual(
      expandVariableList(['${config:does.not.exist}', 'kept']),
      ['kept'],
    );
  });

  test('${config:} interpolates inside a larger path', () => {
    restore = stubConfigurationValues({
      'fastQuickOpen.fdPattern': 'out',
    });
    assert.strictEqual(
      expandVariables('/tmp/${config:fastQuickOpen.fdPattern}/bin'),
      '/tmp/out/bin',
    );
  });

  test('${platform} ${arch} ${hostname} ${username} ${tmpdir} expand', () => {
    assert.strictEqual(expandVariables('${platform}'), process.platform);
    assert.strictEqual(expandVariables('${arch}'), process.arch);
    assert.strictEqual(expandVariables('${hostname}'), os.hostname());
    assert.strictEqual(expandVariables('${tmpdir}'), os.tmpdir());
    const username = expandVariables('${username}');
    assert.ok(username);
    assert.notStrictEqual(username, '${username}');
  });

  test('${config:key_${platform}} expands the nested key', () => {
    restore = stubConfigurationValues({
      [`myvars.root_${process.platform}`]: '/opt/platform-root',
      [`myvars.root_${process.arch}`]: '/opt/arch-root',
      [`myvars.root_${process.platform}_${process.arch}`]: '/opt/combo-root',
    });
    assert.strictEqual(
      expandVariables('${config:myvars.root_${platform}}'),
      '/opt/platform-root',
    );
    assert.strictEqual(
      expandVariables('${config:myvars.root_${arch}}'),
      '/opt/arch-root',
    );
    assert.strictEqual(
      expandVariables('${config:myvars.root_${platform}_${arch}}'),
      '/opt/combo-root',
    );
  });

  test('${config:} value is expanded if it contains variables', () => {
    restore = stubConfigurationValues({
      'myvars.root': '${userHome}/src',
    });
    assert.strictEqual(
      expandVariables('${config:myvars.root}'),
      `${os.homedir()}/src`,
    );
  });

  test('requireNonEmptyVariables keeps literal text around a non-empty variable', () => {
    restore = stubConfigurationValues({
      'myvars.root': '/opt/project',
    });
    assert.strictEqual(
      expandVariables('out ${config:myvars.root}', {
        requireNonEmptyVariables: true,
      }),
      'out /opt/project',
    );
  });

  test('requireNonEmptyVariables voids the whole result when a variable resolves empty', () => {
    restore = stubConfigurationValues({});
    assert.strictEqual(
      expandVariables('out ${config:does.not.exist}', {
        requireNonEmptyVariables: true,
      }),
      undefined,
    );
    // Without the option (default), literal text around the empty variable is kept.
    assert.strictEqual(expandVariables('out ${config:does.not.exist}'), 'out ');
  });

  test('reports direct and nested ${config:} dependencies', () => {
    restore = stubConfigurationValues({
      'myvars.root': '${config:myvars.base}/src',
      'myvars.base': '/opt/project',
    });
    const expanded = expandVariablesWithDependencies('${config:myvars.root}');
    assert.strictEqual(expanded.value, '/opt/project/src');
    assert.deepStrictEqual(
      [...expanded.configDependencies],
      ['myvars.root', 'myvars.base'],
    );
  });
});

suite('expandVariables / active editor', function () {
  this.timeout(8000);

  let tmpDir: string | undefined;
  let restoreFolders: (() => void) | undefined;

  teardown(() => {
    restoreFolders?.();
    restoreFolders = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  async function openFile(
    relativePath: string,
    content = '',
  ): Promise<vscode.TextEditor> {
    if (!tmpDir) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-vars-'));
    }
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(filePath),
    );
    const editor = await vscode.window.showTextDocument(doc);
    // Derive the workspace folder by walking up from the doc's own path
    // (avoids /tmp vs /private/tmp symlink mismatches on macOS).
    const segments = relativePath.split(path.sep).filter(Boolean);
    let workspaceFolder = doc.uri.fsPath;
    for (const _segment of segments) {
      workspaceFolder = path.dirname(workspaceFolder);
    }
    restoreFolders = stubWorkspaceFolders([workspaceFolder]);
    return editor;
  }

  test('${file} / ${relativeFile} and the file-part variables resolve for a root-level file', async () => {
    const editor = await openFile('thing.test.ts');
    const filePath = editor.document.uri.fsPath;
    assert.strictEqual(expandVariables('${relativeFile}'), 'thing.test.ts');
    assert.strictEqual(expandVariables('${relativeFileDirname}'), '');
    assert.strictEqual(expandVariables('${fileBasename}'), 'thing.test.ts');
    assert.strictEqual(
      expandVariables('${fileBasenameNoExtension}'),
      'thing.test',
    );
    assert.strictEqual(expandVariables('${fileExtname}'), '.ts');
    assert.strictEqual(
      normalize(expandVariables('${file}')!),
      normalize(filePath),
    );
    assert.strictEqual(
      normalize(expandVariables('${fileDirname}')!),
      normalize(path.dirname(filePath)),
    );
    assert.strictEqual(
      normalize(expandVariables('${fileWorkspaceFolder}')!),
      normalize(path.dirname(filePath)),
    );
  });

  test('${relativeFileDirname} / ${fileDirnameBasename} resolve for a nested file', async () => {
    await openFile(path.join('src', 'nested.ts'));
    assert.strictEqual(expandVariables('${relativeFile}'), 'src/nested.ts');
    assert.strictEqual(expandVariables('${relativeFileDirname}'), 'src');
    assert.strictEqual(expandVariables('${fileDirnameBasename}'), 'src');
  });

  test('${selectedText} is raw; ${selectedFilePath} filters out non-path-like text', async () => {
    const editor = await openFile(
      'doc.txt',
      '\'alpha.ts\nalpha.ts\'\n\'alpha.ts\'\n"alpha.ts\nalpha.ts"\n"alpha.ts"\nconst x = 1;',
    );
    editor.selection = new vscode.Selection(0, 0, 0, "'alpha.ts".length);
    assert.strictEqual(expandVariables('${selectedText}'), "'alpha.ts");
    assert.strictEqual(expandVariables('${selectedFilePath}'), 'alpha.ts');

    editor.selection = new vscode.Selection(1, 0, 1, "alpha.ts'".length);
    assert.strictEqual(expandVariables('${selectedText}'), "alpha.ts'");
    assert.strictEqual(expandVariables('${selectedFilePath}'), 'alpha.ts');

    editor.selection = new vscode.Selection(2, 0, 2, "'alpha.ts'".length);
    assert.strictEqual(expandVariables('${selectedFilePath}'), 'alpha.ts');

    editor.selection = new vscode.Selection(3, 0, 3, '"alpha.ts'.length);
    assert.strictEqual(expandVariables('${selectedFilePath}'), 'alpha.ts');

    editor.selection = new vscode.Selection(4, 0, 4, 'alpha.ts"'.length);
    assert.strictEqual(expandVariables('${selectedFilePath}'), 'alpha.ts');

    editor.selection = new vscode.Selection(5, 0, 5, '"alpha.ts"'.length);
    assert.strictEqual(expandVariables('${selectedFilePath}'), 'alpha.ts');

    editor.selection = new vscode.Selection(6, 0, 6, 'const x = 1;'.length);
    assert.strictEqual(expandVariables('${selectedText}'), 'const x = 1;');
    assert.strictEqual(expandVariables('${selectedFilePath}'), '');
  });

  test('${lineNumber} / ${columnNumber} are 1-based', async () => {
    const editor = await openFile('doc.txt', 'one\ntwo\nthree');
    editor.selection = new vscode.Selection(1, 2, 1, 2);
    assert.strictEqual(expandVariables('${lineNumber}'), '2');
    assert.strictEqual(expandVariables('${columnNumber}'), '3');
  });

  test('${cwd} and ${execPath} reflect the current process', () => {
    assert.strictEqual(expandVariables('${cwd}'), process.cwd());
    assert.strictEqual(expandVariables('${execPath}'), process.execPath);
  });
});

suite('resolveIndexScope', () => {
  let restore: (() => void) | undefined;
  let folderA: string | undefined;
  let folderB: string | undefined;
  let extra: string | undefined;

  suiteSetup(() => {
    folderA = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-scope-a-'));
    folderB = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-scope-b-'));
    extra = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-scope-extra-'));
    fs.mkdirSync(path.join(folderA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(folderA, 'lib'), { recursive: true });
  });

  suiteTeardown(() => {
    for (const dir of [folderA, folderB, extra]) {
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('default scope roots expand ${workspaceFolderList} and own include/exclude', () => {
    restore = composeRestores(
      stubWorkspaceFolders([folderA!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}'],
          exclude: { '**/secret_default_only': true },
          include: ['src'],
          useSearchExclude: true,
          fdHidden: false,
          fdNoIgnore: false,
          fdPattern: '.',
          fdFlags: ['--follow'],
          fzfFlags: ['--tiebreak=end'],
          maxItems: 40,
        },
        files: {
          exclude: {
            '**/from-files': true,
            '**/*.js': { when: '$(basename).ts' },
          },
        },
        search: { exclude: { '**/from-search': true } },
      }),
    );

    const scope = config.resolveIndexScope(null);
    assert.ok(scope);
    assert.strictEqual(scope.label, 'default');
    assert.deepStrictEqual(scope.roots.map(normalize), [normalize(folderA!)]);
    assert.deepStrictEqual(scope.includeEntries, ['src']);
    assert.ok(hasExclude(scope.excludePatterns, '**/secret_default_only'));
    assert.ok(hasExclude(scope.excludePatterns, '**/from-files'));
    assert.ok(hasExclude(scope.excludePatterns, '**/from-search'));
    assert.ok(!hasExclude(scope.excludePatterns, '**/*.js'));
    assert.strictEqual(scope.fdOptions.hidden, false);
    assert.strictEqual(scope.fdOptions.noIgnore, false);
    assert.deepStrictEqual(scope.fdOptions.extraFlags, ['--follow']);
    assert.ok(scope.fzfExtraFlags.includes('--tiebreak=end'));
    assert.strictEqual(scope.maxItems, 40);
  });

  test('mixed roots list expands sentinel, absolute extra, and named folder', () => {
    restore = composeRestores(
      stubWorkspaceFolders([folderA!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: [
            '${workspaceFolderList}',
            extra!,
            `\${workspaceFolder:${path.basename(folderA!)}}/lib`,
            '${workspaceFolder:does-not-exist}/x',
          ],
          useSearchExclude: false,
        },
      }),
    );

    const scope = config.resolveIndexScope(null);
    assert.ok(scope);
    const roots = scope.roots.map(normalize).sort();
    assert.ok(roots.includes(normalize(folderA!)));
    assert.ok(roots.includes(normalize(folderB!)));
    assert.ok(roots.includes(normalize(extra!)));
    assert.ok(roots.includes(normalize(path.join(folderA!, 'lib'))));
    assert.ok(!roots.some((r) => r.includes('does-not-exist')));
  });

  test('resolved scopes are cached until workspace changes invalidate them', () => {
    let restoreFolders = stubWorkspaceFolders([folderA!]);
    const restoreConfig = stubWorkspaceConfig({
      fastQuickOpen: {
        roots: ['${workspaceFolderList}'],
        useSearchExclude: false,
      },
    });

    try {
      const initial = config.resolveIndexScope(null);
      assert.deepStrictEqual(initial?.roots.map(normalize), [
        normalize(folderA!),
      ]);
      assert.strictEqual(config.resolveIndexScope(null), initial);

      restoreFolders();
      restoreFolders = stubWorkspaceFolders([folderB!]);

      assert.strictEqual(config.resolveIndexScope(null), initial);
      config.clearCache();
      assert.deepStrictEqual(
        config.resolveIndexScope(null)?.roots.map(normalize),
        [normalize(folderB!)],
      );
    } finally {
      restoreFolders();
      restoreConfig();
    }
  });

  test('the default index stays alive; on-demand defaults to destroy', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        onDemand: {
          src: {},
          kept: { lifecycle: 'active' },
        },
      },
    });

    assert.strictEqual(config.resolveIndexScope(null)?.lifecycle, 'active');
    assert.strictEqual(config.resolveIndexScope('src')?.lifecycle, 'destroy');
    assert.strictEqual(config.resolveIndexScope('kept')?.lifecycle, 'active');
  });

  test('default config is cached until invalidated', () => {
    const fastQuickOpen: Record<string, unknown> = {
      lowercaseQuery: false,
    };
    restore = stubWorkspaceConfig({ fastQuickOpen });

    assert.strictEqual(config.settings().lowercaseQuery, false);
    fastQuickOpen.lowercaseQuery = true;
    assert.strictEqual(config.settings().lowercaseQuery, false);

    config.clearCache();
    assert.strictEqual(config.settings().lowercaseQuery, true);
  });

  test('reload debounce accepts zero and falls back for invalid values', () => {
    const fastQuickOpen: Record<string, unknown> = {};
    restore = stubWorkspaceConfig({ fastQuickOpen });

    assert.strictEqual(config.settings().reloadDebounceSeconds, 10);

    fastQuickOpen.reloadDebounceSeconds = 0;
    assert.strictEqual(config.settings().reloadDebounceSeconds, 10);
    config.clearCache();
    assert.strictEqual(config.settings().reloadDebounceSeconds, 0);

    fastQuickOpen.reloadDebounceSeconds = 2.5;
    config.clearCache();
    assert.strictEqual(config.settings().reloadDebounceSeconds, 2.5);

    fastQuickOpen.reloadDebounceSeconds = -1;
    config.clearCache();
    assert.strictEqual(config.settings().reloadDebounceSeconds, 10);

    fastQuickOpen.reloadDebounceSeconds = Number.POSITIVE_INFINITY;
    config.clearCache();
    assert.strictEqual(config.settings().reloadDebounceSeconds, 10);
  });

  test('tracks expanded config keys until the cache is cleared', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        fdFlags: ['--extension', '${config:files.defaultLanguage}'],
      },
    });
    const eventFor = (changedKey: string) => ({
      affectsConfiguration: (key: string) => key === changedKey,
    });

    config.resolveIndexScope(null);
    assert.strictEqual(
      config.isConfigChange(eventFor('files.defaultLanguage')),
      true,
    );
    assert.strictEqual(
      config.isConfigChange(eventFor('editor.fontSize')),
      false,
    );
    assert.strictEqual(config.isConfigChange(eventFor('files.exclude')), true);
    assert.strictEqual(config.isConfigChange(eventFor('search.exclude')), true);
    assert.strictEqual(
      config.isConfigChange(eventFor('files.watcherExclude')),
      true,
    );

    config.clearCache();
    assert.strictEqual(
      config.isConfigChange(eventFor('files.defaultLanguage')),
      false,
    );
    assert.strictEqual(config.isConfigChange(eventFor('files.exclude')), false);
    assert.strictEqual(
      config.isConfigChange(eventFor('search.exclude')),
      false,
    );
    assert.strictEqual(
      config.isConfigChange(eventFor('files.watcherExclude')),
      false,
    );
    config.resolveIndexScope(null);
    assert.strictEqual(
      config.isConfigChange(eventFor('files.defaultLanguage')),
      true,
    );
  });

  test('tracks external excludes only when a cached scope enables them', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        useSearchExclude: false,
        useWatcherExclude: false,
        onDemand: {
          src: {
            useSearchExclude: true,
          },
        },
      },
    });
    const eventFor = (changedKey: string) => ({
      affectsConfiguration: (key: string) => key === changedKey,
    });

    config.settings();
    assert.strictEqual(config.isConfigChange(eventFor('files.exclude')), false);
    assert.strictEqual(
      config.isConfigChange(eventFor('search.exclude')),
      false,
    );
    assert.strictEqual(
      config.isConfigChange(eventFor('files.watcherExclude')),
      false,
    );

    config.resolveIndexScope('src');
    assert.strictEqual(config.isConfigChange(eventFor('files.exclude')), true);
    assert.strictEqual(config.isConfigChange(eventFor('search.exclude')), true);
  });

  test('on-demand does not inherit fastQuickOpen include/exclude; omitted roots are workspaceFolderList/key', () => {
    restore = composeRestores(
      stubWorkspaceFolders([folderA!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          exclude: { '**/secret_default_only': true },
          include: ['vendor'],
          useSearchExclude: true,
          onDemand: {
            src: {
              exclude: ['**/scope-only'],
            },
          },
        },
        files: { exclude: { '**/from-files': true } },
        search: { exclude: { '**/from-search': true } },
      }),
    );

    const scope = config.resolveIndexScope('src');
    assert.ok(scope);
    assert.strictEqual(scope.label, 'on-demand:src');
    assert.deepStrictEqual(scope.roots.map(normalize), [
      normalize(path.join(folderA!, 'src')),
    ]);
    assert.deepStrictEqual(scope.includeEntries, []);
    assert.ok(!hasExclude(scope.excludePatterns, '**/secret_default_only'));
    assert.ok(hasExclude(scope.excludePatterns, '**/scope-only'));
    assert.ok(hasExclude(scope.excludePatterns, '**/from-files'));
    assert.ok(hasExclude(scope.excludePatterns, '**/from-search'));
  });

  test('omitted on-demand roots stay workspaceFolderList/key when include is customized', () => {
    restore = composeRestores(
      stubWorkspaceFolders([folderA!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          useSearchExclude: false,
          onDemand: {
            src: { include: ['lib'] },
          },
        },
      }),
    );

    const scope = config.resolveIndexScope('src');
    assert.ok(scope);
    assert.deepStrictEqual(scope.roots.map(normalize), [
      normalize(path.join(folderA!, 'src')),
    ]);
    assert.deepStrictEqual(scope.includeEntries, ['lib']);
  });

  test('on-demand with roots only (empty include) is valid', () => {
    restore = composeRestores(
      stubWorkspaceFolders([folderA!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          useSearchExclude: false,
          onDemand: {
            all: {
              roots: ['${workspaceFolderList}'],
              include: [],
            },
          },
        },
      }),
    );

    const scope = config.resolveIndexScope('all');
    assert.ok(scope);
    assert.deepStrictEqual(scope.roots.map(normalize), [normalize(folderA!)]);
    assert.deepStrictEqual(scope.includeEntries, []);
  });

  test('explicit on-demand roots do not default include to the key', () => {
    fs.mkdirSync(path.join(folderB!, 'src'), { recursive: true });
    restore = composeRestores(
      stubWorkspaceFolders([folderA!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          useSearchExclude: false,
          onDemand: {
            src: {
              roots: [folderA!],
            },
          },
        },
      }),
    );

    const scope = config.resolveIndexScope('src');
    assert.ok(scope);
    assert.deepStrictEqual(scope.roots.map(normalize), [normalize(folderA!)]);
    assert.deepStrictEqual(scope.includeEntries, []);
  });

  test('fdFlags and fzfFlags stringify non-string list items', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        fdFlags: ['--max-depth', 4, null, '  '],
        fzfFlags: ['--tiebreak=end', true, undefined],
        onDemand: {
          src: {
            fdFlags: ['--max-results', 10],
            fzfFlags: ['--nth', 2],
          },
        },
      },
    });

    const def = config.resolveIndexScope(null);
    assert.ok(def);
    assert.deepStrictEqual(def.fdOptions.extraFlags, ['--max-depth', '4']);
    assert.ok(def.fzfExtraFlags.includes('--tiebreak=end'));
    assert.ok(def.fzfExtraFlags.includes('true'));

    const scope = config.resolveIndexScope('src');
    assert.ok(scope);
    assert.deepStrictEqual(scope.fdOptions.extraFlags, ['--max-results', '10']);
    assert.ok(scope.fzfExtraFlags.includes('--nth'));
    assert.ok(scope.fzfExtraFlags.includes('2'));
  });

  test('on-demand fd/fzf/maxItems and exclude flags fall back to globals', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        fdHidden: true,
        fdNoIgnore: true,
        fdPattern: '.*\\.ts$',
        fdFlags: ['--follow'],
        fzfFlags: ['--tiebreak=end'],
        maxItems: 25,
        useSearchExclude: true,
        onDemand: { src: {} },
      },
      files: { exclude: { '**/from-files': true } },
      search: { exclude: { '**/from-search': true } },
    });

    const scope = config.resolveIndexScope('src');
    assert.ok(scope);
    assert.strictEqual(scope.fdOptions.hidden, true);
    assert.strictEqual(scope.fdOptions.noIgnore, true);
    assert.strictEqual(scope.fdOptions.pattern, '.*\\.ts$');
    assert.deepStrictEqual(scope.fdOptions.extraFlags, ['--follow']);
    assert.ok(scope.fzfExtraFlags.includes('--tiebreak=end'));
    assert.strictEqual(scope.maxItems, 25);
    assert.ok(hasExclude(scope.excludePatterns, '**/from-files'));
    assert.ok(hasExclude(scope.excludePatterns, '**/from-search'));
  });

  test('on-demand explicit false and empty lists do not fall back', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        fdHidden: true,
        fdNoIgnore: true,
        fdFlags: ['--follow'],
        fzfFlags: ['--tiebreak=end'],
        useSearchExclude: true,
        onDemand: {
          src: {
            fdHidden: false,
            fdNoIgnore: false,
            fdFlags: [],
            fzfFlags: [],
            useSearchExclude: false,
            maxItems: 3,
          },
        },
      },
      files: { exclude: { '**/from-files': true } },
      search: { exclude: { '**/from-search': true } },
    });

    const scope = config.resolveIndexScope('src');
    assert.ok(scope);
    assert.strictEqual(scope.fdOptions.hidden, false);
    assert.strictEqual(scope.fdOptions.noIgnore, false);
    assert.deepStrictEqual(scope.fdOptions.extraFlags, []);
    assert.deepStrictEqual(scope.fzfExtraFlags, []);
    assert.strictEqual(scope.maxItems, 3);
    assert.ok(!hasExclude(scope.excludePatterns, '**/from-files'));
    assert.ok(!hasExclude(scope.excludePatterns, '**/from-search'));
  });

  test('unknown on-demand key returns undefined', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: { onDemand: {} },
    });
    assert.strictEqual(config.resolveIndexScope('missing'), undefined);
  });
});

suite('FdCommandBuilder.forScope', () => {
  let restore: (() => void) | undefined;
  let workspaceRoot: string | undefined;
  let folderB: string | undefined;
  let externalRoot: string | undefined;
  let nestedRoot: string | undefined;

  suiteSetup(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-ws-'));
    folderB = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-ws-b-'));
    externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-ext-'));
    nestedRoot = path.join(workspaceRoot, 'nested');
    fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.mkdirSync(path.join(folderB, 'src'), { recursive: true });
    fs.mkdirSync(path.join(externalRoot, 'lib'), { recursive: true });
  });

  suiteTeardown(() => {
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    if (folderB) {
      fs.rmSync(folderB, { recursive: true, force: true });
    }
    if (externalRoot) {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('default and on-demand share the builder with different roots', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}'],
          exclude: { '**/secret_default_only': true },
          include: [],
          useSearchExclude: false,
          fdHidden: false,
          fdNoIgnore: false,
          onDemand: { src: {} },
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    const onDemand = builder.forScope('src');
    assert.ok(def, 'default index spec');
    assert.ok(onDemand, 'on-demand src spec');

    assert.ok(
      def.specs.some(
        (spec) => normalize(spec.base) === normalize(workspaceRoot!),
      ),
      'default bases include the workspace root',
    );
    assert.ok(
      argvHas(def.specs, 'secret_default_only'),
      'default commands exclude secret_default_only',
    );
    assert.ok(
      !argvHas(onDemand.specs, 'secret_default_only'),
      'on-demand commands omit default-only exclude',
    );
    // Omitted on-demand roots → `${workspaceFolderList}/src`.
    assert.ok(
      onDemand.specs.some(
        (spec) =>
          normalize(spec.base) === normalize(path.join(workspaceRoot!, 'src')),
      ),
      'on-demand base is workspaceFolderList/key',
    );
    assert.deepStrictEqual(onDemand.scope.roots.map(normalize), [
      normalize(path.join(workspaceRoot!, 'src')),
    ]);
    assert.deepStrictEqual(onDemand.scope.includeEntries, []);
    assert.ok(
      onDemand.specs.some((spec) => spec.command.includes('.')),
      'on-demand commands search . under the key root',
    );
    assert.strictEqual(def.scope.label, 'default');
    assert.strictEqual(onDemand.scope.label, 'on-demand:src');
  });

  test('on-demand roots ${workspaceFolderList} uses folder bases like the default index', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          useSearchExclude: false,
          onDemand: {
            src: {
              roots: ['${workspaceFolderList}'],
              include: ['src'],
            },
          },
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const onDemand = builder.forScope('src');
    assert.ok(onDemand);
    assert.ok(
      onDemand.specs.some(
        (spec) => normalize(spec.base) === normalize(workspaceRoot!),
      ),
    );
    // src is under the root and not excluded → omitted as a separate walk.
    assert.ok(
      onDemand.specs.every(
        (spec) => !spec.command.includes('./src') || spec.command.includes('.'),
      ),
    );
  });

  test('explicit on-demand roots do not add workspaceFolderList/key in a multi-folder window', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          useSearchExclude: false,
          onDemand: {
            src: {
              roots: [workspaceRoot!],
            },
          },
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const onDemand = builder.forScope('src');
    assert.ok(onDemand);
    assert.deepStrictEqual(onDemand.scope.includeEntries, []);
    assert.deepStrictEqual(onDemand.scope.roots.map(normalize), [
      normalize(workspaceRoot!),
    ]);
    assert.strictEqual(onDemand.specs.length, 1);
    assert.strictEqual(
      normalize(onDemand.specs[0]!.base),
      normalize(workspaceRoot!),
    );
    assert.ok(
      !onDemand.specs.some(
        (spec) =>
          normalize(spec.base) === normalize(path.join(folderB!, 'src')),
      ),
      'other folder key dir is not a search base',
    );
  });

  test('multi-folder workspace: one fd per root, exclude repeated, . first', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}'],
          exclude: { '/node_modules': true },
          include: [],
          useSearchExclude: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.specs.length, 2);
    for (const spec of def.specs) {
      assert.ok(spec.command.includes('--exclude'));
      assert.ok(spec.command.includes('/node_modules'));
      const baseIdx = spec.command.indexOf('--base-directory');
      assert.ok(baseIdx >= 0);
      // pattern then positional paths; '.' should appear as a search path
      assert.ok(spec.command.includes('.'));
      const firstPath = spec.command[spec.command.length - 1];
      // with only the root, the only (and thus first) search path is '.'
      assert.strictEqual(firstPath, '.');
      // sibling folders: no hole-punch excludes for each other
      assert.ok(!spec.command.includes('/nested'));
    }
  });

  test('two in-workspace groups prepend FolderName in --format', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}'],
          include: [],
          useSearchExclude: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.filterLabels, true);
    assert.strictEqual(def.specs.length, 2);
    for (const spec of def.specs) {
      const folder = path.basename(spec.base);
      assert.strictEqual(spec.filterLabel, folder);
      const format = formatArg(spec);
      assert.ok(format === `0/${folder}/{}` || format === `1/${folder}/{}`);
      assert.ok(spec.command.includes('.'));
    }
  });

  test('a single in-workspace group keeps N/{} even if another folder is open', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: [workspaceRoot!],
          include: [],
          useSearchExclude: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.filterLabels, false);
    assert.strictEqual(def.specs.length, 1);
    assert.strictEqual(def.specs[0]!.filterLabel, undefined);
    assert.strictEqual(formatArg(def.specs[0]!), '0/{}');
  });

  test('nested extra root uses the containing workspace folder name', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: [workspaceRoot!, path.join(workspaceRoot!, 'src')],
          include: [],
          useSearchExclude: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.filterLabels, true);
    assert.strictEqual(def.specs.length, 2);
    const folderName = path.basename(workspaceRoot!);
    for (const spec of def.specs) {
      assert.strictEqual(spec.filterLabel, folderName);
      assert.ok(formatArg(spec).endsWith(`/${folderName}/{}`));
    }
  });

  test('an out-of-workspace root does not get a filter label', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: [workspaceRoot!, folderB!],
          include: [],
          useSearchExclude: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.specs.length, 2);
    const inWs = def.specs.find(
      (spec) => normalize(spec.base) === normalize(workspaceRoot!),
    );
    const external = def.specs.find(
      (spec) => normalize(spec.base) === normalize(folderB!),
    );
    assert.ok(inWs);
    assert.ok(external);
    assert.strictEqual(def.filterLabels, false);
    assert.strictEqual(inWs!.filterLabel, undefined);
    assert.strictEqual(external!.filterLabel, undefined);
    assert.match(formatArg(inWs!), /^\d+\/\{\}$/);
    assert.match(formatArg(external!), /^\d+\/\{\}$/);
  });

  test('two in-workspace groups plus an external root use empty labels', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!, folderB!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: [workspaceRoot!, folderB!, externalRoot!],
          include: [],
          useSearchExclude: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.filterLabels, true);
    assert.strictEqual(def.specs.length, 3);
    const inWs = def.specs.filter((spec) =>
      [workspaceRoot!, folderB!].some(
        (root) => normalize(spec.base) === normalize(root),
      ),
    );
    const external = def.specs.find(
      (spec) => normalize(spec.base) === normalize(externalRoot!),
    );
    assert.strictEqual(inWs.length, 2);
    assert.ok(external);
    for (const spec of inWs) {
      assert.strictEqual(spec.filterLabel, path.basename(spec.base));
      assert.match(formatArg(spec), /^\d+\/[^/]+\/\{\}$/);
    }
    assert.strictEqual(external!.filterLabel, '');
    assert.match(formatArg(external!), /^\d+\/\/\{\}$/);
  });

  test('nested workspace folder: own fd + parent hole-punch exclude', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!, nestedRoot!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          roots: ['${workspaceFolderList}'],
          include: [],
          useSearchExclude: false,
          fdHidden: false,
          fdNoIgnore: false,
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    assert.ok(def);
    assert.strictEqual(def.specs.length, 2);

    const parent = def.specs.find(
      (spec) => normalize(spec.base) === normalize(workspaceRoot!),
    );
    const nested = def.specs.find(
      (spec) => normalize(spec.base) === normalize(nestedRoot!),
    );
    assert.ok(parent, 'parent root spec');
    assert.ok(nested, 'nested root spec');

    assert.ok(parent!.command.includes('--exclude'));
    assert.ok(parent!.command.includes('/nested'));
    assert.ok(!nested!.command.includes('/nested'));
    assert.ok(!parent!.command.includes('--no-ignore-parent'));
    assert.ok(!nested!.command.includes('--no-ignore-parent'));

    assert.strictEqual(parent!.command[parent!.command.length - 1], '.');
    assert.strictEqual(nested!.command[nested!.command.length - 1], '.');
  });

  test('on-demand command uses scope fd overrides', () => {
    restore = composeRestores(
      stubWorkspaceFolders([workspaceRoot!]),
      stubWorkspaceConfig({
        fastQuickOpen: {
          useSearchExclude: false,
          fdHidden: false,
          fdNoIgnore: false,
          fdFlags: ['--follow'],
          onDemand: {
            src: {
              fdHidden: true,
              fdFlags: [],
            },
          },
        },
      }),
    );

    const builder = new FdCommandBuilder(extensionPath);
    const def = builder.forScope(null);
    const onDemand = builder.forScope('src');
    assert.ok(def);
    assert.ok(onDemand);
    assert.ok(
      argvHas(def.specs, '--follow'),
      'default commands include --follow',
    );
    assert.ok(
      !argvHas(onDemand.specs, '--follow'),
      'on-demand commands omit global --follow',
    );
    assert.ok(
      !argvHas(def.specs, '--hidden'),
      'default commands omit --hidden',
    );
    assert.ok(
      argvHas(onDemand.specs, '--hidden'),
      'on-demand commands include --hidden',
    );
  });

  test('missing on-demand include dirs yield no spec', () => {
    restore = stubWorkspaceConfig({
      fastQuickOpen: {
        useSearchExclude: false,
        onDemand: {
          ghost: { include: ['this-directory-does-not-exist-fqo'] },
        },
      },
    });

    const builder = new FdCommandBuilder(extensionPath);
    assert.strictEqual(builder.forScope('ghost'), undefined);
    assert.strictEqual(builder.forScope('nope'), undefined);
  });
});
