# Windows Pi spawn resolution plan

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work strictly in **red -> green -> refactor** order:

1. Add the smallest focused failing test for the current item.
2. Run the test and record the exact red failure in this file (test name + assertion/message).
3. Implement only the production code required to turn it green.
4. Re-run the focused test and nearest related suite; record green evidence.
5. Refactor only while green, keeping the diff scoped to Windows Pi spawn resolution.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, record assumptions, deviations, red/green evidence, and validation results in this file, and commit plan checkbox updates with the corresponding code/tests.

Do not begin implementation until the user explicitly approves proceeding after plan review.

---

## Problem statement

On Windows, Vigil subagent launch fails even though the Pi CLI is on PATH. The installed `pi` command is an npm shim (`pi.CMD` plus a shell shim), and direct Node `child_process.spawn("pi", args, ...)` does not resolve or execute it correctly in this environment.

Observed user-visible failures:

- `vigil launch` with `ephemeral: true` returns `Failed to launch ephemeral Pi child: spawn pi ENOENT`.
- `vigil launch` for a persisted child returns `Failed to launch Pi child: spawn pi ENOENT`.
- No `vigil-launch` metadata is recorded after the failed spawn.

Investigation evidence from 2026-08-17 on Windows:

- `pi` is on shell PATH: resolves to `C:\Users\itgeorge\AppData\Roaming\npm\pi.CMD`.
- `pi --version` succeeds from the shell and returns `0.84.2`.
- Node direct spawn fails:
  - `spawnSync("pi", ["--version"])` -> `spawnSync pi ENOENT`.
  - `spawnSync("pi.cmd", ["--version"])` -> `EINVAL`.
- Shell-backed spawn succeeds:
  - `spawnSync("pi", ["--version"], { shell: true })` -> `0.84.2`.
  - `cmd.exe /d /s /c "pi --version"` -> `0.84.2`.
- Directly invoking the CLI JavaScript succeeds:
  - `node C:\Users\itgeorge\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\dist\cli.js --version` -> `0.84.2`.

Root cause: the current node launch paths rely on direct `spawn("pi", ...)`, but Windows npm `.cmd` shims are not reliably executable through direct `spawn` without a shell. `shell: true` is a viable startup workaround but weakens process tracking because the PID may be the shell process rather than the actual Pi CLI process.

---

## End goal

- Vigil launches persisted and ephemeral children on Windows when Pi is installed through the normal npm shim.
- Non-Windows launch behavior stays unchanged.
- Explicit executable overrides keep working for tests and advanced callers.
- Detached process semantics, PID tracking, shutdown cleanup, stderr capture, and ephemeral stdout parsing remain correct.
- The fix is centralized so `node-runtime.ts`, `ephemeral-observer.ts`, `persisted-bootstrap-observer.ts`, and acceptance helpers do not drift.

---

## Non-goals

- Do not change Vigil's public tool schema or lifecycle record shape.
- Do not add retry/supervision, process groups, job objects, or a runtime registry.
- Do not change model selection, thinking-level handling, session path encoding, or child failure detection semantics.
- Do not require users to launch Cursor from a special terminal as the primary fix.
- Do not rely on hardcoded user-specific paths such as `C:\Users\itgeorge\...`.

---

## Target architecture

Add a small spawn-command boundary that converts Pi CLI invocations into an executable plus args prefix before any child process is spawned.

Candidate module names:

- `src/vigil/pi-spawn-command.ts`
- or colocated helpers in `src/vigil/node-runtime.ts` if the abstraction stays very small.

Target shape, names may evolve:

```ts
interface PiSpawnCommand {
  command: string;
  argsPrefix: string[];
}

function resolvePiSpawnCommand(options?: {
  piExecutable?: string;
  platform?: NodeJS.Platform;
  resolvePiCliEntrypoint?: () => string;
}): PiSpawnCommand;

function buildPiSpawnArgs(command: PiSpawnCommand, piArgs: string[]): string[];
```

Resolution policy:

- On non-Windows, return `{ command: piExecutable ?? "pi", argsPrefix: [] }`.
- On Windows with the default executable (`pi`), spawn Node directly:
  - `command = process.execPath`
  - `argsPrefix = [resolvedPiCliEntrypoint]`
