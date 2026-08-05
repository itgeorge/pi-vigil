# Slice 8 — Child launch failure detection and surfaced errors

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work strictly in **red → green → refactor** order:

1. Add the smallest focused failing test for the current item.
2. Run the test and **record the exact red failure** in this file (test name + assertion/message).
3. Implement only the code required to turn it green.
4. Re-run the focused test and the nearest related suite; record green evidence.
5. Refactor only when green; keep diffs minimal and scoped.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, and commit plan checkbox updates with the corresponding code/tests.

Do not begin implementation until the user explicitly approves proceeding after plan review.

**User constraint (confirmed):** implement **both** fail-fast detection on `launch`/`send` **and** downstream error surfacing on `poll`, `wait`, `list`, `complete`, and related read paths. A slow or missed bootstrap failure must still become visible later via persisted failure state and stderr/process signals.

**User approval (2026-08-05):** proceed with implementation. Orchestration uses Composer 2.5 fast `:high` for implementation/fixes and live acceptance; Grok 4.5 for review; final smoke test with Composer 2.5 fast.

---

## Problem statement

Today `launch` and `send` treat **process spawn success** as operation success. Pi can exit immediately (invalid model, auth/CLI errors, etc.) without creating a child session JSONL. Downstream actions then misreport state.

**Investigation evidence (2026-08-05):**
- `pi --mode json -p --session-id <id> --model "totally-invalid-model/foo" "hello"` prints `Error: Model "..." not found` to stderr, exits, and **does not create** a session file.
- `spawnDetachedPiChild` resolves on `spawn` with `stdio: "ignore"`, so stderr is discarded.
- `createNodeChildSessionReader().readChildSessionState` returns `EMPTY_CHILD_SESSION_STATE` when the session file is missing (not an error).
- `deriveVigilState({ alive: false, ... })` returns `"waiting"`, so `poll`/`wait` report a useless settled/waiting result with `latestResponse: null`.

| Symptom today | Root cause |
|---|---|
| `launch`/`send` return `state: "running"` | `spawnDetached` resolves on `spawn`; no bootstrap validation |
| Missing child session | Pi exits before JSONL is written; stderr discarded (`stdio: "ignore"`) |
| `poll` → `waiting`, `latestResponse: null` | `readChildSessionState` returns empty placeholder; dead PID ⇒ `deriveVigilState` ⇒ `waiting` |
| `wait` → immediate `settled` with null response | Same misclassification; looks like “no result” |
| `send` allowed after failed launch | Failed child appears `waiting` |
| Ephemeral failures stored in `vigil-settle.error` but invisible | `resolveEphemeralActiveSnapshot` omits settle error from snapshots |
| Hung alive child, no session | Stays `running` until wait timeout with no explanation |

## End goal

1. **Fail fast when possible:** `launch` and `send` return a clear `{ error: ... }` when bootstrap failure is knowable within a short, bounded window.
2. **Detect later when needed:** `poll`, `wait`, `list`, and other read paths surface the same failure even if launch already returned `running` (slow failure, parent delay, or race).
3. **Durable failure identity:** Persist a parent `vigil-fail` record so failure survives parent restart and is not re-derived from ephemeral process state alone.
4. **stderr + process signals:** Capture bounded child stderr for persisted children; reuse ephemeral stdout/stderr parsing where applicable.

## Public contract (target)

### New parent lifecycle record

```ts
interface VigilFailRecord {
  id: string;
  sessionId: string;
  failedAt: string;
  error: string;          // bounded, sanitized, user-facing
  source: "bootstrap" | "ephemeral-settle" | "turn";
  stderrExcerpt?: string; // optional, bounded
}
```

Malformed/duplicate `vigil-fail` entries follow existing lifecycle hardening (ignore, do not corrupt).

### New error helpers (names may evolve)

```ts
formatVigilChildFailedError(vigilId: string, error: string): string
// e.g. "Vigil child failed: vigil-abc123 — Model \"foo\" not found ..."
```

### Action semantics

| Action | On failed child |
|---|---|
| `launch` | Return `{ error }` when bootstrap failure detected before returning; otherwise current running snapshot |
| `send` | Same bootstrap fail-fast after respawn; reject if lifecycle already has `vigil-fail` |
| `poll` | Return `{ error }` (not a waiting snapshot) |
| `wait` | Return `{ error }` when targeted id failed; for cohort wait, fail the whole wait if any watched child failed (documented) |
| `list` | Include item with `state: "failed"` and omit from default active cohort used by wait |
| `complete` | Return `{ error }` — cannot complete a failed child |
| `search`/`read` | Keep current transcript-unavailable errors; no change required unless tests show confusion |

