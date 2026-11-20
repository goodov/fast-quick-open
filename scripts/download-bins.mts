import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Pinned GitHub release versions. Bump these to update bundled fd. */
const FD_VERSION = '10.5.0';

interface Target {
  dir: string;
  exe: boolean;
  fdAsset: string;
}

const TARGETS: Target[] = [
  {
    dir: 'win32-x64',
    exe: true,
    fdAsset: `fd-v${FD_VERSION}-x86_64-pc-windows-msvc.zip`,
  },
  {
    dir: 'win32-arm64',
    exe: true,
    fdAsset: `fd-v${FD_VERSION}-aarch64-pc-windows-msvc.zip`,
  },
  {
    dir: 'darwin-x64',
    exe: false,
    fdAsset: `fd-v${FD_VERSION}-x86_64-apple-darwin.tar.gz`,
  },
  {
    dir: 'darwin-arm64',
    exe: false,
    fdAsset: `fd-v${FD_VERSION}-aarch64-apple-darwin.tar.gz`,
  },
  {
    dir: 'linux-x64',
    exe: false,
    fdAsset: `fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
  },
  {
    dir: 'linux-arm64',
    exe: false,
    fdAsset: `fd-v${FD_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
  },
];

const ROOT = path.join(import.meta.dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const currentDir = `${process.platform}-${process.arch}`;
const currentOnly = process.argv.includes('--current');

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'fast-quick-open-download-bins' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function extractArchive(archivePath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  // GNU tar (Linux) cannot read zip; Windows has bsdtar but no unzip.
  const [cmd, args] =
    archivePath.endsWith('.zip') && process.platform !== 'win32'
      ? ['unzip', ['-q', '-o', archivePath, '-d', destDir]]
      : ['tar', ['-xf', archivePath, '-C', destDir]];
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${archivePath} failed (${result.status})`);
  }
}

function findFile(root: string, name: string): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (ent.isFile() && ent.name === name) {
        return p;
      }
    }
  }
  return undefined;
}

function extractBinary(
  archivePath: string,
  binName: string,
  destPath: string,
): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-bin-'));
  try {
    extractArchive(archivePath, tmp);
    const found = findFile(tmp, binName);
    if (!found) {
      throw new Error(`No ${binName} in ${path.basename(archivePath)}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(found, destPath);
    fs.chmodSync(destPath, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function installTarget(target: Target): Promise<void> {
  const outDir = path.join(BIN_DIR, target.dir);
  const fdName = target.exe ? 'fd.exe' : 'fd';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fqo-dl-'));

  const fdUrl = `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${target.fdAsset}`;
  const fdArchive = path.join(work, target.fdAsset);

  console.log(`→ ${target.dir}`);
  try {
    await download(fdUrl, fdArchive);
    extractBinary(fdArchive, fdName, path.join(outDir, fdName));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  let targets = TARGETS;
  if (currentOnly) {
    targets = TARGETS.filter((t) => t.dir === currentDir);
    if (targets.length === 0) {
      throw new Error(
        `No download mapping for ${currentDir}. Edit scripts/download-bins.mts.`,
      );
    }
  }

  console.log(`fd v${FD_VERSION}`);
  for (const target of targets) {
    await installTarget(target);
  }
  console.log(`Installed into ${BIN_DIR}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
