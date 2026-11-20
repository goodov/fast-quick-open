import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import resourceToQuickPickItem, {
  fileDescription,
} from '../helpers/filePathToQuickPickItem.ts';
import mergeResults from '../helpers/mergeResults.ts';
import {
  stubWorkspaceConfig,
  stubWorkspaceFolders,
} from './helpers/stubWorkspaceConfig.ts';

function absDir(filePath: string): string {
  const dir = path.parse(filePath).dir;
  const dirNorm = path.normalize(dir);
  if (process.platform !== 'win32') {
    const homeNorm = path.normalize(os.homedir());
    if (homeNorm && dirNorm.startsWith(homeNorm + path.sep)) {
      return `~${dirNorm.slice(homeNorm.length).replace(/\\/g, '/')}`;
    }
  }
  return dirNorm
    .replace(/\\/g, '/')
    .replace(/^([a-z]):/, (_m, letter: string) => `${letter.toUpperCase()}:`);
}

suite('fileDescription', () => {
  const tmp = path.join(os.tmpdir(), 'fqo-picker-desc');
  const project = path.join(tmp, 'project');
  const srcFolder = path.join(tmp, 'src');
  const braveFolder = path.join(tmp, 'brave');
  let restore: (() => void) | undefined;

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('single-folder src: on-demand out/Release is relative to the folder', () => {
    restore = stubWorkspaceFolders([srcFolder]);
    const file = path.join(srcFolder, 'out', 'Release', 'args.gn');
    assert.strictEqual(
      fileDescription(file, { root: path.join(srcFolder, 'out') }),
      'out/Release',
    );
  });

  test('multi-folder src + brave: same out file prefixes the workspace folder name', () => {
    restore = stubWorkspaceFolders([srcFolder, braveFolder]);
    const file = path.join(srcFolder, 'out', 'Release', 'args.gn');
    assert.strictEqual(
      fileDescription(file, { root: path.join(srcFolder, 'out') }),
      'src \u2022 out/Release',
    );
  });

  test('single-folder parent project: src/out/Release is the workspace-relative path', () => {
    restore = stubWorkspaceFolders([project]);
    const file = path.join(project, 'src', 'out', 'Release', 'args.gn');
    assert.strictEqual(
      fileDescription(file, { root: path.join(project, 'src', 'out') }),
      'src/out/Release',
    );
  });

  test('file at the workspace folder root has an empty description', () => {
    restore = stubWorkspaceFolders([srcFolder]);
    const file = path.join(srcFolder, 'foo.ts');
    assert.strictEqual(fileDescription(file, { root: srcFolder }), '');
  });

  test('file at a multi-folder workspace root prefixes the folder name', () => {
    restore = stubWorkspaceFolders([srcFolder, braveFolder]);
    const file = path.join(srcFolder, 'foo.ts');
    assert.strictEqual(fileDescription(file, { root: srcFolder }), 'src');
  });

  test('out-of-workspace root keeps the absolute parent directory, no label', () => {
    restore = stubWorkspaceFolders([project]);
    const external = path.join(tmp, 'user', 'brave');
    const file = path.join(external, 'foo', 'a.ts');
    assert.strictEqual(fileDescription(file, { root: external }), absDir(file));
  });

  test('in-tree + external same basename: in-tree is workspace-relative; external is absolute', () => {
    restore = stubWorkspaceFolders([project]);
    const inTree = path.join(project, 'brave');
    const external = path.join(tmp, 'user', 'brave');
    const inFile = path.join(inTree, 'foo', 'a.ts');
    const extFile = path.join(external, 'foo', 'a.ts');

    assert.strictEqual(fileDescription(inFile, { root: inTree }), 'brave/foo');
    assert.strictEqual(
      fileDescription(extFile, { root: external }),
      absDir(extFile),
    );
  });

  test('nested extra root uses the workspace-relative dir, not the fd-root suffix', () => {
    restore = stubWorkspaceFolders([project]);
    const blink = path.join(project, 'third_party', 'blink');
    const file = path.join(blink, 'renderer', 'x.ts');
    assert.strictEqual(
      fileDescription(file, { root: blink }),
      'third_party/blink/renderer',
    );
  });

  test('nested extra root in a multi-folder window prefixes the folder name', () => {
    restore = stubWorkspaceFolders([
      { fsPath: project, name: 'chromium' },
      braveFolder,
    ]);
    const blink = path.join(project, 'third_party', 'blink');
    const file = path.join(blink, 'renderer', 'x.ts');
    assert.strictEqual(
      fileDescription(file, { root: blink }),
      'chromium \u2022 third_party/blink/renderer',
    );
  });

  test('two workspace folders use folder names, not fd-root unique suffixes', () => {
    restore = stubWorkspaceFolders([srcFolder, braveFolder]);
    const srcA = path.join(srcFolder, 'src');
    const srcB = path.join(braveFolder, 'src');
    const fileA = path.join(srcA, 'foo', 'a.ts');
    const fileB = path.join(srcB, 'foo', 'b.ts');

    assert.strictEqual(
      fileDescription(fileA, { root: srcA }),
      'src \u2022 src/foo',
    );
    assert.strictEqual(
      fileDescription(fileB, { root: srcB }),
      'brave \u2022 src/foo',
    );
  });

  test('renamed workspace folder uses folder.name only in a multi-folder window', () => {
    restore = stubWorkspaceFolders([
      { fsPath: srcFolder, name: 'Frontend' },
      braveFolder,
    ]);
    const file = path.join(srcFolder, 'src', 'a.ts');
    assert.strictEqual(
      fileDescription(file, { root: srcFolder }),
      'Frontend \u2022 src',
    );
  });

  test('renamed single-folder window does not prefix the folder name', () => {
    restore = stubWorkspaceFolders([{ fsPath: srcFolder, name: 'Frontend' }]);
    const file = path.join(srcFolder, 'src', 'a.ts');
    assert.strictEqual(fileDescription(file, { root: srcFolder }), 'src');
  });

  test('recents without a root stay workspace-relative or absolute', () => {
    restore = stubWorkspaceFolders([project]);
    const inside = path.join(project, 'src', 'foo.ts');
    const outside = path.join(tmp, 'elsewhere', 'bar.ts');
    assert.strictEqual(fileDescription(inside), 'src');
    assert.strictEqual(fileDescription(outside), absDir(outside));
  });

  test('recents in a multi-folder window prefix the workspace folder name', () => {
    restore = stubWorkspaceFolders([srcFolder, braveFolder]);
    const inside = path.join(srcFolder, 'out', 'Release', 'args.gn');
    assert.strictEqual(fileDescription(inside), 'src \u2022 out/Release');
  });

  test('out-of-workspace path under home uses a ~ prefix', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    restore = stubWorkspaceFolders([project]);
    const file = path.join(os.homedir(), 'docs', 'notes', 'a.md');
    assert.strictEqual(
      fileDescription(file, { root: path.join(os.homedir(), 'docs') }),
      '~/docs/notes',
    );
    assert.strictEqual(fileDescription(file), '~/docs/notes');
  });

  test('file in the home directory itself keeps the absolute path', () => {
    restore = stubWorkspaceFolders([project]);
    const file = path.join(os.homedir(), 'todo.md');
    const expected = path
      .normalize(os.homedir())
      .replace(/\\/g, '/')
      .replace(/^([a-z]):/, (_m, letter: string) => `${letter.toUpperCase()}:`);
    assert.strictEqual(fileDescription(file), expected);
  });

  test('windows absolute dir capitalizes the drive letter', () => {
    restore = stubWorkspaceFolders([project]);
    const file = 'c:/users/me/docs/a.ts';
    assert.strictEqual(
      fileDescription(file, { root: 'c:/users/me' }),
      'C:/users/me/docs',
    );
  });

  test('a path that only shares a home prefix string stays absolute', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    restore = stubWorkspaceFolders([project]);
    const neighbor = `${os.homedir()}extra`;
    const file = path.join(neighbor, 'foo', 'a.ts');
    assert.strictEqual(fileDescription(file), absDir(file));
    assert.ok(!fileDescription(file).startsWith('~/'));
  });

  test('vscode-userdata settings path uses ~ like a file path', function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    restore = stubWorkspaceFolders([project]);
    const fsPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'profiles',
      '77a16de9',
      'settings.json',
    );
    const uri = vscode.Uri.from({ scheme: 'vscode-userdata', path: fsPath });
    const item = resourceToQuickPickItem(uri.toString(), true);
    assert.strictEqual(
      item.description,
      '~/Library/Application Support/Cursor/User/profiles/77a16de9',
    );
  });
});

