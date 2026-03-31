# Changelog

## 0.1.4

- Fixed Finder `Open With` so opening a file while the app is already running now creates or focuses the correct tab instead of only activating the window.
- Stopped external file opens from auto-creating ad-hoc workspaces; files opened from Finder now stay as standalone tabs unless they already belong to an open workspace.
- Canonicalized external file paths to prevent duplicate tabs for the same file when macOS provides different path representations such as `/var/...` and `/private/var/...`.

## 0.1.3

- Added multi-workspace support so multiple folders can stay open at the same time and the active workspace drives search scope.
- Reworked the sidebar layout with responsive container rules plus a draggable app split between the sidebar and main editor area.
- Narrowed the workspace tree and search index to supported text and config formats only: `txt`, `md`, `markdown`, `json`, `jsonl`, `yaml`, `yml`, `toml`, and `log`.
- Added macOS file associations for the supported formats so the app can be selected from Finder's `Open With` flow.

## 0.1.2

- Fixed the GitHub Actions release workflow by aligning the workflow pnpm version with `package.json`.
- Re-ran the release pipeline with a new tag after the failed `v0.1.1` packaging attempt.

## 0.1.1

- Added Markdown split improvements with preview-only mode, synced preview scrolling, and draggable split resizing.
- Added in-memory workspace search so unsaved Markdown and text edits can be found before saving.
- Added a system settings panel with warm, paper, and night appearance themes.
- Added text zoom controls for TXT and Markdown, including editor and Markdown preview scaling.
- Persisted appearance and text zoom inside session restore.
- Re-ran build, Rust unit tests, functional smoke, and desktop bundle verification before release.

## 0.1.0

- Initial public release.
- Added workspace tree, recent files, multi-tab editing, and manual save.
- Added workspace-wide text search with case-sensitive and whole-word options.
- Added JSON and JSONL validation plus formatting.
- Added Markdown split preview.
- Added session restore for open tabs and editor view position.
- Added GitHub Actions release packaging for macOS, Windows, and Linux.
