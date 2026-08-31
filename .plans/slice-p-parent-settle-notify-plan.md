# Slice P — Parent settle notify (steer / idle wake)

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work in **red → green → refactor** order:

1. Add the smallest focused failing test for the current item.
2. Run it and record the exact red failure in this file.
3. Implement only the code required to turn it green.
4. Re-run focused + nearest related suites; record green evidence.
5. Refactor only when green; keep diffs minimal and scoped.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, and commit plan checkbox updates with the corresponding code/tests.

Do not begin implementation until the user explicitly approves proceeding after plan review.

---

## Problem statement

Vigil today is pull-orchestration: a parent must `wait` / `poll` to learn that a child settled. If the parent forgets to wait, the child can finish silently and the parent stays idle until a human prods it.

Claude Code / Codex-style subagents can push a short “child settled” signal into the orchestrator. Pi already supports this inside an extension via `pi.sendMessage()` / steering delivery — no Pi core changes required.

## End goal

When a direct Vigil child settles (ephemeral or persisted), the **parent** extension optionally injects a short custom message into the parent session so the orchestrator is informed:

- **Parent busy** (including blocked in `wait`): deliver as **steer** — after the current tool batch finishes, before the next LLM call. Does not abort in-flight tools. Adds only a small message to a turn that was going to continue anyway.
- **Parent idle**: **`triggerTurn: true`** — wake the parent. This is an intentional use case (forgot to `wait`).
- **Default: notify on.** Opt out with `dontNotify: true` on `launch` and/or `send`.

```ts
vigil({ action: "launch", name, message, model, cwd?, ephemeral?, allowSubagents?, dontNotify? })
vigil({ action: "send", id, message, model?, dontNotify? })
```

`dontNotify` defaults to **`false`** when omitted (agent is notified). Preference is recorded on the parent ledger for the launch/turn that produced the settle.

### Public notification shape (illustrative)

```ts
pi.sendMessage(
  {
    customType: "vigil-notify",
    content: "[vigil:<name> <id>] settled\n<bounded excerpt>",
    display: true,
    details: {
      id,
      name,
      state: "waiting" | "failed",
      // optional bounded metadata; not sent to the LLM
    },
  },
  {
    deliverAs: "steer",
    triggerTurn: true, // effective when parent is idle; steer path when busy
  },
);
```

Exact wording/bounds can be tightened in implementation, but must stay short, prefixed, and attributable to one Vigil child.

## Key working assumptions

- Stay **inside the Vigil extension**. Communicate with the parent Pi orchestrator only through `pi.sendMessage` (preferred) or equivalent ExtensionAPI injection — not child→parent IPC, sockets, or Pi core patches.
- Child Pi `agent_settled` does **not** cross process boundaries. The **parent** must detect settle (ephemeral: existing `onSettled`; persisted: new parent-side observation).
- Both **ephemeral and persisted** children must notify when enabled.
- Notify on transition to settled/failed for the current turn — not on `complete`, not for historical settles discovered only after parent restart, not for children already `waiting`/`completed`/`failed` before the watcher armed for that turn.
- **One notify per settle event** (dedupe). A later `send` that settles again may notify again unless that turn opted out.
- `dontNotify` on the **latest** runtime record (`vigil-launch` or `vigil-turn`) controls whether that turn’s settle notifies. Omitted ⇒ `false` (notify). Explicit `true` ⇒ skip notify for that turn’s settle. A later `send` without `dontNotify` re-enables notify for the new turn.
- Overlap with an in-flight `wait` that returns the same child is acceptable: one short redundant steer line is fine; do not build wait/notify mutual exclusion as a core requirement.
- Inject a **`ParentNotifier`** (or equivalent) port so unit tests assert notify calls without a live Pi session / real `sendMessage`.
- Session shutdown stops settle watchers / pending notify work (same lifecycle discipline as ephemeral + bootstrap observers).
- Do **not** stream child tokens into the parent. Notification content is a bounded settle ping; full response remains available via `poll` / settled `wait`.
- Do **not** implement `waitAll`, descendant cancel, semantic search, or other optional-followups items in this slice.
- Custom message `details` are not sent to the LLM (`convertToLlm` uses `content` only). Keep LLM-visible `content` short; put structured ids/state in `details`.
- Optional: `registerMessageRenderer("vigil-notify", …)` for distinct TUI styling — nice-to-have, not blocking.

## Out of scope

