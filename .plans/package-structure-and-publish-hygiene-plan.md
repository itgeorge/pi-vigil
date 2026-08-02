# Package structure and publish hygiene

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work in **red → green → refactor** order where meaningful: add the smallest focused failing test first, run it to prove the expected failure, then implement only what is needed to pass. Add newly discovered relevant TODOs beneath the active phase before proceeding. Mark completed items `[x]`, record assumptions, deviations, red/green evidence, and validation results in this file, and commit plan checkbox updates with the relevant code/tests.

Do not change Vigil behavior or the extension's public tool API. Do not add runtime npm dependencies for Pi core packages. Do not add `@sinclair/typebox` — source imports `Type` / `StringEnum` via `@earendil-works/pi-ai`.

---

## What this work is

Prepare `pi-vigil` for source-based Pi distribution with correct peer-dependency semantics, a deterministic publish tarball surface, prepublish validation scripts, and README release documentation. Pi loads `./src/index.ts` directly; there is no build/dist output.

## End goal of this plan

- Pi core imports remain **host-provided peers** declared as `"*"` in `peerDependencies`, with version-pinned npm `devDependencies` for local `tsc`/tests only.
- `package-lock.json` root `peerDependencies` exactly mirror `package.json` (including `@earendil-works/pi-tui`).
- Published tarball ships runtime source plus normal docs/license/metadata only; excludes `.plans`, `test`, `optional-followups`, config, and lockfile.
- `npm run check` runs typecheck, unit tests, and machine-verifiable pack dry-run surface validation; `prepublishOnly` runs `check` (never opt-in live acceptance).
- README documents install via Pi Git source (pinned commit/tag or local path), requirements, peer vs dev dependencies (including `pi-tui`), and license — without claiming npm registry publishing is available.

## Key working assumptions

- Repository: `https://github.com/itgeorge/pi-vigil` (HTTPS git URL for npm `repository` field).
- Extension entry: `pi.extensions` → `./src/index.ts`; no compiled output.
- Runtime non-Pi deps (if any were added later) belong in `dependencies`; Pi core packages never do.
- `npm pack --dry-run --json` emits a JSON array with `files[].path` tarball entries; capture stdout (not human `npm notice` lines, which break when inherited `npm_config_json=true`).
- Default `npm test` remains unit-only; acceptance stays opt-in via `npm run test:acceptance`.
- No `author` field added unless clearly public and appropriate; none is present today.

---

# Phase 0 — Red: package surface contract tests

## Todos

- [x] Read current `package.json`, `package-lock.json`, README Dependencies/Development sections, and existing plan conventions before editing.
- [x] Add failing unit/integration tests for package-surface verification: parse `npm pack --dry-run` and assert include/exclude contract (must fail before `files` and verification script exist).
- [x] Run focused red test and record expected failure in progress notes.

---

# Phase 1 — Green: manifest, lockfile, verification script

## Todos

- [x] Change Pi core `peerDependencies` (`pi-ai`, `pi-coding-agent`, `pi-tui`) to `"*"`.
- [x] Retain version-pinned Pi packages in `devDependencies` for local typecheck/tests.
- [x] Add repository/bugs/homepage/keywords metadata and explicit `files` allowlist (source + README + LICENSE; no build output).
- [x] Add `scripts/verify-package-surface.ts`, `pack:verify`, `check`, and `prepublishOnly`.
- [x] Regenerate `package-lock.json` with npm so root `peerDependencies` match `package.json` without unrelated version churn where avoidable.
- [x] Run focused tests green, then full validation suite.

---

# Phase 2 — README and final validation

## Todos

- [x] Update README: Install (Pi Git pinned + local dev path), Requirements/compatibility, Dependencies (include `pi-tui`, peers vs dev deps), License — preserve user-authored intro prose.
- [x] Run `npm install` (or lock-only equivalent), `npm run typecheck`, `npm test`, `npm run check`, and `npm pack --dry-run`; run acceptance only if opt-in env is already set and safe.
- [x] Record all command results and tarball contents in progress notes; mark plan complete; commit plan with implementation.

