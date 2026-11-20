import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const FZF_DIR = path.join(ROOT, 'fzf');
const PATCH_DIR = path.join(ROOT, 'patches', 'fzf');

function git(
  cwd: string,
  args: string[],
  opts?: { allowFail?: boolean; inherit?: boolean },
): { status: number; stdout: string; stderr: string } {
  const spawnOpts: SpawnSyncOptions = opts?.inherit
    ? { cwd, stdio: 'inherit' }
    : { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const result = spawnSync('git', args, spawnOpts);
  if (result.error) {
    throw result.error;
  }
  const status = result.status ?? 1;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (status !== 0 && !opts?.allowFail) {
    const detail = (stderr || stdout).trim();
    throw new Error(
      `git ${args.join(' ')} failed (${status})${detail ? `\n${detail}` : ''}`,
    );
  }
  return { status, stdout, stderr };
}

function assertRegistered(): void {
  const gitmodules = path.join(ROOT, '.gitmodules');
  if (!fs.existsSync(gitmodules)) {
    throw new Error('fzf is not a git submodule (.gitmodules missing)');
  }
  const listed = git(
    ROOT,
    ['config', '-f', '.gitmodules', '--get', 'submodule.fzf.path'],
    { allowFail: true },
  );
  if (listed.status !== 0 || listed.stdout.trim() !== 'fzf') {
    throw new Error('fzf is not listed as a git submodule in .gitmodules');
  }
}

function assertCheckout(): void {
  assertRegistered();
  if (!fs.existsSync(FZF_DIR)) {
    throw new Error('fzf/ is missing; run pnpm run fzf:sync');
  }
  const gitPath = path.join(FZF_DIR, '.git');
  if (!fs.existsSync(gitPath)) {
    throw new Error('fzf/ is not a git checkout; run pnpm run fzf:sync');
  }
  if (fs.statSync(gitPath).isDirectory()) {
    throw new Error(
      'fzf/ looks like a standalone clone, not a submodule. Replace it with: pnpm run fzf:sync',
    );
  }
}

function pinnedSha(): string {
  const staged = git(ROOT, ['ls-files', '-s', 'fzf']);
  const line = staged.stdout.trim().split('\n')[0] ?? '';
  const match = line.match(/^160000\s+([0-9a-f]{40})\s+\d+\s+fzf$/);
  if (match) {
    return match[1];
  }
  const head = git(ROOT, ['rev-parse', 'HEAD:fzf'], { allowFail: true });
  if (head.status === 0 && head.stdout.trim()) {
    return head.stdout.trim();
  }
  throw new Error('Could not resolve the pinned fzf gitlink SHA');
}

function listPatches(): string[] {
  if (!fs.existsSync(PATCH_DIR)) {
    throw new Error(`Missing ${path.relative(ROOT, PATCH_DIR)}`);
  }
  return fs
    .readdirSync(PATCH_DIR)
    .filter((name) => name.endsWith('.patch'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => path.join(PATCH_DIR, name));
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function applyPatches(patches: string[]): void {
  for (const patch of patches) {
    console.log(`apply ${path.basename(patch)}`);
    git(FZF_DIR, ['apply', '--whitespace=nowarn', patch], { inherit: true });
  }
}

function resetToPin(): string {
  const sha = pinnedSha();
  git(FZF_DIR, ['reset', '--hard', sha]);
  git(FZF_DIR, ['clean', '-fd']);
  return sha;
}

function snapshotTree(): string {
  git(FZF_DIR, ['add', '-A']);
  const tree = git(FZF_DIR, ['write-tree']).stdout.trim();
  git(FZF_DIR, ['reset', '--mixed']);
  return tree;
}

function restoreTree(tree: string): void {
  git(FZF_DIR, ['read-tree', '-u', '--reset', tree]);
  git(FZF_DIR, ['reset', '--mixed']);
}

function sync(): void {
  assertRegistered();
  git(ROOT, ['submodule', 'update', '--init', '--depth', '1', 'fzf'], {
    inherit: true,
  });
  console.log(`fzf synced to ${pinnedSha()}`);
}

function reset(): void {
  assertCheckout();
  const sha = resetToPin();
  console.log(`fzf reset to ${sha}`);
}

function patch(): void {
  assertCheckout();
  const sha = resetToPin();
  const patches = listPatches();
  if (patches.length === 0) {
    console.log(`No patches in patches/fzf; fzf is pristine ${sha}`);
    return;
  }
  applyPatches(patches);
  console.log(`Applied ${patches.length} patch(es) on ${sha}`);
}

function refresh(): void {
  assertCheckout();
  const sha = pinnedSha();
  const patches = listPatches();
  const full = git(FZF_DIR, ['diff', sha]);
  if (!full.stdout.trim()) {
    console.log('fzf matches the pin; no patch to write');
    return;
  }

  if (patches.length <= 1) {
    const dest = patches[0] ?? path.join(PATCH_DIR, '0001-local.patch');
    fs.writeFileSync(dest, ensureTrailingNewline(full.stdout));
    console.log(`Wrote ${path.relative(ROOT, dest)}`);
    return;
  }

  const last = patches[patches.length - 1];
  if (!last) {
    throw new Error('patches/fzf has no .patch files to refresh');
  }
  const earlier = patches.slice(0, -1);
  const nowTree = snapshotTree();
  try {
    resetToPin();
    applyPatches(earlier);
    const prefixTree = snapshotTree();
    const lastDiff = git(FZF_DIR, ['diff', prefixTree, nowTree]);
    if (!lastDiff.stdout.trim()) {
      throw new Error(
        `Nothing left for ${path.basename(last)}; earlier patches already match the worktree`,
      );
    }
    fs.writeFileSync(last, ensureTrailingNewline(lastDiff.stdout));
    console.log(`Wrote ${path.relative(ROOT, last)}`);
  } finally {
    restoreTree(nowTree);
  }
}

function usage(): never {
  console.error('Usage: node scripts/patch-fzf.mts <sync|reset|patch|refresh>');
  process.exit(2);
}

function main(): void {
  const command = process.argv[2];
  switch (command) {
    case 'sync':
      sync();
      return;
    case 'reset':
      reset();
      return;
    case 'patch':
      patch();
      return;
    case 'refresh':
      refresh();
      return;
    default:
      usage();
  }
}

main();
