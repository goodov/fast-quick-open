import * as path from 'path';
import * as vscode from 'vscode';

export function looksLikeUriString(value: string): boolean {
  if (value.startsWith('file:')) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return false;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

export function parseResource(resource: string): vscode.Uri {
  if (looksLikeUriString(resource)) {
    return vscode.Uri.parse(resource);
  }
  return vscode.Uri.file(path.normalize(resource));
}

export function uriKey(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    const normalized = path.normalize(uri.fsPath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }
  return uri.toString();
}
