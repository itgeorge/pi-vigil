# Ephemeral detached child subagents

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work in red → green → refactor order: add the smallest focused failing test first, run it to prove the expected failure, then add only the code required to make it pass.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, record assumptions, deviations, red/green evidence, and validation results in this file, and commit plan checkbox updates with the corresponding code/tests. This slice uses a Composer implementation agent, an independent Composer validation agent, and an independent GPT-5.5 review. Confirmed review findings must be returned to the original implementation session for remediation before acceptance.

Do not begin implementation before the user explicitly approves proceeding after plan review/context compaction.

---

## What this work is

Vigil currently launches every child as a detached, persisted Pi session and observes it from that child JSONL. This is right for resumable, turn-based work, but puts short single-shot children into Pi's `/resume` list.

Add an explicit launch-only opt-in for an **ephemeral child**. The parent remains an ordinary persisted Pi session and continues to store Vigil custom entries. The child runs `pi --mode json -p --no-session`, creates no child JSONL or `/resume` entry, and is observed asynchronously by a bounded parent-owned JSON-output reader while the parent Pi process remains alive.

This is intentionally not the previously considered no-session-parent mode. The existing parent ledger remains durable. Only the selected child is non-persistent.

## End goal of this plan

The public launch shape gains an explicit, default-false choice:

```ts
vigil({ action: "launch", name, message, model?, cwd?, ephemeral?: true })
```

For the default (`ephemeral` absent/false), all existing persisted-child behavior remains unchanged.

For `ephemeral: true`:

- Launch remains asynchronous: it returns a running receipt after spawning a detached child.
- Pi receives `--no-session`; there is no child session JSONL and no `/resume` entry.
- A parent-owned, bounded stdout/stderr drain parses Pi JSONL only internally. It never emits child token streaming to the parent model, TUI, RPC, or wait partial-result channel.
- On the first `agent_settled` event, the observer records a bounded, terminal-safe final `latestResponse` in a new parent `vigil-settle` custom entry, then stops reading/reaps its direct tracked process safely.
- `poll`, `list`, `wait`, and `complete` work from the persisted parent lifecycle/settle state while the parent is alive; settled results expose the stored final response through existing observation paths.
- `send` is rejected: an ephemeral child has no retained conversation to resume.
- `search`, `read`, session rename, and shallow-descendant inspection are rejected/unavailable with explicit ephemeral-child diagnostics; they must not fall through to misleading missing-transcript/session errors.
- Parent exit before the child settles loses the observer and any unrecorded final response. This is accepted. The design must not add a durable spool, external registry, daemon, retry loop, process group, recursive cancellation, or background work after parent shutdown.

## Confirmed product decisions

- Ephemeral mode is an explicit agent-selected `launch` option and defaults to the current persisted child behavior.
- Parent Vigil state is still persisted through custom entries in the parent session.
- Ephemeral children are useful primarily for small single-shot work; preserving `send`/conversation history is out of scope.
- Asynchronous launch is required; do not replace it with a blocking foreground one-shot action.
- Loss of an in-flight ephemeral child/result when the parent exits is acceptable.
- Internal output draining is permitted only to make the asynchronous ephemeral path safe and to capture its final answer. It is not user-visible streaming or general background supervision.

## Key technical assumptions

- Pi `--no-session` creates an in-memory child `SessionManager` but JSON mode still writes JSONL events to stdout. The final terminal assistant message appears in `message_end`/`turn_end`/`agent_end`; `agent_settled` marks completion.
- Current persisted children use detached spawn with `stdio: "ignore"` and derive observation from child JSONL. Ephemeral children require a distinct spawn/observation path; adding `--no-session` alone is insufficient.
- Parent `vigil-*` entries are custom session state, not normal LLM conversation content. A bounded `vigil-settle` entry is therefore the correct durable place for the final response.
- Existing parent `ParentLedger` abstraction and lifecycle reconstruction are the intended integration seam. Do not create a mutable external registry.
- The observer must continuously drain child stdout while it runs to prevent pipe backpressure. It may parse incrementally but must retain only bounded state, not the raw event stream.
- The exact graceful parent-shutdown policy for a still-running ephemeral PID remains an implementation decision to validate in Phase 0. Preferred default: stop the observer and make a best-effort direct termination/reap of that one tracked PID; never kill descendants or a process group. Parent crashes remain unrecoverable by design.

---

# Phase 0 — Contract, lifecycle boundary, and red tests

## Todos

