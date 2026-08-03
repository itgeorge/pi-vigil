# Ephemeral detached child subagents

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work in red → green → refactor order: add the smallest focused failing test first, run it to prove the expected failure, then add only the code required to make it pass.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, record assumptions, deviations, red/green evidence, and validation results in this file, and commit plan checkbox updates with the corresponding code/tests. This slice uses a Composer implementation agent, an independent Composer validation agent, and an independent GPT-5.5 review. Confirmed review findings must be returned to the original implementation session for remediation before acceptance.

Do not begin implementation before the user explicitly approves proceeding after plan review/context compaction.

---

## Implementation status (primary agent)

**Commit:** (pending) — ephemeral detached child subagents implementation

### Persisted-child contract preserved (unchanged)

- Persisted launch still uses `spawnDetachedPiChild` with `stdio: "ignore"` and `buildPiChildArgs` (`--session-id`, optional `--session-dir`).
- Observation for persisted children remains child-session JSONL via `ChildSessionReader`.
- `poll`/`wait` remain non-mutating for persisted children; compact mutation receipts unchanged.
- Guarded `complete` with descendant inspection unchanged for persisted children.

### Graceful shutdown policy (resolved)

On parent `session_shutdown`, `shutdownSharedEphemeralChildObserver()` stops all active observers, closes stream handlers, and best-effort `terminateAndWait`s each **direct tracked ephemeral PID only** (no process groups, no descendant kills). Observers do not append `vigil-settle` after shutdown. Parent crash/restart before settlement yields controlled `poll`/`wait` **observation unavailable** errors; no reattach/spool.

### Red/green evidence

- Added failing tests first in `test/unit/vigil/ephemeral-*.test.ts`; initial failures included missing settle wiring and fake observer settle guard bug (fixed).
- Final deterministic validation: `npm run typecheck` OK, `npm test` **281/281** OK, `npm run check` OK.
- Acceptance guard: `npm run test:acceptance` rejects without `PI_VIGIL_LIVE=1` (expected).
- Live acceptance: `PI_VIGIL_LIVE=1 npm run test:acceptance` **4/4** OK (includes new ephemeral case).

### Intentional limitations

- Ephemeral children are single-turn; no `send`, transcript `search`/`read`, child rename, or descendant inspection.
- No child JSONL/`/resume`; parent stores bounded `vigil-launch` + `vigil-settle` (+ optional `vigil-complete`) only.
- Parent exit/crash before settlement loses in-flight observer/results.
- Ephemeral children launching nested Vigil children unsupported (no durable child ledger).
- Internal stdout drain only; no user/model-visible token streaming.

---

# Phase 0 — Contract, lifecycle boundary, and red tests

## Todos

- [x] Read `src/index.ts`, `node-runtime.ts`, `ports.ts`, `lifecycle.ts`, `session-text.ts`, `types.ts`, terminal-safety helpers, renderers, all action/service/wait/search-read/descendant tests, and the Pi JSON-mode/extension lifecycle documentation before production edits.
- [x] Record the exact persisted-child contract that must remain unchanged, especially detached `stdio: "ignore"`, JSONL-derived observation, compact mutation content, non-mutating persisted `poll`/`wait`, and guarded completion.
- [x] Define the additive launch schema/type field as `ephemeral?: boolean`, default false. Reject `ephemeral` on non-launch actions rather than silently ignoring it if current action-validation conventions support that.
- [x] Define additive lifecycle records/types:
  - [x] `VigilLaunchRecord.ephemeral?: true`;
  - [x] a versioned/validated `vigil-settle` record containing id, bounded final `latestResponse`, settled timestamp, and optional terminal stop reason/error classification;
  - [x] lifecycle state that distinguishes an ephemeral launch from a normal child without changing normal snapshot behavior.
