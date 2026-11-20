import * as vscode from 'vscode';
import { expandVariableListWithDependencies } from './helpers/expandVariables.ts';
import { isPrefillTemplate, type PrefillTemplate } from './helpers/prefill.ts';
import {
  compileQueryReplaceRules,
  QueryReplacer,
} from './helpers/queryReplace.ts';
import { resolveSearchPaths } from './excludes.ts';
import Log from './log.ts';
import {
  enabledBooleanPatterns,
  enabledPatterns,
  normalizePatternMap,
  PatternInput,
  PatternMap,
} from './patterns.ts';
import { workspaceFolderPaths } from './helpers/vscodeUtils.ts';

const SECTION = 'fastQuickOpen';

export type { PatternInput, PatternMap } from './patterns.ts';
export type { PrefillTemplate } from './helpers/prefill.ts';

/** Whether an fzf instance stays alive after the picker closes. */
export type IndexLifecycle = 'active' | 'destroy';

interface IndexConfigValues {
  roots?: string[];
  include?: PatternMap;
  exclude?: PatternMap;
  fdHidden?: boolean;
  fdNoIgnore?: boolean;
  fdPattern?: string;
  fdFlags?: string[];
  fzfFlags?: string[];
  maxItems?: number;
  useSearchExclude?: boolean;
}

type DefaultIndexConfigValues = Required<IndexConfigValues>;

interface SettingsConfigValues {
  prefill: PrefillTemplate;
  lowercaseQuery: boolean;
  useWatcherExclude: boolean;
  reloadDebounceSeconds: number;
}

type ConfigObject = DefaultIndexConfigValues
  & SettingsConfigValues & {
    onDemand: Record<string, unknown>;
    queryReplace: unknown;
  };

type UntrustedValues<T> = {
  [Key in keyof T]?: any;
};

export interface OnDemandEntry extends IndexConfigValues {
  key: string;
  /** When true, pass the full query (including the scope key) to fzf. */
  keepKeyInQuery?: boolean;
  /** Keep this scope's fzf instance after the picker closes (`destroy` by default). */
  lifecycle: IndexLifecycle;
}

/** Resolved include/exclude/fd/fzf settings for the default or an on-demand index. */
export interface IndexScopeConfig {
  scopeKey: string | null;
  label: string;
  /** Resolved absolute fd base directories for this scope. */
  roots: string[];
  includeEntries: string[];
  excludePatterns: string[];
  fdOptions: FdCommandOptions;
  fzfExtraFlags: string[];
  maxItems: number;
  /** The default index is always `active`; only on-demand scopes opt into `destroy`. */
  lifecycle: IndexLifecycle;
}

export interface FdCommandOptions {
  hidden: boolean;
  noIgnore: boolean;
  extraFlags: string[];
  pattern: string;
}

/**
 * Central access to `fastQuickOpen.*` (and related) workspace settings.
 */
export class Config {
  private configCache: ConfigObject | undefined;
  private onDemandCache: Record<string, OnDemandEntry> | undefined;
  private queryReplaceCache: QueryReplacer | undefined;
  private readonly indexScopeCache = new Map<
    string | null,
    IndexScopeConfig | undefined
  >();
  private readonly configDependencies = new Set<string>();

  settings(): SettingsConfigValues {
    return this.configObject();
  }

  watcherExcludePatterns(): string[] {
    if (!this.configObject().useWatcherExclude) {
      return [];
    }
    const watcher = vscode.workspace
      .getConfiguration('files')
      .get<PatternMap>('watcherExclude');
    return enabledBooleanPatterns(watcher);
  }

  resolveIndexScope(scopeKey: string | null): IndexScopeConfig | undefined {
    if (this.indexScopeCache.has(scopeKey)) {
      return this.indexScopeCache.get(scopeKey);
    }

    const entry =
      scopeKey === null ? undefined : this.onDemandEntries()[scopeKey];
    if (scopeKey !== null && !entry) {
      return undefined;
    }

    const defaults = this.defaultIndexConfig();
    const own: IndexConfigValues = entry ?? defaults;
    const scope: IndexScopeConfig = {
      scopeKey,
      label: scopeKey === null ? 'default' : `on-demand:${scopeKey}`,
      roots: this.resolveRootsEntries(
        own.roots ?? (scopeKey === null ? [] : [scopeKey]),
      ),
      includeEntries: this.expandPathLikeEntries(own.include),
      excludePatterns: this.mergeExcludePatterns(
        own.exclude,
        this.vscodeExcludePatterns(own, defaults),
      ),
      fdOptions: this.resolveFdCommandOptions(own, defaults),
      fzfExtraFlags: this.resolveFzfExtraFlags(own, defaults),
      maxItems: this.resolveMaxItems(own.maxItems, defaults.maxItems),
      lifecycle: entry?.lifecycle ?? 'active',
    };

    this.indexScopeCache.set(scopeKey, scope);
    return scope;
  }

