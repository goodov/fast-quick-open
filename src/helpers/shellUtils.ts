/** Quote a single argument for the platform shell (cmd.exe vs POSIX). */
export function quoteForShell(arg: string): string {
  if (process.platform === 'win32') {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Quote argv for a log line. Do not use this when spawning. */
export function argvToShellSyntaxForLogging(argv: string[]): string {
  return argv.map(quoteForShell).join(' ');
}
