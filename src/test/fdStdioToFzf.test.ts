/**
 * Reference: feed several fd processes into one fzf stdin at the OS fd level.
 *
 * The listing stream must never enter Node (`pipe()`, `PassThrough`, or
 * `stdout.on('data')`). Each fd is spawned with `stdio: ['ignore', fzf.stdin,
 * 'pipe']` so the kernel dups the write end. After the last fd exits, close
 * the parent write end (`fzf.stdin.end()`) so fzf sees EOF.
 */
import * as assert from 'assert';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { getFdPath, getFzfPath } from '../binaries.ts';
import { readFzfListenPort } from '../fzfIndex.ts';

const extensionPath = path.join(__dirname, '..', '..');
const fdPath = getFdPath(extensionPath);
const fzfPath = getFzfPath(extensionPath);

interface FzfState {
  reading?: boolean;
  totalCount?: number;
  matches?: Array<{ text: string }>;
}

interface FdRun {
  code: number | null;
  stderr: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(port: number): Promise<FzfState> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/?limit=50`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text) as FzfState);
        } catch {
          reject(new Error(`Invalid JSON from fzf: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('fzf GET timed out'));
    });
  });
}

function assertNoListingHooks(fzf: ChildProcess, label: string): void {
  const stdin = fzf.stdin;
  if (!stdin) {
    throw new Error(`${label}: fzf.stdin missing`);
  }
  if (stdin.listenerCount('data') > 0 || stdin.listenerCount('readable') > 0) {
    throw new Error(`${label}: listing stream has Node data hooks`);
  }
}

function spawnFzf(): ChildProcess {
  const fzf = spawn(
    fzfPath,
    [
      '--listen',
      '127.0.0.1:0',
      '--headless',
      '--no-mouse',
      '--no-preview',
      '--read0',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  fzf.stderr?.resume();
  return fzf;
}

async function waitUntilListening(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await getJson(port);
      return;
    } catch (err) {
      last = err;
      await sleep(30);
    }
  }
  throw new Error(`fzf listen did not come up: ${String(last)}`);
}

/** Sequential fd argv lists, all writing to the same fzf stdin fd. */
async function feedFdLoop(
  fzf: ChildProcess,
  commands: string[][],
): Promise<FdRun[]> {
  const stdin = fzf.stdin;
  if (!stdin) {
    throw new Error('fzf.stdin missing');
  }

  const runs: FdRun[] = [];
  for (const argv of commands) {
    assertNoListingHooks(fzf, `before ${argv.slice(1, 4).join(' ')}`);
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ['ignore', stdin, 'pipe'],
      windowsHide: true,
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    const close = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    runs.push({
      code: close.code,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    });
  }

  assertNoListingHooks(fzf, 'before stdin.end');
  stdin.end();
  return runs;
}

async function waitUntilIdle(port: number): Promise<FzfState> {
  const deadline = Date.now() + 8000;
  let last: FzfState | undefined;
  while (Date.now() < deadline) {
    last = await getJson(port);
    if (last.reading === false) {
      return last;
    }
    await sleep(30);
  }
  throw new Error(
    `fzf still reading after timeout (totalCount=${last?.totalCount})`,
  );
}

function fdListingArgs(groupIndex: number, base: string): string[] {
  return [
    fdPath,
    '--type',
    'f',
    '--type',
    'l',
    '--path-separator',
    '/',
    '--print0',
    '--base-directory',
    base,
    '--format',
    `${groupIndex}/{}`,
    '.',
  ];
}

async function withFzf<T>(
  fn: (fzf: ChildProcess, port: number) => Promise<T>,
): Promise<T> {
  const fzf = spawnFzf();
  try {
    assert.ok(fzf.pid, 'fzf failed to spawn');
    assert.ok(fzf.stdout, 'fzf.stdout missing');
    const port = await readFzfListenPort(fzf.stdout);
    await waitUntilListening(port);
    return await fn(fzf, port);
  } finally {
    fzf.kill();
  }
}

function matchTexts(state: FzfState): string[] {
  return (state.matches ?? []).map((m) => m.text).sort();
}

suite('fd stdio into fzf', function () {
  this.timeout(15000);

  let fixture: string | undefined;

  suiteSetup(function () {
    if (!fs.existsSync(fdPath) || !fs.existsSync(fzfPath)) {
      this.skip();
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-fd-stdio-'));
    for (const [dir, file] of [
      ['group-a', 'alpha.txt'],
      ['group-b', 'beta.txt'],
      ['group-c', 'gamma.txt'],
    ] as const) {
      const dirPath = path.join(root, dir);
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, file), `${file}\n`);
    }
    fixture = root;
  });

  suiteTeardown(() => {
    if (fixture) {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('three fd processes merge into one fzf list', async () => {
    const commands = ['group-a', 'group-b', 'group-c'].map((dir, i) =>
      fdListingArgs(i, path.join(fixture!, dir)),
    );

    await withFzf(async (fzf, port) => {
      const runs = await feedFdLoop(fzf, commands);
      for (const [i, run] of runs.entries()) {
        assert.strictEqual(run.code, 0, `fd[${i}] exit`);
        assert.strictEqual(run.stderr.trim(), '', `fd[${i}] stderr`);
      }

      const state = await waitUntilIdle(port);
      assert.strictEqual(state.totalCount, 3);
      assert.deepStrictEqual(matchTexts(state), [
        '0/./alpha.txt',
        '1/./beta.txt',
        '2/./gamma.txt',
      ]);
    });
  });

  test('a failed middle fd still lets later groups reach fzf', async () => {
    const commands = [
      fdListingArgs(0, path.join(fixture!, 'group-a')),
      [fdPath, '--not-a-real-flag', '--print0', '.'],
      fdListingArgs(2, path.join(fixture!, 'group-c')),
    ];

    await withFzf(async (fzf, port) => {
      const runs = await feedFdLoop(fzf, commands);
      assert.strictEqual(runs[0]?.code, 0, 'fd[0] exit');
      assert.strictEqual(runs[1]?.code, 2, 'fd[1] exit (bad flag)');
      assert.match(runs[1]?.stderr ?? '', /unexpected argument/);
      assert.strictEqual(runs[2]?.code, 0, 'fd[2] exit');

      const state = await waitUntilIdle(port);
      assert.strictEqual(state.totalCount, 2);
      assert.deepStrictEqual(matchTexts(state), [
        '0/./alpha.txt',
        '2/./gamma.txt',
      ]);
    });
  });
});