  onDemandEntries(): Record<string, OnDemandEntry> {
    if (this.onDemandCache) {
      return this.onDemandCache;
    }

    const result: Record<string, OnDemandEntry> = {};
    for (const [key, value] of Object.entries(this.configObject().onDemand)) {
      const entry = this.parseOnDemandEntry(key, value);
      if (entry) {
        result[key] = entry;
      } else {
        Log.warn?.('[onDemand]', 'skipped entry', { key, value });
      }
    }

    Log.debug?.('[onDemand]', 'parsed entries', result);

    this.onDemandCache = result;
    return result;
  }

  queryReplacer(): QueryReplacer {
    if (this.queryReplaceCache) {
      return this.queryReplaceCache;
    }

    const { replacer, errors } = compileQueryReplaceRules(
      this.configObject().queryReplace,
    );
    if (errors.length > 0) {
      for (const error of errors) {
        Log.error?.(`[queryReplace] ${error}`);
      }
      vscode.window.showErrorMessage(
        `Fast Quick Open: ${errors.length} invalid `
          + `queryReplace rule(s) skipped. First: ${errors[0]}`,
      );
    }

    this.queryReplaceCache = replacer;
    return replacer;
  }

  clearCache(): void {
    this.configCache = undefined;
    this.onDemandCache = undefined;
    this.queryReplaceCache = undefined;
    this.indexScopeCache.clear();
    this.configDependencies.clear();
  }

  isConfigChange(e: vscode.ConfigurationChangeEvent): boolean {
    if (e.affectsConfiguration(SECTION)) {
      return true;
    }
    for (const key of this.configDependencies) {
      if (e.affectsConfiguration(key)) {
        return true;
      }
    }
    return false;
  }

  private configObject(): ConfigObject {
    if (this.configCache) {
      return this.configCache;
    }

    const defaults: ConfigObject = {
      roots: ['.'],
      include: {},
      exclude: {},
      fdHidden: true,
      fdNoIgnore: true,
      fdPattern: '.',
      fdFlags: [],
      fzfFlags: [],
      maxItems: 50,
      prefill: [],
      lowercaseQuery: true,
      useSearchExclude: true,
      useWatcherExclude: true,
      reloadDebounceSeconds: 10,
      onDemand: {},
      queryReplace: [],
    };

    const configured: UntrustedValues<ConfigObject> = vscode.workspace
      .getConfiguration()
      .get(SECTION, {});

    this.configCache = {
      ...this.prepareIndexConfig(configured, defaults),
      prefill: this.parsePrefillTemplate(configured.prefill, defaults.prefill),
      lowercaseQuery: configured.lowercaseQuery ?? defaults.lowercaseQuery,
      useWatcherExclude:
        configured.useWatcherExclude ?? defaults.useWatcherExclude,
      reloadDebounceSeconds: this.resolveReloadDebounceSeconds(
        configured.reloadDebounceSeconds,
        defaults.reloadDebounceSeconds,
      ),
      onDemand: configured.onDemand ?? defaults.onDemand,
      queryReplace: configured.queryReplace ?? defaults.queryReplace,
    };
    this.addConfigDependency(
      'files.watcherExclude',
      this.configCache.useWatcherExclude,
    );
    return this.configCache;
  }

  private addConfigDependency(key: string, enabled: boolean | undefined) {
    if (enabled) {
      this.configDependencies.add(key);
    }
  }

  private parsePrefillTemplate(
    value: unknown,
    fallback: PrefillTemplate,
  ): PrefillTemplate {
    return isPrefillTemplate(value) ? value : fallback;
  }

  private prepareIndexConfig(
    values: UntrustedValues<IndexConfigValues>,
    defaults: DefaultIndexConfigValues,
  ): DefaultIndexConfigValues;
  private prepareIndexConfig(
    values: UntrustedValues<IndexConfigValues>,
  ): IndexConfigValues;
  private prepareIndexConfig(
    values: UntrustedValues<IndexConfigValues>,
    defaults: IndexConfigValues = {},
  ): IndexConfigValues {
    const prepared: IndexConfigValues = {
      roots: this.normalizeStringList(values.roots) ?? defaults.roots,
      include:
        values.include === undefined
          ? defaults.include
          : normalizePatternMap(values.include),
      exclude:
        values.exclude === undefined
          ? defaults.exclude
          : normalizePatternMap(values.exclude),
      fdHidden: values.fdHidden ?? defaults.fdHidden,
      fdNoIgnore: values.fdNoIgnore ?? defaults.fdNoIgnore,
      fdPattern: values.fdPattern ?? defaults.fdPattern,
      fdFlags: this.normalizeStringList(values.fdFlags) ?? defaults.fdFlags,
      fzfFlags: this.normalizeStringList(values.fzfFlags) ?? defaults.fzfFlags,
      maxItems: values.maxItems ?? defaults.maxItems,
      useSearchExclude: values.useSearchExclude ?? defaults.useSearchExclude,
    };
    this.addConfigDependency('files.exclude', prepared.useSearchExclude);
    this.addConfigDependency('search.exclude', prepared.useSearchExclude);
    return prepared;
  }

