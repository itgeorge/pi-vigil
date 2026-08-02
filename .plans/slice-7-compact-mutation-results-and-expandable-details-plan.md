# Slice 7 — Compact mutation results with expandable human detail

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work in **red → green → refactor** order: first add the smallest focused failing test for the next behavior and run it to prove the expected failure; then add only the production code needed to make it pass; then refactor with the deterministic suite green.

Add newly discovered relevant TODOs beneath the active phase before proceeding. Mark completed items `[x]`, record assumptions, deviations, red/green evidence, and validation results in this file, and commit plan checkbox updates with the relevant code/tests. This slice uses a Composer implementation agent, an independent Composer smoke-test agent, and a GPT-5.5 review. Review findings must be returned to the **original implementation session** for remediation before slice acceptance.

Do not add new Vigil actions, result-selection parameters, session persistence formats, child-session writes, watchers, subscriptions, background work, LLM summaries, recursive inspection, or changes to `poll`, `wait`, `list`, `search`, or `read` output semantics.

---

## What this work is

`launch`, `send`, and `complete` are mutation/acknowledgement operations. Their current final `content` uses the full `VigilSnapshot` formatter, including `sessionId`, `cwd`, and potentially long `latestResponse` text. That repeats observation data that an orchestrator normally already obtained through `wait` or `poll`, inflates model context, and blurs the distinction between mutation and observation.

Pi custom tools separate provider-facing `content` from tool-result `details`. Built-in provider serialization sends text/image `content` to the model, while `details` is persisted extension metadata available to a custom `renderResult` for TUI display. The TUI passes an `expanded` flag and original `context.args`; `keyHint("app.tools.expand", ...)` must be used instead of hard-coding a key such as Ctrl-O.

## End goal of this plan

Keep action result `details` backward compatible as the existing full `VigilSnapshot`, but make successful `launch`, `send`, and `complete` final **content** compact mutation receipts:

```text
id: vigil-…
name: Research API
state: running
```

`complete` additionally includes `completedAt`. Mutation content must omit `sessionId`, `cwd`, and `latestResponse`. Errors remain self-sufficient existing error text.

Add a Vigil custom `renderResult`:

- Default/collapsed TUI output is a compact acknowledgement and an expandable-detail hint when detail exists.
- Expanded `send` shows its source message from `context.args.message`; do not duplicate that message into result `details`.
- Expanded `complete` may show the pre-completion/latest child response retained in `details.latestResponse`.
- `launch` remains compact without an expanded launch-message preview.
- All renderer-only session-derived/user-controlled detail is terminal-safe and capped at **4,000 visible characters** per detail block. A truncation indication is required. The renderer must never leak raw control/ANSI sequences.

`poll` and settled `wait` remain the deliberate model-facing observation APIs that expose `latestResponse`. Existing `list`, `search`, and `read` outputs are out of scope.

## Key working assumptions

- The context-saving contract applies to final tool `content`, not merely a visually collapsed renderer. A renderer alone cannot reduce provider context because Pi sends `content` to the model.
- `details` is retained in parent session JSONL, available to extensions/TUI/export, and should therefore be treated as bounded/sensitive metadata even though provider adapters do not serialize it as tool-result text. Do not introduce a new raw/unbounded copy of child output.
- Keeping the current full `VigilSnapshot` in `details` preserves programmatic compatibility. `latestResponse` is therefore hidden from normal mutation **content**, not removed from the structured metadata contract.
- `send`'s message already occurs in the assistant tool-call arguments. The renderer must use `context.args.message` on expansion rather than store/repeat it in `details` or normal result content.
- The 4,000-character renderer detail cap matches Slice 5's bounded diagnostic entry detail. Existing output-safety helpers should be reused where compatible; exact helper/module names may improve during implementation.
- Result renderers are visual only: they must not append entries, refresh child sessions, perform I/O, mutate display caches, or change action execution/results.
- The compact content remains line-oriented, safe, and sufficiently self-contained to identify the affected child and resulting state. Exact receipt wording may improve, but field presence/omissions above are contractual.

---

# Phase 0 — Red: specify compact mutation content and safe expanded detail

## Todos

