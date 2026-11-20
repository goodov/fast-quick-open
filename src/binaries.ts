import * as path from 'path';

function getBinPath(extensionPath: string, name: string): string {
  if (process.platform === 'win32') {
    name += '.exe';
  }
  return path.join(
    extensionPath,
    'bin',
    `${process.platform}-${process.arch}`,
    name,
  );
}

export function getFdPath(extensionPath: string): string {
  return getBinPath(extensionPath, 'fd');
}

export function getFzfPath(extensionPath: string): string {
  return getBinPath(extensionPath, 'fzf');
}
