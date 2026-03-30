# Simple Notes Studio

Simple Notes Studio is a lightweight desktop editor for `json`, `jsonl`, `md`, and `txt` files. It focuses on a clean workspace, fast text search, and session continuity instead of heavyweight IDE features.

## Features

- Open folders as a workspace tree.
- Open individual files outside the workspace.
- Edit in multiple tabs with dirty-state markers.
- Use built-in copy, undo, redo, and manual save controls.
- Search across the current workspace with plain text, case-sensitive, and whole-word modes.
- Validate and format `json` and `jsonl`.
- Preview Markdown in a split panel.
- Restore the previous session on launch, including open tabs and scroll/cursor position.
- Keep a recent files list for quick re-entry.

## Stack

- Tauri 2
- React 19
- TypeScript
- Monaco Editor
- Markdown-It

## Local Development

```bash
pnpm install
pnpm tauri dev
```

## Production Build

```bash
pnpm build
pnpm tauri build
```

## Release Flow

GitHub Actions builds installers for macOS, Windows, and Linux when a tag such as `v0.1.0` is pushed.

## Project Structure

- `src/`: React UI, editor state, workspace tree, search, preview.
- `src-tauri/`: Rust commands for file IO, search, formatting, and session persistence.
- `.github/workflows/release.yml`: cross-platform release pipeline.

## License

MIT
