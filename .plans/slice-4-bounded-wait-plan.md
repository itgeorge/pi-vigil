# Slice 4 — Bounded wait for settled children

## How agents should use this plan

Read this entire plan before making changes. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered, relevant TODOs beneath the current phase before continuing. Mark completed items `[x]`, and record assumptions, deviations, and test notes in this file. Commit plan updates in the same commit as their corresponding code/test changes.

This plan intentionally covers **only Slice 4**. Do not implement full-conversation `search`, partial response streaming, subscriptions/callbacks, background watchers, retry/supervision, process groups, or an external mutable registry.

---

## What this work is

Dogfooding showed that individual synchronous `poll` snapshots are correct but place too much orchestration burden on a parent model: it may poll too tightly, then forget to poll again without an external nudge.

Add one bounded, foreground wait primitive:

```ts
vigil({ action: "wait", timeoutMs?, initialDelayMs?, maxDelayMs? })
```

`wait` observes a fixed cohort of active Vigil children from the current parent session and returns when **any** child has settled. In Vigil vocabulary, *settled* means `waiting` (a child turn finished or its process exited) or `completed` if a completion record appears while waiting. It does **not** mean calling the explicit `complete` retirement action.

The action uses capped exponential-backoff polling in the foreground. It has a finite timeout, supports normal tool cancellation, and makes no process/session/ledger mutation.

## End goal of this plan

The public API becomes:

```ts
vigil({ action: "launch", name, message, model?, cwd? })
vigil({ action: "poll", id })
vigil({ action: "send", id, message, model? })
vigil({ action: "list", includeCompleted? })
vigil({ action: "complete", id })
vigil({ action: "wait", timeoutMs?, initialDelayMs?, maxDelayMs? })
```

A successful `wait` returns structured details with one of these normal outcomes:

```ts
type VigilWaitResult =
  | {
      outcome: "settled";
      waitedMs: number;
      settled: VigilSnapshot[]; // one or more snapshots, including latestResponse
    }
  | {
      outcome: "timeout";
      waitedMs: number;
      pending: VigilListItem[]; // concise current items; no latestResponse bloat
    }
  | {
      outcome: "empty";
      waitedMs: 0;
    }
  | {
      outcome: "cancelled";
      waitedMs: number;
      pending: VigilListItem[];
    };
```

The exact DTO spelling can evolve, but `outcome`, elapsed time, and settled/pending information must be stable, concise, and structured in tool `details`.

## Key working assumptions

- `wait` is a **foreground, bounded convenience loop**, not a worker, subscription, callback, or watcher. Once its tool call returns/cancels/times out, it does nothing further.
- At invocation, `wait` snapshots the active (`running`/`waiting`) children in the current parent session into a fixed cohort. New children launched after it begins are not added; this avoids an unbounded moving target. Normally the same parent cannot issue another tool call while waiting anyway.
- A child already `waiting` in the initial scan is immediately a `settled` result. Multiple children observed as settled in one scan are returned together.
- Completed children are excluded from the initial active cohort, but if another writer records completion for a watched ID during a wait, a `completed` poll result is considered settled and returned without any side effect.
- Timeout and cancellation are normal, non-error outcomes. They return concise pending items so the parent can decide to call `wait` again, `poll`, or otherwise recover.
- Default policy: immediate scan; `timeoutMs` defaults to 60,000; delays begin at 500 ms, double after each scan, and cap at 5,000 ms. Tool parameters may tune within documented validated bounds (recommended maximum timeout 300,000 ms; maximum delay 30,000 ms).
- Every sleep is truncated to the remaining timeout, so actual waiting cannot intentionally exceed the requested/default bound apart from normal event-loop overhead.
- Cancellation uses the tool `AbortSignal`; an abortable sleep must stop promptly and return the `cancelled` result. Do not leave a timer, promise loop, or background task alive after cancellation.
- Existing `poll`/`list` state semantics are reused. `wait` never launches, sends, reaps, completes, renames, deletes, or appends an entry.
- Tests prefer observable wait outcomes, virtual elapsed time, and unchanged process/session/ledger state. One narrowly scoped fake-scheduler test may assert the capped backoff schedule itself.

---

# Phase 0 — Define wait contract with failing outcome tests

## Todos

- [x] Read all completed Slice 1–3 plans, current service/ports/adapter, README, and the dogfood lessons before changing code. Preserve accepted lifecycle and retention semantics.
- [x] Add failing service/adapter tests for the action schema and validation:
  - `wait` is accepted by the `StringEnum` schema and requires no ID/message/name;
  - omitted timing values use documented defaults;
  - timing parameters must be finite safe integer milliseconds and within documented positive bounds;
  - invalid timeout/delay combinations (including `maxDelayMs < initialDelayMs`) produce concise tool errors.
