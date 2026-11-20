import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getFdPath } from '../binaries.ts';

const fdPath = getFdPath(path.join(__dirname, '..', '..'));

function writeTree(root: string, files: string[]): void {
  for (const file of files) {
    const abs = path.join(root, file.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'x');
  }
}

function createTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-fd-'));
  writeTree(root, [
    'a.txt',
    'node_modules/top.txt',
    'src/srcA.txt',
    'src/nested/n.txt',
    'src/node_modules/nested.txt',
    'third_party/t.txt',
    'third_party/blink/b.txt',
    'third_party/other/o.txt',
    'sub/third_party/st.txt',
    'sub/keep/k.txt',
  ]);
  return root;
}

function createSiblingFolders(): {
  parent: string;
  folderA: string;
  folderB: string;
} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-fd-siblings-'));
  const folderA = path.join(parent, 'folderA');
  const folderB = path.join(parent, 'folderB');
  writeTree(folderA, ['a.txt', 'node_modules/nmA.txt', 'src/srcA.txt']);
  writeTree(folderB, ['b.txt', 'node_modules/nmB.txt', 'src/srcB.txt']);
  return { parent, folderA, folderB };
}

function runFd(
  root: string,
  excludes: string[],
  searchPaths: string[],
  options?: { cwd?: string; baseDirectory?: string },
): string[] {
  const args: string[] = [];
  for (const pattern of excludes) {
    args.push('--exclude', pattern);
  }
  args.push('--type', 'f', '--path-separator', '/', '--no-ignore');
  const baseDirectory = options?.baseDirectory ?? root;
  args.push('--base-directory', baseDirectory, '.', ...searchPaths);
  const result = spawnSync(fdPath, args, {
    encoding: 'utf8',
    cwd: options?.cwd,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0)
    .sort();
}

/** Like runFd but respects gitignore (no --no-ignore). */
function runFdRespectIgnore(
  baseDirectory: string,
  excludes: string[],
  searchPaths: string[],
): string[] {
  const args: string[] = [];
  for (const pattern of excludes) {
    args.push('--exclude', pattern);
  }
  args.push(
    '--type',
    'f',
    '--path-separator',
    '/',
    '--base-directory',
    baseDirectory,
    '.',
    ...searchPaths,
  );
  const result = spawnSync(fdPath, args, { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter((line) => line.length > 0)
    .sort();
}

function gitInit(dir: string): void {
  const init = spawnSync('git', ['init', '-q'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.strictEqual(init.status, 0, init.stderr);
}

suite('fd exclude behavior', () => {
  let root: string | undefined;
  let siblings:
    { parent: string; folderA: string; folderB: string } | undefined;

  suiteSetup(function () {
    if (!fs.existsSync(fdPath)) {
      this.skip();
    }
    root = createTree();
    siblings = createSiblingFolders();
  });

  suiteTeardown(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    if (siblings) {
      fs.rmSync(siblings.parent, { recursive: true, force: true });
    }
  });

  test('an anchored exclude only applies to the search root', () => {
    assert.deepStrictEqual(runFd(root!, ['/third_party'], ['.']), [
      'a.txt',
      'node_modules/top.txt',
      'src/nested/n.txt',
      'src/node_modules/nested.txt',
      'src/srcA.txt',
      'sub/keep/k.txt',
      'sub/third_party/st.txt',
    ]);
  });

  test('an unanchored exclude applies at any depth', () => {
    assert.deepStrictEqual(runFd(root!, ['third_party'], ['.']), [
      'a.txt',
      'node_modules/top.txt',
      'src/nested/n.txt',
      'src/node_modules/nested.txt',
      'src/srcA.txt',
      'sub/keep/k.txt',
    ]);
  });

  test('an explicit search path is walked despite an exclude on its parent', () => {
    assert.deepStrictEqual(
      runFd(root!, ['/third_party'], ['.', './third_party/blink']),
      [
        'a.txt',
        'node_modules/top.txt',
        'src/nested/n.txt',
        'src/node_modules/nested.txt',
        'src/srcA.txt',
        'sub/keep/k.txt',
        'sub/third_party/st.txt',
        'third_party/blink/b.txt',
      ],
    );
    assert.deepStrictEqual(
      runFd(root!, ['third_party'], ['.', './third_party/blink']),
      [
        'a.txt',
        'node_modules/top.txt',
        'src/nested/n.txt',
        'src/node_modules/nested.txt',
        'src/srcA.txt',
        'sub/keep/k.txt',
        'third_party/blink/b.txt',
      ],
    );
  });

  test('/node_modules with first path . drops only top-level node_modules', () => {
    const out = runFd(root!, ['/node_modules'], ['.']);
    assert.ok(!out.includes('node_modules/top.txt'));
    assert.ok(out.includes('src/node_modules/nested.txt'));
  });

  test('first path ./src only: /node_modules drops src/node_modules; /src/nested does not', () => {
    assert.deepStrictEqual(runFd(root!, ['/node_modules'], ['./src']), [
      'src/nested/n.txt',
      'src/srcA.txt',
    ]);
    // /src/nested is relative to first path ./src → means src/src/nested
    assert.deepStrictEqual(runFd(root!, ['/src/nested'], ['./src']), [
      'src/nested/n.txt',
      'src/node_modules/nested.txt',
      'src/srcA.txt',
    ]);
    assert.deepStrictEqual(runFd(root!, ['/nested'], ['./src']), [
      'src/node_modules/nested.txt',
      'src/srcA.txt',
    ]);
  });

  test('two sibling search paths: /node_modules only hits the first path', () => {
    const { parent, folderA, folderB } = siblings!;
    const aThenB = runFd(parent, ['/node_modules'], ['./folderA', './folderB']);
    assert.ok(!aThenB.includes('folderA/node_modules/nmA.txt'));
    assert.ok(aThenB.includes('folderB/node_modules/nmB.txt'));

    const bThenA = runFd(parent, ['/node_modules'], ['./folderB', './folderA']);
    assert.ok(bThenA.includes('folderA/node_modules/nmA.txt'));
    assert.ok(!bThenA.includes('folderB/node_modules/nmB.txt'));

    // Per-folder fd bases (how the extension groups) apply /node_modules to each.
    assert.ok(
      !runFd(folderA, ['/node_modules'], ['.']).includes(
        'node_modules/nmA.txt',
      ),
    );
    assert.ok(
      !runFd(folderB, ['/node_modules'], ['.']).includes(
        'node_modules/nmB.txt',
      ),
    );
  });

  test('unanchored node_modules applies at any depth in all search paths', () => {
    const { parent } = siblings!;
    const out = runFd(parent, ['node_modules'], ['./folderA', './folderB']);
    assert.ok(!out.some((p) => p.includes('node_modules')));
    assert.ok(out.includes('folderA/a.txt'));
    assert.ok(out.includes('folderB/b.txt'));
  });

  test('overlapping . and ./src duplicates src files', () => {
    const out = runFd(root!, [], ['.', './src']);
    const srcHits = out.filter((p) => p === 'src/srcA.txt');
    assert.ok(
      srcHits.length >= 2,
      `expected duplicate src/srcA.txt listings, got ${out.join(',')}`,
    );
  });

  test('--base-directory is not the exclude anchor; first search path is', () => {
    const out = runFd(root!, ['/node_modules'], ['.'], {
      cwd: os.tmpdir(),
      baseDirectory: root!,
    });
    assert.ok(!out.includes('node_modules/top.txt'));
    assert.ok(out.includes('src/node_modules/nested.txt'));
  });
});

suite('fd nested root / gitignore hole-punch', () => {
  let plainRoot: string | undefined;
  let nestedRepoRoot: string | undefined;
  let dupRoot: string | undefined;

  suiteSetup(function () {
    if (!fs.existsSync(fdPath)) {
      this.skip();
    }
    const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (gitCheck.status !== 0) {
      this.skip();
    }

    plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-fd-plain-'));
    writeTree(plainRoot, ['keep/k.txt', 'nested/n.txt', 'nested/deep/d.txt']);
    gitInit(plainRoot);
    fs.writeFileSync(path.join(plainRoot, '.gitignore'), 'nested/\n');

    nestedRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-fd-nrepo-'));
    writeTree(nestedRepoRoot, [
      'keep/k.txt',
      'vendor/lib/v.txt',
      'vendor/lib/secret/x.txt',
    ]);
    gitInit(nestedRepoRoot);
    fs.writeFileSync(path.join(nestedRepoRoot, '.gitignore'), 'vendor/\n');
    gitInit(path.join(nestedRepoRoot, 'vendor', 'lib'));
    fs.writeFileSync(
      path.join(nestedRepoRoot, 'vendor', 'lib', '.gitignore'),
      'secret/\n',
    );

    dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-fd-dup-'));
    writeTree(dupRoot, ['keep/k.txt', 'nested/n.txt']);
    gitInit(dupRoot);
  });

  suiteTeardown(() => {
    for (const dir of [plainRoot, nestedRepoRoot, dupRoot]) {
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('parent .gitignore nested/: parent walk omits; nested base lists files', () => {
    assert.deepStrictEqual(runFdRespectIgnore(plainRoot!, [], ['.']), [
      'keep/k.txt',
    ]);
    assert.deepStrictEqual(
      runFdRespectIgnore(path.join(plainRoot!, 'nested'), [], ['.']),
      ['deep/d.txt', 'n.txt'],
    );
  });

  test('nested git repo: own base respects inner .gitignore', () => {
    const nestedBase = path.join(nestedRepoRoot!, 'vendor', 'lib');
    assert.deepStrictEqual(runFdRespectIgnore(nestedRepoRoot!, [], ['.']), [
      'keep/k.txt',
    ]);
    assert.deepStrictEqual(runFdRespectIgnore(nestedBase, [], ['.']), [
      'v.txt',
    ]);
  });

  test('parent --exclude /nested punches a hole (omits nested files)', () => {
    assert.deepStrictEqual(runFdRespectIgnore(plainRoot!, ['/nested'], ['.']), [
      'keep/k.txt',
    ]);
  });

  test('. + ./nested without exclude duplicates when dir is not gitignored', () => {
    const out = runFdRespectIgnore(dupRoot!, [], ['.', './nested']);
    const hits = out.filter((p) => p === 'nested/n.txt');
    assert.ok(
      hits.length >= 2,
      `expected duplicate nested/n.txt, got ${out.join(',')}`,
    );
  });
});
