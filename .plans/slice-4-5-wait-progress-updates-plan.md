# Slice 4.5 — Live deterministic progress updates for `wait`

## How agents should use this plan

Read this entire plan before making changes. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered, relevant TODOs beneath the current phase before continuing. Mark completed items `[x]`, and record assumptions, deviations, and test notes in this file. Commit plan updates in the same commit as their corresponding code/test changes.

This plan intentionally covers **only Slice 4.5**. Do not implement LLM-generated progress summaries, ephemeral Pi summarizer subprocesses, full-conversation `search`, partial token streaming, file watchers, subscriptions, background workers, retries, process groups, or an external mutable registry.

---

## What this work is

Slice 4 `wait` already performs a single bounded foreground observation loop. Pi tool definitions support `onUpdate(...)`, which lets the same active tool call display partial progress in the TUI/RPC/JSON event stream before its final result.

Add deterministic, human-readable status updates to that existing wait loop. A user should see what each watched child has **persisted** since the wait began without re-invoking `wait`, launching another child, or paying for another LLM call.

The update is deliberately factual—not an inferred natural-language “what it is thinking” summary. It reports the observed child state, a persisted-entry step count, and the most recent persisted activity. This is useful for iterative controller visibility and is safe/cheap enough to make part of foreground waiting.

## End goal of this plan

Extend the wait API with optional progress controls:

```ts
vigil({
  action: "wait",
  timeoutMs?,
  initialDelayMs?,
  maxDelayMs?,
  progress?,           // "status" (default) | "none"
  progressIntervalMs?, // heartbeat cap for unchanged status
})
```

While one `wait` tool invocation is running, its adapter calls Pi’s `onUpdate(...)` after the initial scan and later scans when visible child activity changes or the heartbeat interval elapses. Pi renders these as partial tool results in the TUI; JSON-mode consumers receive `tool_execution_update` events. The final tool result remains the existing Slice 4 settled/timeout/empty/cancelled result.

A typical partial update is one concise line per visible child:

```text
elapsed 15s · next poll ≤4s · Slice 4 implementation [vigil-abcd] — running · steps: 12 · messages: 7 · last: tool result bash (3s ago)
```

“steps” has a stable factual definition: total persisted non-header entries in the child session JSONL at the time of the scan. “messages” counts persisted conversation message entries within those steps. These are counts of persisted session/tree entries, **not** a claim of live token/LLM reasoning progress.

## Key working assumptions

- A single foreground `wait` call can emit multiple `onUpdate` partial results while it remains pending. It does not need to return/reinvoke to display them. Updates are visible in Pi TUI/RPC and in JSON event-stream `tool_execution_update` events.
- This is **poll-cadence activity**, not token streaming: a child’s state becomes visible on the next bounded `wait` scan after Pi has persisted its JSONL entry. No file watcher/background process is added.
- `progress` defaults to `"status"`; callers can pass `"none"` to suppress partial updates while preserving normal wait behavior.
- `progressIntervalMs` defaults to 30,000 ms. Emit immediately after the initial scan; thereafter emit when a child’s progress fingerprint changes (state, step/message count, or last persisted activity) or after the heartbeat interval. Validate it as a positive safe integer within a documented finite bound (recommended maximum 60,000 ms).
- Progress updates are UI/transport ephemera only: they do not append parent ledger records, custom messages, child-session entries, or a registry. The final wait result remains the only ordinary tool result.
- The fixed initial active cohort, capped exponential backoff, timeout, cancellation, and read-only semantics from Slice 4 remain unchanged.
- Progress must be bounded: emit at most a documented number of child lines per update (recommended 20) followed by a concise omitted-count line; truncate untrusted names/activity descriptions to a safe single-line length using Pi truncation helpers or an equivalent tested utility.
- Completed children remain excluded from an initial wait cohort. If a watched child is completed by another writer during wait, show it as observed `completed` activity and let normal Slice 4 settlement return it.
- Do not make an LLM call. An optional future slice may investigate a rate-limited, explicitly opt-in ephemeral read-only summarizer with its own model/cost/security/usage-accounting design.

---

# Phase 0 — Define observable progress contract with failing tests

## Todos

- [ ] Read the fully accepted Slice 1–4 plans, current `wait` implementation/tests, Pi extension `onUpdate` documentation, README, and dogfood lessons before changing code.
- [ ] Add failing adapter tests demonstrating that one registered-tool `wait` invocation can capture partial updates before its final result:
  - default `progress` emits an initial status update for an active cohort;
  - `progress: "none"` emits no updates but returns the identical final wait outcome;
  - an update contains child ID/name/state, persisted `steps`, `messages`, and a factual latest-activity field;
  - tool final `content`/`details` remain the Slice 4 result shape rather than a progress transcript.