- [ ] Read `src/index.ts`, `node-runtime.ts`, `ports.ts`, `lifecycle.ts`, `session-text.ts`, `types.ts`, terminal-safety helpers, renderers, all action/service/wait/search-read/descendant tests, and the Pi JSON-mode/extension lifecycle documentation before production edits.
- [ ] Record the exact persisted-child contract that must remain unchanged, especially detached `stdio: "ignore"`, JSONL-derived observation, compact mutation content, non-mutating persisted `poll`/`wait`, and guarded completion.
- [ ] Define the additive launch schema/type field as `ephemeral?: boolean`, default false. Reject `ephemeral` on non-launch actions rather than silently ignoring it if current action-validation conventions support that.
- [ ] Define additive lifecycle records/types:
  - [ ] `VigilLaunchRecord.ephemeral?: true`;
  - [ ] a versioned/validated `vigil-settle` record containing id, bounded final `latestResponse`, settled timestamp, and optional terminal stop reason/error classification;
  - [ ] lifecycle state that distinguishes an ephemeral launch from a normal child without changing normal snapshot behavior.
- [ ] Decide and document exact graceful `session_shutdown` behavior for a running ephemeral child, based on a focused Pi lifecycle/process probe. It must be direct-PID-only, bounded, and not leave a live stdout pipe without a reader. Record the user-approved crash/restart loss semantics.
- [ ] Add focused failing lifecycle tests for launch + settle reconstruction, duplicate/out-of-order/malformed settle entries, bounded final response handling, completed snapshots, and unchanged persisted records.
- [ ] Add failing schema/adapter tests proving `ephemeral: true` is launch-only, default launch arguments/receipts remain unchanged, and ephemeral state is visible only through deliberate additive structured/display surfaces.
- [ ] Run focused red tests and record expected failures.

## Agent notes / assumptions

- Do not put raw/unbounded child JSON events, stderr, tool arguments, or terminal controls into parent custom entries.
- The final response limit should reuse or deliberately align with the existing 4,000-visible-character diagnostic/detail policy unless a documented lower transport limit is needed.
- Mutation content remains the established compact receipt (`id`, `name`, `state`, optional `completedAt`); do not add raw response output to launch content.

---

# Phase 1 — Bounded ephemeral child observer and spawn seam

## Todos

- [ ] Introduce a narrow injected port/service, tentatively `EphemeralChildObserver` or `ObservedChildRunner`, rather than overloading persisted `ChildSessionReader` with process-stream concerns. Keep deterministic fake implementations easy to drive in unit tests.
- [ ] Add a Node implementation that starts an ephemeral child with `--mode json -p --no-session` and a directly tracked PID. Preserve ordinary persisted child spawn behavior byte-for-byte when `ephemeral` is false.
- [ ] Drain stdout and stderr continuously with strict bounded buffering/line handling:
  - [ ] parse only LF-delimited JSON events;
  - [ ] handle chunk boundaries, CRLF input, malformed lines, oversized lines, C0/C1/ANSI payloads, and child errors without crashing the extension;
  - [ ] retain only enough terminal assistant state, timestamps, stop classification, and bounded diagnostics to produce the final response;
  - [ ] never expose `message_update` token deltas or raw stdout/stderr as tool partial results;
  - [ ] avoid unbounded memory, timers, retries, filesystem spools, watchers, process groups, or external registries.
- [ ] Treat `agent_settled` plus the final terminal assistant event as the normal settle signal; define deterministic controlled behavior for nonzero exit, no assistant message, malformed event stream, abort, and Pi processes that remain alive after settling.
- [ ] Ensure observer cleanup is idempotent on settle, spawn failure, process error/close, parent shutdown, and extension reload. It must never write into a replacement parent session after `session_shutdown`.
- [ ] Add focused failing/green unit tests using deterministic chunked JSON fixtures, not live model calls, for normal settle, split JSON lines, malformed/oversized input, output caps, error/abort/no-answer paths, detached PID cleanup, and no partial-result emission.
- [ ] Run focused tests plus typecheck before integrating parent lifecycle persistence.

## Agent notes / assumptions

- This is the slice's intentional narrow exception to “no streaming”: bytes are drained internally for backpressure only. There is no user/model-facing streaming and no observer survives its owning parent runtime.
- Do not introduce a worker thread, daemon, or sidecar process. Node stream listeners tied to the one tracked child are sufficient.

---

# Phase 2 — Parent ledger settlement and action semantics

## Todos

