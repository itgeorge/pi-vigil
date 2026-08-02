# Slice 6 — Shallow descendant visibility and guarded completion

## How agents should use this plan

Read this complete plan before making changes. Work in **red → green → refactor** order: first add the smallest focused failing test for the next behavior, run it to prove it fails for the intended reason, implement only enough production code to pass it, then refactor while keeping the full deterministic suite green. Do not add implementation before the relevant failure exists.

Find the next unchecked `[ ]` TODO and complete it as a coherent, testable chunk. Add newly discovered relevant TODOs beneath its current phase before proceeding. Mark completed work `[x]`; document assumptions, deviations, and test results in this plan. Commit plan/checklist updates with their related code and tests.

This slice is deliberately limited to **one-level** descendant inspection and parent completion guarding. Do not implement targeted `wait`, recursive/subtree traversal, descendant process killing/cancellation, process groups, cross-session writes, automatic cleanup, child continuation/branching, LLM summaries, fuzzy search, watchers, subscriptions, background workers, retries/supervision, an external registry, or arbitrary file-path access.

---

## What this work is

Vigil children are themselves Pi sessions and can launch their own direct Vigil children. This creates useful nested orchestration, but the root parent currently sees only its immediate children. It cannot tell whether a direct child is finishing while its own direct subagents remain incomplete, and can mark that child completed without an explicit acknowledgement of that situation.

The intended model remains session-local and append-only: an intermediate child owns its own child ledger and normally decides whether/how to finish its own work. “Orphaned” retained waiting sessions are not a global resource to clean up. This slice adds only enough shallow visibility for a parent to gently remind an intermediate child and enough protection to prevent an accidental completion from hiding known immediate descendants.

## End goal of this plan

For each direct Vigil child shown by root `list` or `wait`, return/read a bounded summary of that child’s **direct** Vigil children—root grandchildren—with no recursion beyond one level.

Example list/wait text (exact layout may improve):

```text
id: vigil-a, name: Implement feature A, state: waiting
  direct subagents: 2 incomplete (1 running, 1 waiting; 1 completed)
  - Research API [vigil-a1b2c3d] — running
  - Write tests [vigil-e4f5a6b] — waiting
```

The structured object should preserve enough identity for an LLM to prompt the intermediate child, e.g. a bounded summary plus direct child `id`, `name`, and derived state. Display output is capped; detailed direct-child lists may be capped with an omitted count, but counts must reflect the full shallow ledger inspection.

Extend completion:

```ts
vigil({
  action: "complete",
  id,
  allowIncompleteSubagents?: false,
})
```

Default completion of a settled direct child rejects when its own session ledger has incomplete **direct** Vigil children:

```text
Cannot complete Vigil child vigil-a: 2 incomplete direct subagents (1 running, 1 waiting).
Prompt the child to finish them, or pass allowIncompleteSubagents: true.
```

`allowIncompleteSubagents: true` is an explicit acknowledgement: it marks **only the requested direct child** completed under the existing Slice 3 behavior. It does not kill, reap, rename, send to, complete, or otherwise modify any descendant. It is intentionally not named `ignoreRunningSubagents`/`ignoreWaitingSubagents`, because “allow completion” must never silently imply process termination.

If Vigil cannot read/validate the direct child session/ledger needed to determine descendants, default completion fails closed with a controlled verification error. The override does not bypass unavailable/unverifiable session data; this is a safety guard, not a force-write escape hatch.

## Key working assumptions

- Scope is exactly depth one from the currently managed direct child. Root → A → A1 is visible when looking at A; A1’s children are never read or included. No recursive function/loop may traverse descendants.
- A direct child’s child ledger lives as `vigil-launch`/`vigil-turn`/`vigil-complete` custom entries in that direct child’s retained Pi session JSONL. Reuse `reconstructVigilLifecycleFromEntries` and its existing canonical identity/tombstone hardening; do not invent another persistence format.
- Descendant states use the existing persisted state derivation where child session/PID information is available (`running`, `waiting`, `completed`). If a particular direct-descendant state cannot be inspected, represent this explicitly as a bounded `unknown` inspection status or fail the enclosing inspection according to a documented rule—never fabricate `waiting`/`completed`.
- The guard’s crucial predicate is **incomplete**: canonical direct descendant lifecycle with no completion tombstone. A descendant’s transient live state is informative for display/error text but is not needed to determine incompleteness.
- A parent may read an intermediate child’s JSONL while the intermediate writes its own session. This is observational, not transactional. Use the same controlled parse/read-failure discipline as Slice 5; do not retry, watch, lock, or write the child session.
- Root `list` and foreground `wait` gain shallow descendant information. `poll` remains a narrow direct-child snapshot operation in this slice unless a small shared DTO seam makes an additive field unavoidable; do not make it a recursive inspector.
- `wait` keeps all Slice 4/4.5 semantics: fixed direct-child cohort, capped backoff, no mutation, no new background work. Shallow summaries may update with wait scans, but they do not alter settlement rules.
- `list`/`wait` may read descendant state/PIDs for **display** only. `complete` must inspect descendants before any mutation/reap/rename of the requested direct child. No descendant PID is ever terminated in this slice.
- A direct child with zero descendants returns a verified zero summary; an unavailable/corrupt child ledger is distinguishable from zero descendants in structured details/text.
- Use documented finite bounds, recommended initial values: at most 20 direct descendant items displayed per root child, with `omittedCount`; counts (`running`, `waiting`, `completed`, `incomplete`) are not capped. Sanitize/truncate all session-derived display fields using existing output-safety helpers.
- `allowIncompleteSubagents` is valid only for `complete`; it has no effect on `list`, `wait`, `poll`, `search`, or `read`.
- Nested Vigil use requires the extension to be loaded in the intermediate Pi session. This slice does not change extension inheritance/loading.

