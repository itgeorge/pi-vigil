# Optional follow-ups

This is a parking lot for deliberately deferred Vigil work. Items here are **not approved implementation scope** and should be selected, designed, and tested as separate slices when dogfooding demonstrates a need.

## Current baseline

The current workflow supports detached direct children; `poll`; resumable `send`; bounded `wait`, including one exact direct-child target; bounded cursor-paginated `list`; retained sessions; guarded parent completion; shallow direct-subagent visibility; and bounded literal `search`/entry `read` diagnostics.

Relevant milestones:

- Slice 5 diagnostics: `dfc5ed3` through `00e9440`
- Slice 6 shallow visibility/guarded completion: `4016841`, `48376a6`, `763b36a`, `cf5bf6d`
- Targeted single-child wait: `582b9a9`, `c3b2979`
- Compact mutation content / expandable details: `9d8428a`, `5592b14`, `4720ed2`
- Cursor-paginated list: `025441d`; live pagination/targeted-wait coverage: `cf7b101`

---

## Faux harness (Slice F / O)

Test-only `vigil-faux` scripted provider for deterministic acceptance without `PI_VIGIL_LIVE`. Run `npm run test:faux`.

- Slice N nesting-policy deny/allow e2e (`test/faux-acceptance/vigil-nesting-faux.test.ts`) reuses this harness with `loadLocalVigil: true` (`-ne` + dual `-e` for workspace Vigil + faux).
- Slice O mechanistic release smoke (`test/faux-acceptance/vigil-orchestration-faux.test.ts`): real detached Pi parent, staggered faux children, targeted waits, completes, parent-ledger asserts — no LLM auth, no TUI.

**Deferred:** live self-test skill for TUI wait partials (Aug 9-style manual smoke); see Slice O plan follow-ups.

---

## 1. Explicit multi-child `waitAll`

**Why:** Targeted `wait({ id })` avoids unrelated siblings settling a wait. Coordinating several selected children is still awkward when the caller needs every selected child to become quiescent.

**Possible shape:**

```ts
vigil({
  action: "waitAll",
  ids: ["vigil-a", "vigil-b"],
  timeoutMs?,
})
```

**Required semantics to design before implementation:**

- `ids` are nonempty, unique, exact direct-child IDs from the current parent ledger.
- Fixed selected cohort; settle only when **every** selected child is `waiting` or `completed`.
- Define completed-at-start behavior, unknown/excluded-ID errors, timeout/cancellation output, result ordering, and progress representation.
- `waiting` means a child is quiescent/resumable after its current turn, not permanently finished.

**Boundary:** Do not overload `wait` with an ambiguous `ids` plus `any|all` mode. `waitAll` should be a separately named synchronization primitive.

**Reference:** Targeted wait design/implementation in `src/vigil/node-runtime.ts`, `src/vigil/types.ts`, and commits `582b9a9`, `c3b2979`.

---

## 2. Explicit descendant/subtree cancellation

**Why:** A parent can currently see known incomplete direct descendants and choose guarded-completion override, but it cannot cancel them.

**Example future capability:**

```ts
// Illustrative only — no approved API.
vigil({ action: "cancelDescendants", id: "vigil-parent" })
```

**Design prerequisites:** ownership across independently retained intermediate sessions; canonical ledger authorization; child-session writes; process/PID reuse safety; auditing; failure/partial-cancellation semantics; and likely process-group considerations.

**Boundary:** `allowIncompleteSubagents: true` must continue to complete only the requested parent and never silently kill descendants. No recursive termination exists today.

**Reference:** Guarded completion/one-level inspection in `src/vigil/descendant-inspector.ts` and `src/vigil/node-runtime.ts`; commits `48376a6`, `763b36a`.

---

## 3. Recursive hierarchy browsing or supervision

**Why:** Slice 6 intentionally displays only root grandchildren—each session owns only its own direct-child ledger.

**Possible future direction:** explicit depth-limited tree browsing, perhaps a separate read-only action with a strict depth/item budget.

