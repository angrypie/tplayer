# AGENTS.md

## Purpose
- This file guides agentic contributors in this repo.
- Keep instructions aligned with existing tooling and style.

## Repository overview
- Frontend: Vite + React + TypeScript/JavaScript in `src/`.
- State: MobX stores in route folders.
- Routing: Wouter in `src/routes`.
- Styling: Tailwind CSS with CSS variables in `src/index.css`.
- Storage: Dexie (IndexedDB) in `src/storage`.
- Audio: Howler in `src/routes/Playlist/Player`.
- Backend build: Go binary in `server/` via Makefile.

## Tooling prerequisites
- Node.js + npm (see `README.md`/`Makefile`).
- Go toolchain for server builds.
- Optional: `pwa-assets-generator` for PWA assets.

## Common commands
- Install JS deps: `npm install`
- Dev server (frontend): `npm run dev`
- Build frontend (typecheck + vite): `npm run build`
- Preview build: `npm run preview`
- Lint: `npm run lint`
- Generate PWA assets: `npm run generate-pwa-assets`
- Build Go server: `make build-go`
- Build full prod bundle: `make prod`
- Run go build after restore: `make restore`
- Create snapshot tarball: `make snapshot`
- Install system deps (linux): `make install`

## Tests
- No test runner configured; there are no `*.test.*` or `*.spec.*` files.
- If you need a single-test command, add a runner (Vitest/Jest) first.
- Use `npm run lint` and `npm run build` as current CI-style checks.

## Project structure
- Entry point: `src/main.tsx`
- App shell: `src/App.jsx`
- Routes: `src/routes/index.jsx`, with nested route folders.
- UI primitives: `src/components/ui/*`
- Shared helpers: `src/lib/utils.ts`, `src/utils/index.js`
- Storage layer: `src/storage/index.js`

## Module resolution and aliases
- TypeScript baseUrl is repo root.
- Alias `~/*` maps to `src/*`.
- Use the alias for cross-feature imports; keep relative paths for same-folder imports.

## Formatting (Prettier)
- Config: `.prettierrc`
- Indentation: tabs, width 2.
- Semicolons: none.
- Quotes: single quotes; JSX uses single quotes.
- Trailing commas: ES5 style.
- Line endings: LF.
- Keep formatting consistent with existing file style (some JS uses semis; avoid mixing).

## Linting (ESLint)
- Config: `eslint.config.js` with `@eslint/js` + `typescript-eslint`.
- React hooks rules are enforced.
- React refresh rule warns for non-component exports.
- Lint targets `**/*.{ts,tsx,js,jsx}` and ignores `dist`.

## TypeScript settings
- Strict mode enabled; noUnusedLocals/Parameters true.
- `noUncheckedSideEffectImports` is enabled: avoid side-effect-only imports.
- Bundler module resolution; `allowImportingTsExtensions` true.
- Prefer `.ts/.tsx` for new code unless file is already JS.

## React conventions
- Functional components are preferred; class components exist but avoid new ones.
- Hooks: name custom hooks with `use*`.
- Keep component props typed in TS files.
- Use `React.FC` only when it adds value; follow local file style.
- Use `export default` for route components as in existing routes.

## Styling conventions
- Tailwind CSS classes are primary styling mechanism.
- Theme tokens live in `src/index.css` CSS variables.
- Use `cn` helper (`src/lib/utils.ts` or `src/utils/index.js`) to merge classes.
- Inline styles only for dynamic sizing (see `src/routes/Playlist/index.jsx`).

## Imports
- Order: external packages, then `~/` alias imports, then relative imports.
- Use named imports where possible; default exports for components as established.
- Keep import paths consistent (`~/routes/...` rather than deep relative).

## Naming conventions
- Components: PascalCase (`Search`, `TorrentInfo`).
- Hooks: camelCase with `use` prefix (`useLibraryStore`).
- Variables/functions: camelCase; constants in lowerCamel or UPPER_SNAKE if global.
- Files: PascalCase for components, lowerCamel or kebab for utils; match existing folder.

## State management
- MobX stores are in `store.js`/`libraryStore.js`.
- Keep observable state mutations inside store actions where possible.
- Avoid direct state mutation in views unless current patterns do so.

## Data and storage
- Dexie DB lives in `src/storage/index.js`.
- Storage functions return `null` when not found; handle gracefully.
- Keep DB schema updates aligned with existing versioning.

## Error handling
- Use `try/catch` for async IO (network/storage).
- Log errors with `console.error` or `console.log` as existing code does.
- UI-facing errors use lightweight messaging (existing `alert` usage in storage).
- Avoid throwing from React render paths.

## Routing
- Wouter is used for navigation.
- Use `useLocation` for navigation and `Link` for links.

## Build outputs
- Vite outputs to `dist/`; `make prod` moves it into `server/dist`.
- Avoid editing `dist/` or `server/dist` manually.

## Environment
- `dev` server runs on `http://localhost:3000` with `--host`.
- The app assumes browser APIs (clipboard, audio, IndexedDB).

## Cursor / Copilot rules
- No `.cursor/rules`, `.cursorrules`, or `.github/copilot-instructions.md` found.

## Agent workflow tips
- Prefer editing existing files over creating new ones.
- Match existing semicolon and indentation style in the file you edit.
- Keep changes scoped; do not refactor unrelated areas.
- For new UI, follow Tailwind + CSS variable theme.
- When in doubt, run `npm run lint` before build.

## Single-test guidance (if added later)
- If Vitest is added, use `npm run test -- <pattern>` or `vitest <pattern>`.
- If Jest is added, use `npm test -- <pattern>` or `jest <pattern>`.
- Document new test commands here when a runner is introduced.

## Files worth knowing
- `src/routes/Playlist/Player/player.js` audio control with Howler.
- `src/routes/Home/Search.tsx` contains magnet/info-hash parsing logic.
- `src/components/ui/button.tsx` uses class-variance-authority patterns.
- `src/index.css` defines theme tokens and base styles.

## Notes
- There is a mix of TS and JS; avoid converting files unless necessary.
- Some files use semicolons even though Prettier defaults to none; keep local consistency.
- Use ASCII unless the file already uses unicode.