### New `VigilState`

Add `"failed"` to `VigilState` and `VigilListItem.state`. `VigilSnapshot.state` remains `running | waiting | completed` for successful paths; failures use `{ error }` from service methods instead of a failed snapshot (keeps mutation receipts unchanged).

---

## Architecture sketch

### 1. Pure failure helpers — `src/vigil/child-failure.ts`

- `parsePiStderrFailure(stderr: string): string | null` — detect lines like `Error: Model "..." not found`
- `boundStderrExcerpt(stderr: string, maxChars): string`
- `classifyPersistedBootstrapFailure({ alive, sessionExists, turnStartedAt, lastConversationTimestamp, stderr }): string | null`
- Unit-tested without processes.

### 2. Persisted bootstrap observer — `src/vigil/persisted-bootstrap-observer.ts`

Mirror ephemeral observer patterns but for persisted launches:

- Spawn with `stderr: "pipe"` (keep stdout ignored unless needed later).
- Track until **first definitive signal**:
  - child session file exists for `sessionId` ⇒ bootstrap success, detach/close observer
  - process exits ⇒ evaluate failure (no session / stderr / both) ⇒ persist `vigil-fail`
  - stderr matches known fatal pattern ⇒ fail fast without waiting for exit
- Bounded stderr buffer (e.g. 8–16 KiB).
- `activate()` after parent `vigil-launch` append (same race fix as ephemeral).
- Shared shutdown hook on parent `session_shutdown`.

### 3. Lifecycle integration

- Extend `VigilLifecycleState` with `failRecord: VigilFailRecord | null`.
- `reconstructVigilLifecycleFromEntries` ingests `vigil-fail`.
- `deriveDiagnosticChildIdentity` maps failed ⇒ `state: "failed"`.
- `listLifecycleStates(includeCompleted)` excludes failed from active cohort (like completed).

### 4. Service integration (`node-runtime.ts`)

- `launch`/`send`: await `bootstrapObserver.waitForOutcome({ timeoutMs })` before returning.
  - `failed` ⇒ roll forward `vigil-fail` already appended by observer ⇒ return `{ error }`
  - `started` ⇒ return running snapshot
  - `timeout` ⇒ return running snapshot (poll/wait will continue watching)
- `buildActiveSnapshot`/`resolveEphemeralActiveSnapshot`: check `failRecord` first ⇒ `{ error }`
- `send`: reject when `failRecord` present.
- `wait` scan: if any cohort member has `failRecord`, return `{ error }` (or structured per-id message).

### 5. Ports

```ts
interface PersistedBootstrapObserver {
  start(input: PersistedBootstrapInput): Promise<{ pid: number; activate(): void }>;
  waitForOutcome(vigilId: string, options: { timeoutMs: number }): Promise<
    | { status: "started" }
    | { status: "failed"; error: string }
    | { status: "timeout" }
  >;
  shutdown(options?: TerminateAndWaitOptions): Promise<void>;
}
```

Inject via `VigilServiceDeps` with node default + test fake.

---

## Testing strategy

- **Unit tests** with fakes (no real `pi` spawn) for every phase.
- **CLI-boundary tests** optional for stderr parsing from recorded fixtures.
- **Live acceptance** behind `PI_VIGIL_LIVE=1` only in final phase.
- Each phase lists an explicit **RED command** and expected failure snippet.

Suggested focused commands:

```bash
npm test -- test/unit/vigil/child-failure.test.ts
npm test -- test/unit/vigil/persisted-bootstrap-observer.test.ts
npm test -- test/unit/vigil/launch-failure.test.ts
npm test -- test/unit/vigil/poll-failure.test.ts
npm test -- test/unit/vigil/wait-failure.test.ts
npm test -- test/unit/vigil/send-failure.test.ts
npm test -- test/unit/vigil/list-failure.test.ts
npm test -- test/unit/vigil/ephemeral-failure-surface.test.ts
npm run check
```

---

# Phase 0 — Specify failure contract with pure helper red tests

## Todos

- [x] Read `node-runtime.ts`, `ephemeral-observer.ts`, `lifecycle.ts`, `session-text.ts`, `ports.ts`, `types.ts`, `service.test.ts`, ephemeral tests, and wait/list tests before edits.
- [x] Add `src/vigil/child-failure.ts` and `test/unit/vigil/child-failure.test.ts`.
- [x] **RED:** `parsePiStderrFailure` extracts model-not-found message from fixture stderr.
  - Run: `npm test -- test/unit/vigil/child-failure.test.ts -t "model not found"`
  - Expected RED: function/module missing or returns `null`.