---

# Phase 0 — Red: lock down shallow scope and completion policy

## Todos

- [x] Read the accepted Slice 1–5 plans, current 4.5 progress implementation, current types/lifecycle/node adapter/ports/extension adapter/rendering, Pi session-tree format docs, and existing deterministic/live test harness before changing code.
- [x] Add focused failing unit tests proving a root child session containing custom Vigil records for A1/A2/A3 produces a **one-level** direct-descendant summary:
  - canonical active/completed records produce deterministic counts/items;
  - malformed/duplicate/tampered descendant records inherit lifecycle reconstruction hardening;
  - no deeper ledger (A1’s own children) is inspected or exposed;
  - zero direct descendants differs from unavailable child-ledger inspection.
- [x] Add failing tests for display-state inspection: mixed `running`, `waiting`, and `completed` direct descendants; unavailable direct descendant session/state reports an explicit documented status/error rather than an invented terminal state.
- [x] Add failing `complete` service/adapter tests:
  - a settled direct parent with incomplete A1/A2 rejects with the exact actionable error and causes no parent append, reaping, rename, spawn, child-session write, or descendant mutation;
  - an all-completed direct-descendant ledger allows normal existing completion;
  - `allowIncompleteSubagents: true` allows normal completion of the parent only and leaves descendant records/process operations untouched;
  - unavailable/corrupt intermediate child ledger fails closed even with the allow flag;
  - a still-running requested direct parent keeps existing “still running” rejection before any completion mutation.
- [x] Add failing `list` and `wait` tests proving summary hydration is bounded/read-only, wait settlement behavior/fixed cohort is unchanged, direct-descendant data appears in structured/text output, and a changed shallow summary changes wait progress fingerprint/status without a heartbeat.
- [x] Add failing schema/rendering tests: `allowIncompleteSubagents` is a boolean option on `complete` only; compact call rendering shows an explicit bounded override indicator when true; malformed/partial params are safe.

## Agent notes / assumptions

- Tests must first fail for the missing shallow-visibility/guard behavior, not due to type errors or fixture mistakes. Record the red test command/output in progress notes.
- Build intermediate session fixtures using real Pi `SessionEntry`/`SessionManager` shapes; do not use a fake alternate ledger format.

---

# Phase 1 — Green: read and derive exactly one child ledger

## Todos

- [x] Add a read-only shallow descendant inspection port/module, e.g. `ChildSessionDescendantInspector`, independent of the parent ledger and writable `SessionManager`. Its input is the canonical direct child session identity (`sessionId`, `cwd`, `sessionDir`); its output is either a bounded/typed inspection result or a controlled error.
- [x] Implement node inspection by resolving only that canonical direct child session through existing session-dir policy, parsing its JSONL with Pi’s parser, excluding the session header, and calling `reconstructVigilLifecycleFromEntries` on **that one file’s entries**.
- [x] Make the one-level boundary structural: the inspector must not call itself, inspect a descendant’s session JSONL, recurse through lifecycle records, or accept arbitrary paths. Add a test fixture with nested records to prove this.
- [x] Define DTOs such as:

  ```ts
  interface VigilDirectSubagentItem {
    id: string;
    sessionId: string;
    name: string;
    state: VigilState | "unknown";
  }

  interface VigilDirectSubagentSummary {
    inspection: "available";
    total: number;
    incomplete: number;
    running: number;
    waiting: number;
    completed: number;
    unknown: number;
    items: VigilDirectSubagentItem[]; // bounded display list
    omittedCount: number;
  }
  ```

  Exact names may improve, but include counts plus a bounded identity list and distinguish unavailable inspection from a verified empty summary.