  private defaultIndexConfig(): DefaultIndexConfigValues {
    return this.configObject();
  }

  /** Resolve raw root entries against the current workspace-folder list. */
  private resolveRootsEntries(entries: string[]): string[] {
    return resolveSearchPaths(
      workspaceFolderPaths(),
      this.expandVariableList(entries),
    );
  }

  /** Enabled globs from `files.exclude` / `search.exclude` (when enabled). */
  private vscodeExcludePatterns(
    own: IndexConfigValues,
    defaults: DefaultIndexConfigValues,
  ): string[] {
    const patterns = new Set<string>();

    if (own.useSearchExclude ?? defaults.useSearchExclude) {
      const files = vscode.workspace
        .getConfiguration('files')
        .get<PatternMap>('exclude');
      for (const p of enabledBooleanPatterns(files)) {
        patterns.add(p);
      }
      const search = vscode.workspace
        .getConfiguration('search')
        .get<PatternMap>('exclude');
      for (const p of enabledBooleanPatterns(search)) {
        patterns.add(p);
      }
    }

    return [...patterns];
  }

  private resolveFdCommandOptions(
    override: IndexConfigValues,
    defaults: DefaultIndexConfigValues,
  ): FdCommandOptions {
    const hidden = override.fdHidden ?? defaults.fdHidden;
    const noIgnore = override.fdNoIgnore ?? defaults.fdNoIgnore;
    const extraFlags = this.expandVariableList(
      override.fdFlags ?? defaults.fdFlags,
    );
    const pattern = override.fdPattern ?? defaults.fdPattern;
    return { hidden, noIgnore, extraFlags, pattern };
  }

  private resolveFzfExtraFlags(
    override: IndexConfigValues,
    defaults: DefaultIndexConfigValues,
  ): string[] {
    return this.expandVariableList(override.fzfFlags ?? defaults.fzfFlags);
  }

  private resolveMaxItems(value?: number, fallback = 50): number {
    const normalizedFallback =
      Number.isFinite(fallback) && fallback >= 1
        ? Math.min(Math.floor(fallback), 100)
        : 100;
    if (value === undefined || !Number.isFinite(value) || value < 1) {
      return normalizedFallback;
    }
    return Math.min(Math.floor(value), 100);
  }

  private resolveReloadDebounceSeconds(value: unknown, fallback = 10): number {
    const normalizedFallback =
      Number.isFinite(fallback) && fallback >= 0 ? fallback : 10;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : normalizedFallback;
  }

  private expandPathLikeEntries(input: PatternInput): string[] {
    return this.expandVariableList(
      enabledPatterns(input)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
  }

  private expandVariableList(values: string[]): string[] {
    const expanded = expandVariableListWithDependencies(values);
    for (const key of expanded.configDependencies) {
      if (key) {
        this.configDependencies.add(key);
      }
    }
    return expanded.value;
  }

  private mergeExcludePatterns(
    own: PatternInput,
    vscodeExcludes: string[],
  ): string[] {
    const patterns = new Set<string>(enabledPatterns(own));
    for (const p of vscodeExcludes) {
      patterns.add(p);
    }
    return [...patterns];
  }

  /** Convert each list item to a string, then trim and drop empty entries. */
  private normalizeStringList(
    value: unknown[] | undefined,
  ): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }

    return value
      .map((item) =>
        item === null || item === undefined ? '' : String(item).trim(),
      )
      .filter((item) => item.length > 0);
  }

  private parseOnDemandEntry(
    key: string,
    value: unknown,
  ): OnDemandEntry | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const obj = value as UntrustedValues<OnDemandEntry>;

    return {
      key,
      ...this.prepareIndexConfig(obj),
      keepKeyInQuery: obj.keepKeyInQuery,
      lifecycle: obj.lifecycle === 'active' ? 'active' : 'destroy',
    };
  }
}

/** Shared config instance; set via {@link createConfig} (e.g. on extension activate). */
export let config!: Config;

/** Create and install the shared {@link config} instance. */
export function createConfig(): Config {
  config = new Config();
  return config;
}