- [ ] Add failing service tests for update timing:
  - initial scan emits immediately;
  - a changed child progress fingerprint emits on the next scan even before heartbeat expiry;
  - unchanged state does not emit repeatedly before `progressIntervalMs`;
  - unchanged state emits a heartbeat at/after the interval;
  - no update occurs after timeout/cancellation/return.
- [ ] Add failing session-text/reader tests for activity facts:
  - step count excludes the session header and counts all persisted entry types;
  - message count counts only `message` entries;
  - latest activity describes the newest persisted entry without pretending it is live thought;
  - assistant tool-use/tool-result, user message, model change, and no-session/no-entry cases produce stable safe descriptions.
- [ ] Add failing validation tests:
  - `progress` accepts only `status`/`none` through Pi-compatible schema;
  - `progressIntervalMs` defaults correctly and rejects non-integer/zero/oversized values;
  - `progressIntervalMs` has no effect when `progress: "none"`.

## Agent notes / assumptions

- Test Pi tool updates through the registered adapter’s `onUpdate` callback, not a custom TUI renderer or real terminal.
- Prefer observable emitted partial payloads and final result state over method-call spying. A narrowly scoped fake clock/scheduler is appropriate for heartbeat timing.

---

# Phase 1 — Stable persisted activity facts and bounded progress DTOs

## Todos

- [ ] Extend child-session parsing/reader state with a small, explicit persisted-activity DTO, for example:

  ```ts
  interface VigilSessionActivity {
    steps: number;             // persisted non-header session entries
    messages: number;          // persisted `message` entries
    lastActivity: string | null;
    lastActivityTimestamp: string | null;
  }
  ```

  Keep existing latest-response/current-turn state behavior unchanged.
- [ ] Derive `lastActivity` only from persisted entry type/role and safe metadata, such as `user message`, `assistant tool use: bash`, `tool result: bash`, `assistant response`, or `model change`. Never fabricate a claim about current hidden reasoning or work.
- [ ] Add wait-progress domain types independent of Pi UI, for example:

  ```ts
  interface VigilWaitProgressItem {
    id: string;
    name: string;
    state: VigilState;
    steps: number;
    messages: number;
    lastActivity: string | null;
    lastActivityTimestamp: string | null;
  }

  interface VigilWaitProgress {
    waitedMs: number;
    nextPollInMs: number;
    items: VigilWaitProgressItem[];
    omittedItemCount: number;
  }
  ```

  Exact names may evolve, but no `latestResponse` body should be repeated in progress updates.
- [ ] Define a pure progress fingerprint from all facts that should cause an early update (state, counts, latest activity/timestamp). Keep it distinct from the final wait outcome.
- [ ] Implement bounded single-line formatting for each item and a concise update header. Use an exported Pi truncation helper or a small tested local function to avoid newline injection or unbounded names/tool metadata.
- [ ] Add a documented constant for maximum update items and for default/maximum heartbeat interval.

## Agent notes / assumptions

- `steps` is deliberately a persisted-entry count, which closely reflects the activity users inspect in Pi session/tree views. It is not the number of model turns and should be named/documented accordingly.
- Session files may not exist immediately after launch. In that case report zero steps/messages and `lastActivity: null` rather than erroring or inventing progress.

---

# Phase 2 — Integrate foreground progress emissions into `wait`

## Todos

- [ ] Extend `WaitInput` and policy validation/defaulting with `progress` and `progressIntervalMs`, preserving existing timing defaults/bounds.
- [ ] Add an optional service-level progress callback, for example `onProgress?: (progress: VigilWaitProgress) => void`, so `VigilService.wait` stays independent of Pi tool-result block types.
- [ ] Implement wait-loop emission in this order:
  1. validate policy and capture start time;
  2. resolve fixed active cohort and run the existing initial scan;
  3. construct and emit initial progress when mode is `status` (including an immediate waiting/settled child);
  4. retain the existing immediate `empty`/`settled` behavior;
  5. before/after each existing bounded sleep and scan, build progress from the same scan data;
  6. emit only when the fingerprint changed or heartbeat time elapsed;
  7. use the next bounded polling delay in the progress hint, never schedule a separate timer;
  8. return existing timeout/cancelled/settled result normally and make no subsequent callback.
- [ ] Ensure update callbacks are synchronous/non-blocking from the wait loop’s perspective or handle callback failure defensively so a rendering/consumer exception does not leave wait running or mutate child state.
- [ ] Preserve concurrent read-only cohort scanning. Do not add extra child-session file reads solely for progress if the existing reader state can carry activity data.
- [ ] Verify no progress callback/adapter path starts a child, reaps a PID, renames/completes a session, appends ledger entries, or persists a transcript.

