# Contributing

## Setup

```bash
pnpm install
pnpm tauri dev
```

## Guidelines

- Keep the UI simple and responsive.
- Prefer file-format support that keeps plain-text editing first.
- Keep Rust commands focused on filesystem, search, and persistence concerns.
- Run `pnpm build` before opening a pull request.
- If you touch Rust command signatures, update the matching TypeScript types in `src/types.ts`.

## Pull Requests

- Describe the user-facing change.
- Mention validation steps you ran locally.
- Keep scope tight and avoid mixing refactors with feature work unless necessary.
