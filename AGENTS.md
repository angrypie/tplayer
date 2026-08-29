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
- Backend: Bun + Hono + WebTorrent TypeScript modules in `server/`.

## Tooling prerequisites
- Bun 1.4.0 (pinned in `package.json`).

## Common commands
- Install JS deps: `bun install --frozen-lockfile`
- Dev server (frontend): `bun run dev`
- Build frontend and server bundle: `bun run build`
- Preview build: `bun run preview`
- Check formatting/lint: `bun run check`
- Fix formatting/lint: `bun run fix`
- Diagnose Ultracite: `bunx --bun ultracite doctor`
- Build Hono server bundle: `make build-backend`
- Build full prod bundle: `make prod`
- Run foreground production: `make prod-run`
- Print canonical production paths: `make production-config`
- Install/start macOS LaunchAgent: `make launchctl-install`
- Inspect macOS LaunchAgent: `make launchctl-status`
- Stop macOS LaunchAgent: `make launchctl-stop`
- Restore a production snapshot: `make restore`
- Create snapshot tarball: `make snapshot`
- Install dependencies: `make install-deps`
- Cloudflare onboarding: see `cloudflare/onboarding.md`.

## Tests
- Bun's test runner covers server integration and browser-storage behavior.
- Playwright covers user flows against a real local WebTorrent swarm.
- Use `bun run check`, `bun run build`, `bun run test`, and `bun run test:ui`
  as the current CI-style checks.
- Use `bun run benchmark` for measured streaming throughput and range latency.
- Use `make test-macos` to verify terminal and LaunchAgent path parity.

## Project structure
- Entry point: `src/main.tsx`
- App shell: `src/App.jsx`
- Routes: `src/routes/index.jsx`, with nested route folders.
- UI primitives: `src/components/ui/*`
- Shared helpers: `src/lib/utils.ts`, `src/utils/index.js`
- Storage layer: `src/storage/index.ts`
- Server entry point: `server/index.ts`
- Hono composition: `server/app.ts`
- WebTorrent lifecycle: `server/torrent/manager.ts`

## Module resolution and aliases
- TypeScript baseUrl is repo root.
- Alias `~/*` maps to `src/*`.
- Use the alias for cross-feature imports; keep relative paths for same-folder imports.

## Formatting (Ultracite/Biome)
- Config: `biome.jsonc`; use Ultracite commands rather than invoking Biome
  directly.
- Indentation: tabs, width 2.
- Semicolons: none.
- Quotes: single quotes; JSX uses single quotes.
- Line endings: LF.
- Run `bun run fix` after editing JavaScript or TypeScript.

## Linting (Ultracite/Biome)
- `bun run check` is the repository-wide quality gate.
- React hooks, accessibility, correctness, security, and complexity rules are
  enforced by Ultracite.
- Lefthook runs the configured checks for staged changes.

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
- Dexie DB lives in `src/storage/index.ts`.
- Storage lookups may return `null` when not found; handle gracefully.
- Keep DB schema updates aligned with existing versioning.

## Error handling
- Use `try/catch` for async IO (network/storage).
- Present recoverable UI errors through application state instead of `alert`.
- Avoid production `console.log`; use intentional error reporting where needed.
- Avoid throwing from React render paths.

## Content and source policy
- Keep `CONTENT_POLICY.md`, `src/search/contentPolicy.ts`, and user-facing
  warnings aligned.
- Public-domain, rights-labelled, and unverified third-party sources must remain
  visibly distinct. Do not describe source-supplied rights metadata as verified.
- Optional tracker providers must remain disabled by default, require the
  current versioned policy acknowledgement, and fail closed when the saved
  version is missing or stale.
- Opening a tracker result or direct magnet/info-hash reference must require a
  per-action authorization confirmation before any resolve or registration
  request is sent.
- Torrent warnings must disclose possible peer upload. Do not imply that owning
  another copy automatically authorizes third-party acquisition or sharing.
- Bump `CONTENT_USE_POLICY_VERSION` when the acknowledgement's material meaning
  changes so previously stored consent cannot silently carry forward.

## Routing
- Wouter is used for navigation.
- Use `useLocation` for navigation and `Link` for links.

## Build outputs
- Vite outputs to `dist/`; Bun outputs the externalized server bundle to
  `build/`.
- Avoid editing `dist/`, `build/`, or legacy `server/dist/` manually.

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
- When in doubt, run `bun run check` before build.

## Single-test guidance (if added later)
- Use `bun test <path-or-pattern>` for a focused Bun test.
- Use `bunx playwright test <path-or-pattern>` for a focused UI test.

## Files worth knowing
- `src/routes/Playlist/Player/player.js` audio control with Howler.
- `src/routes/Home/Search.tsx` contains magnet/info-hash parsing logic.
- `src/components/ui/button.tsx` uses class-variance-authority patterns.
- `src/index.css` defines theme tokens and base styles.

## Notes
- There is a mix of TS and JS; avoid converting files unless necessary.
- Some files use semicolons even though Prettier defaults to none; keep local consistency.
- Use ASCII unless the file already uses unicode.


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `npm exec -- ultracite fix`
- **Check for issues**: `npm exec -- ultracite check`
- **Diagnose setup**: `npm exec -- ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `npm exec -- ultracite fix` before committing to ensure compliance.