- [ ] Wire `launch({ ephemeral: true })` to append the normal parent launch record, start the observer, and retain a runtime observation keyed by canonical Vigil id/session generation.
- [ ] On a successful observer settle, append one idempotent `vigil-settle` entry to the original parent ledger with the bounded final response. Reconstructing the parent session after that point must preserve the settled response without needing the child process or child JSONL.
- [ ] Ensure the observer cannot append after parent shutdown/reload or append duplicate settle entries when `poll`, `wait`, and process-close races overlap.
- [ ] Add an observation seam so snapshots choose:
  - [ ] existing child-session JSONL state for normal children;
  - [ ] live bounded observer state while an ephemeral child runs;
  - [ ] persisted `vigil-settle` state after an ephemeral child settles.
- [ ] Preserve existing state semantics where meaningful: ephemeral `running` until settled; `waiting` when settled; `completed` only after explicit `complete`. Handle an unresolved ephemeral record reconstructed after a parent crash/restart with a controlled, documented “observation unavailable” path rather than inventing a response or reattaching.
- [ ] Implement explicit ephemeral action boundaries:
  - [ ] `send` rejects with a clear single-turn/non-resumable error;
  - [ ] `search` and `read` reject with an explicit no-retained-transcript error;
  - [ ] `complete` never calls child-session rename or descendant inspection for an ephemeral child, but only succeeds after settlement and uses a deterministic completed display name;
  - [ ] `list` retains the item and exposes an additive ephemeral marker in structured/display detail without bloating default model-facing output;
  - [ ] `wait` observes observer state but emits no captured token/message previews; settled final results retain normal observation behavior.
- [ ] Keep ordinary persisted `poll`, `wait`, `search`, `read`, `send`, completion guard, descendants, pagination, and compact mutation-result contracts unchanged.
- [ ] Add red/green service and adapter tests covering every action above, including settle-before-first-poll, duplicate settle, parent reconstruction after settle, parent reconstruction before settle, and mixed persistent/ephemeral lists.

## Agent notes / assumptions

- Persisting `vigil-settle` is an intentional ephemeral-only observer side effect, not a reason to make normal `poll` or `wait` mutate parent state.
- Do not claim an ephemeral child can be manually resumed merely because its generated id remains known; `--no-session` retains no conversation.
- An ephemeral child launching its own Vigil children is unsupported in v1 because its own parent ledger is not durable. State this rather than attempting recursive recovery.

---

# Phase 3 — UI, documentation, package tests, and live acceptance

## Todos

- [ ] Update tool descriptions/schema descriptions, README API/install semantics, limitations, and troubleshooting to distinguish default persisted children from explicit single-turn ephemeral children.
- [ ] Revise the prominent README overview claim that every launched agent gets its own Pi session: state that this remains the default, while explicit `ephemeral: true` launches do not create a child Pi session or `/resume` entry. Preserve the user-authored introductory tone; do not imply ephemeral children can be manually resumed.
- [ ] Document that ephemeral children avoid Pi child-session/`/resume` entries but still write bounded lifecycle/final-response metadata into the existing parent Vigil session.
- [ ] Document unavailable operations (`send`, `search`, `read`, resume, descendants), parent-exit/crash loss behavior, and no user-visible token streaming.
- [ ] Update compact call/result rendering to identify an ephemeral launch safely without violating compact mutation receipt content or showing raw captured response by default.
- [ ] Add renderer/safety tests for ephemeral markers, malformed structured details, terminal controls, long final responses, and no regressions to persistent render paths.
- [ ] Add deterministic integration tests proving no child session JSONL is created for the ephemeral spawn path while the parent ledger stores only bounded lifecycle/settle data.
- [ ] Extend opt-in live acceptance through the registered adapter:
  - [ ] launch an ephemeral child with a unique final marker;
  - [ ] observe it settle asynchronously through `wait`/`poll`;
  - [ ] assert the final marker is available from the parent-backed result;
  - [ ] assert no child session appears in the isolated session directory/resume corpus;
  - [ ] assert `send`, `search`, and `read` reject deliberately;
  - [ ] clean up direct tracked processes/capture state deterministically.
- [ ] Run and record `npm test`, `npm run typecheck`, `npm run check`, `npm run test:acceptance` without opt-in (expected guard), and `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.

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

- Confirm the preferred graceful `session_shutdown` policy for a running ephemeral child: direct-PID terminate/reap (recommended) versus abandon it after closing the observer. Either choice loses the child/result; the former avoids a detached process with a broken stdout pipe.
- Confirm whether an additive `ephemeral: true` marker on structured list/snapshot details is sufficient, or whether the user wants a visible compact list-text marker as well. The recommended default is a concise visible marker plus structured data, while mutation receipt content remains unchanged.