- Changing `wait` semantics or replacing pull orchestration.
- Child-side extensions that push to the parent.
- Auto-`complete` on settle.
- Notifying about grandchild / nested subagents (direct children only).
- `sendUserMessage` as the primary path (prefer `sendMessage` + `customType: "vigil-notify"` so content is filterable/renderable).

---

# Phase 0 — Contract, schema, and red tests

## Todos

- [x] Read current `src/index.ts`, `node-runtime.ts`, `lifecycle.ts`, `types.ts`, `ports.ts`, ephemeral/persisted observers, README notify/wait sections, and Pi `sendMessage` / steer docs (`@earendil-works/pi-coding-agent` ExtensionAPI) before production edits.
- [x] Lock the tool schema:
  - `launch` and `send` accept optional boolean `dontNotify` (default behavior when omitted: notify / treat as `false`).
  - Reject `dontNotify` on actions other than `launch`/`send` with a concise error (same style as `ephemeral` only-on-launch).
- [x] Add failing unit tests for schema/adapter validation of `dontNotify` on launch/send and rejection elsewhere.
- [x] Add failing service tests for ledger preference:
  - `launch` without `dontNotify` records notify-enabled (no `dontNotify: true` stamp, or explicit false — pick one durable representation and stick to it; prefer omit-unless-true like `allowSubagents: false`).
  - `launch({ dontNotify: true })` stamps opt-out on `vigil-launch`.
  - `send({ dontNotify: true })` stamps opt-out on that `vigil-turn`.
  - `send` omitting `dontNotify` after a prior opt-out re-enables notify for the new turn.
- [x] Add failing notifier tests (fake `ParentNotifier`):
  - [x] ephemeral settle with default notify → exactly one `sendMessage`-shaped notify;
  - [x] ephemeral settle with `dontNotify: true` → no notify;
  - [x] persisted child running→waiting → one notify (Phase 4: `persisted-notify.test.ts`);
  - [x] persisted opt-out → no notify (Phase 4);
  - [x] failed settle/failure path notifies unless opted out (same channel, distinct content/state in details);
  - [x] duplicate settle callbacks do not double-notify;
  - [x] after `send` without opt-out, the next settle notifies again (Phase 4);
  - [x] shutdown prevents further notifies.

## Agent notes / assumptions

- Mirror `allowSubagents?: false` ledger style: persist `dontNotify: true` only when opted out; absence means notify.
- Keep notification body bounded (recommend ≤ ~500 visible chars total, with a short excerpt of `latestResponse` or error). Exact cap chosen in Phase 2 and documented in README.
- **Red evidence (2026-08-28):** `npm test -- test/unit/vigil/dont-notify-adapter.test.ts test/unit/vigil/dont-notify-ledger.test.ts` → 7 failed (schema rejection missing, ledger stamps absent, `shouldNotifyOnSettle` undefined).
- **Green evidence (2026-08-28):** same command → 7 passed; full `npm test` → 450 passed; `npm run typecheck` clean.
- Ephemeral notifier tests in Phase 2/3 (`test/unit/vigil/ephemeral-notify.test.ts`, `test/unit/vigil/parent-notifier.test.ts`). Persisted notifier tests in Phase 4 (`test/unit/vigil/persisted-notify.test.ts`).

---

# Phase 1 — Ledger + lifecycle preference

## Todos

- [x] Extend `VigilLaunchRecord` / `VigilTurnRecord` (and lifecycle parsers) with optional `dontNotify?: true`.
- [x] Thread `dontNotify` from tool → `VigilService.launch` / `send` into appendLaunch/appendTurn.
- [x] Add a pure helper, e.g. `shouldNotifyOnSettle(lifecycle): boolean`, based on the latest runtime record’s preference.
- [x] Update render-call compact rows only if useful (`dontNotify` hint); do not bloat mutation receipts.
- [x] Green the Phase 0 ledger preference tests.

## Agent notes / assumptions

- Preference is per turn, not a sticky session flag independent of ledger records.
- `complete` / `list` / `poll` / `wait` remain unchanged aside from any shared lifecycle typing.
- `shouldNotifyOnSettle` reads `lifecycle.runtimeRecord.dontNotify` (latest launch or turn). Omit-unless-true stamp via `buildLaunchRecordNotifyPolicy` / `buildTurnRecordNotifyPolicy` in `node-runtime.ts`.
- Compact render shows `no notify` on launch/send when `dontNotify: true`.

---

# Phase 2 — ParentNotifier port + delivery policy

## Todos

- [x] Introduce a narrow port, e.g.:

  ```ts
  interface ParentNotifier {
    notifySettled(input: {
      id: string;
      name: string;
      state: "waiting" | "failed";
      latestResponse: string | null;
      error?: string;
    }): void;
  }
  ```