**Questions to resolve first:** traversal authorization across session-local ledgers; partial/unavailable branch representation; stable hierarchy identities; output/context caps; traversal ordering; and whether a tree viewer implies supervision responsibilities.

**Boundary:** No automatic recursive discovery, watcher, registry, tree UI, or recursive completion/cancellation should be added incidentally.

**Reference:** `MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS` and the one-level inspector in `src/vigil/descendant-inspector.ts`; Slice 6 commits above.

---

## 4. Fuzzy or semantic diagnostics search

**Why:** Current `search` is intentionally deterministic case-insensitive literal substring matching.

**Possible future shape:**

```ts
// Illustrative only.
vigil({ action: "search", query: "why did validation fail?", mode: "semantic" })
```

**Questions to resolve first:** ranking/result reproducibility, embeddings/model and cost policy, privacy of child transcript content, indexes versus fresh reads, cancellation/usage accounting, and how semantic results link into exact `read` anchors.

**Boundary:** Do not make literal `search` fuzzy by default or add hidden provider/model calls.

**Reference:** `src/vigil/transcript.ts`; Slice 5 commits above.

---

## 5. Optional LLM-generated progress summaries

**Why:** Current wait progress uses deterministic persisted facts and recent-message previews, which are cheap and auditable but not synthesized summaries.

**Possible future direction:** explicitly opt-in, ephemeral summaries for a wait progress panel.

**Requirements:** a clear opt-in parameter; rate limit; strict bounded input; cancellation; usage/cost reporting; no parent/child session mutation; no token streaming requirement; deterministic factual fallback; and an explanation of what may be sent to the summary model.

**Boundary:** Do not replace persisted factual wait progress with opaque summaries by default.

**Reference:** `src/vigil/wait-progress.ts`, `src/vigil/session-text.ts`; commits `17f71e1`, `88d1103`, `9076eed`, `d533dfc`.

---

## 6. Pagination consistency or richer list navigation

**Why:** `list({ maxResults?, skipToId? })` is deliberately a fresh observational scan per page. A ledger mutation between pages can change the surrounding page boundary.

**Potential directions:** an opaque snapshot cursor, a caller-visible generation/version marker, bidirectional navigation, or a deliberately bounded completed-history view.

**Boundary:** Do not imply transactional consistency that the append-only session ledger cannot provide. The current inclusive `skipToId` is intentionally simple and directly reusable from `nextSkipToId`.

**Reference:** `src/vigil/types.ts` (`ListInput`, `VigilListResult`) and `src/vigil/node-runtime.ts`; commits `025441d`, `cf7b101`.

---

## 7. Broader output-budget policy

**Why:** Mutation content and `list` pages are now bounded/compact, but `poll`, settled unscoped `wait`, `search`, and `read` intentionally provide progressively richer observation/diagnostic output.

**Potential work:** measure real orchestration-context use and, only if needed, design explicit detail/limit controls for an observation action.

**Boundary:** Preserve the useful distinction: mutation acknowledgements are compact; `poll` and settled `wait` are explicit latest-response observation paths; `read` is the explicit bounded deep diagnostic path. Do not silently truncate an observation result without an indication or a recovery path.

**Reference:** `src/vigil/types.ts`, `src/vigil/transcript.ts`, `src/vigil/wait-progress.ts`; compact mutation commits `9d8428a`, `5592b14`.

---

## 8. Interactive result-card refinements

**Why:** The custom result renderer currently supplies compact mutation receipts plus bounded expandable launch/send prompts and completion latest-response detail.

**Potential work:** accessibility/keyboard usability review, copy affordances, richer but bounded result cards, or controlled presentation of unavailable shallow-inspection reasons.

**Boundary:** Renderer work must remain visual only: no session/process I/O, no mutation, no raw unbounded transcript display, and no change to provider-facing `content` merely to improve TUI presentation.

**Reference:** `src/vigil/render-result.ts`, `src/vigil/render-call.ts`; commits `9d8428a`, `4720ed2`.
