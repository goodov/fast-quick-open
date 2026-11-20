/**
 * Contract for the patched fzf GET payload:
 * - change-query alone keeps previous matches while searching (TUI).
 * - clear-query+change-query empties matches while progress is below 100 (HTTP).
 */
import * as assert from 'assert';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import { getFzfPath } from '../binaries.ts';
import { readFzfListenPort } from '../fzfIndex.ts';

const fzfPath = getFzfPath(path.join(__dirname, '..', '..'));

interface FzfState {
  query: string;
  reading: boolean;
  progress: number;
  totalCount: number;
  matchCount: number;
  matches: Array<{ text: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(
  port: number,
  method: 'GET' | 'POST',
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: method === 'GET' ? '/?limit=5' : '/',
        method,
        headers: body
          ? {
              'Content-Type': 'text/plain',
              'Content-Length': Buffer.byteLength(body),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (
            !res.statusCode
            || res.statusCode < 200
            || res.statusCode >= 300
          ) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          resolve(text);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy(new Error('fzf HTTP timed out'));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function getState(port: number): Promise<FzfState> {
  const state = JSON.parse(await request(port, 'GET')) as Partial<FzfState>;
  assert.strictEqual(typeof state.query, 'string', 'fzf query is missing');
  assert.strictEqual(typeof state.reading, 'boolean', 'fzf reading is missing');
  assert.strictEqual(
    typeof state.progress,
    'number',
    'fzf progress is missing',
  );
  assert.strictEqual(
    typeof state.totalCount,
    'number',
    'fzf totalCount is missing',
  );
  assert.strictEqual(
    typeof state.matchCount,
    'number',
    'fzf matchCount is missing',
  );
  assert.ok(Array.isArray(state.matches), 'fzf matches is missing');
  for (const match of state.matches) {
    assert.strictEqual(
      typeof match.text,
      'string',
      'fzf match text is missing',
    );
  }
  return state as FzfState;
}

function changeQuery(port: number, query: string): Promise<string> {
  return request(port, 'POST', `clear-query+change-query:${query}`);
}

function changeQueryOnly(port: number, query: string): Promise<string> {
  return request(port, 'POST', `change-query:${query}`);
}

function matchTexts(state: FzfState): string[] {
  return state.matches.map((m) => m.text);
}

async function waitUntil(
  port: number,
  pred: (state: FzfState) => boolean,
  timeoutMs = 8000,
): Promise<FzfState> {
  const deadline = Date.now() + timeoutMs;
  let last: FzfState | undefined;
  while (Date.now() < deadline) {
    try {
      last = await getState(port);
      if (pred(last)) {
        return last;
      }
    } catch {
      // listen not up yet
    }
    await sleep(15);
  }
  throw new Error(`timed out waiting for fzf state: ${JSON.stringify(last)}`);
}

suite('fzf --listen progress', function () {
  this.timeout(20000);

  suiteSetup(function () {
    if (!fs.existsSync(fzfPath)) {
      this.skip();
    }
  });

  test('GET progress distinguishes in-flight and settled query results', async () => {
    const fzf: ChildProcess = spawn(
      fzfPath,
      [
        '--listen',
        '127.0.0.1:0',
        '--headless',
        '--no-mouse',
        '--no-preview',
        '--no-sort',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, FZF_DEFAULT_OPTS: '' },
      },
    );
    fzf.stderr?.resume();
    assert.ok(fzf.pid, 'fzf failed to spawn');
    assert.ok(fzf.stdout, 'fzf.stdout missing');
    const port = await readFzfListenPort(fzf.stdout);

    try {
      const n = 80_000;
      const stdin = fzf.stdin;
      assert.ok(stdin, 'fzf.stdin missing');
      const chunk: string[] = [];
      for (let i = 0; i < n; i++) {
        chunk.push(`item_${String(i).padStart(6, '0')}_apple\n`);
        if (chunk.length >= 2000) {
          stdin.write(chunk.join(''));
          chunk.length = 0;
        }
      }
      for (let i = 0; i < 20; i++) {
        chunk.push(`item_${String(i).padStart(6, '0')}_zzzzunique\n`);
      }
      stdin.end(chunk.join(''));

      await waitUntil(
        port,
        (s) => s.reading === false && s.progress === 100 && s.totalCount >= n,
      );
      await changeQuery(port, 'zzzzunique');
      const unique = await waitUntil(
        port,
        (s) =>
          s.query === 'zzzzunique'
          && s.progress === 100
          && matchTexts(s).some((t) => t.includes('zzzzunique')),
      );
      assert.ok(
        matchTexts(unique).every((t) => t.includes('zzzzunique')),
        `zzzzunique snapshot: ${matchTexts(unique).join(',')}`,
      );

      await changeQueryOnly(port, 'apple');
      const tuiDeadline = Date.now() + 5000;
      let sawTuiInFlight = false;
      while (Date.now() < tuiDeadline) {
        const state = await getState(port);
        const texts = matchTexts(state);
        if (state.query === 'apple' && state.progress < 100) {
          sawTuiInFlight = true;
          assert.ok(
            texts.some((t) => t.includes('zzzzunique')),
            `change-query alone cleared matches: ${texts.join(',')}`,
          );
          break;
        }
        if (
          state.query === 'apple'
          && state.progress === 100
          && texts.some((t) => t.includes('apple'))
        ) {
          break;
        }
        await sleep(5);
      }
      assert.ok(
        sawTuiInFlight,
        'never saw an in-flight change-query-only snapshot',
      );
      await waitUntil(
        port,
        (s) =>
          s.query === 'apple'
          && s.progress === 100
          && matchTexts(s).some((t) => t.includes('apple')),
      );

      await changeQuery(port, 'item');
      const deadline = Date.now() + 5000;
      let fresh: FzfState | undefined;
      let sawHttpInFlight = false;
      while (Date.now() < deadline) {
        const state = await getState(port);
        const texts = matchTexts(state);
        if (state.query === 'item' && state.progress < 100) {
          sawHttpInFlight = true;
          assert.ok(
            !texts.some((t) => t.includes('apple') || t.includes('zzzzunique')),
            `in-flight GET still has previous matches: ${texts.join(',')}`,
          );
          assert.strictEqual(state.matchCount, 0);
        }
        if (
          state.query === 'item'
          && state.progress === 100
          && texts.some((t) => t.includes('item'))
        ) {
          fresh = state;
          break;
        }
        await sleep(5);
      }
      assert.ok(sawHttpInFlight, 'never saw an in-flight clear-query snapshot');
      assert.ok(
        fresh,
        'never received a completed item snapshot after clear-query',
      );
      assert.ok(
        matchTexts(fresh).every((t) => t.includes('item')),
        `fresh snapshot: ${matchTexts(fresh).join(',')}`,
      );

      await changeQuery(port, 'item');
      const repeatDeadline = Date.now() + 5000;
      let repeat: FzfState | undefined;
      while (Date.now() < repeatDeadline) {
        const state = await getState(port);
        const texts = matchTexts(state);
        if (
          state.query === 'item'
          && state.progress === 100
          && texts.some((t) => t.includes('item'))
        ) {
          repeat = state;
          break;
        }
        await sleep(5);
      }
      assert.ok(repeat, 'same-query clear-query+change-query stayed empty');
      assert.ok(
        matchTexts(repeat).every((t) => t.includes('item')),
        `repeat snapshot: ${matchTexts(repeat).join(',')}`,
      );
    } finally {
      fzf.kill();
    }
  });

  test('change-query: (colon form) round-trips ")" and "\\" without escaping', async () => {
    const fzf: ChildProcess = spawn(
      fzfPath,
      [
        '--listen',
        '127.0.0.1:0',
        '--headless',
        '--no-mouse',
        '--no-preview',
        '--no-sort',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, FZF_DEFAULT_OPTS: '' },
      },
    );
    fzf.stderr?.resume();
    assert.ok(fzf.pid, 'fzf failed to spawn');
    assert.ok(fzf.stdout, 'fzf.stdout missing');
    const port = await readFzfListenPort(fzf.stdout);

    try {
      fzf.stdin?.end('foo)bar\nbaz\\qux\n');

      for (const query of [')', '\\', 'a)b\\c']) {
        await changeQuery(port, query);
        const state = await waitUntil(port, (s) => s.query === query);
        assert.strictEqual(state.query, query);
      }
    } finally {
      fzf.kill();
    }
  });
});