- [x] Implement a Node/extension adapter that calls `pi.sendMessage` with:
  - `customType: "vigil-notify"`
  - short prefixed `content`
  - `display: true`
  - structured `details`
  - `{ deliverAs: "steer", triggerTurn: true }`
- [x] Wire the adapter from `registerVigilExtension` (capture `pi.sendMessage` alongside `appendEntry`).
- [x] Inject the port through `createVigilServiceForContext` / runtime overrides for tests.
- [x] Unit-test the adapter’s content formatting/bounds with a recording fake (no live Pi).

## Agent notes / assumptions

- When the parent is streaming, Pi’s `sendCustomMessage` uses steer/followUp queues; `triggerTurn` applies when idle. Passing both `deliverAs: "steer"` and `triggerTurn: true` matches the agreed always-on policy.
- Do not use `ctx.ui.notify` as the orchestration signal (TUI-only).
- Prefer not to call `sendUserMessage` for the default path.
- Content cap: `MAX_VIGIL_NOTIFY_CONTENT_CHARS = 500` in `src/vigil/parent-notifier.ts` (prefix + bounded excerpt/error).
- **Red evidence (2026-08-28):** `npm test -- test/unit/vigil/parent-notifier.test.ts test/unit/vigil/ephemeral-notify.test.ts` → 9 failed (port/adapter/wiring absent).
- **Green evidence (2026-08-28):** same command → 9 passed; full `npm test` → 459 passed; `npm run typecheck` clean.

---

# Phase 3 — Ephemeral settle → notify

## Todos

- [x] In the ephemeral `onSettled` path (where `vigil-settle` is appended), if `shouldNotifyOnSettle` and not already notified for this settle, call `ParentNotifier`.
- [x] Ensure activate/launch ordering still appends `vigil-launch` before settle can fire (preserve Slice ephemeral durability invariants).
- [x] Cover success and `settleRecord.error` / failed ephemeral outcomes.
- [x] Green ephemeral notify tests; confirm opt-out skips notifier.

## Agent notes / assumptions

- Reuse existing settle dedupe guards (`settleRecord` already present ⇒ no re-append); `settleNotifiedKeys` + `createShutdownAwareParentNotifier` guard duplicate notify and post-shutdown delivery.
- **Green evidence (2026-08-28):** `test/unit/vigil/ephemeral-notify.test.ts` → 5 passed.

---

# Phase 4 — Persisted settle watcher → notify

## Todos

- [x] Add a parent-owned persisted settle observer/watcher that arms on successful `launch` / `send` for notify-enabled children.
- [x] Detect `running → waiting` or failure using existing child-session + PID / fail-record signals (same truth as `poll`, not a second divergent state machine).
- [x] On first settle/fail for that turn: notify once (if enabled), then disarm for that turn.
- [x] Do not notify for children that are already settled when the watcher first observes them after arming races — define and test the arming rule clearly (prefer: arm while `running` after launch/send success; first observed terminal state triggers notify).
- [x] Honor `dontNotify` from the latest turn record at notify time.
- [x] Stop watchers on `session_shutdown` and when the parent session id changes / service tears down (match existing shared-observer patterns).
- [x] Deterministic tests with fake clock/reader/process ports — no real sleeps in unit tests.
- [x] Green persisted notify tests including opt-out on launch and on last `send`.

## Agent notes / assumptions

- This reintroduces a **scoped background watcher** (Slice 1 avoided a global registry; this watcher is notify-specific, parent-session-scoped, and shut down cleanly).
- Polling cadence may reuse wait-style capped backoff, but must not mutate ledger/processes.
- fs.watch is optional; timer+poll against `ChildSessionReader` is enough for v1 if simpler and testable.
- Bootstrap fail-fast / `vigil-fail` should notify as `failed` unless opted out (parent idle wake on bad launch is valuable).
- **`VigilService` ctor defaults `persistedSettleWatcher` to noop** (like ephemeral observer); real watcher is created only in `createVigilServiceForContext`.
- Dedupe key: `${vigilId}:${turnStartedAt}:${pid}` — launch+send in the same millisecond stay distinct.
- Phase gate: `npm run check` (typecheck + unit + faux-acceptance + pack:verify).
- **Green evidence (2026-08-29):** `test/unit/vigil/persisted-notify.test.ts` → 7 passed; `npm run check` clean. Faux orchestration script opts `dontNotify` on launch so settle steer does not disrupt scripted wait/complete flow.

