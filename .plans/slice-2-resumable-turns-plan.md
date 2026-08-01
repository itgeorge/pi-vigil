# Slice 2 — Resumable turns and model selection

## How agents should use this plan

Read this entire plan before making changes. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered, relevant TODOs beneath the current phase before continuing. Mark completed items `[x]`, and record assumptions, deviations, and test notes in this file. Commit plan updates in the same commit as their corresponding code/test changes.

This plan intentionally covers **only Slice 2**. Do not implement `list`, `search`, `complete`, live partial streaming, retry logic, or a mutable runtime registry.

---

## What this work is

Extend the Slice 1 `vigil` walking skeleton with turn-based continuation of an existing child Pi session:

```ts
vigil({ action: "send", id, message, model? })
```

The parent agent must be able to inspect a child until it is `waiting`, decide the next prompt/model, then send that prompt to the **same** Pi `--session-id`. The child keeps its prior Pi-session context and model history.

This slice also fixes a lifecycle boundary exposed by Slice 1: a Pi print-mode process can remain alive after its agent turn has settled. Before starting the next turn, Vigil must reap that settled process so two Pi processes never concurrently write the same child session file.

## End goal of this plan

The public API becomes:

```ts
vigil({ action: "launch", message, model?, cwd? })
vigil({ action: "poll", id })
vigil({ action: "send", id, message, model? })
```

`send` returns a new `running` `VigilSnapshot`, appends one durable `vigil-turn` parent-session entry, and uses the same child session ID/cwd/session directory as launch. It accepts an optional model for every turn.

## Key working assumptions

- Slice 1 behavior and public snapshot shape remain intact.
- A child is eligible for `send` only when its **current/latest turn** is `waiting`.
- A `waiting` child whose tracked Pi PID is still alive has a complete turn in its session. `send` terminates and waits for that tracked process to exit before spawning the next Pi process.
- If the tracked PID has already exited, `send` proceeds without attempting to terminate it.
- `poll` does not terminate processes; reaping is a `send` responsibility so polling remains observational.
- One parent custom entry is appended per additional child turn: `vigil-turn` with the child identity, new PID, optional model, cwd/session directory, and timestamp. Do not duplicate prompt text there: the child Pi session is its canonical history. This is append-only session history, not a mutable registry.
- Current-turn detection must not mistake an old completed assistant message for completion after a newer user/tool message has been appended.
- Terminal assistant stop reasons for turn completion are `stop`, `length`, `error`, and `aborted`; `toolUse`, `pending`, missing stop reasons, and a trailing user/tool-result message mean the turn is still running/incomplete.
- Tests assert outcomes (snapshots, persisted entries, child-session content, and no overlapping live process), not implementation calls. Narrow CLI-boundary tests remain acceptable.

---

# Phase 0 — Establish Slice 2 behavior with failing tests

## Todos

- [ ] Read the completed Slice 1 plan and current implementation before changing code; preserve its accepted semantics unless this plan explicitly refines them.
- [ ] Add failing service/adapter tests for the `send` action:
  - a waiting child produces a new `running` snapshot with the same `id`, `sessionId`, and cwd;
  - the newly persisted parent entry has custom type `vigil-turn` and records the new tracked PID plus supplied model;
  - a `running` child returns a clear error and does not create another turn entry;
  - unknown ID and missing `id`/`message` return clear tool errors;
  - an omitted model remains omitted from the child invocation/turn record, allowing Pi to restore the child’s prior model.
- [ ] Add failing tests for current-turn detection using JSONL fixtures or direct session entries:
  - previous terminal assistant response followed by a newer user message => `latestResponse` retains the prior text but `turnComplete === false`;
  - assistant `toolUse` followed by a tool-result message => incomplete;
  - final assistant with each terminal stop reason => complete;
  - no assistant response => `latestResponse: null`, incomplete.
- [ ] Add a regression test demonstrating the Slice 1 failure mode: a child whose old assistant response is complete but whose newest turn starts with a user message must remain `running` while its PID is alive.

## Agent notes / assumptions

- Treat the persisted session as the observable state source. Tests should construct realistic Pi session entries instead of asserting private parser calls.
- Preserve `latestResponse` as the most recent complete assistant text even when the newest turn is incomplete; this lets an orchestrator see the last response while the next turn runs.

---

# Phase 1 — Current-turn-aware session state

## Todos

- [ ] Refine the child-session state extraction so it derives two independent facts:
  1. `latestResponse`: last assistant text found in the conversation;
  2. `turnComplete`: whether the **latest relevant conversation message** represents a terminal assistant result.
- [ ] Ensure the implementation handles Pi tool-use sequences correctly:
  - terminal assistant messages are complete only for `stop`, `length`, `error`, or `aborted`;
  - an assistant `toolUse`, a tool result, or a user message as the newest message is incomplete.
- [ ] Update `poll` tests and README/plan wording to describe the refined completion semantics. Do not change the public `VigilSnapshot` shape.
- [ ] Run deterministic tests after this focused refactor before adding continuation behavior.

## Agent notes / assumptions

