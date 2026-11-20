# Fast Quick Open

Fast Quick Open is a file picker for VS Code powered by
[`fd`](https://github.com/sharkdp/fd) and
[`fzf`](https://github.com/junegunn/fzf). Press `Ctrl+E` on Windows/Linux or
`Cmd+E` on macOS, start typing a path or filename, and press Enter.

The point is speed and control, especially in large repositories:

- VS Code's usual Quick Open may spend a lot of time searching a huge tree.
- You may want hidden or ignored build files to be searchable, but not every
  vendor directory.
- You may need several different search areas: the main source tree, generated
  output, a neighboring checkout, or a single directory somewhere else.
- You may want the picker prefilled from a selected path, the active file, or
  the previous query.

Fast Quick Open keeps a file index in a long-running fzf process and updates it
when files are created or deleted. The required `fd` and `fzf` binaries are
bundled with the extension; you do not need to install them separately.

## How to use it

Run **Fast Quick Open** from the Command Palette or use the default shortcut:

- Windows/Linux: `Ctrl+E`
- macOS: `Cmd+E`

This is a separate command, so VS Code's normal `Ctrl+P` / `Cmd+P` Quick Open
continues to work as usual.

When the picker is empty, it shows recently used and open files. Start typing to
fuzzy-search the indexed paths. Press the shortcut again while the picker is
open to move to the next result, or press Enter to open the selected file.

You can add a line or range at the end of a query, just like VS Code Quick Open:

```text
src/main.ts:42
src/main.ts:42:5
src/main.ts:42-50
```

The file opens at that location.

### Search syntax

Queries use fzf's fuzzy matching. You can combine normal terms, exact matches,
prefixes, and suffixes as needed. This extension's patched fzf also treats a
standalone `||` as an OR between complete queries:

```text
failed || lock file
```

That matches either `failed` or the terms `lock` and `file`. A single `|` keeps
fzf's normal term-level OR behavior.

Before matching, backslashes become forward slashes, `::` is removed, the query
is lowercased by default, and `fastQuickOpen.queryReplace` rules are applied.

## Indexing settings

All settings in this section can be placed in VS Code User or Workspace
Settings.

| Setting                               | Default | What it does                                                                                                                             |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fastQuickOpen.roots`                 | `["."]` | Base directories indexed by the normal picker. Relative paths resolve against each workspace folder.                                     |
| `fastQuickOpen.include`               | `{}`    | Directories to restore when an exclude would otherwise remove them. Paths are relative to each root.                                     |
| `fastQuickOpen.exclude`               | `{}`    | Additional glob patterns excluded from the normal index. Map each pattern to `true` or `false`.                                          |
| `fastQuickOpen.useSearchExclude`      | `true`  | Also use enabled boolean entries from `files.exclude` and `search.exclude`. Conditional `files.exclude` entries with `when` are ignored. |
| `fastQuickOpen.useWatcherExclude`     | `true`  | Apply `files.watcherExclude` when deciding whether file creation or deletion should trigger an index refresh.                            |
| `fastQuickOpen.reloadDebounceSeconds` | `10`    | Quiet period before file-watcher events rebuild a closed picker index. Set to `0` to defer reloads until the picker opens.               |
| `fastQuickOpen.fdHidden`              | `true`  | Include hidden files and directories (`fd --hidden`).                                                                                    |
| `fastQuickOpen.fdNoIgnore`            | `true`  | Do not honor `.gitignore` and other ignore files (`fd --no-ignore`).                                                                     |
| `fastQuickOpen.fdPattern`             | `"."`   | Pattern passed to fd. It is a regular expression unless `fdFlags` adds `--glob`.                                                         |
| `fastQuickOpen.fdFlags`               | `[]`    | Extra arguments passed to fd, such as `["--max-depth", "4"]`.                                                                            |
| `fastQuickOpen.fzfFlags`              | `[]`    | Extra arguments passed after fzf's built-in options, such as `["--tiebreak=end"]`.                                                       |
| `fastQuickOpen.maxItems`              | `100`   | Maximum results shown in the picker, from 1 to 100.                                                                                      |

## Include and exclude

Exclude entries are gitignore-style patterns evaluated relative to each
configured `roots` directory. The leading slash matters here:

- `/third_party` is anchored to each configured root, so it excludes only the
  top-level `third_party` directory.
- `node_modules` has no leading slash and can match that name at any depth.
- `**/vendor/**` matches vendor directories anywhere in the tree.
- `/out/**` excludes everything under the top-level `out` directory.

Includes do not use that pattern syntax. An include is a real directory path
relative to each configured root. Fast Quick Open walks that directory
explicitly when an exclude would otherwise hide it. That is why `include` uses
`third_party/blink`, without a leading slash: do not think of the `/` as a
marker for every path setting; it is an anchor specifically for an exclude
pattern.

At the top level, both settings are objects, so you can enable or disable
individual entries. For a large repository, that might look like this:

```jsonc
{
  "fastQuickOpen.exclude": {
    "/third_party": true,
    "**/vendor/**": true,
    "/out/**": true,
  },
  "fastQuickOpen.include": {
    "third_party/blink": true,
    "third_party/skia": true,
    "third_party/re2": true,
  },
}
```

Most of `third_party` and all generated output stay out of the normal index,
while the few third-party projects you actually work with are searchable.

## On-demand scopes

`fastQuickOpen.onDemand` gives a query prefix its own index:

```jsonc
{
  "fastQuickOpen.onDemand": {
    "android": {
      "roots": ["third_party"],
      "include": ["android_build_tools", "android_platform", "android_sdk"],
      "exclude": ["/*"],
    },
    "depot_tools": {
      "roots": ["../depot_tools"],
    },
    "gitconfig": {
      "roots": ["${userHome}"],
      "fdPattern": "\\.gitconfig",
      "fdFlags": ["--max-depth", "1"],
    },
    "out": {},
  },
}
```

Android dependencies, a neighboring checkout, a configuration file or generated
output can stay outside the normal index until needed. Type `out`,
`out args.gn`, or `args.gn out`; a key can appear at the start or as the last
space-separated term. Other useful examples are `android emulator`,
`depot_tools upload`, and `gitconfig` to jump straight to a Git config file.

If a key has an empty configuration, as with `"out": {}` above, no magic is
required: the scope searches an `out` directory under each workspace folder.
More generally, omitting `roots` defaults it to the directory named by the key.
Unspecified fd/fzf and result-limit options use the top-level settings.

Scope roots, includes, and excludes describe a separate index. The `include` and
`exclude` values for a scope are arrays, unlike the top-level objects. They
follow the same path rules: scope excludes are gitignore-style and relative to
that scope's roots, while scope includes are concrete directories relative to
those roots. For `android` above, `exclude: ["/*"]` hides every immediate child
under `third_party`, and `include` explicitly walks the Android-specific
directories anyway.

Each scope supports:

| Option             | Meaning                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `roots`            | Base directories for this scope.                                                                                      |
| `include`          | Concrete directories to restore inside excluded roots; paths are relative to the scope roots.                         |
| `exclude`          | Gitignore-style glob patterns relative to each scope root.                                                            |
| `fdHidden`         | Override `fastQuickOpen.fdHidden`.                                                                                    |
| `fdNoIgnore`       | Override `fastQuickOpen.fdNoIgnore`.                                                                                  |
| `fdPattern`        | Override `fastQuickOpen.fdPattern`.                                                                                   |
| `fdFlags`          | Override `fastQuickOpen.fdFlags`.                                                                                     |
| `fzfFlags`         | Override `fastQuickOpen.fzfFlags`.                                                                                    |
| `useSearchExclude` | Choose whether this scope uses `files.exclude` and `search.exclude`.                                                  |
| `maxItems`         | Override the number of displayed results.                                                                             |
| `keepKeyInQuery`   | Keep the scope key in the actual fzf query instead of stripping it.                                                   |
| `lifecycle`        | `"destroy"` (default) releases the scope index when the picker closes. `"active"` keeps it ready for the next search. |

## Query transformations

### Lowercasing

| Setting                        | Default | What it does                                                                       |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------- |
| `fastQuickOpen.lowercaseQuery` | `true`  | Lowercase the query before matching. Turn it off to use fzf's smart-case behavior. |

With smart case, an all-lowercase query is case-insensitive, while a query
containing an uppercase letter is case-sensitive.

### Query rewrite rules

`fastQuickOpen.queryReplace` can turn short or copied paths into a more useful
fzf query. Rules run after lowercasing and before on-demand scope detection.

A plain rule applies wherever it appears:

```jsonc
{
  "fastQuickOpen.queryReplace": [
    {
      "find": "^(?:\\.\\./)+",
      "replace": "",
    },
  ],
}
```

An array of rules is a group. Its first rule is both the first replacement and
the condition for the group. The first matching group runs; later groups are
skipped. Plain rules before or after the groups still run:

```jsonc
{
  "fastQuickOpen.queryReplace": [
    {
      "find": "^//",
      "replace": "",
    },
    [
      {
        "find": "^gh ",
        "replace": ".github/",
      },
      {
        "find": "$",
        "replace": ".yml",
      },
    ],
  ],
}
```

Here, `gh build` becomes `.github/build.yml`.

Rules use JavaScript regular-expression syntax. `replace` supports `$1`,
`$<name>`, and `$&`. `flags` accepts JavaScript regex flags; add `"g"` to
replace every match rather than only the first. Invalid rules are reported and
skipped.

## Shortcuts and prefilled searches

`fastQuickOpen.prefill` is a list of fallback templates. The first template that
expands to a non-empty value wins:

```jsonc
{
  "fastQuickOpen.prefill": ["${selectedFilePath}", "${relativeFile}"],
}
```

That means “use a path selected in the editor if there is one; otherwise use the
active file.” If a variable inside a template is empty, that entire template is
skipped. For example, `out ${selectedFilePath}` falls through instead of
becoming the useless query `out `.

You can also create shortcuts for a different kind of search:

```jsonc
[
  {
    "key": "cmd+shift+e",
    "command": "extension.fastQuickOpen",
    "args": {
      "prefill": ["${selectedFilePath}", "${relativeFile}"],
    },
  },
  {
    "key": "cmd+shift+alt+e",
    "command": "extension.fastQuickOpen",
    "args": {
      "prefill": ["out ${selectedFilePath}", "out ${fileBasename}"],
    },
  },
]
```

The first shortcut looks for the selected or active file. The second searches
for it in the `out` on-demand scope. A command-specific `prefill` list overrides
the global setting for that invocation.

Prefill and `fastQuickOpen.queryReplace` work especially well together. The
shortcut supplies a real path, and a rewrite rule can look for related files at
another location or with another extension. For example, one shortcut can
prefill from the active file while this rule finds either that file or its
corresponding test:

```jsonc
{
  "fastQuickOpen.queryReplace": [
    {
      "find": "^src/(.*)\\.ts$",
      "replace": "$& || test/$1.test.ts",
    },
  ],
}
```

Prefilling `src/widgets/menu.ts` then becomes
`src/widgets/menu.ts || test/widgets/menu.test.ts`. The same idea can map `src`
to `patches`, add `.patch`, swap `.cc` for `.h`, or produce several `||`
alternatives from one selected path.

Calling a shortcut with different arguments while the picker is open refills the
input. Calling the same shortcut again selects the next result.

Both `fastQuickOpen.prefill` (default `[]`) and a shortcut's `args.prefill` use
the same variables. The first non-empty expanded template wins.

### Prefill variables

Path and file variables:

- `${file}`, `${relativeFile}`, `${fileWorkspaceFolder}`
- `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`
- `${fileDirname}`, `${fileDirnameBasename}`, `${relativeFileDirname}`
- `${workspaceFolder}`, `${workspaceFolder:name}`, `${workspaceFolderBasename}`,
  `${workspaceFolderBasename:name}`

Editor and query variables:

- `${selectedFilePath}` — the current single-line selection if it looks like a
  path, with an optional `:line` or `(line)` suffix
- `${selectedText}` — the raw selected text
- `${lineNumber}`, `${columnNumber}`
- `${lastQuery}` — the value typed in the previous Fast Quick Open session

Environment and machine variables:

- `${cwd}`, `${execPath}`, `${userHome}`, `${tmpdir}`
- `${env:VAR}`, `${config:key}`
- `${pathSeparator}` or `${/}`
- `${platform}`, `${arch}`, `${hostname}`, `${username}`

Paths always use forward slashes, including on Windows. Unknown variables are
left unchanged.

## Path variables

`roots`, `fdFlags`, and `fzfFlags` expand the path, workspace, environment, and
machine variables listed above. `include` and `exclude` entries expand them too.

`${workspaceFolderList}` is special: inside `roots`, it expands to one entry per
open workspace folder. For example:

```jsonc
{
  "fastQuickOpen.roots": ["${workspaceFolderList}", "${userHome}/shared-files"],
}
```

If a named workspace folder cannot be resolved, that list entry is skipped.

## License

MIT — see [LICENSE.md](LICENSE.md). Bundled fd, fzf, and other third-party
components are listed with their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