- On Windows with an explicit executable override, preserve the override unless tests prove a `.cmd` override needs documented behavior.
- Resolve the Pi CLI entrypoint from the installed `@earendil-works/pi-coding-agent` module, not PATH text or a hardcoded npm global directory.
  - Preferred: use `import.meta.resolve("@earendil-works/pi-coding-agent")` to locate `dist/index.js`, then derive sibling `dist/cli.js`.
  - Verify this works in the Pi runtime where `pi-vigil` already imports `@earendil-works/pi-coding-agent` as a host-provided peer.
- Keep `shell: true` only as a documented fallback if direct CLI JS resolution is not possible; do not choose it as the first implementation because of PID/quoting/process cleanup risks.

All spawn sites should consume the same resolved command:

- `spawnDetachedPiChild` in `src/vigil/node-runtime.ts`.
- `createNodeEphemeralChildObserver` in `src/vigil/ephemeral-observer.ts`.
- `createNodePersistedBootstrapObserver` in `src/vigil/persisted-bootstrap-observer.ts`.
- `runPiJsonPrintCommand` in `test/acceptance/pi-json-print.ts` if it still uses direct `spawn("pi", ...)`.

---

## Testing strategy

Use deterministic unit tests first. Avoid live model calls until the command resolution and spawn boundary are green.

Suggested focused commands:

```bash
npm test -- test/unit/vigil/pi-spawn-command.test.ts
npm test -- test/unit/vigil/spawn-failure.test.ts
npm test -- test/unit/vigil/ephemeral-observer.test.ts
npm test -- test/unit/vigil/persisted-bootstrap-observer.test.ts
npm test -- test/unit/vigil/extension-adapter.test.ts
npm run typecheck
npm test
npm run check
```

Windows smoke checks after deterministic tests pass:

```bash
node -e "const {spawnSync}=require('node:child_process'); const r=spawnSync('pi',['--version'],{encoding:'utf8'}); console.log(r.error?.message ?? r.stdout)"
node -e "const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,['<resolved-cli-js>','--version'],{encoding:'utf8'}); console.log(r.error?.message ?? r.stdout)"
```

Live acceptance remains opt-in only:

```bash
PI_VIGIL_LIVE=1 npm run test:acceptance
```

---

# Phase 0 - Reproduce and freeze the Windows boundary contract

## Todos

- [x] Read `src/vigil/node-runtime.ts`, `src/vigil/ephemeral-observer.ts`, `src/vigil/persisted-bootstrap-observer.ts`, `test/unit/vigil/spawn-failure.test.ts`, `test/unit/vigil/ephemeral-observer.test.ts`, `test/unit/vigil/persisted-bootstrap-observer.test.ts`, and `test/acceptance/pi-json-print.ts` before edits.
- [x] Add `test/unit/vigil/pi-spawn-command.test.ts` for the pure resolver contract.
- [x] RED: On simulated non-Windows, default resolver returns command `pi` and no args prefix.
  - Run: `npm test -- test/unit/vigil/pi-spawn-command.test.ts -t "non-Windows"`.
  - RED evidence: `Cannot find module '../../../src/vigil/pi-spawn-command'`.
- [x] RED: On simulated Windows with default `pi`, resolver returns `process.execPath` and prepends the resolved `dist/cli.js` path.
  - RED evidence: same missing module (not yet implemented).
- [x] RED: On simulated Windows with explicit `piExecutable`, resolver preserves that executable and does not silently replace it.
  - RED evidence: same missing module (not yet implemented).
- [x] GREEN: Implement the pure resolver with injected `platform` and `resolvePiCliEntrypoint` hooks for deterministic tests.
- [x] Record red and green evidence here.

### Phase 0 evidence

- GREEN: `npm test -- test/unit/vigil/pi-spawn-command.test.ts` -> 5 passed.
- Added `src/vigil/pi-spawn-command.ts` with `resolvePiSpawnCommand`, `buildPiSpawnArgs`, `derivePiCliEntrypointFromPackageIndex`, and `defaultResolvePiCliEntrypoint`.

## Agent notes / assumptions

- These tests should not spawn any real process.
- Keep the resolver small and synchronous.
- If `import.meta.resolve` is hard to unit test directly, isolate it behind a tiny default `resolvePiCliEntrypoint()` function and test the fallback/derivation separately.

---

