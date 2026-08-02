# Slice 4.6 — Compact, identifiable Vigil tool-call rendering

## How agents should use this plan

Read this entire plan before making changes. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered relevant TODOs under the current phase before continuing. Mark completed items `[x]`, and record assumptions, deviations, and test notes in this file. Commit plan updates in the same commit as their corresponding code/test changes.

This plan is deliberately limited to **interactive Pi tool-call rendering**. Do not change Vigil lifecycle records, session-only persistence, child-process behavior, public tool semantics, wait progress behavior, result text/details, JSON/print-mode output, or implement search/LLM summaries/watchers.

---

## What this work is

The current Vigil definition provides `label: "Vigil"` but no custom `renderCall`. Pi therefore renders its compact tool-call header using the generic label alone, requiring a user to expand the row or inspect resumed JSONL to learn what action and child were involved.

Pi supports custom `renderCall(args, theme, context)` components. Add a concise factual call header that identifies the operation and, for ID-addressed actions, the human-readable Vigil session name as well as a short ID. The required child name becomes the primary visual identity; IDs remain a compact disambiguator.

## End goal of this plan

In the interactive TUI, default compact tool-call rows render approximately as follows (styling/spacing may vary with the active theme):

```text
vigil launch · Slice 4.5 implementation · model cursor/composer-2.5-fast
vigil poll · Slice 4.5 implementation [vigil-bd02f54]
vigil send · Slice 4.5 implementation [vigil-bd02f54] — Address reviewer feedback · model cursor/composer-2.5-fast
vigil complete · Slice 4.5 implementation [vigil-bd02f54]
vigil list · active
vigil list · including completed
vigil wait · up to 60s · progress status
```

Rules:

- `launch` shows the supplied required `name` and **always** shows a model indicator. Show the supplied `model` exactly when present; when the call omitted it, show the factual fallback `model Pi default` (not an invented/resolved model identity).
- `poll`, `send`, and `complete` show the reconstructed Vigil display name plus a stable shortened ID. If the ID is not known in the active parent branch, fall back safely to its shortened ID without a fabricated name.
- `send` also shows a bounded, quoted/safe one-line excerpt of `message`; it shows `model <value>` **only if a model was supplied** for that continuation.
- `list` reports whether completed sessions are included. `wait` reports effective-looking invocation options from arguments/defaults without implying a run outcome.
- The prompt/message excerpt is not shown for `launch`: the required launch name is its human-readable task summary.
- Full arguments and normal raw results remain available on expansion. This slice changes presentation only in interactive TUI; Pi JSON/print modes and tool content/details remain unchanged.

## Key working assumptions

- `renderCall` receives typed tool arguments and rendering context, but not an extension/session context and cannot perform asynchronous lifecycle reconstruction. It must not read files or spawn work.
- Maintain a small **read-only renderer cache** of `vigilId -> display name`, rebuilt from existing parent custom lifecycle entries on `session_start` and `session_tree`. This is a derived view of session-only state, not a new persistence mechanism or registry.
- Refresh the cache after a successful lifecycle-mutating tool operation as needed so later rerenders reflect launches/completions. Reconstruct from the session manager/ledger rather than trusting arbitrary tool parameters or raw result text.
- Branch navigation must rebuild the cache from the active branch so names follow normal Pi branching semantics.
- Use Pi’s `Text` component and theme colors with default tool shell/padding. Do not add a custom result renderer or `renderShell: "self"` unless a concrete renderer limitation is demonstrated.
- Sanitize/truncate untrusted user-controlled names, messages, models, and IDs to a single safe line and bounded visible length. Do not include cwd, full child prompt, `latestResponse`, or other potentially large/sensitive data in the compact header.
- A shortened ID must preserve the `vigil-` prefix and enough UUID characters to distinguish common concurrent children, e.g. `vigil-bd02f54`; document/test exact deterministic shortening behavior.

---

# Phase 0 — Specify presentation behavior with renderer-focused failing tests

## Todos