- [x] Decide and document exact graceful `session_shutdown` behavior for a running ephemeral child, based on a focused Pi lifecycle/process probe. It must be direct-PID-only, bounded, and not leave a live stdout pipe without a reader. Record the user-approved crash/restart loss semantics.
- [x] Add focused failing lifecycle tests for launch + settle reconstruction, duplicate/out-of-order/malformed settle entries, bounded final response handling, completed snapshots, and unchanged persisted records.
- [x] Add failing schema/adapter tests proving `ephemeral: true` is launch-only, default launch arguments/receipts remain unchanged, and ephemeral state is visible only through deliberate additive structured/display surfaces.
- [x] Run focused red tests and record expected failures.

---

# Phase 1 — Bounded ephemeral child observer and spawn seam

## Todos

- [x] Introduce a narrow injected port/service, tentatively `EphemeralChildObserver` or `ObservedChildRunner`, rather than overloading persisted `ChildSessionReader` with process-stream concerns. Keep deterministic fake implementations easy to drive in unit tests.
- [x] Add a Node implementation that starts an ephemeral child with `--mode json -p --no-session` and a directly tracked PID. Preserve ordinary persisted child spawn behavior byte-for-byte when `ephemeral` is false.
- [x] Drain stdout and stderr continuously with strict bounded buffering/line handling:
  - [x] parse only LF-delimited JSON events;
  - [x] handle chunk boundaries, CRLF input, malformed lines, oversized lines, C0/C1/ANSI payloads, and child errors without crashing the extension;
  - [x] retain only enough terminal assistant state, timestamps, stop classification, and bounded diagnostics to produce the final response;
  - [x] never expose `message_update` token deltas or raw stdout/stderr as tool partial results;
  - [x] avoid unbounded memory, timers, retries, filesystem spools, watchers, process groups, or external registries.
- [x] Treat `agent_settled` plus the final terminal assistant event as the normal settle signal; define deterministic controlled behavior for nonzero exit, no assistant message, malformed event stream, abort, and Pi processes that remain alive after settling.
- [x] Ensure observer cleanup is idempotent on settle, spawn failure, process error/close, parent shutdown, and extension reload. It must never write into a replacement parent session after `session_shutdown`.
- [x] Add focused failing/green unit tests using deterministic chunked JSON fixtures, not live model calls, for normal settle, split JSON lines, malformed/oversized input, output caps, error/abort/no-answer paths, detached PID cleanup, and no partial-result emission.
- [x] Run focused tests plus typecheck before integrating parent lifecycle persistence.

---

# Phase 2 — Parent ledger settlement and action semantics

## Todos

- [x] Wire `launch({ ephemeral: true })` to append the normal parent launch record, start the observer, and retain a runtime observation keyed by canonical Vigil id/session generation.
- [x] On a successful observer settle, append one idempotent `vigil-settle` entry to the original parent ledger with the bounded final response. Reconstructing the parent session after that point must preserve the settled response without needing the child process or child JSONL.
- [x] Ensure the observer cannot append after parent shutdown/reload or append duplicate settle entries when `poll`, `wait`, and process-close races overlap.
- [x] Add an observation seam so snapshots choose:
  - [x] existing child-session JSONL state for normal children;
  - [x] live bounded observer state while an ephemeral child runs;
  - [x] persisted `vigil-settle` state after an ephemeral child settles.
- [x] Preserve existing state semantics where meaningful: ephemeral `running` until settled; `waiting` when settled; `completed` only after explicit `complete`. Handle an unresolved ephemeral record reconstructed after a parent crash/restart with a controlled, documented “observation unavailable” path rather than inventing a response or reattaching.
- [x] Implement explicit ephemeral action boundaries:
  - [x] `send` rejects with a clear single-turn/non-resumable error;
  - [x] `search` and `read` reject with an explicit no-retained-transcript error;
  - [x] `complete` never calls child-session rename or descendant inspection for an ephemeral child, but only succeeds after settlement and uses a deterministic completed display name;
  - [x] `list` retains the item and exposes an additive ephemeral marker in structured/display detail without bloating default model-facing output;
  - [x] `wait` observes observer state but emits no captured token/message previews; settled final results retain normal observation behavior.
