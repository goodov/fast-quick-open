import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regenerates THIRD_PARTY_NOTICES.md from what actually ships in the VSIX:
 * the fd/fzf binaries in bin/, the Go modules linked into fzf, and the npm
 * runtime dependencies bundled into dist/.
 */

const ROOT = path.join(import.meta.dirname, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const FZF_DIR = path.join(ROOT, 'fzf');
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.md');
const HOST_DIR = `${process.platform}-${process.arch}`;
const EXE = process.platform === 'win32' ? '.exe' : '';

interface Notice {
  name: string;
  version: string;
  license: string;
  url: string;
  note?: string;
  texts: string[];
}

function run(cmd: string, args: string[], cwd = ROOT): string {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    // pnpm is a .cmd shim on Windows and need a shell.
    shell: process.platform === 'win32',
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stderr}`);
  }
  return res.stdout;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'fast-quick-open-gen-notices' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function hostBin(name: string): string {
  const p = path.join(BIN_DIR, HOST_DIR, name + EXE);
  if (!fs.existsSync(p)) {
    throw new Error(`${p} is missing; run pnpm run download-bins / fzf:build`);
  }
  return p;
}

function licenseFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /licen[cs]e|copying|notice/i.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

function guessSpdx(text: string): string {
  if (/Apache License,?\s+Version 2\.0/i.test(text)) {
    return 'Apache-2.0';
  }
  if (/Permission is hereby granted, free of charge/i.test(text)) {
    return 'MIT';
  }
  if (/Neither the name of/i.test(text)) {
    return 'BSD-3-Clause';
  }
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return 'BSD-2-Clause';
  }
  return 'see text';
}

async function fdNotice(): Promise<Notice> {
  const version = run(hostBin('fd'), ['--version']).trim().split(/\s+/)[1];
  const repo = 'https://github.com/sharkdp/fd';
  const raw = `https://raw.githubusercontent.com/sharkdp/fd/v${version}`;
  return {
    name: 'fd',
    version,
    license: 'MIT OR Apache-2.0',
    url: repo,
    note:
      'Bundled as the unmodified upstream release binary and redistributed under'
      + ' the MIT option. The binary statically links Rust crates listed in'
      + ` ${repo}/blob/v${version}/Cargo.lock, each under its own license`
      + ' (predominantly MIT and/or Apache-2.0).',
    texts: [await fetchText(`${raw}/LICENSE-MIT`)],
  };
}

function fzfNotice(): Notice {
  const version = run(hostBin('fzf'), ['--version']).trim();
  return {
    name: 'fzf',
    version,
    license: 'MIT',
    url: 'https://github.com/junegunn/fzf',
    note:
      'Built from source with local modifications; see patches/fzf in'
      + ' https://github.com/goodov/fast-quick-open.',
    texts: licenseFiles(FZF_DIR),
  };
}

function fzfBinaries(): string[] {
  return fs
    .readdirSync(BIN_DIR)
    .map((d) =>
      path.join(BIN_DIR, d, `fzf${d.startsWith('win32') ? '.exe' : ''}`),
    )
    .filter((p) => fs.existsSync(p));
}

async function goNotices(): Promise<Notice[]> {
  const deps = new Map<string, string>();
  const goVersions = new Set<string>();
  for (const bin of fzfBinaries()) {
    for (const line of run('go', ['version', '-m', bin]).split('\n')) {
      const header = line.match(/^\S.*:\s+(go\S+)$/);
      if (header) {
        goVersions.add(header[1]);
      }
      const dep = line.match(/^\s+dep\s+(\S+)\s+(\S+)/);
      if (dep) {
        deps.set(dep[1], dep[2]);
      }
    }
  }
  if (goVersions.size === 0) {
    throw new Error('No fzf binaries found in bin/; run pnpm run fzf:build');
  }

  const notices: Notice[] = [];
  for (const goVersion of [...goVersions].sort()) {
    notices.push({
      name: 'Go standard library',
      version: goVersion,
      license: 'BSD-3-Clause',
      url: 'https://go.dev',
      note: 'Statically linked into the fzf binaries.',
      texts: [
        await fetchText(
          `https://raw.githubusercontent.com/golang/go/${goVersion}/LICENSE`,
        ),
      ],
    });
  }

  for (const [mod, version] of [...deps].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const info = JSON.parse(
      run('go', ['mod', 'download', '-json', `${mod}@${version}`], FZF_DIR),
    ) as { Dir: string };
    const texts = licenseFiles(info.Dir);
    if (texts.length === 0) {
      throw new Error(`No license file found for ${mod}@${version}`);
    }
    notices.push({
      name: mod,
      version,
      license: [...new Set(texts.map(guessSpdx))].join(', '),
      url: `https://pkg.go.dev/${mod}@${version}`,
      note: 'Statically linked into the fzf binaries.',
      texts,
    });
  }
  return notices;
}

function npmNotices(): Notice[] {
  const dirs = run('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--parseable'])
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && path.resolve(l) !== ROOT);
  const notices: Notice[] = [];
  for (const dir of [...new Set(dirs)]) {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as { name: string; version: string; license?: string };
    const texts = licenseFiles(dir);
    if (texts.length === 0) {
      throw new Error(`No license file found for ${pkg.name}@${pkg.version}`);
    }
    notices.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? texts.map(guessSpdx).join(', '),
      url: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
      note: 'Bundled into dist/extension.js.',
      texts,
    });
  }
  return notices.sort((a, b) => a.name.localeCompare(b.name));
}

function render(notices: Notice[]): string {
  const out: string[] = [
    '# Third-Party Notices',
    '',
    'Fast Quick Open is licensed under the MIT License (see LICENSE.md). It'
      + ' redistributes the third-party components listed below, which remain'
      + ' under their own licenses.',
    '',
    '<!-- Generated by `pnpm run notices`. Do not edit by hand. -->',
    '',
    '| Component | Version | License |',
    '| --- | --- | --- |',
    ...notices.map(
      (n) => `| [${n.name}](${n.url}) | ${n.version} | ${n.license} |`,
    ),
    '',
  ];
  for (const n of notices) {
    out.push(`## ${n.name} ${n.version}`, '');
    out.push(`License: ${n.license} — <${n.url}>`, '');
    if (n.note) {
      out.push(n.note, '');
    }
    for (const text of n.texts) {
      out.push('````text', text.replace(/\s+$/, ''), '````', '');
    }
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const notices = [
    fzfNotice(),
    await fdNotice(),
    ...(await goNotices()),
    ...npmNotices(),
  ];
  fs.writeFileSync(OUT, render(notices));
  run('pnpm', ['exec', 'prettier', '--write', OUT]);
  console.log(
    `Wrote ${path.relative(ROOT, OUT)} (${notices.length} components)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
