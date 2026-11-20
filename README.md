# Fast Quick Open README

## Watcher reloads

`fastQuickOpen.reloadDebounceSeconds` controls the quiet period before file
watcher notifications rebuild the index when the Quick Pick is closed. It
defaults to `10` seconds. Set it to `0` to keep watcher reloads pending until
the Quick Pick is opened; an open Quick Pick flushes pending reloads
immediately.

## Path variables

`fastQuickOpen.roots`, `fastQuickOpen.fdFlags`, `fastQuickOpen.fzfFlags`, and
their `fastQuickOpen.onDemand` per-scope equivalents expand:

- `${workspaceFolder}`, `${workspaceFolder:name}`, `${workspaceFolderBasename}`
- `${workspaceFolderList}` (`fastQuickOpen.roots` only — expands 1-to-N, one
  path per open workspace folder)
- `${userHome}`, `${env:VAR}`, `${config:key}`
- `${pathSeparator}` / `${/}`

All expand with forward slashes, even on Windows. An item referencing an
unresolved `${workspaceFolder:name}` is skipped.

## Full-query OR

The bundled fzf treats a standalone `||` as a separator between complete
queries. For example, `failed || lock file` matches `failed` or both `lock` and
`file`. A single `|` keeps fzf's original term-level OR behavior.

## Include and exclude

`fastQuickOpen.exclude` uses the same
[glob pattern](https://aka.ms/vscode-glob-patterns) syntax as `search.exclude`.
A leading `/` anchors a pattern to each `fastQuickOpen.roots` entry (like fd and
`.gitignore`), so `/third_party` only excludes the top-level directory; a
pattern without a slash (e.g. `node_modules`) matches at any depth. Use
`fastQuickOpen.include` to restore specific subdirectories that would otherwise
be excluded.

## On-demand scopes

`fastQuickOpen.onDemand` maps a query prefix ("key") to its own fd/fzf index,
built the first time a query starts with that key. Each scope has its own
`roots` / `include` / `exclude` and fd/fzf overrides — nothing is inherited from
the top-level `fastQuickOpen.*` settings. When `roots` is omitted, it defaults
to `["<key>"]` (the key directory under each workspace folder).

## Query rewrite rules

`fastQuickOpen.queryReplace` rewrites the query (after
`fastQuickOpen.lowercaseQuery`) before it reaches on-demand scopes and fzf. A
top-level list may contain plain rules, rule groups, or both. Entries run in
declared order:

- Plain rules apply unconditionally wherever they appear:
  `[{ "find": "^gh ", "replace": ".github/workflows/" }]`
- A rule **group** is an array whose first rule is also its condition. The first
  group whose leading rule matches the query runs in full; later groups are
  skipped, but later plain rules still run:
  `[[{ "find": "^gh ", "replace": ".github/" }, { "find": "$", "replace": ".yml" }], [{ "find": "^t ", "replace": "src/test/" }]]`

For example, this strips leading `../` segments before selecting a group, then
adds a suffix after the group:

```json
[
  { "find": "^(?:\\.\\./)+", "replace": "" },
  [
    { "find": "^gh ", "replace": ".github/" },
    { "find": "$", "replace": ".yml" }
  ],
  { "find": "\\.yml$", "replace": ".yaml" }
]
```

`replace` supports `$1`, `$<name>`, and `$&`.

## Prefill variables

`fastQuickOpen.prefill` (and the `extension.fastQuickOpen` command's
`args.prefill`) is a list of templates. Each template may mix literal text with
variables; the first template that expands to a non-empty string is used to
prefill the picker. If any variable in a template resolves to an empty string,
that whole template is skipped — even if surrounding literal text would
otherwise make it non-empty. For example, with no active selection,
`"out ${selectedFilePath}"` is skipped entirely (not used as `"out "`).

Supports VS Code's own
[predefined variables](https://code.visualstudio.com/docs/reference/variables-reference):

- `${file}`, `${relativeFile}`, `${fileWorkspaceFolder}`
- `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`
- `${fileDirname}`, `${fileDirnameBasename}`, `${relativeFileDirname}`
- `${selectedText}` (raw, unfiltered), `${lineNumber}`, `${columnNumber}`
- `${cwd}`, `${execPath}`
- `${workspaceFolder}`, `${workspaceFolder:name}`, `${workspaceFolderBasename}`
- `${userHome}`, `${pathSeparator}` / `${/}`
- `${env:VAR}`, `${config:key}`

Plus this extension's own variables:

- `${selectedFilePath}` — the current editor selection, only if it looks like a
  single-line file path (optional `:line` / `(line)` suffix); multiline or
  code-like selections resolve to empty.
- `${lastQuery}` — the input value from the most recent Fast Quick Open session
  (empty on first use).

Default: `[]` (no prefill). Example:
`["${selectedFilePath}", "${relativeFile}"]` prefers the selection and falls
back to the active file's path.

All path-valued variables (`${file}`, `${workspaceFolder}`, `${userHome}`,
`${pathSeparator}` / `${/}`, etc.) always expand with forward slashes, even on
Windows — this extension consistently represents paths that way throughout.

## License

MIT — see [LICENSE.md](LICENSE.md). Bundled fd, fzf, and other third-party
components are listed with their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