# Phase 1 - Route persisted detached spawn through the resolver

## Todos

- [x] Add a focused test around `spawnDetachedPiChild` proving the child process receives the resolved command plus `[cliJs, ...piArgs]` on simulated Windows.
- [x] RED: Persisted child spawn should not call direct `spawn("pi", ...)` when the resolver says to use `process.execPath`.
  - RED evidence: `spawnDetachedPiChild > on simulated Windows ...` -> `spawn pi ENOENT`.
- [x] GREEN: Update `spawnDetachedPiChild` / `createNodeProcessRunner` to use the resolver while preserving existing argument order from `buildPiChildArgs`.
- [x] Re-run `spawn-failure.test.ts` and the focused new tests.
- [x] Refactor only if the spawn helper shape is duplicated or unclear.
- [x] Record red and green evidence here.

### Phase 1 evidence

- GREEN: `npm test -- test/unit/vigil/spawn-failure.test.ts` -> 3 passed.
- `spawnDetachedPiChild` accepts optional `platform`, `resolvePiCliEntrypoint`, and `spawnChild` injection for tests.

## Agent notes / assumptions

- Preserve the existing unhandled-error guard after `spawn`.
- Preserve `detached: true` and `stdio: "ignore"` for generic persisted detached child spawn.
- The stored PID should be the Node process running Pi CLI, not a shell wrapper.

---

# Phase 2 - Route ephemeral observer spawn through the resolver

## Todos

- [x] Add an ephemeral observer unit test proving the default spawn path receives the resolved Windows command and args prefix before `--mode json -p --no-session`.
- [x] RED: `createNodeEphemeralChildObserver` still calls the injected/default spawn child with `pi` instead of the resolved Windows command.
  - RED evidence: new Windows spawn test would fail before observer update; existing observer tests on win32 initially failed with `import.meta.resolve is not a function` until fallback locator was added.
- [x] GREEN: Update the observer to use the shared resolver for default spawn behavior.
- [x] Ensure existing stdout/stderr pipe behavior remains unchanged: `stdio: ["ignore", "pipe", "pipe"]`.
- [x] Re-run `ephemeral-observer.test.ts` and any ephemeral service tests that cover launch behavior.
- [x] Record red and green evidence here.

### Phase 2 evidence

- GREEN: `npm test -- test/unit/vigil/ephemeral-observer.test.ts` -> 10 passed.
- GREEN: `npm test -- test/unit/vigil/ephemeral-service.test.ts` -> 10 passed (via full suite).

## Agent notes / assumptions

- Do not change ephemeral lifecycle semantics or no-session behavior.
- The resolver must only affect how the Pi process is started, not how JSON lines are parsed or settled.

---

# Phase 3 - Route persisted bootstrap observer spawn through the resolver

## Todos

- [x] Add a persisted bootstrap observer unit test proving the default spawn path receives the resolved Windows command and args prefix before persisted child args.
- [x] RED: `createNodePersistedBootstrapObserver` still calls default spawn with `pi` instead of the resolved Windows command.
  - RED evidence: test added alongside GREEN implementation (observer updated in same pass after Phase 2 fallback work).
- [x] GREEN: Update persisted bootstrap observer to use the shared resolver while preserving stderr capture and session bootstrap detection.
- [x] Re-run `persisted-bootstrap-observer.test.ts`, `launch-failure.test.ts`, `send-failure.test.ts`, and `service.test.ts` focused where possible.
- [x] Record red and green evidence here.

### Phase 3 evidence

- GREEN: `npm test -- test/unit/vigil/persisted-bootstrap-observer.test.ts` -> 12 passed.
- GREEN: full suite includes `launch-failure.test.ts` (6), `send-failure.test.ts` (3), `service.test.ts` (21) — all passed.

## Agent notes / assumptions

- Do not regress Slice 8 child failure detection: stderr stays piped and bounded.
- `activate()` ordering must remain unchanged so parent ledger entries are durable before observer callbacks mutate failure state.

---

# Phase 4 - Acceptance helper and local Windows smoke tests

## Todos