- [x] **RED:** `classifyPersistedBootstrapFailure` returns error when `alive=false`, `sessionExists=false`, stderr has model error.
  - Expected RED: returns `null` or throws.
- [x] **RED:** `classifyPersistedBootstrapFailure` returns `null` when session exists (success path).
- [x] **RED:** `classifyPersistedBootstrapFailure` returns `null` when process alive and session missing (still bootstrapping).
- [x] **GREEN:** implement pure helpers; record passing output.

## Agent notes / assumptions

- Do not spawn processes in this phase.
- Keep parsing conservative: prefer explicit `Error:` lines from Pi CLI over heuristic guessing.

---

# Phase 1 — Persisted bootstrap observer (stderr + exit detection)

## Todos

- [x] Add `src/vigil/persisted-bootstrap-observer.ts` and `test/unit/vigil/persisted-bootstrap-observer.test.ts` with `createFakePersistedBootstrapObserver` for service tests.
- [x] **RED:** observer `start` + `activate` + simulated stderr `Error: Model "bad" not found` + child `close` ⇒ `onFailed`/`waitForOutcome` ⇒ `{ status: "failed", error: ... }`.
  - Expected RED: module missing or status `"started"`.
- [x] **RED:** child `close` with no session and no stderr ⇒ failed with generic bootstrap error.
- [x] **RED:** session-appears signal (fake callback) before exit ⇒ `{ status: "started" }`, no `vigil-fail`.
- [x] **RED:** `waitForOutcome` with no signal before timeout ⇒ `{ status: "timeout" }`.
- [x] **RED:** `activate()` is required before stream handlers attach (mirror ephemeral race guard).
- [x] **GREEN:** implement node observer + fake; wire bounded stderr drain.

## Agent notes / assumptions

- Session existence check should reuse `findChildSessionPath` injection, not inline FS in untested code.
- Observer appends `vigil-fail` via callback supplied by service/ledger (observer does not own ledger).

---

# Phase 2 — Lifecycle: ingest `vigil-fail`

## Todos

- [x] Extend `types.ts` with `VigilFailRecord`; add `appendFail` to `ParentLedger` / `createSessionParentLedger`.
- [x] Update `lifecycle.ts` reconstruction and `deriveDiagnosticChildIdentity`.
- [x] **RED:** `reconstructVigilLifecycleFromEntries` retains first valid `vigil-fail` and exposes `failRecord`.
  - File: `test/unit/vigil/lifecycle.test.ts`
  - Expected RED: `failRecord` undefined.
- [x] **RED:** malformed/duplicate `vigil-fail` ignored (parallel to settle/complete hardening).
- [x] **RED:** `listLifecycleStates(false)` excludes failed children.
- [x] **GREEN:** implement lifecycle + ledger wiring.

---

# Phase 3 — `launch` fail-fast (persisted children)

## Todos

- [x] Add `test/unit/vigil/launch-failure.test.ts` using fake bootstrap observer.
- [x] **RED:** persisted `launch` returns `{ error }` when observer reports `failed` within bootstrap window.
  - Expected RED: `isVigilError(result)` is false; snapshot state `"running"`.
- [x] **RED:** extension adapter `execute({ action: "launch", ... })` maps bootstrap failure to `isError: true` with the same message (via existing `isVigilError` path).
- [x] **RED:** failed launch still appends `vigil-launch` **and** `vigil-fail` (audit trail), but tool result is error.
- [x] **RED:** `launch` returns running snapshot when observer reports `timeout` (slow-start tolerance).
- [x] **RED:** spawn throw still returns `Failed to launch Pi child: ...` (regression).
- [x] **RED:** ephemeral `launch` path does not use persisted bootstrap observer (regression).
- [x] **GREEN:** integrate observer into `VigilService.launch` for non-ephemeral children.

## Agent notes / assumptions

- Bootstrap default timeout: start with **1500ms** (constant in `child-failure.ts` or `config.ts`); tune only with test evidence.
- Tool adapter (`src/index.ts`) already maps `{ error }` to `isError: true`; no presentation slice required here.

---

# Phase 4 — `poll` surfaces persisted failure (late detection)

## Todos