---

## Progress notes

- 2026-08-02: Plan created; implementation started.
- Phase 0 red evidence: `npm test -- test/unit/package-surface.test.ts` failed — live integration test reported missing README/LICENSE/package.json/src entries (npm notices on stderr not captured initially), peer deps still `>=0.75.0`, and would have failed on forbidden `.plans/` / `test/` entries once parsing was fixed.
- Phase 1 green: added `files` allowlist, Pi core peers `"*"`, publishing metadata/keywords, `scripts/verify-package-surface.ts` + `pack:verify`/`check`/`prepublishOnly`, and minimal lockfile root peer update (added missing `pi-tui`, changed ranges to `"*"`; no dependency version churn).
- Deviation: verification script is TypeScript run via `node --experimental-strip-types` (Node >=22.19) so unit tests and typecheck share one module; initial `.mjs` prototype replaced after tsc import friction.
- Phase 2 validation:
  - `npm install` → up to date, audited 287 packages; lockfile root peers now `@earendil-works/pi-ai`, `pi-coding-agent`, `pi-tui` all `"*"`.
  - `npm run typecheck` → passed.
  - `npm test` → **262/262** passed (includes 4 package-surface tests).
  - `npm run check` → passed (`pack:verify` → `package surface ok (16 tarball entries)`).
  - `npm pack --dry-run` tarball entries (16): `LICENSE`, `README.md`, `package.json`, and 13 files under `src/` (`index.ts` + 12 `src/vigil/*.ts` modules). Excluded: `.plans/`, `test/`, `optional-followups.md`, `tsconfig.json`, `vitest.config.ts`, `package-lock.json`.
  - `npm run test:acceptance` without `PI_VIGIL_LIVE=1` → expected opt-in guard error (not run live; env unset).
- README: added Install, Requirements, expanded Dependencies (including `pi-tui`, host peers vs dev deps), License, and `npm run check` in Development; preserved user-authored intro prose.
- README Install uses Pi source syntax (`pi install https://github.com/itgeorge/pi-vigil.git@<commit-or-tag>` and `git:` shorthand), not npm-style `git+https://...#ref`.
- Non-goals confirmed: no Vigil behavior/API changes, no typebox dependency, no npm registry publish claim, no live acceptance in prepublish/check.

---

# Phase 3 — Review remediation (JSON pack verifier + Pi install docs)

## Todos

- [x] Replace README npm-style `git+https://...#ref` install example with documented Pi `pi install` Git source syntax; keep local path example valid.
- [x] Change `scripts/verify-package-surface.ts` to invoke `npm pack --dry-run --json` and parse `files[].path` (robust to mixed notice/JSON output).
- [x] Expand unit tests for JSON parsing and inherited `npm_config_json=true`; validate `npm run check` / `pack:verify` in both environments.
- [x] Validate `npm publish --dry-run --json` when safe (no actual publication).

## Progress notes

- 2026-08-02 review remediation: independent GPT review confirmed README used npm `git+https` syntax instead of Pi install syntax, and `verify-package-surface.ts` parsed human `npm notice` lines (breaks under inherited `npm_config_json=true`, including via `npm publish --dry-run --json` → `prepublishOnly`).
- Red evidence: live package-surface integration test failed under `npm_config_json=true` (notice parser returned 0 paths → missing required entries).
- Green: switched verifier to `npm pack --dry-run --json` + JSON `files[].path` parser with mixed-output fallback; README Install now documents `pi install https://github.com/itgeorge/pi-vigil.git@<commit-or-tag>` and `git:` shorthand.
- Validation (normal env): `npm test -- test/unit/package-surface.test.ts` → **6/6** passed; `npm run check` → passed.
- Validation (`npm_config_json=true`): `npm_config_json=true npm run pack:verify` → passed; `npm_config_json=true npm run check` → passed.
- Validation (`npm publish --dry-run --json`): prepublishOnly/check/pack:verify completed without publication.
