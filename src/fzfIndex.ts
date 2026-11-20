import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { type FdCommandSpec, type IndexBuild } from './fdCommand.ts';
import { argvToShellSyntaxForLogging } from './helpers/shellUtils.ts';
import { showErrorMessage } from './helpers/vscodeUtils.ts';
import Log from './log.ts';
import { getFzfPath } from './binaries.ts';

export interface SearchResultMeta {
  /** fzf is still loading input, or a search for this query is in flight. */
  indexing: boolean;
}

/** One fzf match decoded from `N/rel` plus the fd-group root (`specs[N].base`). */
export interface FzfHit {
  path: string;
  root: string;
}

interface FzfMatch {
  text: string;
}

interface FzfState {
  query: string;
  matches: FzfMatch[];
  reading?: boolean;
  progress?: number;
  totalCount?: number;
  matchCount?: number;
}

function hitSnapshotKey(hit: FzfHit): string {
  return `${hit.path}\0${hit.root}`;
}

/**
 * Searchable `/`-fields after the group index.
 * Unlabeled: `N/./rel` — skip `N` and `.` (`3..`).
 * Labeled: `N/Name/./rel` or `N//./rel` — keep the label field through the
 * path (`2..`) so `Name/rel` matches. The `.` from fd stays searchable.
 */
export function fzfNthForBuild(
  build: Pick<IndexBuild, 'filterLabels'>,
): string {
  return build.filterLabels ? '2..' : '3..';
}

/** fzf process argv (scheme + extra flags). Reads NUL-delimited paths on stdin. */
export function buildFzfArgs(
  fzfExtraFlags: string[] | undefined,
  nth: string,
): string[] {
  const extraFlags = fzfExtraFlags ?? [];
  return [
    '--listen',
    '127.0.0.1:0',
    '--headless',
    '--scheme=path',
    '--no-mouse',
    '--no-preview',
    '--read0',
    '--delimiter',
    '/',
    '--nth',
    nth,
    ...extraFlags,
  ];
}

/** First stdout line from patched `--headless --listen` is `{"port":N}`. */
export function readFzfListenPort(
  stdout: NodeJS.ReadableStream,
  timeoutMs = 10000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const finish = (err: Error | undefined, port?: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.off('data', onData);
      stdout.off('end', onEnd);
      stdout.off('error', onError);
      stdout.resume();
      if (err) {
        reject(err);
      } else {
        resolve(port!);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error('timed out waiting for fzf listen port'));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        return;
      }
      const line = buf.slice(0, nl).trim();
      try {
        const parsed = JSON.parse(line) as { port?: unknown };
        if (
          typeof parsed.port !== 'number'
          || !Number.isInteger(parsed.port)
          || parsed.port <= 0
          || parsed.port > 65535
        ) {
          finish(new Error(`invalid fzf listen port: ${line}`));
          return;
        }
        finish(undefined, parsed.port);
      } catch {
        finish(new Error(`invalid fzf listen line: ${line}`));
      }
    };
    const onEnd = () => {
      finish(
        new Error(
          `fzf exited before announcing listen port: ${buf.trim().slice(0, 200)}`,
        ),
      );
    };
    const onError = (err: Error) => {
      finish(err);
    };
    stdout.on('data', onData);
    stdout.on('end', onEnd);
    stdout.on('error', onError);
  });
}

function normalizeQuery(text: string): string {
  return text.replace(/\\/g, '/');
}

function isStillIndexing(state: FzfState): boolean {
  if (state.reading) {
    return true;
  }
  if (typeof state.progress === 'number' && state.progress < 100) {
    return true;
  }
  return false;
}