## Agent notes / assumptions

- The user sees updates as they arrive, but the parent LLM ordinarily continues only after the final tool result. These updates are controller/TUI visibility, not intermediate prompts for the parent model to act on.
- If a waited child reaches `waiting`/`completed`, emit its latest factual progress update before/with returning the normal settled result when practical; do not delay settlement for a heartbeat.

---

# Phase 3 — Pi adapter wiring and documentation

## Todos

- [ ] Add Pi-compatible `progress` string enum and optional `progressIntervalMs` number parameters to the tool schema.
- [ ] In the extension adapter, pass a progress callback to `service.wait` that calls the supplied `onUpdate` with:
  - concise text content suitable for partial tool-result display;
  - structured `VigilWaitProgress` details for UI/RPC/JSON consumers;
  - no error flag and no final-result replacement semantics.
- [ ] Retain the existing final `formatWaitText` response and structured `VigilWaitResult` details unchanged.
- [ ] Add adapter tests that collect emitted partial results, assert their content/details, and confirm `progress: "none"` is silent.
- [ ] Update README:
  - explain foreground partial updates and that one wait invocation stays active;
  - document `progress` defaults, heartbeat/bounds, step/message definitions, and output caps;
  - distinguish persisted activity reporting from live token streaming and LLM-generated summaries;
  - state that updates are transport/UI events and do not change child/ledger state.
- [ ] Add a concise orchestration note: use TUI progress while wait is active, then use the final settled result to `poll`, `send`, or `complete`; keep atomic task-file delivery for external TUI automation.
- [ ] Run deterministic tests and typecheck before live acceptance work.

## Agent notes / assumptions

- Do not add a custom TUI renderer in this slice. Pi’s standard partial tool-result rendering and JSON `tool_execution_update` are the intended transport.
- Tool-update content must remain bounded and safe even if a child session name/tool metadata is unusually long or contains newlines.

---

# Phase 4 — Live acceptance: partial updates from a real waiting child

## Todos

- [ ] Extend the existing opt-in acceptance test through the registered adapter:
  1. launch the existing uniquely named real child;
  2. call `wait` with default/explicit `progress: "status"` and collect its partial `onUpdate` results;
  3. assert at least one partial update arrives before final settlement and includes the real child ID, state, and persisted step/message indicators;
  4. assert final wait result still settles with the expected marker;
  5. retain the existing send → wait → list → rename → complete/session-retention assertions;
  6. add a deterministic-only test for silence under `progress: "none"` rather than extending live runtime unnecessarily.
- [ ] Retain existing test-only session isolation, temporary directory teardown, opt-in/auth preflight, and timeout handling.
- [ ] Run and record:
  - `npm test`;
  - `npm run typecheck`;
  - `npm run test:acceptance` without opt-in for helpful failure;
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.

## Agent notes / assumptions

- Acceptance should observe partial adapter updates, not rely on timing-sensitive terminal screen scraping.
- The child’s session may settle quickly. Initial update is therefore the required live proof; do not make the test depend on multiple heartbeats.

---

# Phase 5 — Slice handoff and boundaries

## Todos

- [ ] Confirm default tests use fake clock/scheduler/session data and do not sleep in real time.
- [ ] Confirm one `wait` invocation emits partial updates while foreground-running, with no need for reinvocation and no background work after return.
- [ ] Confirm all progress facts are persisted-session observations, output is bounded, and no LLM/process is spawned for progress.
- [ ] Confirm cancellation/timeout stop future updates and preserve the existing non-mutating wait lifecycle.
- [ ] Confirm no LLM summary parameters/model selection, search, streaming tokens, file watcher, registry, or other future capability was added.
- [ ] Update this plan’s checkboxes, assumptions, deviations, progress notes, and test notes; commit plan updates with code/tests.
- [ ] Provide the reviewer: commit SHA, public API/defaults/bounds, sample progress update semantics, tests, live acceptance status, cancellation behavior, and deviations.

## Future slices (not implementation work for this handoff)

- LLM progress summaries: explicitly opt-in, rate-limited, ephemeral/read-only child-session summarization with model selection, strict cancellation/timeout/usage accounting, and privacy review.
- Bounded full-conversation `search` across retained child sessions.

## Progress notes

- 2026-08-02: Plan created after accepted Slice 4. User approved deterministic live progress/status updates plus persisted session step/message counters, while deferring LLM-generated summaries to a later dedicated design. No Slice 4.5 implementation has started.