- [x] Add failing outcome-based service tests for initial-state behavior:
  - no active child => `{ outcome: "empty", waitedMs: 0 }`;
  - one already-waiting child => immediate `settled` with its full snapshot/latest response;
  - several already-settled children => one immediate result containing all of them;
  - completed children do not cause a default wait to return `settled` when no active child exists.
- [x] Add failing tests for delayed behavior:
  - wait returns once any initially-running child later becomes `waiting` and includes its persisted latest response;
  - a terminal `completed` result observed for a watched ID is treated as settled;
  - no child settling by the deadline returns a non-error `timeout` with concise pending list items;
  - cancellation returns a non-error `cancelled` result with pending list items and no later state mutation.
- [x] Add a test proving wait is observational: it creates no parent custom entries, starts no child, reaps no PID, and does not rename/complete sessions.

## Agent notes / assumptions

- Avoid real clocks and real sleeps in deterministic tests. Inject a minimal clock/sleeper/scheduler seam or equivalent so tests advance virtual time and model state changes deterministically.
- “Any” means return as soon as one or more children settle in the same scan; do not wait for every child.

---

# Phase 1 — Testable bounded-backoff policy and wait DTOs

## Todos

- [x] Add the stable domain types for wait input/result and tool-text formatting. Keep list timeout/cancellation payloads concise; only settled snapshots contain `latestResponse`.
- [x] Introduce a small injected timing port, for example:

  ```ts
  interface WaitScheduler {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled">;
  }
  ```

  A structurally equivalent small abstraction is acceptable. Its production implementation must use `Date.now()` plus an abortable timer; fake implementations must enable deterministic tests.
- [x] Implement pure wait-policy validation/defaulting:
  - immediate first scan;
  - defaults: 60 s timeout, 500 ms initial delay, 5 s cap;
  - exponential factor of 2, capped at `maxDelayMs`;
  - clamp final sleep to remaining timeout;
  - enforce explicit input bounds and coherent initial/max relationship.
- [x] Add exactly one focused policy test asserting the observable virtual sleep sequence reaches the cap and never exceeds either `maxDelayMs` or remaining total timeout. Keep other tests outcome-focused.
- [x] Document the cancellation convention chosen for normal results and ensure aborted timers are cleaned up/listeners removed.

## Agent notes / assumptions

- Do not add a dependency merely for scheduling or retries.
- Tool `content` for `wait` must be self-sufficient when a parent only receives text: settled outcomes include full snapshot text per child; timeout/cancellation include concise pending id/name/state (and `completedAt` when present). Structured `details` remain unchanged.

---

# Phase 2 — Service-level fixed-cohort polling loop

## Todos

- [x] Extend the parent-ledger/service boundary only as needed to obtain a stable active cohort at wait start. Reuse lifecycle reconstruction; do not build a second registry.
- [x] Implement `VigilService.wait(...)` in this order:
  1. validate/default policy and capture start time;
  2. snapshot default active lifecycle records from the current parent session;
  3. derive snapshots for that fixed cohort concurrently/read-only;
  4. return `empty` if there is no active cohort, or immediate `settled` for all non-running snapshots;
  5. sleep with capped exponential backoff, honoring abort/cutoff;
  6. re-poll only the fixed cohort concurrently;
  7. return all non-running snapshots from that scan, otherwise repeat until timeout/cancellation;
  8. on timeout/cancellation, derive concise pending items from the final known/rerun state.
- [x] Treat a stale/malformed watched record that no longer resolves as a clear service error rather than silently claiming successful settlement. Normal parent-ledger state should not produce this condition.
- [x] Preserve ordering deterministically (the cohort’s existing most-recent-first ordering) in `settled` and `pending` output.
- [x] Ensure all service wait code is read-only: it must not call process reaping, spawning, child naming, or ledger append methods.
- [x] Add service tests for a child transition after several virtual sleeps, simultaneous settlements, timeout boundary settlement (settlement wins if observed at the deadline scan), cancellation during sleep, and no leaked follow-on work after return.

## Agent notes / assumptions

- `buildActiveSnapshot` / `poll` already classify a dead PID as `waiting`, including a child with no response. That is a settled result for orchestration; callers can inspect its snapshot/error context next.
- A completion record is a parent-ledger transition, not an action `wait` should initiate.

---

# Phase 3 — Extension adapter, documentation, and regression coverage

## Todos