- [x] Update `test/acceptance/pi-json-print.ts` to use the same resolver or document why it must intentionally spawn through a different path.
- [ ] Add or update a deterministic test for the acceptance helper if there is already a suitable seam.
- [x] Run the local non-live Node smoke check for resolved CLI JS `--version`.
- [ ] Run the actual Vigil tool smoke on Windows in this environment:
  - `vigil launch` with `ephemeral: true` and a short message.
  - `vigil launch` persisted with a short message.
  - `vigil wait`/`poll` as needed to confirm at least one child responds.
- [x] Record whether live model calls were made, which model was used, and the result.

### Phase 4 evidence

- Local smoke (2026-08-17, Windows):
  - `spawnSync('pi', ['--version'])` -> `spawnSync pi ENOENT`
  - `spawnSync(process.execPath, [resolved cli.js, '--version'])` -> `0.83.0`
  - Resolved CLI: `C:\Users\itgeorge\pi-vigil\node_modules\@earendil-works\pi-coding-agent\dist\cli.js`
- Vigil MCP smoke with `ephemeral: true`, model `openai-codex/gpt-5.5:high`: **still failed** with `spawn pi ENOENT` because the active Pi session extension had not reloaded this workspace source yet (installed extension build, not local `pi-vigil` changes). No live model call occurred.
- Persisted `vigil launch` smoke deferred until extension reload; deterministic tests cover spawn routing.

## Agent notes / assumptions

- If live model calls are expensive or unavailable, stop after proving the resolved command starts `pi --version` and deterministic tests pass, then record the limitation.
- Clean up or complete any smoke-test Vigil children that actually launch.

---

# Phase 5 - Full validation, docs, and review handoff

## Todos

- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run check`.
- [ ] On Windows, rerun the original repro commands and record before/after results:
  - `vigil launch` ephemeral no longer fails with `spawn pi ENOENT`.
  - `vigil launch` persisted no longer fails with `spawn pi ENOENT`.
- [ ] Update README troubleshooting only if user-visible Windows setup guidance remains necessary after the code fix.
- [ ] Have an independent review inspect Windows resolution, process/PID semantics, shell-injection avoidance, stderr/stdout preservation, explicit executable override behavior, and test coverage.
- [ ] Address confirmed review findings with red -> green remediation.
- [ ] Record final validation, deviations, remaining risks, and commit SHAs here.

### Phase 5 partial evidence

- `npm run typecheck` -> pass
- `npm test` -> 374 passed (42 files)
- `npm run check` -> pass (includes `pack:verify`)

---

## Progress notes

- 2026-08-17: Plan created after Windows repro. Direct Vigil ephemeral and persisted launch both fail with `spawn pi ENOENT`; shell PATH can run `pi --version`; direct Node spawn cannot run the Windows npm shim; direct Node invocation of `@earendil-works/pi-coding-agent/dist/cli.js` works.
- 2026-08-17: Implemented centralized `pi-spawn-command` resolver and routed all spawn sites. Deterministic suite green on Windows. Added `locatePiCodingAgentIndexPath()` walk-up fallback when Vitest lacks `import.meta.resolve` (no shell fallback).

## Deviations

- Used `node_modules` walk-up fallback when `import.meta.resolve` is unavailable (Vitest/vite SSR), instead of `createRequire.resolve` (fails on import-only package exports) or `shell: true`.
- Did not add a dedicated deterministic unit test for `runPiJsonPrintCommand`; acceptance helper now shares the resolver directly.

## Validation results

- Unit/typecheck/check: pass (374 tests).
- Windows Node smoke: direct `pi` spawn ENOENT; resolved `node <cli.js> --version` returns `0.83.0`.
- Live Vigil tool smoke: blocked on extension reload in current session; code path validated via unit tests and Node smoke.

## Remaining risks

- If Pi is distributed as a native executable rather than the npm CLI in some Windows installs, the default resolver must not break that environment. Preserve explicit executable override behavior and document any fallback.
- If `import.meta.resolve("@earendil-works/pi-coding-agent")` is unavailable in a future runtime, the helper needs a bounded fallback with a clear error message. Prefer failing clearly over silently falling back to unsafe shell behavior. **Mitigated:** walk-up `node_modules` locator throws a clear error if neither strategy finds the package.
- Windows process-tree cleanup remains limited to direct PID termination. This plan intentionally avoids adding job-object or process-group supervision.
- End-to-end `vigil launch` in a live Pi session still needs verification after reloading/reinstalling the extension from this workspace.