---

# Phase 5 — Docs, rendering polish, faux/acceptance hooks

## Todos

- [x] Update README: `dontNotify` on launch/send; default notify-on; steer + idle `triggerTurn` behavior; ephemeral + persisted; short message contract; relationship to `wait`.
- [ ] Optionally register a `vigil-notify` message renderer for TUI distinction.
- [x] Update tool description strings so models know notify is default and how to opt out.
- [x] Add or extend faux-acceptance coverage if cheap (scripted settle → parent notifier invoked). Live acceptance only if it can assert notify without flaky LLM coupling — prefer recording the extension notifier seam in faux/parent harness over full LLM wake tests.
- [x] Run `npm run check`. Record results. If live acceptance is extended, run with `PI_VIGIL_LIVE=1`.

## Agent notes / assumptions

- The optional `vigil-notify` renderer remains deferred; the custom message transport and default TUI display are sufficient for this slice.
- Faux acceptance records real parent-session `vigil-notify` entries for persisted default-on, persisted launch opt-out, and ephemeral transport. The ephemeral faux child can exit nonzero after producing output, so that test accepts `waiting` or `failed`; changing the faux process behavior solely to force a clean exit was not sufficiently low-risk for this infrastructure test.
- Faux acceptance intentionally exercises the busy/steer route through `wait`; idle wake is covered by the notifier unit assertion for `{ deliverAs: "steer", triggerTurn: true }`, and a real-Pi idle e2e is deferred.
- The internal `enablePersistedSettleNotifyWatcher` override is explicitly documented and unit-asserted; it opts injected faux runners into the live watcher while ordinary injected unit harnesses retain the noop watcher.
- **Green evidence (2026-08-29):** `npm run check` passed: typecheck clean, **465 unit tests**, **8 faux-acceptance tests**, package surface OK (**27 entries**). Focused `npm run test:faux -- --reporter=verbose test/faux-acceptance/vigil-notify-faux.test.ts` passed: **3 tests**.

---

# Phase 6 — Review checklist (before merge)

## Todos

- [x] Confirm default omit `dontNotify` ⇒ notify for both modes.
- [x] Confirm `dontNotify: true` on launch silences; on last `send` silences subsequent settle; omitted `send` re-enables.
- [x] Confirm busy path uses steer (no tool abort); idle path triggers a turn.
- [x] Confirm one notify per settle; no notify after shutdown; no historical notify on parent resume.
- [x] Confirm wait overlap is redundant-but-safe; no mutual exclusion required.
- [x] Confirm content stays bounded; full response still via poll/wait.
- [x] Confirm no Pi core dependency beyond ExtensionAPI `sendMessage`.
- [x] Independent review of race: launch/send append vs watcher arm vs fast settle (especially ephemeral + fast persisted fail).

## Review evidence

- Independent Luna review found a persisted watcher re-arm generation race and an in-flight shutdown race. Commit `e64a2d6` adds object-identity generation checks before/after async polling, prevents stale loops from deleting newer watches, and makes watcher shutdown suppress in-flight delivery.
- Pi lifecycle documentation confirms `/new` and `/resume` emit `session_shutdown` before `session_start`; shared watchers/observers are shut down on the former. Commit `e64a2d6` recreates the shutdown-aware production notifier on the latter, so old callbacks stay muted while notifications work in the new session.
- Append-before-activate ordering protects fast ephemeral/persisted callbacks; bootstrap failure uses immediate notifier delivery with the same per-turn policy and dedupe set.
- Visible `vigil-notify` content is capped at 500 characters; full child output remains available through `poll`/`wait`. Production delivery depends only on `ExtensionAPI["sendMessage"]` and uses `{ deliverAs: "steer", triggerTurn: true }`.
- Final parent gate (2026-08-31): `npm run check` passed with **468 unit tests**, **8 faux-acceptance tests**, and package surface OK (**27 entries**).

---

## Implementation status

Slice P Phases 0–6 are complete through `e64a2d6` plus this review checkpoint. Parent settle notifications are implemented, documented, faux-accepted, race-reviewed, and green under the final phase gate.

## Context-compaction recovery checkpoint (2026-08-29)

### Safe committed baseline

- `c3cf954` — Phase 0–1: `dontNotify` schema, ledger preference, and lifecycle helper.
- `fba3330` — Phase 2–3: `ParentNotifier`, Pi steer/idle-wake delivery, and ephemeral notify.
- `1a00b6c` — Phase 4 persisted settle watcher.
- `faa6e6b` — Phase 4 timer-loop and send re-notify test fixes.
- Keep `stash@{0}` (`slice-p-phase4-wip-before-hang-bisect`) only as a temporary recovery artifact; it was not applied to the clean Phase 4 implementation.

