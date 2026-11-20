import { getFdPath } from './binaries.ts';
import { IndexScopeConfig, config, FdCommandOptions } from './config.ts';
import {
  type FdInvocation,
  getIndexFdInvocations,
  holePunchExcludePatterns,
} from './excludes.ts';
import { containingWorkspaceFolder } from './helpers/vscodeUtils.ts';
import Log from './log.ts';

/** One fd argv plus the base used to decode `--format` paths. */
export interface FdCommandSpec {
  command: string[];
  base: string;
  /**
   * Workspace folder name after `N/` when the index is in labeled mode.
   * `''` keeps the field so out-of-workspace invocations stay aligned (`N//{}`).
   * Omitted when the index has no label field (`N/{}`).
   */
  filterLabel?: string;
}

function escapeFdFormat(text: string): string {
  return text.replace(/\{/g, '{{').replace(/\}/g, '}}');
}

function fdFormat(invocationIndex: number, filterLabel?: string): string {
  if (filterLabel === undefined) {
    return `${invocationIndex}/{}`;
  }
  return `${invocationIndex}/${escapeFdFormat(filterLabel)}/{}`;
}

export interface IndexBuild {
  scope: IndexScopeConfig;
  specs: FdCommandSpec[];
  /** Every spec has a label field (name or ""). */
  filterLabels: boolean;
}

/** Builds fd argv lists that Node feeds into fzf stdin. */
export default class FdCommandBuilder {
  private readonly fdPath: string;

  constructor(extensionPath: string) {
    this.fdPath = getFdPath(extensionPath);
  }

  forScope(scopeKey: string | null): IndexBuild | undefined {
    const scope = config.resolveIndexScope(scopeKey);
    if (!scope) {
      return undefined;
    }

    const invocations = getIndexFdInvocations(
      scope.roots,
      scope.includeEntries,
      scope.excludePatterns,
    );
    if (invocations.length === 0) {
      Log.warn?.(
        scopeKey
          ? 'on-demand scope: no directories found on disk'
          : 'default scope: no directories found on disk',
        scopeKey ?? undefined,
      );
      return undefined;
    }

    const { specs, filterLabels } = this.build(
      invocations,
      scope.excludePatterns,
      scope.fdOptions,
      scope.roots,
    );
    return { scope, specs, filterLabels };
  }

  private build(
    invocations: FdInvocation[],
    excludes: string[],
    fdOptions: FdCommandOptions,
    roots: string[],
  ): { specs: FdCommandSpec[]; filterLabels: boolean } {
    const inWorkspaceCount = invocations.filter((invocation) =>
      containingWorkspaceFolder(invocation.base),
    ).length;
    const filterLabels = inWorkspaceCount > 1;
    const specs = invocations.map((invocation, index) => {
      const filterLabel = filterLabels
        ? (containingWorkspaceFolder(invocation.base)?.name ?? '')
        : undefined;
      return {
        command: this.commandArgs(
          index,
          invocation,
          excludes,
          fdOptions,
          roots,
          filterLabel,
        ),
        base: invocation.base,
        filterLabel,
      };
    });
    return { specs, filterLabels };
  }

  private commandArgs(
    invocationIndex: number,
    invocation: FdInvocation,
    excludes: string[],
    fdOptions: FdCommandOptions,
    roots: string[],
    filterLabel?: string,
  ): string[] {
    const args = [this.fdPath];
    for (const pattern of excludes) {
      args.push('--exclude', pattern);
    }
    for (const pattern of holePunchExcludePatterns(invocation.base, roots)) {
      args.push('--exclude', pattern);
    }
    if (fdOptions.noIgnore) {
      args.push('--no-ignore');
    }
    if (fdOptions.hidden) {
      args.push('--hidden');
    }
    args.push(
      '--type',
      'f',
      '--type',
      'l',
      '--path-separator',
      '/',
      '--print0',
      '--base-directory',
      invocation.base,
      '--format',
      fdFormat(invocationIndex, filterLabel),
    );
    for (const searchPath of invocation.searchPaths) {
      args.push('--search-path', searchPath);
    }
    if (fdOptions.pattern) {
      args.push(fdOptions.pattern);
    }
    for (const flag of fdOptions.extraFlags) {
      args.push(flag);
    }
    return args;
  }
}
