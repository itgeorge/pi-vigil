# Slice 1 — Vigil walking skeleton

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered, relevant TODOs beneath the current phase before continuing. Mark completed items `[x]`, and record assumptions, deviations, and test notes in this file. Commit the plan updates in the same commit as their code and test changes.

This plan intentionally covers **only Slice 1**. Do not implement `send`, `list`, `search`, or `complete` yet.

---

## What this work is

Create the first end-to-end vertical slice of `pi-vigil`: an extension tool that can launch one detached, resumable Pi child session and later poll it for `running` or `waiting` status plus its latest *complete* assistant response.

This slice proves the core design:

- a Pi extension registers the `vigil` tool;
- the parent records a durable `vigil-launch` custom session entry;
- a child uses `pi --mode json -p --session-id <generated-id>`;
- the child session JSONL is the source of truth for the response;
- polling derives `running` from PID liveness and `waiting` otherwise.

No live partial-output capture, retry, process supervision, or mutable registry is in scope.

## End goal of this plan

A package-loadable TypeScript Pi extension with two actions:

```ts
vigil({ action: "launch", message, model?, cwd? })
vigil({ action: "poll", id })
```

`launch` returns a `VigilSnapshot` with a generated `vigil-…` ID and `running` state. `poll` returns `running` while the child PID is alive, or `waiting` with the child’s latest complete assistant text after it exits.

## Key working assumptions

- Extension/package name: `pi-vigil`; tool name: `vigil`; child IDs use `vigil-` prefix.
- Child cwd defaults to the calling parent’s `ctx.cwd`; `launch.cwd` may override it.
- `launch.model` is optional and accepts Pi CLI model syntax such as `openai-codex/gpt-5.5:high`.
- Child sessions use Pi’s default storage in production. Test-only configuration may supply a temporary `--session-dir` for isolation.
- `pi.appendEntry("vigil-launch", data)` is the parent relationship ledger. The child conversation, including model changes, stays in its native Pi session JSONL.
- A completed child process is `waiting` until a later slice adds parent-directed `complete`.
- Tests prefer observable outputs, persisted entries, and session contents. Avoid call/argument assertions except for a narrowly scoped CLI-boundary wiring test.
- Live tests are opt-in but **must fail**, not skip, when explicitly run without `PI_VIGIL_LIVE=1` or usable Pi authentication.

---

# Phase 0 — Package and test harness

## Todos

- [x] Add a package manifest for `pi-vigil`:
  - package is ESM;
  - `pi.extensions` points to `./src/index.ts`;
  - Node engine is compatible with the installed Pi requirement (currently Node >=22.19);
  - runtime dependencies contain only packages required at extension execution;
  - Pi packages are declared as peer/dev dependencies as appropriate for type checking and tests.
- [x] Add TypeScript and Vitest configuration plus scripts:
  - `npm test` runs deterministic tests only;
  - `npm run test:unit` is an explicit deterministic equivalent;
  - `npm run test:acceptance` runs live acceptance tests only;
  - acceptance tests are not included in the default test command.
- [x] Add a minimal source/test layout:

  ```text
  src/index.ts                 # Thin Pi extension adapter
  src/vigil/types.ts           # Domain DTOs: VigilSnapshot, launch record, statuses
  src/vigil/service.ts         # Launch/poll orchestration
  src/vigil/ports.ts           # Process runner, child-session reader, parent ledger ports
  src/vigil/node-runtime.ts    # Node/Pi implementations of ports
  test/unit/...                # Deterministic unit/integration tests
  test/fixtures/...            # Pi JSONL session fixtures
  test/acceptance/...          # Opt-in real-Pi tests
  ```

  File/module names may evolve if a clearer small design emerges; update this plan if they do.
- [x] Add a test helper that captures the registered `vigil` tool from the extension and provides a fake parent context/API. It should allow tests to invoke the registered tool’s `execute` function without an LLM.
- [x] Add JSONL fixtures representing: a valid child session header, a user message, and an assistant message containing text. Fixtures should resemble current Pi v3 session entries.
- [x] Verify the empty package baseline: install dependencies, run `npm test`, and run type checking if configured.

## Agent notes / assumptions