- [x] Read current adapter result dispatch, `VigilSnapshot`/formatters, call renderer, transcript/terminal-safety helpers, Pi custom-tool `renderResult` API, and all launch/send/complete adapter/service/render tests before editing production code.
- [x] Add focused failing unit tests for a pure compact mutation formatter (or equivalent) proving successful launch/send/complete content contains only ID, name, state, and optional completion timestamp; it excludes `sessionId`, `cwd`, and `latestResponse`, including a very long latest response.
- [x] Add failing adapter tests proving successful mutation actions return compact `content` while preserving the existing full `VigilSnapshot` in `details`; errors retain current controlled text/isError behavior.
- [x] Add failing renderer tests proving:
  - collapsed successful mutation output is compact and uses the configured `app.tools.expand` hint only where detail is available;
  - expanded send renders the original message from `context.args`, not a duplicated details field;
  - expanded complete renders details `latestResponse` only on demand;
  - launch has no expanded launch-message preview;
  - control/ANSI/C1 payloads, long names/messages/responses, missing/malformed details, and partial/error results are safe and cannot throw or leak controls;
  - expanded detail is visibly capped at 4,000 characters with a clear truncation marker.
- [x] Run the focused red tests and record the expected failures in progress notes.

## Agent notes / assumptions

- Prefer outcome-focused tests against returned content/details and rendered component text. Do not assert incidental component identity or private cache internals.
- Use deterministic synthetic snapshots/renderer contexts; no live Pi child or timing dependency is needed for red/green unit tests.

---

# Phase 1 — Green: compact provider-facing mutation receipts

## Todos

- [x] Add a focused formatter/DTO seam, e.g. `formatMutationSnapshotText(snapshot)`, that produces compact safe success content without changing `formatSnapshotText` used by `poll` and settled `wait`.
- [x] Route only successful `launch`, `send`, and `complete` adapter results through that compact formatter. Preserve their `details` as the current full snapshot and preserve cache refresh behavior for launch/complete.
- [x] Ensure `complete` includes its immutable `completedAt` when present; launch/send do not invent it.
- [x] Preserve all existing action validation, service lifecycle/reaping ordering, schema, and structured result semantics. Do not alter `VigilSnapshot`, `poll`, `wait`, `list`, `search`, `read`, or error formatting to achieve compaction.
- [x] Refactor only after focused and full deterministic tests are green.

## Agent notes / assumptions

- A mutation receipt does not need `sessionId` because current Vigil launch IDs/session IDs are canonically paired and the action's ID remains sufficient for subsequent `poll`, `wait({ id })`, `send`, or `complete` calls.
- Do not put `latestResponse` into mutation text "just in case"; callers that need an observation must explicitly `poll` or use `wait`.

---

# Phase 2 — Green: expandable bounded TUI-only detail

## Todos

- [x] Add `renderResult` to the registered Vigil tool alongside the existing compact `renderCall`, using Pi's renderer API and `keyHint("app.tools.expand", ...)`.
- [x] Render successful mutation results compactly by default. On expansion:
  - for `send`, render a labeled, safe, bounded sent-message view from `context.args.message`;
  - for `complete`, render a labeled, safe, bounded latest-response view from `result.details.latestResponse` only when it is a nonempty string;
  - for `launch`, do not surface a launch message preview;
  - never show irrelevant details for a different action.
- [x] Use existing terminal-safety conventions for all expansion surfaces and enforce the 4,000-visible-character cap plus a clear truncation suffix. Preserve deliberate line breaks only where safe/readable.
- [x] Handle errors, malformed/missing results/details/args, partial updates, and fallback rendering safely. A renderer failure must degrade to normal `content`, not prevent tool execution.
- [x] Do not copy sent messages or response text into parent custom entries, new public fields, or result content. Do not perform session/process I/O from rendering.

## Agent notes / assumptions

- `details` may already contain full raw snapshot fields for compatibility. The renderer is the only new consumer and must sanitize before display.
- The custom result renderer must not change what an RPC/print-mode caller receives: that remains compact final `content` plus existing `details`.

---

# Phase 3 — Documentation, regressions, and acceptance

## Todos