### Phase 5 checkpoint contents

- README + Vigil tool description document default notify-on, `dontNotify`, steer delivery, idle `triggerTurn`, and `wait` overlap.
- New real-Pi faux acceptance test records parent-session `vigil-notify` custom-message entries for persisted default-on, verifies persisted opt-out suppression, and verifies ephemeral notification transport.
- Faux runtime explicitly opts an injected faux `processRunner` into the persisted watcher through the internal `enablePersistedSettleNotifyWatcher` runtime override. Normal unit harnesses with injected runners remain on the noop watcher and do not leak timer loops.
- Current phase gate is green: `npm run check` → typecheck clean, **465 unit tests**, **8 faux-acceptance tests**, package surface OK (**27 entries**).
- The Phase 5 Composer process died after its focused faux tests became green, before plan updates, full-gate recording, and commit. Its OS process is dead; do not resume it.

### Review caveats

- Persisted default-on and `dontNotify: true` are covered end-to-end with a real Pi parent and detached faux child.
- Ephemeral e2e proves notification injection but permits `state: waiting | failed`, because the faux ephemeral process can exit code 1 after producing output. Transport coverage is sufficient for this slice; forcing a clean faux exit would add infrastructure risk for no additional notification-path confidence.
- Faux tests exercise the busy/steer route by having the parent call `wait`. Idle wake remains structurally covered by the notifier unit assertion for `{ deliverAs: "steer", triggerTurn: true }`, not by a real-Pi idle e2e.
- The internal `enablePersistedSettleNotifyWatcher` override has a clarifying comment and a small runtime-overrides unit assertion; no broader production rewrite was needed.

### Next steps after compaction

1. Parent reviews this Phase 5 checkpoint and completes Phase 6; rerun `npm run check` as the final gate.
2. Retire stale Vigil sessions after review. Remove `stash@{0}` only after final acceptance.
3. Every `bash` tool call must include an explicit timeout. Every implementation-phase gate is `npm run check`.

## Open decisions (resolved in planning)

| Topic | Decision |
|---|---|
| Delivery while busy | `deliverAs: "steer"` |
| Delivery while idle | `triggerTurn: true` (desired wake) |
| Default | Notify on (`dontNotify` default `false` / omit) |
| Opt-out | `dontNotify` on `launch` and `send` |
| Modes | Ephemeral + persisted |
| Mechanism | Parent-side detect + `pi.sendMessage` (`customType: "vigil-notify"`) |
| Wait overlap | Allow short redundant steer; no special suppression |

## Phase 7 — Notification sequencing follow-up

- [x] Document that parent notifications are eventual turn-boundary messages, deferred behind an in-flight tool batch, with no chronology or global FIFO guarantee across user/extension queues.
- [x] Add deterministic real-Pi faux coverage proving a persisted child settlement during a longer parent `bash` call is recorded only after the blocking bash tool result, exactly once, and attributable to the launched child.
- [x] Run the focused sequencing faux test, `git diff --check`, and exactly `npm run check`; record green evidence here.

**Rationale:** Validate Pi's busy-tool steer/delivery boundary without changing notification delivery, Pi queue ordering, or Vigil's pull orchestration. Settlement, polling observation/enqueue, and Pi delivery remain distinct timestamps.

**Deliberate non-goals:** No mixed interactive user-message ordering test, queue reordering, global FIFO promise, or notification redesign. Mixed ordering remains Pi queue behavior rather than a Vigil guarantee.

**Green evidence (2026-08-31):** Focused `npm run test:faux -- --reporter=verbose test/faux-acceptance/vigil-notify-faux.test.ts -t "defers persisted settle notify"` passed (1 test, 3 skipped). `git diff --check` passed. Exactly one `npm run check` passed: typecheck clean, **468 unit tests**, **9 faux-acceptance tests**, package surface OK (**27 entries**).

## Remaining implementation choices (resolve in Phase 0–2, document here)

- Exact notify content template and excerpt/error bounds.
- Whether failed bootstrap notifies as `state: "failed"` in the same `vigil-notify` channel (recommended: yes).
- Persisted watcher: timer poll vs `fs.watch` (recommended: timer poll + existing readers for testability).
- Whether to persist a `vigil-notified` ledger breadcrumb (optional audit; not required if notifier dedupe is in-memory per turn + settle record presence).