- Session entries such as model-change/custom entries are not conversation messages and must not turn a preceding user message into a completed turn.
- If Pi introduces additional terminal stop reasons in a future version, do not silently classify unknown values as terminal; treat them as incomplete until deliberately supported.

---

# Phase 2 — Persisted turn records and safe process handoff

## Todos

- [ ] Add a typed `VigilTurnRecord` and parent-ledger support for:
  - appending `vigil-turn` entries;
  - resolving the latest tracked turn for a Vigil ID by considering its launch record plus subsequent turn records.
- [ ] Keep launch as the first turn; resolve the current runtime record from the most recent `vigil-launch`/`vigil-turn` entry for that ID.
- [ ] Extend the process-runner port with a bounded terminate-and-wait operation for a tracked PID.
- [ ] Implement Node process reaping:
  - send `SIGTERM` only to the tracked Pi PID when it is still alive;
  - wait for exit with a short, configurable internal bound;
  - return a clear error if it cannot be reaped in time;
  - treat an already-exited PID as successfully reaped;
  - preserve the existing spawn-error hardening.
- [ ] Add outcome-based tests for handoff:
  - a settled-but-still-alive child is no longer alive before the next turn is started;
  - a child that has already exited can continue without termination failure;
  - an unreapable child returns an error and no new `vigil-turn` entry is appended;
  - no test should inspect private method invocation order.

## Agent notes / assumptions

- Do not kill a child during `poll`; this preserves the declared observational behavior.
- This slice only reaps the direct tracked Pi process. Process-group management, retries, and OS-level supervision are out of scope.
- PID reuse is an accepted v2 limitation; do not add a process supervisor or external registry merely to solve it. Document it if the implementation needs an explicit caveat.

---

# Phase 3 — `send` adapter and model-per-turn support

## Todos

- [ ] Add `send` to the `vigil` action schema using `StringEnum` compatibility.
- [ ] Validate adapter arguments:
  - `launch` requires `message`;
  - `poll` requires `id`;
  - `send` requires both `id` and `message`;
  - validation errors use the existing concise tool-error pattern.
- [ ] Implement service `send`:
  1. resolve the latest persisted turn record for the supplied Vigil ID;
  2. derive current state from child session + tracked PID;
  3. reject if currently `running`;
  4. reap a still-live settled Pi process;
  5. start a detached child Pi turn with the same session ID/cwd/session directory and optional requested model;
  6. append `vigil-turn` only after successful spawn;
  7. return the new `running` snapshot.
- [ ] Update the narrow CLI-boundary test to cover `send`’s observable continuation contract: same session ID, same cwd/session directory, supplied model when present, and new message.
- [ ] Update README public API and lifecycle documentation.
- [ ] Run deterministic tests and typecheck.

## Agent notes / assumptions

- The next Pi invocation’s `--session-id` must exactly equal the original child session ID; do not create a new session ID for a follow-up.
- The caller may explicitly select a different model on any `send`; Pi persists the model change in the child session.

---

# Phase 4 — Live acceptance: real resumed conversation

## Todos

- [ ] Extend the existing opt-in acceptance test rather than adding a separate provider-dependent suite:
  1. launch a child asked to reply with a unique first marker;
  2. poll until `waiting`;
  3. call `send` using the same Vigil ID, an explicit test model, and a prompt requiring both the first marker and a unique follow-up marker in its response;
  4. assert `send` returns `running` with the same session ID;
  5. poll until `waiting` again;
  6. assert the final response contains both markers;
  7. assert the persisted child session contains both turns;
  8. ensure temporary child processes/session files are cleaned up after the test.
- [ ] Assert the original tracked child PID is no longer alive after the handoff when it was alive at send time; phrase this as an observable no-lingering-process outcome, not a spy/call assertion.
- [ ] Keep `PI_VIGIL_LIVE=1`, authentication preflight, test model overrides, timeouts, and no-opt-in failure behavior intact.
- [ ] Run and record:
  - `npm test`;
  - `npm run typecheck`;
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` when this system is authenticated.

## Agent notes / assumptions

- A single authenticated model is sufficient for live acceptance. Model-selection semantics are primarily covered by deterministic CLI/persisted-record tests; the live test passes an explicit model on both turns.
- Do not introduce a second-model requirement that makes acceptance unavailable to valid single-subscription setups.

---

# Phase 5 — Slice handoff and boundaries

## Todos

- [ ] Confirm default tests remain deterministic and credential-free.
- [ ] Confirm live acceptance fails helpfully without opt-in/auth and passes with the configured authenticated test model.
- [ ] Confirm no Slice 3+ APIs (`list`, `search`, `complete`) or mutable external registry were added.
- [ ] Update this plan’s checkboxes, deviations, and progress notes; commit the plan changes with implementation/tests.
- [ ] Provide the reviewer with the commit SHA, test results, live acceptance status, public API change, lifecycle/reaping behavior, and deviations.

## Future slices (not implementation work for this handoff)

- Slice 3: current-parent-session `list`, explicit `complete`, and cleanup/retention behavior.
- Slice 4: bounded full-conversation `search`.

## Progress notes

- 2026-08-02: Plan created from accepted Slice 1 state, including the follow-up fixes and ephemeral auth preflight cleanup. No Slice 2 implementation has started.
