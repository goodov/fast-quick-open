import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const FZF_DIR = path.join(ROOT, 'fzf');
const BIN_DIR = path.join(ROOT, 'bin');
const currentDir = `${process.platform}-${process.arch}`;
const currentOnly = process.argv.includes('--current');

interface Target {
  dir: string;
  goos: string;
  goarch: string;
  exe: boolean;
}

const TARGETS: Target[] = [
  { dir: 'darwin-arm64', goos: 'darwin', goarch: 'arm64', exe: false },
  { dir: 'darwin-x64', goos: 'darwin', goarch: 'amd64', exe: false },
  { dir: 'linux-arm64', goos: 'linux', goarch: 'arm64', exe: false },
  { dir: 'linux-x64', goos: 'linux', goarch: 'amd64', exe: false },
  { dir: 'win32-arm64', goos: 'windows', goarch: 'arm64', exe: true },
  { dir: 'win32-x64', goos: 'windows', goarch: 'amd64', exe: true },
];

function assertCheckout(): void {
  if (!fs.existsSync(FZF_DIR)) {
    throw new Error(
      'fzf/ is missing; run pnpm run fzf:sync && pnpm run fzf:patch',
    );
  }
  const gitPath = path.join(FZF_DIR, '.git');
  if (!fs.existsSync(gitPath)) {
    throw new Error(
      'fzf/ is not a git checkout; run pnpm run fzf:sync && pnpm run fzf:patch',
    );
  }
}

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: FZF_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `git ${args.join(' ')} failed (${result.status ?? 'null'})${detail ? `\n${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function versionFlags(): string {
  const version = (
    process.env.FZF_VERSION || git(['describe', '--abbrev=0'])
  ).replace(/^v/, '');
  const revision =
    process.env.FZF_REVISION
    || git(['log', '-n', '1', '--pretty=format:%h', '--abbrev=8']);
  return `-s -w -X main.version=${version} -X main.revision=${revision}`;
}

function fzfBinName(exe: boolean): string {
  return exe ? 'fzf.exe' : 'fzf';
}

function buildTarget(target: Target, ldflags: string): void {
  const dest = path.join(BIN_DIR, target.dir, fzfBinName(target.exe));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Unlink first so macOS does not reuse a stale code-signature inode.
  if (fs.existsSync(dest)) {
    fs.unlinkSync(dest);
  }

  console.log(`→ ${target.dir}`);
  const result = spawnSync(
    'go',
    ['build', '-ldflags', ldflags, '-trimpath', '-o', dest],
    {
      cwd: FZF_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: target.goos,
        GOARCH: target.goarch,
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `go build ${target.dir} failed (${result.status ?? 'null'})`,
    );
  }
  fs.chmodSync(dest, 0o755);
}

function build(): void {
  assertCheckout();
  let targets = TARGETS;
  if (currentOnly) {
    targets = TARGETS.filter((t) => t.dir === currentDir);
    if (targets.length === 0) {
      throw new Error(
        `No build mapping for ${currentDir}. Edit scripts/build-fzf.mts.`,
      );
    }
  }

  const ldflags = versionFlags();
  for (const target of targets) {
    buildTarget(target, ldflags);
  }
  console.log(`Installed into ${BIN_DIR}`);
}

build();