- [x] Derive completed names/states from immutable completion records. For active direct descendants, reuse existing state derivation only through read-only process/session inspection; catch per-descendant storage/state failure into an explicit `unknown` item/count if that preserves useful aggregate visibility. Do not call reaping/spawning/renaming/append APIs.
- [x] Add a conservative controlled error for failure to resolve/read/parse the **intermediate child ledger** itself. Keep its text free of raw paths/unbounded parser messages.
- [x] Thread the inspector through `VigilServiceDeps`, context factory, runtime overrides, and deterministic harnesses without changing existing poll/search/read transcript-reader semantics.

## Agent notes / assumptions

- A direct child’s current parent-session file can contain normal messages and its own Vigil custom ledger entries. Only the latter are lifecycle input; no LLM content need be exposed for this feature.
- Retained child JSONLs are permanent by design, including a completed intermediate session, so inspection must work for active and completed direct parent children where explicitly requested by root list semantics.

---

# Phase 2 — Green: hydrate list/wait visibility with bounded safe text

## Todos

- [x] Add optional/additive shallow-summary fields to the list/wait-facing DTOs rather than changing existing ID/name/state semantics. Preserve `list` sorting and concise behavior.
- [x] Hydrate every root direct child included in `list` with an independent shallow inspection. Define/implement deterministic controlled behavior if one child cannot be inspected; recommended: retain the root child item with an explicit unavailable-inspection summary rather than failing an entire observational list. Document and test it.
- [x] Hydrate each existing `wait` cohort scan with shallow summary data. Preserve current direct-child state scan and progress timing; do not alter what counts as settled. Use the same scan results for final settled/pending output where possible to avoid redundant reads.
- [x] Extend wait-progress DTO/fingerprint/text so a changed direct-descendant count/state/item summary emits a factual status update before heartbeat. Keep the existing recent-message previews, 20 root-child status-block cap, and all output bounds.
- [x] Add compact, self-sufficient safe formatting helpers for list, wait-progress, and final wait snapshots/pending results, e.g. `direct subagents: none`, `2 incomplete (1 running, 1 waiting; 1 completed)`, followed by at most the display cap of direct items and an omitted-count line.
- [x] Sanitize and bound all direct-descendant names/IDs/state labels in text. Preserve raw stable IDs in structured details only where current API conventions already do so.
- [x] Confirm `poll`, `search`, `read`, launch, send, and completion behavior remain unchanged except the explicitly planned guarded completion path.

## Agent notes / assumptions

- Do not make visibility recursive merely because a direct descendant’s session itself contains ledger entries; root needs a gentle signal, not a full hierarchy browser.
- A `waiting` root child with incomplete descendants remains a valid wait settlement. The parent decides whether to send it a reminder or use the explicit completion override.

---

# Phase 3 — Green: guarded parent completion, no descendant mutation

## Todos

- [x] Extend `CompleteInput`, schema, adapter dispatch, compact call formatter, and README with `allowIncompleteSubagents?: boolean`, default false.
- [x] Refactor `VigilService.complete` ordering safely:
  1. resolve canonical requested direct lifecycle and preserve existing completed/idempotent and running checks;
  2. read/validate its one-level descendant ledger before any direct-parent reaping, session-name update, or parent ledger append;
  3. if inspection fails, return controlled fail-closed verification error with no mutation;
  4. if `incomplete > 0` and flag is false, return actionable rejection with bounded counts and no mutation;
  5. if no incomplete descendants or explicit allow flag, perform the exact existing direct-parent reaping → rename → `vigil-complete` append flow;
  6. never call a descendant process runner, namer, ledger append, `send`, `complete`, or session writer.
- [x] Ensure the guard does not inspect/modify grandchildren beyond direct descendant ledger records. The override must not turn into a recursive operation.
- [x] Preserve immutable completion tombstone/idempotence: a repeated complete on an already completed parent returns its existing completion snapshot without a new descendant inspection/mutation requirement unless a documented safety reason requires otherwise.
- [x] Add self-sufficient error/text details that let an LLM act: identify the direct parent and counts; advise prompting the child versus passing the explicit override. Do not expose raw child session paths or unbounded descendant lists in an error.

## Agent notes / assumptions

- The guard is deliberately conservative. It protects accidental loss of orchestration visibility; it does not claim descendants are a globally owned resource.
- Do not add an option that kills/cancels descendants. Explicit recursive cancellation, if ever desired, is a distinct future product with ownership, PID reuse, cross-session write, process-group, and audit semantics.

---

# Phase 4 — Adapter/UI/docs and red-green regression coverage

## Todos

