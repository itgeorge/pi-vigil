# Slice 3 — Session names, listing, and explicit completion

## How agents should use this plan

Read this entire plan before making changes. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered, relevant TODOs beneath the current phase before continuing. Mark completed items `[x]`, and record assumptions, deviations, and test notes in this file. Commit plan updates in the same commit as their corresponding code/test changes.

This plan intentionally covers **only Slice 3**. Do not implement full-conversation `search`, partial-output streaming, retry/supervision, process groups, or an external mutable registry.

---

## What this work is

Give the parent agent a durable, named working set of Vigil children and an explicit way to retire work it has finished with.

```ts
vigil({ action: "launch", name, message, model?, cwd? })
vigil({ action: "list", includeCompleted? })
vigil({ action: "complete", id })
```

Every child launched by Vigil must receive a nonblank human-readable Pi session name. Completion is intentionally **not deletion**: child JSONL remains the durable conversation, audit trail, and potential manual recovery context. `complete` reaps a lingering settled Pi worker, prefixes the child session’s current name with `[completed]`, and appends a parent `vigil-complete` tombstone. The active parent working set no longer includes it.

## End goal of this plan

The extension supports:

```ts
vigil({ action: "launch", name, message, model?, cwd? })
vigil({ action: "poll", id })
vigil({ action: "send", id, message, model? })
vigil({ action: "list", includeCompleted? })
vigil({ action: "complete", id })
```

- `launch` rejects missing/whitespace-only names and invokes Pi with `--name <name>`.
- `list` reconstructs Vigil children from append-only entries in the current **parent session file**, returns active children by default, and includes tombstoned children only with `includeCompleted: true`.
- `complete` is permitted only while a child is `waiting`; it reaps a tracked live Pi process, preserves the child JSONL, prefixes its current Pi session display name, appends one completion record, and returns a `completed` snapshot.
- After completion, `poll` returns the retained child as `completed`; `send` rejects it. Repeating `complete` is idempotent and never adds another prefix/ledger entry.

## Key working assumptions

- Child session JSONL files are **never deleted by Vigil**. Temporary acceptance-test directories may still be removed by test teardown.
- A name is Pi-native session metadata, not a Vigil-only alias: initial launch passes `--name`; completion uses public `SessionManager` APIs to append a session-info name update.
- On completion, derive the name from the child session’s current display name, not the original launch record. If it changed during child work, preserve that change and prepend `[completed]`; never restore the original launch name.
  - A missing/cleared current name becomes `[completed]`.
  - Do not special-case an already-prefixed name: normal idempotency prevents a second completion; a user-supplied `[completed] …` name is still prefixed once as instructed.
- `VigilSnapshot` may gain stable `name`, `completedAt`, and `state: "completed"` data as needed. A list item should be concise (identity/name/cwd/state/completion time) and must not duplicate potentially large `latestResponse`; callers can use `poll` for response text.
- The parent ledger is the sole authority for whether a Vigil child is active or completed. The child session name is presentation/retention metadata, not a substitute for the parent completion record.
- Listing covers all Vigil custom entries held in the currently open parent session file (including its stored branches), never other parent session files or an external registry. Return a documented deterministic order (recommended: most recently updated first).
- Existing Slice 2 safety remains: `poll` is observational; `send`/`complete` must never leave a second Pi process writing the same child session.
- Use outcome/persistence tests and a narrow CLI-boundary test; avoid mock call assertions except where wiring to Pi CLI/public SessionManager APIs is the behavior under test.

---

# Phase 0 — Define public contracts with failing tests

## Todos

- [x] Read the completed Slice 1 and Slice 2 plans plus current implementation before changing code. Preserve existing launch/poll/send semantics except where this plan explicitly extends them.
- [x] Add failing adapter/service tests establishing name validation and initial name propagation:
  - `launch` requires a nonblank `name` in addition to `message`;
  - a valid launch returns/persists the normalized name;
  - the child CLI invocation includes `--name <name>` exactly for the initial launch;
  - `send` does **not** pass a name that could overwrite a child-renamed session.
- [x] Add failing contract tests for `list`:
  - default list includes active launched/sent children and excludes completed ones;
  - `includeCompleted: true` includes both active and completed children;
  - multiple turns for one ID collapse to one item using the latest runtime record;
  - deterministic ordering is explicitly asserted;
  - unknown/malformed unrelated custom entries do not appear.
- [x] Add failing contract tests for `complete`:
  - a waiting child becomes `completed`, receives one parent `vigil-complete` record, and retains its child session;
  - a running child returns a clear error and is not renamed/completed;
  - a waiting-but-live child is reaped before its name is updated/completion is recorded;
  - a completed ID polls as `completed`, rejects `send`, and a second `complete` is idempotent;
  - failure to reap or rename returns a clear error and does not append `vigil-complete`.
