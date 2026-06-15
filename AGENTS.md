# Repository Guidelines

## Project Structure & Module Organization

WeekLog is an Electron desktop app. Main-process Node code lives in `src/main/`, with IPC in `ipc.js`, Git collection in `git.js`, report generation in `pipeline.js`, and LLM adapters under `src/main/llm/`. The secure bridge is `src/preload/index.js`. The renderer is a React + TypeScript + Vite app in `src/renderer/`: pages are in `src/renderer/src/pages/`, shared components in `components/`, hooks in `hooks/`, and styles in `styles/`. Static renderer assets are in `src/renderer/public/`. Icons and installer resources are in `build/`; packaged output goes to `release/`. Node smoke tests are in `tests/`.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies; approve native build scripts listed in `pnpm-workspace.yaml` when prompted.
- `pnpm dev`: build the renderer, then launch Electron with `WEEKLOG_DEV=1` and DevTools.
- `pnpm start`: build the renderer and launch the app normally.
- `pnpm dev:renderer`: run only the Vite renderer server.
- `pnpm build:renderer`: produce `src/renderer/dist/`.
- `pnpm typecheck`: run TypeScript checks for renderer code.
- `node tests/_smoke.js`: run core logic smoke checks without Electron.
- `pnpm dist:win` / `pnpm dist:mac`: create platform packages in `release/`.

## Coding Style & Naming Conventions

Use CommonJS JavaScript for `src/main/` and TSX/ES modules for renderer code. Follow two-space indentation and omit semicolons. React components and pages use PascalCase filenames, hooks use `useX.ts(x)`, and utility modules use lower-case descriptive names. Prefer the `@/*` alias for renderer imports from `src/renderer/src`. Reuse existing shadcn/Radix components and Tailwind utilities before adding primitives.

## Testing Guidelines

There is no aggregate `test` script yet; run targeted Node tests directly from `tests/`. Name new tests `tests/_<area>_test.js` or `tests/_<area>.js` to match the current convention. For renderer-facing changes, run `pnpm typecheck` and `pnpm build:renderer`; for packaging or icon changes, also run the relevant smoke test such as `node tests/_icon_assets_test.js`.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes such as `fix(win): ...`, `fix(ci): ...`, `feat: ...`, and `release: ...`. Keep subjects imperative and scoped when useful. Pull requests should describe the user-visible change, list verification commands, link related issues or plans, and include screenshots or recordings for UI changes.

## Security & Configuration Tips

Do not commit generated outputs (`release/`, `dist/`, logs) or local agent/tool folders ignored by `.gitignore`. API keys must stay in OS keychain-backed app settings or environment variables such as `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`; never place secrets in docs, tests, or fixtures.