- [x] Add `allowIncompleteSubagents` to the Pi-compatible `complete` schema with an accurate description. Reject/ignore it for other actions by schema/dispatch design rather than silently changing lifecycle semantics.
- [x] Extend Slice 4.6 compact `renderCall` output for complete calls with an explicit, safe suffix such as `allow incomplete subagents` only when the boolean is true. Existing complete row output remains unchanged otherwise.
- [x] Update README:
  - describe immediate-child-only visibility and its session-local ownership model;
  - show a list/wait summary example and state all bounded counts/item display rules;
  - document default guarded completion, exact override behavior, fail-closed unavailable-ledger policy, and no recursive termination;
  - distinguish a child `waiting` orchestration state from a `completed` tombstone;
  - reiterate that deeper descendants are intentionally not traversed.
- [x] Ensure deterministic test coverage includes all red/green cases, safe output controls/long names, direct item cap/omitted count, resumed/branch ledger isolation, custom/malformed ledger entries, empty/missing session behavior, errors before mutation, wait cancellation/timeout, and no public result regression for flat children.
- [x] Run `npm test` and `npm run typecheck` after every coherent green/refactor phase. Keep tests deterministic—fake process/session readers and schedulers, no sleeps.

## Agent notes / assumptions

- The implementation should not add a custom result renderer, TUI selection UI, partial token streaming, or any additional public action.
- Follow existing Slice 5 terminal-control safety conventions for every new textual surface.

---

# Phase 5 — Live acceptance, review handoff, and slice completion

## Todos

- [x] Extend opt-in authenticated live acceptance without relying on an LLM child to autonomously perform nested orchestration:
  1. launch a real uniquely named root child and wait for it to settle;
  2. locate its retained child session under the isolated test session directory and append a valid synthetic direct-descendant Vigil lifecycle ledger into that intermediate session using Pi session APIs/test setup;
  3. prove the root adapter `list`/`wait` sees only that shallow descendant summary;
  4. prove root `complete` rejects until `allowIncompleteSubagents: true`, then completes only the root child and leaves the synthetic descendant session/ledger retained/unmodified;
  5. retain existing launch/send/search/read/list/rename/completion assertions and unique cleanup;
  6. do not spawn/kill a real nested child just for acceptance.
- [x] Run and record:
  - `npm test`;
  - `npm run typecheck`;
  - `npm run test:acceptance` without opt-in, expecting the documented prerequisite error;
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.
- [x] Confirm exact non-goals: no targeted wait selector, recursion, descendant kill/reap/rename/append, child-session write, process groups, watcher, registry, search change, LLM summary, or automatic cleanup.
- [x] Update this plan checkboxes/notes/deviations/test results and commit with code/tests.
- [x] Provide implementation-review handoff: commits, API/default, depth boundary, summary/unavailable policy, completion ordering/error/override behavior, tests/live result, and non-goals.

## Future work (explicitly not this slice)

- **Targeted `wait` selection:** allow `wait` to specify one or more direct Vigil IDs, so already-waiting siblings do not make a later wait settle immediately. The user requested this next, but do not implement it in Slice 6.
- Explicit descendant/subtree cancellation or process termination, only after a separate design for cross-session ownership, PID reuse, audit records, and process groups.
- Recursive hierarchy browsing/supervision, tree UI, automatic cleanup, fuzzy/semantic search, LLM summaries, and live token streaming.

## Progress notes

- 2026-08-02: Plan created after accepted Slice 5 and deterministic wait recent-message previews. User approved one-level visibility for a direct child’s own direct Vigil children plus guarded completion; `allowIncompleteSubagents` explicitly allows only parent completion and never kills descendants. Red-green TDD is mandatory. No Slice 6 implementation has started.
- 2026-08-02: Slice 6 implemented. Red tests added first in `descendant-inspector.test.ts`, `guarded-complete.test.ts`, `list-subagents.test.ts`, `wait.test.ts`, and `render-call.test.ts`. Production: `src/vigil/descendant-inspector.ts`, list/wait hydration, guarded `complete`, schema/render/README, live acceptance append test.
- Red command (Phase 0): `npm test -- test/unit/vigil/descendant-inspector.test.ts` failed with missing module before green.
- Green: `npm test` — 204 passed; `npm run typecheck` — clean.
- Acceptance without opt-in: `npm run test:acceptance` fails with documented `PI_VIGIL_LIVE` prerequisite (expected).
- Live acceptance with auth not run in this session (requires `PI_VIGIL_LIVE=1` and authenticated Pi).
- Deviations: `setVigilRuntimeOverrides` now merges partial overrides so extension tests can set `descendantInspector` in `beforeEach` without losing per-test runner/reader overrides. Default deterministic harnesses use `createZeroDescendantInspector()`; production uses `createNodeChildSessionDescendantInspector`.