- [x] Update README to distinguish compact mutation acknowledgements from observation output: `poll` and settled `wait` return latest response; mutation detail is available only in interactive expandable UI and is bounded/sanitized.
- [x] Update existing unit expectations for launch/send/complete output intentionally changed by this slice; preserve assertions for their structured details and all unrelated actions.
- [x] Add or update opt-in live acceptance through the registered adapter to assert at least one mutation receipt omits a unique child latest-response marker while a subsequent `poll` or settled `wait` exposes it. Keep unique values, isolated session directory, and existing cleanup.
- [x] Run and record `npm test`, `npm run typecheck`, `npm run test:acceptance` without opt-in (expected prerequisite guard), and `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.
- [x] Confirm non-goals: no action/schema expansion, no mutation service behavior change, no output change for poll/wait/list/search/read, no LLM summary, no automatic rendering-side read, no raw/unbounded UI transcript view, no extra parent persistence.
- [x] Update this plan's checkboxes/notes/results and commit plan changes with implementation/tests.

---

# Phase 4 — Independent smoke test, review, remediation, and handoff

## Todos

- [ ] Have an independent Composer 2.5 Fast smoke-test agent inspect the committed implementation without editing it. It must exercise compact mutation output, details preservation, expansion behavior, safety cap, full unit/typecheck validation, and opt-in live acceptance when available; report commands/results/failures.
- [ ] Have an independent GPT-5.5 review inspect implementation, tests, smoke findings, and plan. It must report only substantive findings ranked by severity, including context serialization correctness, result/details compatibility, renderer safety/bounds/fallback, action scoping, and test gaps.
- [ ] Return all confirmed review/smoke issues to the **original Composer implementation session** for focused red-green remediation. Do not hand-edit implementation except an emergency recovery that is explicitly recorded.
- [ ] Re-run affected deterministic tests, full unit/typecheck, and opt-in live acceptance after remediation. Re-review any nontrivial remediation before acceptance.
- [ ] Record commits, red/green/smoke/review results, deviations, final context contract, renderer detail contract, and remaining risks in this plan.

## Future work (explicitly not this slice)

- A separate explicit API for retrieving a bounded/full child response beyond `poll`, settled `wait`, and existing diagnostic `read`.
- Per-action custom result cards beyond mutation acknowledgements, selectable UI controls, copy/export actions, or a raw transcript viewer.
- Redacting/removing historical tool-call arguments from model context; this slice only avoids duplicating them in tool-result content.
- Global top-level list/wait output caps, changed search/read bounds, recursive orchestration views, LLM summaries, watchers, subscriptions, or background supervision.

## Progress notes

- 2026-08-02: User approved compact successful launch/send/complete content; full snapshots remain in `details` for compatibility. Poll and settled wait remain model-facing latest-response observation surfaces. Expanded `send` uses `context.args.message`; expanded `complete` may show `details.latestResponse`; launch has no expanded message. All expanded text is terminal-safe and capped at 4,000 visible characters. No implementation has started.
- 2026-08-02 Phase 0 red evidence: `npm test -- test/unit/vigil/mutation-content.test.ts test/unit/vigil/render-result.test.ts test/unit/vigil/extension-adapter.test.ts` failed as expected — `formatMutationSnapshotText is not a function`, missing `render-result` module, launch adapter still returned full snapshot text in `content`.
- 2026-08-02 Phase 1–2 green: added `formatMutationSnapshotText` in `src/vigil/types.ts`, routed launch/send/complete through `mutationSnapshotResult` in `src/index.ts`, added `src/vigil/render-result.ts` with bounded `renderResult` using `sanitizeDisplayMultiline` + `keyHint("app.tools.expand", "to expand")` (fallback to `keyText` + passed theme when Pi global theme is uninitialized in tests).
- 2026-08-02 Phase 3 validation: `npm test` → 231/231 passed; `npm run typecheck` → passed; `npm run test:acceptance` without opt-in → expected guard error; `PI_VIGIL_LIVE=1 npm run test:acceptance` → 2/2 passed (includes launch/send compact-content assertions omitting `sessionId`/`latestResponse` while settled `wait` still exposes markers).
- Final provider-facing mutation content contract: `id`, `name`, `state`, optional `completedAt` only; omits `sessionId`, `cwd`, `latestResponse`. Full `VigilSnapshot` preserved in `details`.
- Renderer detail contract: collapsed compact receipt + expand hint when send message or complete latestResponse exists; expanded send shows `context.args.message`; expanded complete shows bounded `details.latestResponse`; launch has no expanded prompt; 4,000 visible chars via `MAX_ENTRY_DETAIL_CHARS`/`sanitizeDisplayMultiline`; non-mutation/errors/partials fall back to normal `content`.
- Deviation: `keyHint` throws outside initialized Pi TUI theme; renderer uses try/catch with `keyText("app.tools.expand")` + caller theme as safe fallback while preserving configured binding lookup (no hardcoded keys).
- Remaining risks: Phase 4 independent smoke/review pending; expand-hint appearance depends on Pi keybinding config at runtime.