export function decodeIndexedLine(
  text: string,
  specs: FdCommandSpec[],
): FzfHit | undefined {
  const slash = text.indexOf('/');
  if (slash <= 0) {
    return undefined;
  }
  const index = Number.parseInt(text.slice(0, slash), 10);
  if (!Number.isFinite(index) || index < 0 || index >= specs.length) {
    return undefined;
  }
  let relative = text.slice(slash + 1);
  if (!relative) {
    return undefined;
  }
  const spec = specs[index]!;
  if (spec.filterLabel !== undefined) {
    const label = spec.filterLabel;
    if (relative === label) {
      relative = '';
    } else if (relative.startsWith(`${label}/`)) {
      relative = relative.slice(label.length + 1);
    } else {
      return undefined;
    }
  }
  if (relative.startsWith('./')) {
    relative = relative.slice(2);
  }
  if (!relative) {
    return undefined;
  }
  return {
    path: path.normalize(
      path.join(spec.base, relative.replace(/\//g, path.sep)),
    ),
    root: spec.base,
  };
}

function hitsFromState(
  state: FzfState,
  limit: number,
  specs: FdCommandSpec[],
): FzfHit[] {
  const result: FzfHit[] = [];
  for (const match of state.matches || []) {
    const text = match.text;
    if (!text || text.trim() === '') {
      continue;
    }
    const decoded = decodeIndexedLine(text, specs);
    if (decoded) {
      result.push(decoded);
    }
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function delay(ms: number, isCancelled?: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isCancelled?.()) {
      reject(new Error('aborted'));
      return;
    }
    setTimeout(() => {
      if (isCancelled?.()) {
        reject(new Error('aborted'));
      } else {
        resolve();
      }
    }, ms);
  });
}

function killProcess(proc: ChildProcess | undefined): void {
  if (!proc) {
    return;
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

/**
 * One fzf --listen process fed by sequential fd commands on stdin.
 */
export default class FzfIndex implements vscode.Disposable {
  private readonly fzfPath: string;
  private build: IndexBuild;
  private fzf: ChildProcess | undefined;
  private currentFd: ChildProcess | undefined;
  private feedGeneration = 0;
  private port: number | undefined;
  private readyPromise: Promise<void>;
  private disposed = false;
  private queryEpoch = 0;
  private lastNotifiedError: string | undefined;
  private fzfStderrTail = '';

  constructor(extensionPath: string, build: IndexBuild) {
    this.fzfPath = getFzfPath(extensionPath);
    this.build = build;
    this.readyPromise = this.start();
  }

  private get specs(): FdCommandSpec[] {
    return this.build.specs;
  }

  private get logPrefix(): string {
    return this.build.scope.label;
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private logFzfState(
    context: string,
    state: FzfState,
    extra?: Record<string, unknown>,
  ): void {
    Log.trace?.(`[${this.logPrefix}]`, 'fzf state', {
      context,
      state,
      extra,
    });
  }

  private killCurrentFd(): void {
    const fd = this.currentFd;
    this.currentFd = undefined;
    killProcess(fd);
  }

  /** Stop feeding and kill both processes. In-flight feed sees a new generation. */
  private stopChain(): void {
    this.feedGeneration += 1;
    this.killCurrentFd();
    const fzf = this.fzf;
    this.fzf = undefined;
    this.port = undefined;
    killProcess(fzf);
  }

  private handleProcessExit(
    proc: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.fzf !== proc) {
      return;
    }
    Log.debug?.(`[${this.logPrefix}]`, 'fzf closed', {
      code,
      signal,
      disposed: this.disposed,
    });
    this.killCurrentFd();
    this.fzf = undefined;
    this.port = undefined;
    if (this.disposed) {
      return;
    }
    this.feedGeneration += 1;
    const stderr = this.fzfStderrTail.trim();
    const status = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
    this.reportFailure('fzf', stderr || `fzf exited unexpectedly (${status})`, {
      code,
      signal,
    });
    Log.debug?.(`[${this.logPrefix}]`, 'fzf exited unexpectedly; restarting');
    this.readyPromise = this.restart();
  }

  private async restart(): Promise<void> {
    await new Promise((r) => setTimeout(r, 250));
    if (this.disposed) {
      return;
    }
    await this.start();
  }

  private reportFailure(
    kind: 'fd' | 'fzf',
    detail: string,
    extra?: Record<string, unknown>,
  ): void {
    const text = detail.trim() || `${kind} failed`;
    Log.error?.(`[${this.logPrefix}]`, `${kind} failed`, {
      detail: text,
      ...extra,
    });
    const preview = text.replace(/\s+/g, ' ').slice(0, 240);
    const exit = typeof extra?.code === 'number' ? ` (exit ${extra.code})` : '';
    const headline =
      kind === 'fd' ? `fd indexing failed${exit}` : `fzf failed${exit}`;
    const message = `(${this.logPrefix}): ${headline}. ${preview}`;
    if (message === this.lastNotifiedError) {
      return;
    }
    this.lastNotifiedError = message;
    void showErrorMessage(message);
  }

  private reportFdFailure(
    stderr: string,
    code: number | null,
    argv: string[],
  ): void {
    this.reportFailure(
      'fd',
      stderr.trim() || `fd exited ${code ?? 'unknown'}`,
      {
        code,
        args: argv.slice(1),
      },
    );
  }

  /**
   * Sequential fd → fzf.stdin via OS fd dup. Does not read the listing in Node.
   * Completes in the background so `ready` only waits for the listen port.
   */
  private async feedFd(
    generation: number,
    fzf: ChildProcess,
    specs: FdCommandSpec[],
  ): Promise<void> {
    const stdin = fzf.stdin;
    if (!stdin) {
      Log.error?.(`[${this.logPrefix}]`, 'fzf stdin missing');
      return;
    }

    let anyFailed = false;
    for (const spec of specs) {
      if (
        this.disposed
        || generation !== this.feedGeneration
        || this.fzf !== fzf
      ) {
        return;
      }

      const argv = spec.command;

      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', stdin, 'pipe'],
        windowsHide: true,
      });
      this.currentFd = child;

      const stderrChunks: Buffer[] = [];
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      let code: number | null = null;
      let signal: NodeJS.Signals | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (exitCode, exitSignal) => {
            code = exitCode;
            signal = exitSignal;
            resolve();
          });
        });
      } catch (err) {
        if (this.currentFd === child) {
          this.currentFd = undefined;
        }
        if (
          generation !== this.feedGeneration
          || this.disposed
          || this.fzf !== fzf
        ) {
          return;
        }
        anyFailed = true;
        this.reportFdFailure((err as Error).message, null, argv);
        continue;
      }

      if (this.currentFd === child) {
        this.currentFd = undefined;
      }

      if (
        generation !== this.feedGeneration
        || this.disposed
        || this.fzf !== fzf
      ) {
        return;
      }
      if (signal) {
        return;
      }

      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        anyFailed = true;
        this.reportFdFailure(stderr, code, argv);
        continue;
      }
      if (stderr.trim()) {
        Log.warn?.(`[${this.logPrefix}]`, 'fd stderr', stderr.trim());
      }
    }

    if (
      generation === this.feedGeneration
      && this.fzf === fzf
      && fzf.stdin
      && !fzf.killed
    ) {
      fzf.stdin.end();
      if (!anyFailed) {
        this.lastNotifiedError = undefined;
      }
    }
  }

  private async start(): Promise<void> {
    const fzfArgs = buildFzfArgs(
      this.build.scope.fzfExtraFlags,
      fzfNthForBuild(this.build),
    );
    Log.debug?.(`[${this.logPrefix}]`, 'start', {
      fdCommands: this.specs.map((s) => argvToShellSyntaxForLogging(s.command)),
      bases: this.specs.map((s) => s.base),
    });
    Log.debug?.(`[${this.logPrefix}]`, 'fzf command', {
      executable: this.fzfPath,
      args: fzfArgs,
      line: argvToShellSyntaxForLogging([this.fzfPath, ...fzfArgs]),
    });
    if (this.disposed) {
      return;
    }

    let fzf: ChildProcess;
    try {
      fzf = spawn(this.fzfPath, fzfArgs, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.reportFailure('fzf', (err as Error).message);
      this.port = undefined;
      return;
    }

    this.fzf = fzf;
    this.fzfStderrTail = '';
    Log.debug?.(`[${this.logPrefix}]`, 'fzf spawned', { pid: fzf.pid });
    fzf.stderr?.on('data', (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      this.fzfStderrTail = (this.fzfStderrTail + text).slice(-2000);
      const trimmed = text.trim();
      if (trimmed) {
        Log.debug?.(`[${this.logPrefix}]`, 'fzf stderr', trimmed);
      }
    });
    fzf.on('error', (err) => {
      Log.error?.(`[${this.logPrefix}]`, 'fzf process error', err.message);
    });
    fzf.on('close', (code, signal) => {
      this.handleProcessExit(fzf, code, signal);
    });

    const generation = this.feedGeneration;
    void this.feedFd(generation, fzf, this.specs).catch((err) => {
      Log.error?.(
        `[${this.logPrefix}]`,
        'fd feed failed',
        (err as Error).message,
      );
    });

    let port: number;
    try {
      if (!fzf.stdout) {
        throw new Error('fzf stdout missing');
      }
      port = await readFzfListenPort(fzf.stdout);
    } catch (err) {
      if (this.disposed) {
        return;
      }
      this.reportFailure('fzf', (err as Error).message);
      this.port = undefined;
      killProcess(fzf);
      return;
    }
    if (this.disposed) {
      return;
    }
    this.port = port;
    Log.debug?.(`[${this.logPrefix}]`, 'fzf listen', { port, pid: fzf.pid });

    await this.waitUntilReady(port);
  }

  /**
   * Resolves when fzf has finished ingesting (`!reading`, and `progress >= 100`).
   * Survives a crash-restart of this instance. Returns early on dispose/cancel.
   */
  async waitUntilLoaded(isCancelled?: () => boolean): Promise<void> {
    const isStale = () => this.disposed || !!isCancelled?.();
    const pollIntervalMs = 20;

    while (!isStale()) {
      await this.ready;
      if (isStale()) {
        return;
      }
      if (!this.port) {
        try {
          await delay(pollIntervalMs, isStale);
        } catch {
          return;
        }
        continue;
      }

      try {
        const raw = await this.httpRequest(
          'GET',
          this.port,
          '/?limit=1',
          undefined,
          isStale,
        );
        if (isStale()) {
          return;
        }
        const state = JSON.parse(raw) as FzfState;
        if (!isStillIndexing(state)) {
          this.logFzfState('loaded', state);
          return;
        }
      } catch {
        if (isStale()) {
          return;
        }
        Log.trace?.(`[${this.logPrefix}]`, 'loaded probe failed');
      }

      try {
        await delay(pollIntervalMs, isStale);
      } catch {
        return;
      }
    }
  }

  private async waitUntilReady(port: number): Promise<void> {
    const deadline = Date.now() + 10000;
    let attempts = 0;
    while (!this.disposed && Date.now() < deadline) {
      attempts += 1;
      try {
        const raw = await this.httpRequest('GET', port, '/?limit=1');
        const state = JSON.parse(raw) as FzfState;
        this.logFzfState('ready', state, { attempts });
        return;
      } catch (err) {
        Log.trace?.(`[${this.logPrefix}]`, 'ready probe failed', {
          attempts,
          error: (err as Error).message,
        });
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!this.disposed) {
      Log.error?.(`[${this.logPrefix}]`, 'listen server did not become ready', {
        attempts,
        port,
      });
    }
  }

  private httpRequest(
    method: 'GET' | 'POST',
    port: number,
    urlPath: string,
    body?: string,
    isCancelled?: () => boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (isCancelled?.()) {
        reject(new Error('aborted'));
        return;
      }

      const started = Date.now();
      Log.trace?.(
        `[${this.logPrefix}]`,
        'http →',
        method,
        `http://127.0.0.1:${port}${urlPath}`,
        body ?? '',
      );

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          agent: false,
          headers: {
            Connection: 'close',
            ...(body
              ? {
                  'Content-Type': 'text/plain',
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const ms = Date.now() - started;
            if (isCancelled?.()) {
              reject(new Error('aborted'));
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (
              res.statusCode
              && res.statusCode >= 200
              && res.statusCode < 300
            ) {
              Log.trace?.(
                `[${this.logPrefix}]`,
                'http ←',
                method,
                urlPath,
                res.statusCode,
                `${ms}ms`,
              );
              resolve(text);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${text}`));
            }
          });
        },
      );

      req.on('error', (err) => {
        if (isCancelled?.()) {
          reject(new Error('aborted'));
          return;
        }
        Log.error?.(
          `[${this.logPrefix}]`,
          'http ✕',
          method,
          urlPath,
          err.message,
        );
        reject(err);
      });
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  async runQuery(
    fzfQuery: string,
    isCancelled: () => boolean,
    onResult: (hits: FzfHit[], meta: SearchResultMeta) => void,
    maxItems: number,
  ): Promise<void> {
    const epoch = ++this.queryEpoch;
    const isStale = () =>
      epoch !== this.queryEpoch || isCancelled() || this.disposed || !this.port;

    await this.ready;
    if (isStale()) {
      return;
    }

    await this.httpRequest(
      'POST',
      this.port!,
      '/',
      // `:` is fzf's no-escaping action-argument form: since change-query is
      // the last (and only other) action here, it takes the rest of the
      // line verbatim, including `)` and `\`. The paren form's escaping is
      // never undone by fzf, which otherwise stalls polling forever.
      `clear-query+change-query:${fzfQuery}`,
      isStale,
    );

    if (isStale()) {
      return;
    }

    const pollIntervalMs = 20;
    const pollDeadline = Date.now() + 10 * 60 * 1000;
    const limit = maxItems;
    let lastEmittedKey = '';
    let wasIndexing = false;

    while (!isStale() && Date.now() < pollDeadline) {
      const raw = await this.httpRequest(
        'GET',
        this.port!,
        `/?limit=${limit}`,
        undefined,
        isStale,
      );

      if (isStale()) {
        return;
      }

      const state = JSON.parse(raw) as FzfState;
      const returnedQuery = normalizeQuery(state.query || '');
      const expectedQuery = normalizeQuery(fzfQuery);

      if (returnedQuery !== expectedQuery) {
        const indexing = isStillIndexing(state);
        if (indexing) {
          Log.debug?.(
            `[${this.logPrefix}]`,
            'query mismatch while indexing, keep polling',
            {
              expected: fzfQuery,
              got: state.query,
              reading: state.reading,
              progress: state.progress,
            },
          );
          onResult([], { indexing: true });
          wasIndexing = true;
          await delay(pollIntervalMs, isStale);
          continue;
        }
        Log.debug?.(`[${this.logPrefix}]`, 'stale GET dropped', {
          expected: fzfQuery,
          got: state.query,
        });
        await delay(pollIntervalMs, isStale);
        continue;
      }

      const indexing = isStillIndexing(state);
      const hits = hitsFromState(state, limit, this.specs);
      this.logFzfState('poll', state, { fzfQuery, limit, indexing });

      if (indexing) {
        const emitKey = hits.map(hitSnapshotKey).join('\0');
        if (emitKey !== lastEmittedKey || wasIndexing) {
          lastEmittedKey = emitKey;
          wasIndexing = true;
          onResult(hits, { indexing: true });
        }
        await delay(pollIntervalMs, isStale);
        continue;
      }

      onResult(hits, { indexing: false });
      return;
    }
  }

  dispose(): void {
    Log.debug?.(`[${this.logPrefix}]`, 'dispose');
    this.disposed = true;
    this.stopChain();
  }
}