- [x] Agree on/encode a stable structured result for list, for example:

  ```ts
  interface VigilListItem {
    id: string;
    sessionId: string;
    name: string;
    cwd: string;
    state: "running" | "waiting" | "completed";
    completedAt?: string;
  }

  interface VigilListResult {
    vigils: VigilListItem[];
  }
  ```

  The exact DTO names may evolve, but keep `details` structured and tool text concise/machine-readable.

## Agent notes / assumptions

- Use fakes that expose resulting process/session/ledger state. Do not merely assert `terminateAndWait` or rename methods were called.
- Preserve original accepted snapshot fields (`id`, `sessionId`, `cwd`, `state`, `latestResponse`) when extending snapshot details.

---

# Phase 1 — Model lifecycle history and reconstruct the parent working set

## Todos

- [x] Add typed records/DTOs for the new lifecycle data:
  - required launch `name` on `VigilLaunchRecord`;
  - `VigilCompletionRecord` with at least ID, session ID, final completed name, and completion timestamp;
  - active/completed lifecycle resolution and concise list items;
  - `completed` in the externally visible state union as required by the Phase 0 contract.
- [x] Replace the current single-record lookup with a parent-ledger reconstruction that scans `vigil-launch`, `vigil-turn`, and `vigil-complete` entries for the current parent session file:
  - retain the latest runtime PID/cwd/session-dir/model record for each ID;
  - mark an ID completed only when a valid later completion record is present;
  - retain the final completion name/time for completed list/poll output;
  - ignore malformed/incomplete records safely;
  - produce a deterministic most-recent-first list.
- [x] Ensure a completion record dominates later lookup for the same ID. A valid ledger created by Vigil will never append a new turn after completion; defensively avoid treating malformed history as an active runnable child.
- [x] Keep this session-only and append-only. Do not add a JSON database, in-memory registry, or parent-session mutation/deletion.
- [x] Add tests for reconstruction across launches, multiple turns, completions, interleaved IDs, and unrelated custom entries.

## Agent notes / assumptions

- `getEntries()` is intentionally scoped to the currently open parent Pi session; it may include stored tree branches. Do not scan arbitrary parent session files from disk.
- A parent crash between child rename and `vigil-complete` append remains an accepted v1 atomicity limitation. Document it; do not introduce transactional storage to solve it.

---

# Phase 2 — Pi-native child session naming adapter

## Todos

- [x] Extend child spawning input/CLI construction so only `launch` supplies the normalized required name via Pi’s public `--name` option. Keep session ID, model, cwd, and test session-dir behavior unchanged.
- [x] Add a narrow child-session naming port/adapter using public Pi session APIs:
  - locate the child session by exact ID/cwd/session directory;
  - open it through `SessionManager`;
  - read its current display name;
  - append a session-info update with `[completed] ${currentName}` (or `[completed]` if absent);
  - return the final completed name.
- [x] Do not rewrite the child JSONL directly. Do not overwrite a changed name with the launch name.
- [x] Add deterministic tests using fixtures/fakes for initial name, a changed current name, missing current name, and a naming failure/missing child session.
- [x] Add a focused CLI-boundary assertion covering `--name` for `launch` and its absence from `send`.

## Agent notes / assumptions

- Public Pi supports `--name` / `-n` at startup and `SessionManager.appendSessionInfo(name)` for later display-name updates. Prefer these public contracts over handwritten session-entry JSON.
- `complete` must only mutate session name after the current child turn is settled and any tracked worker has been reaped, preventing concurrent JSONL writers.

---

# Phase 3 — `list` and `complete` service/extension actions

## Todos

- [x] Add `list` and `complete` to the `vigil` `StringEnum` action schema, plus optional boolean `includeCompleted` compatible with Pi tool schemas.
- [x] Implement adapter validation:
  - `launch` requires `name` and `message`;
  - `poll`, `send`, and `complete` require `id`;
  - `list` accepts no ID and uses `includeCompleted: false` by default;
  - errors use the project’s concise tool-error pattern.
- [x] Implement `list` service behavior:
  - reconstruct parent lifecycle state;
  - derive current `running`/`waiting` state for active records using existing session/PID logic;
  - return concise active list items by default;
  - include completed lifecycle items on request without starting/reaping child processes or exposing `latestResponse` in each list item.
- [x] Implement `complete` service behavior in this order:
  1. resolve lifecycle state from the parent ledger;
  2. return the existing completed result without side effects if already completed;
  3. derive active child state and reject `running`;
  4. if the settled tracked PID is alive, terminate and wait using the Slice 2 bound;
  5. prefix the child session’s current Pi-native name;
  6. append one durable `vigil-complete` record;
  7. return a `completed` snapshot with final name and most recent retained response.