suite('mergeResults root attach', () => {
  let restore: (() => void) | undefined;

  setup(() => {
    restore = stubWorkspaceConfig({});
  });

  teardown(() => {
    restore?.();
    restore = undefined;
  });

  test('empty query returns recents without a root', () => {
    const recent = path.join(os.tmpdir(), 'ws', 'a.ts');
    assert.deepStrictEqual(mergeResults('', [], [recent]), [{ path: recent }]);
  });

  test('fzf hits keep their root; a matching recent reuses that hit', () => {
    const file = path.join(os.tmpdir(), 'ws', 'a.ts');
    const hit = { path: file, root: path.join(os.tmpdir(), 'ws') };
    assert.deepStrictEqual(mergeResults('a', [hit], [file]), [hit]);
  });

  test('explicit path candidates are promoted ahead of fzf hits', () => {
    const explicit = path.join(os.tmpdir(), 'ws', 'ignored.ts');
    const other = path.join(os.tmpdir(), 'ws', 'other.ts');
    const explicitHit = {
      path: explicit,
      root: path.join(os.tmpdir(), 'ws'),
    };
    const otherHit = { path: other, root: path.join(os.tmpdir(), 'ws') };

    assert.deepStrictEqual(
      mergeResults('ignored', [otherHit, explicitHit], [], [explicit]),
      [explicitHit, otherHit],
    );
  });
});