- [x] Add `test/unit/vigil/poll-failure.test.ts`.
- [x] **RED:** when lifecycle has `vigil-fail`, `poll(id)` returns `{ error }` containing failure message (not `state: "waiting"`).
  - Expected RED: `poll` returns waiting snapshot / `latestResponse: null`.
- [x] **RED:** when child dead + no session + no `vigil-fail` yet, `poll` still uses existing behavior (waiting) — observer will eventually fail in background OR next poll after fail record appended.
- [x] **RED:** after background observer appends `vigil-fail`, subsequent `poll` returns `{ error }`.
- [x] **GREEN:** short-circuit in `poll` / `buildActiveSnapshot` on `failRecord`.

---

# Phase 5 — `wait` surfaces persisted failure

## Todos

- [x] Extend `test/unit/vigil/wait.test.ts` or add `test/unit/vigil/wait-failure.test.ts`.
- [x] **RED:** `wait({ id: failedChild })` returns `{ error }` immediately (not `outcome: "settled"` with null response).
  - Expected RED: `outcome: "settled"`, `latestResponse: null`.
- [x] **RED:** cohort `wait` with one failed child returns `{ error }` naming the failed id.
- [x] **RED:** failed children are excluded from default active cohort so a prior failure does not block unrelated waits.
- [x] **GREEN:** integrate fail checks in `scanWaitCohort` / `resolveWaitCohortIds`.

---

# Phase 6 — `send` fail-fast + reject failed children

## Todos

- [x] Add `test/unit/vigil/send-failure.test.ts`.
- [x] **RED:** `send` on lifecycle with `vigil-fail` returns `{ error }` without spawning.
  - Expected RED: spawn called; returns running snapshot.
- [x] **RED:** `send` on waiting child when bootstrap observer reports respawn failure returns `{ error }`.
- [x] **RED:** successful `send` still returns running snapshot (regression).
- [x] **GREEN:** wire bootstrap wait into `send` spawn path; guard on `failRecord`.

---

# Phase 7 — `list` shows failed children

## Todos

- [x] Extend `test/unit/vigil/list-pagination.test.ts` or add `test/unit/vigil/list-failure.test.ts`.
- [x] **RED:** `list()` includes failed child with `state: "failed"` and excludes it from active-only semantics.
  - Expected RED: `state: "waiting"` or `"running"`.
- [x] **RED:** `list({ includeCompleted: true })` includes failed children alongside completed.
- [x] **GREEN:** map `failRecord` in `lifecycleStateToListItem` / `buildListItemsFromStates`.

---

# Phase 8 — Ephemeral: surface `vigil-settle.error` on poll/wait

## Todos

- [x] Add `test/unit/vigil/ephemeral-failure-surface.test.ts`.
- [x] **RED:** ephemeral child settles with `{ error: "ephemeral child exited (code 1)" }` ⇒ `poll` returns `{ error }` (not waiting/null).
  - Expected RED: waiting snapshot, `latestResponse: null`.
- [x] **RED:** `wait({ id })` returns `{ error }` once settle record with error exists.
- [x] **RED:** successful ephemeral settle still returns waiting snapshot with text (regression).
- [x] **GREEN:** when ephemeral `settleRecord.error` present, treat as failure in `resolveEphemeralActiveSnapshot` / `poll` / `wait`.

## Agent notes / assumptions

- **Implemented:** surface `settleRecord.error` directly on `poll`/`wait`/`launch`; do not duplicate into `vigil-fail`.

---

# Phase 9 — Ephemeral launch fail-fast

## Todos

- [x] **RED:** ephemeral `launch` returns `{ error }` when observer settles with error within bootstrap window.
  - Expected RED: running snapshot returned; failure only visible on later `poll`.
- [x] **RED:** ephemeral launch timeout still returns running when child is slow (regression).
- [x] **GREEN:** await ephemeral observer outcome in `launch` symmetric to persisted path.

---

# Phase 10 — `complete` and guarded actions on failed children

## Todos

- [x] **RED:** `complete({ id: failedChild })` returns `{ error }`, does not rename/reap/spawn.
- [x] **RED:** `search`/`read` on failed persisted child keep transcript-unavailable errors (explicit regression tests if gaps exist).
- [x] **GREEN:** add early fail guard in `complete`.

---

# Phase 11 — Hung bootstrap timeout (alive, no session)

## Todos

- [x] **RED:** when child process stays alive beyond bootstrap timeout and session never appears, observer/appends `vigil-fail` with timeout message; `poll` returns `{ error }`.
  - Expected RED: stays `running` until manual wait timeout.
- [x] **GREEN:** implement stale-bootstrap watchdog (only after Phase 1–4 green).

