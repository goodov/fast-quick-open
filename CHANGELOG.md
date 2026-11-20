# Change Log

All notable changes to the "fast-quick-open" extension will be documented in
this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how
to structure this file.

## [Unreleased]

- Added configurable file-watcher reload debounce with immediate refreshes for
  an open Quick Pick. Setting `fastQuickOpen.reloadDebounceSeconds` to `0` keeps
  background watcher reloads pending until the picker opens.
- Initial release
