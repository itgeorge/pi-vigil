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
- [ ] Add failing notifier tests (fake `ParentNotifier`):
  - ephemeral settle with default notify → exactly one `sendMessage`-shaped notify;
  - ephemeral settle with `dontNotify: true` → no notify;
  - persisted child running→waiting → one notify;
  - persisted opt-out → no notify;
  - failed settle/failure path notifies unless opted out (same channel, distinct content/state in details);
  - duplicate settle callbacks do not double-notify;
  - after `send` without opt-out, the next settle notifies again;
  - shutdown prevents further notifies.

## Agent notes / assumptions

- Mirror `allowSubagents?: false` ledger style: persist `dontNotify: true` only when opted out; absence means notify.
- Keep notification body bounded (recommend ≤ ~500 visible chars total, with a short excerpt of `latestResponse` or error). Exact cap chosen in Phase 2 and documented in README.
- **Red evidence (2026-08-28):** `npm test -- test/unit/vigil/dont-notify-adapter.test.ts test/unit/vigil/dont-notify-ledger.test.ts` → 7 failed (schema rejection missing, ledger stamps absent, `shouldNotifyOnSettle` undefined).
- **Green evidence (2026-08-28):** same command → 7 passed; full `npm test` → 450 passed; `npm run typecheck` clean.
- Notifier tests deferred to Phase 2+ per session scope.

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

- [ ] Introduce a narrow port, e.g.:

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

- [ ] Implement a Node/extension adapter that calls `pi.sendMessage` with:
  - `customType: "vigil-notify"`
  - short prefixed `content`
  - `display: true`
  - structured `details`
  - `{ deliverAs: "steer", triggerTurn: true }`
- [ ] Wire the adapter from `registerVigilExtension` (capture `pi.sendMessage` alongside `appendEntry`).
- [ ] Inject the port through `createVigilServiceForContext` / runtime overrides for tests.
- [ ] Unit-test the adapter’s content formatting/bounds with a recording fake (no live Pi).

## Agent notes / assumptions

- When the parent is streaming, Pi’s `sendCustomMessage` uses steer/followUp queues; `triggerTurn` applies when idle. Passing both `deliverAs: "steer"` and `triggerTurn: true` matches the agreed always-on policy.
- Do not use `ctx.ui.notify` as the orchestration signal (TUI-only).
- Prefer not to call `sendUserMessage` for the default path.

---

# Phase 3 — Ephemeral settle → notify

## Todos

- [ ] In the ephemeral `onSettled` path (where `vigil-settle` is appended), if `shouldNotifyOnSettle` and not already notified for this settle, call `ParentNotifier`.
- [ ] Ensure activate/launch ordering still appends `vigil-launch` before settle can fire (preserve Slice ephemeral durability invariants).
- [ ] Cover success and `settleRecord.error` / failed ephemeral outcomes.
- [ ] Green ephemeral notify tests; confirm opt-out skips notifier.

## Agent notes / assumptions

- Reuse existing settle dedupe guards (`settleRecord` already present ⇒ no re-append); extend with a notify-once guard if notifier could run without a new settle append.

---

# Phase 4 — Persisted settle watcher → notify

## Todos

- [ ] Add a parent-owned persisted settle observer/watcher that arms on successful `launch` / `send` for notify-enabled children.
- [ ] Detect `running → waiting` or failure using existing child-session + PID / fail-record signals (same truth as `poll`, not a second divergent state machine).
- [ ] On first settle/fail for that turn: notify once (if enabled), then disarm for that turn.
- [ ] Do not notify for children that are already settled when the watcher first observes them after arming races — define and test the arming rule clearly (prefer: arm while `running` after launch/send success; first observed terminal state triggers notify).
- [ ] Honor `dontNotify` from the latest turn record at notify time.
- [ ] Stop watchers on `session_shutdown` and when the parent session id changes / service tears down (match existing shared-observer patterns).
- [ ] Deterministic tests with fake clock/reader/process ports — no real sleeps in unit tests.
- [ ] Green persisted notify tests including opt-out on launch and on last `send`.

## Agent notes / assumptions

- This reintroduces a **scoped background watcher** (Slice 1 avoided a global registry; this watcher is notify-specific, parent-session-scoped, and shut down cleanly).
- Polling cadence may reuse wait-style capped backoff, but must not mutate ledger/processes.
- fs.watch is optional; timer+poll against `ChildSessionReader` is enough for v1 if simpler and testable.
- Bootstrap fail-fast / `vigil-fail` should notify as `failed` unless opted out (parent idle wake on bad launch is valuable).

---

# Phase 5 — Docs, rendering polish, faux/acceptance hooks

## Todos

- [ ] Update README: `dontNotify` on launch/send; default notify-on; steer + idle `triggerTurn` behavior; ephemeral + persisted; short message contract; relationship to `wait`.
- [ ] Optionally register a `vigil-notify` message renderer for TUI distinction.
- [ ] Update tool description strings so models know notify is default and how to opt out.
- [ ] Add or extend faux-acceptance coverage if cheap (scripted settle → parent notifier invoked). Live acceptance only if it can assert notify without flaky LLM coupling — prefer recording the extension notifier seam in faux/parent harness over full LLM wake tests.
- [ ] Run `npm run check`. Record results. If live acceptance is extended, run with `PI_VIGIL_LIVE=1`.

## Agent notes / assumptions

- Consider a one-line mention in `optional-followups.md` only if deferring renderer polish or live wake e2e; do not park the core feature there.

---

# Phase 6 — Review checklist (before merge)

## Todos

- [ ] Confirm default omit `dontNotify` ⇒ notify for both modes.
- [ ] Confirm `dontNotify: true` on launch silences; on last `send` silences subsequent settle; omitted `send` re-enables.
- [ ] Confirm busy path uses steer (no tool abort); idle path triggers a turn.
- [ ] Confirm one notify per settle; no notify after shutdown; no historical notify on parent resume.
- [ ] Confirm wait overlap is redundant-but-safe; no mutual exclusion required.
- [ ] Confirm content stays bounded; full response still via poll/wait.
- [ ] Confirm no Pi core dependency beyond ExtensionAPI `sendMessage`.
- [ ] Independent review of race: launch/send append vs watcher arm vs fast settle (especially ephemeral + fast persisted fail).

---

## Implementation status

Phase 0 (schema + adapter/ledger red tests) and Phase 1 (ledger preference + `shouldNotifyOnSettle`) complete. ParentNotifier delivery, ephemeral/persisted notify wiring, and docs deferred to Phases 2–5.

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

## Remaining implementation choices (resolve in Phase 0–2, document here)

- Exact notify content template and excerpt/error bounds.
- Whether failed bootstrap notifies as `state: "failed"` in the same `vigil-notify` channel (recommended: yes).
- Persisted watcher: timer poll vs `fs.watch` (recommended: timer poll + existing readers for testability).
- Whether to persist a `vigil-notified` ledger breadcrumb (optional audit; not required if notifier dedupe is in-memory per turn + settle record presence).