## Agent notes / assumptions

- Use a larger watchdog (e.g. 30–60s) than launch fail-fast window to avoid false positives on slow disks.

---

# Phase 12 — Live acceptance + docs

## Todos

- [x] **RED (live):** `PI_VIGIL_LIVE=1` acceptance case: `launch` with invalid model returns tool error (or poll error within bounded time).
  - Guarded by existing acceptance harness; skip locally without env.
- [x] **GREEN:** implement if unit fakes masked a real integration gap.
- [x] Update `README.md` failure semantics section (failed state, bootstrap fail-fast, poll/wait errors).
- [x] Run `npm run check`; record final counts in this file.

---

## Issue coverage matrix

| Reported issue | Phase(s) |
|---|---|
| Invalid model on `launch` reports success | 0, 1, 3, 12 |
| Invalid model on `send` reports success | 0, 1, 6 |
| Missing child session misclassified as `waiting` | 0, 2, 4 |
| `wait` yields no useful result | 4, 5, 8 |
| stderr errors invisible for persisted children | 0, 1 |
| Ephemeral settle error not surfaced | 8, 9 |
| Hung child, no session, silent until wait timeout | 11 |
| `send` allowed after failed launch | 5, 6 |
| `list` misleading state | 7 |

---

## Explicit non-goals (this slice)

- Streaming child stderr/stdout to the parent model in real time.
- Retrying failed launches automatically.
- Validating model names against `modelRegistry` before spawn (Pi remains source of truth).
- Changing compact mutation receipt rendering for successful `launch`/`send`/`complete`.
- Nested Vigil failure propagation beyond existing descendant-inspector behavior.

---

## Red/green evidence log

| Phase | RED (test → message) | GREEN (command → result) |
|---|---|---|
| 0 | `child-failure.test.ts` → Cannot find module `child-failure` | `npm test -- test/unit/vigil/child-failure.test.ts` → 4 passed |
| 1 | `persisted-bootstrap-observer.test.ts` → Cannot find module | `npm test -- test/unit/vigil/persisted-bootstrap-observer.test.ts` → 6 passed |
| 2 | `lifecycle.test.ts` → failRecord undefined / failed not excluded | `npm test -- test/unit/vigil/lifecycle.test.ts` → 9 passed |
| 3 | `launch-failure.test.ts` → running snapshot / module missing | `npm test -- test/unit/vigil/launch-failure.test.ts` → 6 passed |
| 4 | `poll-failure.test.ts` → waiting snapshot / latestResponse null | `npm test -- test/unit/vigil/poll-failure.test.ts` → 4 passed |
| 5 | `wait-failure.test.ts` → outcome settled with null response | `npm test -- test/unit/vigil/wait-failure.test.ts` → 3 passed |
| 6 | `send-failure.test.ts` → spawn called / running snapshot | `npm test -- test/unit/vigil/send-failure.test.ts` → 3 passed |
| 7 | `list-failure.test.ts` → state waiting/running | `npm test -- test/unit/vigil/list-failure.test.ts` → 2 passed |
| 8 | `ephemeral-failure-surface.test.ts` → waiting/null | `npm test -- test/unit/vigil/ephemeral-failure-surface.test.ts` → 5 passed |
| 9 | ephemeral launch → running snapshot on settle error | `npm test -- test/unit/vigil/ephemeral-failure-surface.test.ts` → 5 passed |
| 10 | `complete` on failed child → completed snapshot | `poll-failure.test.ts` + `search-read-safety.test.ts` → pass |
| 11 | watchdog → stays running | `persisted-bootstrap-observer.test.ts` watchdog test → 7 passed |
| 12 | live invalid model (PI_VIGIL_LIVE=1) | `npm run check` → 337 unit tests passed |

---

## Open decisions (resolved 2026-08-05)

- [x] **Failed launch ledger:** keep `vigil-launch` + append `vigil-fail` (audit trail).
- [x] **Ephemeral failure persistence:** surface `settleRecord.error` directly on `poll`/`wait`; do not duplicate into `vigil-fail`.
- [x] **Cohort wait policy:** fail entire wait with `{ error }` when any watched child has failed.
- [x] **Bootstrap fail-fast timeout:** default **1500ms** for `launch`/`send`; Phase 11 watchdog **30–60s** for hung alive/no-session.
- [x] **Live acceptance:** include invalid-model case in Phase 12 behind `PI_VIGIL_LIVE=1`, run with `cursor/composer-2.5-fast:high`.