- [x] Make `poll` recognize a completion record and return a `completed` snapshot while continuing to read the retained child session’s latest response when available.
- [x] Make `send` explicitly reject a completed ID before any process/session mutation.
- [x] Format `list` tool text concisely and return `VigilListResult` in `details`; continue returning structured snapshots for launch/poll/send/complete.
- [x] Update README API, lifecycle, naming, and retention documentation.
- [x] Run deterministic tests and typecheck.

## Agent notes / assumptions

- If the child session cannot be found/renamed, completion must fail clearly rather than claim the name was marked completed. Do not append a completion record in this case.
- If the current process already exited, completion skips termination and can still mark the retained session complete.
- Do not add an `uncomplete` action in this slice. A user can manually rename/revisit retained Pi sessions, but Vigil completion remains immutable parent ledger history.

---

# Phase 4 — Live acceptance: named retained completion and listing

## Todos

- [x] Extend the single existing opt-in acceptance test through the registered extension adapter:
  1. launch a uniquely named child with the existing first marker;
  2. poll to `waiting`, send the existing follow-up, and poll to `waiting` again;
  3. verify default `list` contains the active child with its name/state and does not expose an oversized response field;
  4. change the child’s Pi-native display name through public session APIs (simulating work-time renaming);
  5. call `complete` and verify a `completed` result plus the `[completed]` prefix applied to that changed name;
  6. assert the child session file still exists and its final session display name is the prefixed changed name;
  7. assert `poll` reports `completed`, `send` rejects it, default `list` excludes it, and `list({ includeCompleted: true })` includes it;
  8. if the final tracked PID was alive before completion, assert it is no longer alive afterward.
- [x] Retain the current opt-in/auth prerequisite behavior and test model/timeouts.
- [x] Ensure test teardown, not `complete`, removes only temporary test directories/processes.
- [x] Run and record:
  - `npm test`;
  - `npm run typecheck`;
  - `npm run test:acceptance` without opt-in to confirm helpful failure;
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.

## Agent notes / assumptions

- The live test may use `SessionManager.open(...).appendSessionInfo(...)` to simulate a user/child session rename because it is exercising Pi’s public persisted-session behavior.
- Keep acceptance to one available authenticated model; no multi-provider/multi-model requirement is needed.

---

# Phase 5 — Slice handoff and boundaries

## Todos

- [x] Confirm all default tests remain deterministic and credential-free.
- [x] Confirm no child JSONL deletion is performed by `complete`; document that Pi’s normal session UI/manual cleanup remains available to the user.
- [x] Confirm default list excludes completed children and `includeCompleted` includes them without an external registry.
- [x] Confirm no Slice 4 `search` or unrelated lifecycle APIs were added.
- [x] Update this plan’s checkboxes, progress notes, assumptions, and deviations; commit plan updates with code/tests.
- [x] Provide the reviewer: commit SHA, test results, live acceptance status, public API changes, exact completion/name retention behavior, and deviations.

## Future slice (not implementation work for this handoff)

- Slice 4: bounded full-conversation `search` across retained child sessions.

## Progress notes

- 2026-08-02: Plan created after accepted Slices 1–2. User confirmed that `complete` must retain child session JSONL, use Pi-native required launch names, prefix the child’s current name with `[completed]`, and expose completed items only through `list({ includeCompleted: true })`. No Slice 3 implementation has started.
- 2026-08-02: Slice 3 implemented. Added lifecycle reconstruction (`src/vigil/lifecycle.ts`), required launch `name` with Pi `--name`, `list`/`complete` actions, `ChildSessionNamer` via `SessionManager.appendSessionInfo`, and parent `vigil-complete` tombstones. Unit tests: 63 passed; typecheck clean. Live acceptance extended but not executed in CI (requires `PI_VIGIL_LIVE=1` + authenticated Pi). `npm run test:acceptance` without opt-in fails fast with setup instructions as expected.

## Deviations

- None from the plan’s product decisions. Implementation uses `ParentLedger.getLifecycle` / `listLifecycleStates` rather than separate `findLatestTurn`/`findCompletion`/`listVigils` helpers on the port.

## Test notes

- `npm test`: 63/63 unit tests passed (credential-free).
- `npm run typecheck`: passed.
- `npm run test:acceptance` without `PI_VIGIL_LIVE=1`: fails immediately with opt-in instructions (expected).
- `PI_VIGIL_LIVE=1 npm run test:acceptance`: not run in this environment (no authenticated Pi session available here).
