# Repository instructions

## Scope and sources of truth

- These instructions apply repository-wide.
- TPlayer is a Vite/React client backed by a Bun/Hono/WebTorrent service.
- Use Bun 1.4.0. Do not substitute npm, pnpm, or yarn.
- `README.md` owns setup and operations documentation.
- `package.json` and `Makefile` own commands; `biome.jsonc` owns formatting
  and lint configuration.
- For Cloudflare work, follow `cloudflare/onboarding.md`.

## Ultracite

- This repository uses Ultracite with the Biome backend.
- Before writing or reviewing JavaScript/TypeScript, or handling lint,
  formatting, or code-quality work, load and follow
  `.agents/skills/ultracite/SKILL.md`.
- Use `bun run check` for read-only validation, `bun run fix` for automated
  fixes, and `bunx ultracite doctor` only for setup diagnosis.
- Keep detailed Ultracite standards in the skill and enforceable rules in
  `biome.jsonc`; do not duplicate them here.

## Project conventions

- Prefer TypeScript for new files, but do not convert existing JavaScript
  solely for consistency.
- Use `~/*` for cross-feature imports and relative imports within a feature.
- Match existing filename patterns; route and component files use PascalCase.
- Use Tailwind and the tokens in `src/index.css`; merge classes with `cn`.
- Keep MobX state changes inside store actions where practical.
- Update Dexie versioning whenever its schema changes.
- Do not edit generated `dist/`, `build/`, or `server/dist/` files.
- Do not remove Bun `trustedDependencies` without verifying a clean production
  installation.

## Content-use invariants

- Treat `CONTENT_POLICY.md` as a product requirement.
- Keep it, `src/search/contentPolicy.ts`, and user-facing warnings aligned.
- Keep public-domain, rights-labelled, and unverified sources visibly distinct;
  never present source-supplied rights metadata as independently verified.
- Optional tracker providers must remain disabled by default and fail closed
  when the current versioned acknowledgement is missing or stale.
- Require per-action authorization before resolving or registering tracker
  results, magnets, or info hashes.
- Disclose that torrent transfers may upload pieces to peers; owning another
  copy does not by itself authorize third-party acquisition or sharing.
- Bump `CONTENT_USE_POLICY_VERSION` whenever the acknowledgement's material
  meaning changes.

## Validation

- Run `bun run fix` and `bun run check` after JavaScript or TypeScript changes.
- Run `bun run build` and `bun run test` before handing off substantive code.
- Add `bun run test:ui` for user-flow changes.
- Add `bun run benchmark` for streaming or performance changes.
- Run `make test-macos` for production-path or LaunchAgent changes.
- Normal tests must use the private local swarm. Run live provider or tracker
  tests only when explicitly relevant.