- The extension should import public APIs from `@earendil-works/pi-coding-agent`; do not copy Pi session-format logic.
- Prefer direct service-result assertions over assertions that a fake’s methods were called.

---

# Phase 1 — Define the testable core contract (TDD)

## Todos

- [x] Write failing tests for the domain result shape before implementing it:

  ```ts
  type VigilState = "running" | "waiting";

  interface VigilSnapshot {
    id: string;
    sessionId: string;
    cwd: string;
    state: VigilState;
    latestResponse: string | null;
  }
  ```

  Additional fields are allowed only when useful and stable; callers must always receive the fields above.
- [x] Define small ports rather than coupling service logic to Node globals:
  - start a detached child Pi turn and return a PID;
  - determine whether a PID is alive;
  - find/read a child session by exact session ID, cwd, and optional session directory;
  - append parent ledger data.
- [x] Write failing outcome-based tests for `launch` using a fake runtime:
  - returns a `running` snapshot with a unique `vigil-` ID;
  - uses parent cwd when no override is supplied;
  - uses explicit `cwd` when supplied;
  - preserves the requested model as launch metadata;
  - makes one durable parent `vigil-launch` record whose data can reconstruct the child identity, PID, cwd, and optional model.
- [x] Write failing outcome-based tests for `poll`:
  - alive child returns `running` and the latest persisted assistant text, if any;
  - exited child returns `waiting` and the most recent complete assistant text;
  - a child session with no assistant message returns `latestResponse: null` without throwing.
- [x] Implement only enough pure/core code to make these tests pass.
- [x] Add exactly one focused boundary test for command construction. Assert only the externally required child invocation semantics:
  - noninteractive JSON mode and print mode are selected;
  - exact `--session-id` is included;
  - optional `--model` is included when requested;
  - parent/default-or-override cwd is used.

## Agent notes / assumptions

- The service should produce snapshots; the extension should format them for the LLM, rather than forcing business logic to return tool-content blocks.
- Polling an unknown ID may return a clear error result. Choose and document a stable behavior in tests rather than silently creating state.

---

# Phase 2 — Node/Pi adapters and thin extension adapter

## Todos

- [x] Implement a Node process runner that starts a detached Pi child without waiting for completion:
  - invoke the installed `pi` executable (or the current Pi executable when that is the safer equivalent);
  - use `--mode json -p --session-id <id>`;
  - pass optional `--model <model>` and the message;
  - use the selected cwd;
  - avoid retaining stdout/stderr or attempting live progress in this slice;
  - call `unref()` so the parent tool returns immediately.
- [x] Implement a child-session reader using public Pi session APIs where possible. It must locate a child by exact session ID and read the latest assistant text from its persisted session entries.
- [x] Implement the extension in `src/index.ts`:
  - register a `vigil` tool with a typed action enum (`launch`, `poll`);
  - use a schema compatible with Pi providers (use `StringEnum` for string enum parameters where required);
  - call `pi.appendEntry("vigil-launch", …)` on successful launch;
  - return a concise, machine-readable snapshot in tool text and the structured snapshot in `details`;
  - do not add custom TUI rendering in Slice 1.
- [x] Add adapter-level tests that invoke the registered tool through the test helper and assert tool results and captured persisted entry data, not internal service calls.
- [x] Verify all deterministic tests pass.

## Agent notes / assumptions

- Do not add `--no-session`: children must remain resumable.
- Do not create a standalone runtime registry, event log, or background watcher.
- A parent-process crash between spawn and entry append is an accepted v1 limitation; document it briefly if encountered.

---

# Phase 3 — Opt-in live acceptance test

## Todos

- [x] Add a live-test prerequisite helper:
  - `PI_VIGIL_LIVE` must equal `1`; otherwise `npm run test:acceptance` fails with instructions;
  - model defaults to `openai-codex/gpt-5.5`, overridable through `PI_VIGIL_TEST_MODEL`;
  - verify usable Pi authentication with a real, tiny Pi request rather than provider-specific credential-file inspection;
  - authentication/preflight failure must fail with an actionable message, never skip.