- [x] Add `wait` to the tool action enum and optional timing parameters to the Pi-compatible schema.
- [x] Pass the extension’s tool-call `AbortSignal` to the service wait operation; do not ignore it as other immediate actions may do.
- [x] Return concise machine-readable tool text plus structured `VigilWaitResult` details. Timeouts/cancellations must not be marked tool errors.
- [x] Update adapter tests to invoke the registered tool, exercise validation/default behavior, and inspect settled/timeout/cancelled result details rather than private service calls.
- [x] Update README:
  - document `wait` semantics and all timing defaults/bounds;
  - distinguish settled `waiting` from explicit `complete` retirement;
  - document the recommended orchestration loop: `list` → `wait` → inspect `poll`/settled response → `send` or `complete` → repeat;
  - state explicitly that wait has no background watcher behavior and timeout/cancellation leave children untouched.
- [x] Add a concise dogfooding/runbook note, in README or a focused project document, recommending atomic task-file input for automated TUI drivers and an ID/role worklog. Do not implement tmux or controller automation.
- [x] Run deterministic tests and typecheck before live acceptance work.

## Agent notes / assumptions

- The timing values are user-controlled operational limits, not a promise that Pi child work will finish within them.
- Keep `wait` scoped to the current parent session, like `list`; it is not a global child-session query.

---

# Phase 4 — Live acceptance: bounded waiting in real resumed flow

## Todos

- [x] Extend the existing single opt-in acceptance test through the registered adapter:
  1. launch the existing uniquely named real child;
  2. call `wait` (using the existing acceptance timeout and a short bounded initial delay) instead of a tight manual poll loop;
  3. assert a `settled` outcome containing the child snapshot and first marker;
  4. send the existing follow-up turn, then call `wait` again and assert the second settled response contains both markers;
  5. retain the Slice 3 list/rename/complete/session-retention assertions;
  6. confirm final process cleanup remains conditional on PID liveness as before.
- [x] Keep the default opt-in/auth prerequisite behavior and clean temporary session directory only in test teardown.
- [x] Add a deterministic, credential-free test for timeout/cancellation rather than deliberately causing a live child to hang.
- [x] Run and record:
  - `npm test`;
  - `npm run typecheck`;
  - `npm run test:acceptance` without opt-in to confirm helpful failure;
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.

## Agent notes / assumptions

- The live test should prove a real child is observed through wait, not assert internal timer call counts.
- Do not add acceptance dependencies on a second provider/model or a deliberately unresponsive child.

---

# Phase 5 — Slice handoff and boundaries

## Todos

- [x] Confirm default tests remain deterministic, fast, and credential-free; no real timer waits belong in them.
- [x] Confirm `wait` has a finite default timeout, capped delays, cancellation cleanup, and no background task left after return.
- [x] Confirm `wait` performs no spawn/send/reap/rename/complete/ledger append/session deletion and only observes the fixed initial active cohort.
- [x] Confirm no Slice 5 full-conversation `search`, streaming, external registry, retry service, or background watcher was added.
- [x] Update this plan’s checkboxes, assumptions, deviations, progress notes, and test notes; commit plan updates with code/tests.
- [x] Provide the reviewer: commit SHA, timing defaults/bounds, structured wait outcomes, test results, live acceptance status, cancellation behavior, and deviations.

## Future slice (not implementation work for this handoff)

- Slice 5: bounded full-conversation `search` across retained child sessions.

## Progress notes

- 2026-08-02: Plan created after accepted Slice 3 and review of the terminal-Snake dogfood lessons. User approved a dedicated wait slice before search. No Slice 4 implementation has started.
- 2026-08-02: Slice 4 implemented TDD-first. Added deterministic `WaitScheduler` injection, policy validation, fixed-cohort foreground polling, structured wait outcomes, adapter AbortSignal forwarding, README/runbook documentation, and live acceptance coverage through two real waits.

## Assumptions / deviations

- Chosen documented bounds are 1..300,000 ms for `timeoutMs` and 1..30,000 ms for each delay; `maxDelayMs` must be at least `initialDelayMs`.
- Cancellation returns the last read-only scan as concise `pending` items rather than issuing another scan after abort; this returns promptly and leaves no timer/listener or loop alive. This is within the plan's final-known/rerun allowance.
- No product-scope deviations: no search, streaming, retry/supervision, external registry, process groups, or background watcher were added.

## Test notes

- `npm test`: 77 deterministic credential-free tests passed.
- Follow-up: `formatWaitText()` now embeds settled snapshot text and concise pending identity in tool `content` so parent models that only see text can identify which child settled and read its latest response.
- `npm run typecheck`: passed.
- `npm run test:acceptance` without `PI_VIGIL_LIVE=1`: failed fast with the expected opt-in instructions.
- `PI_VIGIL_LIVE=1 npm run test:acceptance`: 1/1 passed (~11 s total); the real child was observed through `wait` before and after `send`.