- [x] Keep ordinary persisted `poll`, `wait`, `search`, `read`, `send`, completion guard, descendants, pagination, and compact mutation-result contracts unchanged.
- [x] Add red/green service and adapter tests covering every action above, including settle-before-first-poll, duplicate settle, parent reconstruction after settle, parent reconstruction before settle, and mixed persistent/ephemeral lists.

---

# Phase 3 — UI, documentation, package tests, and live acceptance

## Todos

- [x] Update tool descriptions/schema descriptions, README API/install semantics, limitations, and troubleshooting to distinguish default persisted children from explicit single-turn ephemeral children.
- [x] Revise the prominent README overview claim that every launched agent gets its own Pi session: state that this remains the default, while explicit `ephemeral: true` launches do not create a child Pi session or `/resume` entry. Preserve the user-authored introductory tone; do not imply ephemeral children can be manually resumed.
- [x] Document that ephemeral children avoid Pi child-session/`/resume` entries but still write bounded lifecycle/final-response metadata into the existing parent Vigil session.
- [x] Document unavailable operations (`send`, `search`, `read`, resume, descendants), parent-exit/crash loss behavior, and no user-visible token streaming.
- [x] Update compact call/result rendering to identify an ephemeral launch safely without violating compact mutation receipt content or showing raw captured response by default.
- [x] Add renderer/safety tests for ephemeral markers, malformed structured details, terminal controls, long final responses, and no regressions to persistent render paths.
- [x] Add deterministic integration tests proving no child session JSONL is created for the ephemeral spawn path while the parent ledger stores only bounded lifecycle/settle data.
- [x] Extend opt-in live acceptance through the registered adapter:
  - [x] launch an ephemeral child with a unique final marker;
  - [x] observe it settle asynchronously through `wait`/`poll`;
  - [x] assert the final marker is available from the parent-backed result;
  - [x] assert no child session appears in the isolated session directory/resume corpus;
  - [x] assert `send`, `search`, and `read` reject deliberately;
  - [x] clean up direct tracked processes/capture state deterministically.
- [x] Run and record `npm test`, `npm run typecheck`, `npm run check`, `npm run test:acceptance` without opt-in (expected guard), and `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.

---

# Phase 4 — Independent validation, review, remediation, and handoff

## Todos

- [ ] Have an independent Composer validation agent inspect the committed implementation without editing it. It must run focused ephemeral tests, full deterministic tests/typecheck/package check, inspect the persisted/ephemeral action matrix, exercise output bounds and cleanup paths, and run opt-in live acceptance when available. Record commands/results/failures.
- [ ] Have an independent GPT-5.5 reviewer inspect implementation, tests, validation findings, and this plan. It must report only substantive findings ranked by severity, including: asynchronous/detached semantics, stdout backpressure/bounds/parser safety, stale-session writes, shutdown cleanup, parent-ledger durability, action restrictions, persistent-child regressions, and user-visible documentation accuracy.
- [ ] Return confirmed validation/review findings to the original Composer implementation session for focused red-green remediation. Do not hand-edit implementation except emergency recovery explicitly recorded here.
- [ ] Re-run affected tests, full deterministic validation, package check, and opt-in live acceptance after remediation. Re-review nontrivial remediation before acceptance.
- [ ] Update this plan with commits, red/green evidence, validation/review results, final ephemeral lifecycle contract, intentional limitations, and remaining risks.

## Explicit non-goals

- No no-session **parent** mode in this slice.
- No multi-turn ephemeral conversation rehydration, `send`, session restoration, or synthetic transcript storage.
- No child `/resume` entry, child JSONL, child session rename, child transcript search/read, or child descendant recovery for ephemeral launches.
- No raw response/transcript persistence, no external registry, daemon, temporary durable spool, retry loop, watcher, process group, recursive cancellation, or user/model-facing live token streaming.
- No change to default persisted-child behavior or its session-only persistence model.

## Follow-up questions before implementation

- **Resolved:** graceful `session_shutdown` uses direct-PID terminate/reap (recommended).
- **Resolved:** additive structured `ephemeral: true` plus compact list-text `ephemeral` marker; mutation receipts unchanged.