- [x] Write one end-to-end acceptance test through the registered tool adapter and real process runner:
  1. make a unique temporary cwd and isolated test session directory;
  2. call `vigil.launch` with a request to reply exactly with a unique marker such as `VIGIL_READY_<random>`;
  3. assert the launch result is `running` and has a `vigil-` ID;
  4. repeatedly call `vigil.poll` until `waiting` or a bounded timeout;
  5. assert the final snapshot contains the exact marker;
  6. assert the child session is persisted and contains the expected complete assistant response.
- [x] Ensure test cleanup removes temporary cwd/session storage even after failures.
- [x] Document the live test command and required variables in `README.md`.
- [x] Run deterministic tests and, if this machine is authenticated and opt-in is supplied, run the acceptance command. Record whether it was run and its result in this plan.

## Agent notes / assumptions

- The live test should validate outcomes, not whether `spawn()` was called.
- The live test may use a test-only isolated session directory; production behavior continues to use Pi’s default session store.
- Keep timeout/poll interval configurable through test-only environment variables with conservative defaults.

---

# Phase 4 — Slice handoff and boundaries

## Todos

- [x] Confirm all default tests are deterministic and credential-free.
- [x] Confirm `npm run test:acceptance` fails fast and helpfully without opt-in/auth, rather than being skipped.
- [x] Confirm no Slice 2+ APIs (`send`, `list`, `search`, `complete`) were added beyond any private abstractions strictly needed by Slice 1.
- [x] Update this plan’s checkboxes, notes, and deviations; commit plan changes with code/test changes.
- [x] Provide the reviewer with: commit SHA, test commands/results, whether acceptance was run, changed public API, and any deviations from this plan.

## Future slices (not implementation work for this handoff)

- Slice 2: `send` for turn-based resumption and model selection on every child turn.
- Slice 3: parent-session reconstruction, `list`, and explicit `complete` cleanup semantics.
- Slice 4: bounded full-conversation `search`.

## Progress notes

- 2026-08-01: Plan created. No implementation has started.
- 2026-08-02: Slice 1 implemented. Deterministic tests: 17/17 passing (`npm test`, `npm run typecheck`). Acceptance: attempted with `PI_VIGIL_LIVE=1`; preflight failed (`spawnSync pi ETIMEDOUT` after 120s) — fails helpfully, not skipped. Without opt-in, `npm run test:acceptance` fails in setup with PI_VIGIL_LIVE instructions.
- 2026-08-02: Slice 1 follow-up. Fixed runtime session-dir lookup (`SessionManager.listAll` for explicit `--session-dir`), execution-time `PI_VIGIL_SESSION_DIR`, Pi print-mode `waiting` semantics (turn complete OR process exit), async spawn error handling, and `@earendil-works/pi-ai` peer dependency. Deterministic tests: 22/22. Acceptance with `PI_VIGIL_LIVE=1`: passed (~3s poll loop).

## Deviations / implementation notes

- `VigilService` lives in `src/vigil/node-runtime.ts` alongside Node adapters (no separate `service.ts`) to keep the walking skeleton small.
- Child session reading uses exported `parseSessionEntries` plus `SessionManager.list` rather than non-exported `loadEntriesFromFile` / `getDefaultSessionDir` helpers from `@earendil-works/pi-coding-agent@0.83.0`.
- Test-only runtime injection uses `setVigilRuntimeOverrides()` rather than mocking internal module calls.
- Launch `id` and Pi `--session-id` share the same generated `vigil-<uuid>` value; `VigilSnapshot.sessionId` mirrors `id`.
- Test-only isolated child storage is enabled via `PI_VIGIL_SESSION_DIR` (read at tool execution time, passed as `--session-dir`); production omits it and uses Pi defaults.
- `@earendil-works/pi-ai` is a peer dependency (also in devDependencies for local tests).
- **Poll / Pi lifecycle:** Pi print-mode children may remain alive after `agent_settled`. `poll` transitions to `waiting` when the child session's latest assistant turn is complete (`stopReason !== pending`) or the PID has exited.
- **Custom session dirs:** when a launch record includes `sessionDir`, child lookup uses `SessionManager.listAll(sessionDir)` so macOS `/private` cwd prefixes do not hide sessions from `SessionManager.list(cwd, sessionDir)`.
- **Preflight / acceptance:** live tests use JSON print stdout (`agent_settled` + marker) rather than `spawnSync` waiting for Pi process exit.