- [x] Read current `src/index.ts`, lifecycle reconstruction, extension-adapter harness/tests, accepted Slice 4/4.5 plans, and Pi custom-tool rendering documentation before editing.
- [x] Add focused failing tests for the `renderCall` output (render the returned component with a deterministic test theme/width or a small pure formatter seam):
  - `launch` renders name and an explicitly supplied model;
  - `launch` with omitted model renders `model Pi default`, not the parent model or an invented child model;
  - `poll`, `send`, and `complete` render the lifecycle-reconstructed display name plus short ID;
  - `send` renders a bounded/sanitized message excerpt and adds model only when supplied;
  - `list` differentiates active-only from `includeCompleted: true`;
  - `wait` renders its default/explicit timeout and progress mode concisely;
  - unknown/malformed IDs fall back safely without error;
  - long/newline-containing name/message/model/ID values remain a bounded single line.
- [x] Add a failing adapter/lifecycle integration test proving the cache is hydrated on resumed session state and rebuilt on a branch/tree change, so a renderer does not leak a name from another branch/session.
- [x] Add a failing test proving the rendering layer neither appends entries nor calls child/session/process services.

## Agent notes / assumptions

- Prefer direct observable rendered text and lifecycle-driven cache behavior. Do not assert private map mutation sequences.
- Keep TUI styling assertions minimal; validate semantic text, safe output, and use of expected theme categories where practical.
- Implemented via `test/unit/vigil/render-call.test.ts` (pure formatter + themed render + integration) and an adapter test for post-`launch` cache refresh.

---

# Phase 1 — Derive branch-aware display identity from the existing ledger

## Todos

- [x] Add a narrowly scoped renderer/display helper, with names such as `VigilDisplayNameIndex`, `buildVigilDisplayNameIndex`, or `formatVigilCallText`. Exact structure may evolve, but separate pure formatting from extension event wiring.
- [x] Reuse `reconstructVigilLifecycleFromEntries(...)` (or a small exported lifecycle projection) to map canonical Vigil IDs to display names from current parent entries:
  - active lifecycle uses its original launch name;
  - completed lifecycle uses its immutable completed display name when the cache is refreshed after completion;
  - malformed/duplicate/tampered records retain existing lifecycle hardening and do not corrupt a valid name.
- [x] Install refreshes at Pi `session_start` and `session_tree`, using the active session branch/entries appropriate to current lifecycle reconstruction semantics. Reset/replace the entire cache on refresh; never merge stale IDs across sessions/branches.
- [x] Refresh the derived index at an appropriate point after a successful `launch` or `complete` result so future tool rows in the same session can identify it. Ensure an error result never invents an entry.
- [x] Keep cache ownership session-scoped and read-only: no custom entry, disk file, child JSONL write, timer, watcher, process, or background task.
- [x] Add unit coverage for duplicate/malformed lifecycle data and branch replacement behavior if existing lifecycle tests do not already prove the renderer projection inherits it.

## Agent notes / assumptions

- Rendering starts before tool execution, so same-row `launch` identity comes from `params.name`; subsequent ID operations need the prehydrated derived cache.
- The user asked that names make `poll`/`send`/`complete` recognizable. The name cache is UX-only and must never become a source of lifecycle truth for services.
- `createVigilDisplayNameCache()` in `src/vigil/render-call.ts` owns the read-only map; `src/index.ts` wires Pi events and post-success refresh only.

---

# Phase 2 — Implement compact custom `renderCall`

## Todos

- [x] Import Pi TUI `Text` and implement `renderCall` on the Vigil `defineTool` definition. Preserve the default tool shell.
- [x] Implement a pure action formatter (suggested `formatVigilCallSummary(args, lookup)`) that follows the End Goal examples and centralizes:
  - action label;
  - display-name lookup and unknown-ID fallback;
  - deterministic short-ID formatting;
  - safe one-line truncation/quoting of send message excerpt;
  - launch/send model indicator rules;
  - concise list/wait option summaries using existing documented defaults.
- [x] Style the stable `vigil` title with `toolTitle`/bold and secondary values with `muted`/`dim`/`accent` using the supplied Pi theme. Avoid ANSI construction outside theme APIs.
- [x] Use `context.lastComponent` when suitable to update a `Text` component across re-renders; do not cache theme-colored strings in module state.
- [x] Ensure incomplete/partially decoded tool arguments render defensively during streaming/preflight. A renderer exception must not prevent the underlying tool from executing; retain a simple safe fallback header.
- [x] Do not add `renderResult`; preserve current final text/details and Slice 4.5 partial result rendering behavior.

## Agent notes / assumptions

- “Always include model in launch” means an explicit indicator in every launch header. `Pi default` is intentionally honest when no model argument was supplied; resolving a child’s eventual actual model is out of scope for this renderer slice.
- “Include model in send whenever supplied” means omit any model field for sends that do not override the continuation model.

---

# Phase 3 — Documentation, regression suite, and handoff

## Todos

- [x] Update README only as needed to state that interactive Vigil rows render compact action/name/ID summaries, that names are reconstructed from the current parent session, and that full args/results are expandable. Do not document implementation-only cache names.
- [x] Add a short user-facing example showing launch/poll/send rendering and clarify that the launch `name` is the visual task identity; launch prompt text is deliberately not echoed in the compact row.
- [x] Run and record:
  - `npm test` — 118 passed (13 files);
  - `npm run typecheck` — clean;
  - `npm run test:acceptance` without `PI_VIGIL_LIVE=1` — fails immediately with opt-in instructions (expected prerequisite behavior);
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` — 1 passed (live child orchestration unchanged).
- [x] Confirm no behavioral API/result/session changes and no new state persistence/background work were introduced.
- [x] Update this plan’s checkboxes, assumptions/deviations, progress notes, and test notes. Commit plan updates with code/tests.
- [x] Provide reviewer handoff with commit SHA, rendered action examples, exact model fallback behavior, cache-refresh/branch behavior, test results, and deviations.

## Progress notes

- 2026-08-02: Plan created after Slice 4.5 acceptance. User approved names plus short IDs for ID-addressed actions, bounded send-message excerpts, no launch-prompt excerpt, and model display on every launch / supplied-model sends. No implementation has started.
- 2026-08-02: Implemented `src/vigil/render-call.ts` (`buildVigilDisplayNameIndex`, `formatVigilShortId`, `formatVigilCallSummary`, `renderVigilCallText`) and wired `renderCall` plus session-scoped cache refresh in `src/index.ts`. Added `test/unit/vigil/render-call.test.ts`, extended adapter/harness coverage, and README interactive-row notes.
- 2026-08-02: Review-correction pass: `@earendil-works/pi-tui` promoted to peerDependency; expanded rows append full JSON args; robust `lastComponent` fallback.

## Deviations

- Send message excerpts are rendered with ASCII quotes (`"..."`) per the plan rules section (“quoted/safe one-line excerpt”), while the end-goal example line omits visible quotes.
- Short IDs use the first seven hex characters after removing hyphens from the UUID suffix (`vigil-bd02f54e-…` → `vigil-bd02f54`).

## Test notes

- Short-ID behavior is covered in `formatVigilShortId` unit tests.
- Branch isolation uses `SessionManager.branch()` plus `session_tree` refresh in render integration tests.
- Rendering side-effect freedom is asserted by comparing `capturedEntries` length before/after `renderCall`.
- `@earendil-works/pi-tui` is declared as a runtime peer dependency (`>=0.75.0`) with a matching devDependency for local tests/typecheck.
- Expanded tool rows append pretty-printed full arguments via `formatVigilCallExpandedArgs`; collapsed compact lines are unchanged.
- `lastComponent` reuse checks for `setText` before reusing; otherwise a fresh `Text` component is allocated.

## Future work (explicitly out of scope)

- Custom `renderResult` cards, persistent status widgets, interactive child selection, live token streaming, LLM-generated wait summaries, and bounded child-session search.
