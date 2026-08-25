# Slice O — Faux-parent orchestration e2e (release smoke, minus LLM / TUI)

## How agents should use this plan

Read this entire plan before changing code. Also skim Slice F (`.plans/slice-f-vigil-faux-harness-plan.md`) and the nesting faux e2e notes in Slice N Phase 4 — this slice **extends** the faux harness and reuses `-ne` + dual `-e` (local Vigil + faux).

Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work strictly in **red → green → refactor** order:

1. Add the smallest focused failing test for the current item.
2. Run the test and **record the exact red failure** in this file (test name + assertion/message).
3. Implement only the code required to turn it green.
4. Re-run the focused test and the nearest related suite; record green evidence.
5. Refactor only when green; keep diffs minimal and scoped.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, and commit plan checkbox updates with the corresponding code/tests.

**Scope:** this repository only. Do not modify Pi upstream packages.

**Do not begin implementation until the user explicitly approves proceeding after plan review.**

### Resolved decisions (parent / design discussion)

1. **Shape:** real detached **Pi parent** process loading checkout Vigil + faux (`-ne` + `-e <repo>/src/index.ts` + `-e <faux>`), model `vigil-faux/scripted`, one-shot `-p` prompt — not in-process harness-as-parent.
2. **ID binding:** `$launch[N].id` placeholders in `toolCall.arguments` (0-based, fill order = successful vigil launch tool results seen in context). No by-name captures in v1.
3. **Stagger:** `delayMs` on the **step** (sibling of `when` / `then`); used on child reply steps so Fast/Slow settle at different times.
4. **Wait:** parent script issues **two unscoped** `vigil({ action: "wait", timeoutMs })` calls (no `id`).
5. **List:** include final `list` with `includeCompleted: true` (cheap; Aug 9 parity).
6. **Assert:** **parent session ledger only** (launches, completes, id consistency). No child-transcript assertions in v1. Nesting / allowSubagents out of scope (v2).
7. **TUI / live wait partials:** out of scope (future self-test skill).
8. **Shared script:** one `PI_VIGIL_FAUX_SCRIPT` inherited by parent and children; distinguish roles via different `userTextIncludes` markers.
9. **Teardown:** known parent `--session-id` + tracked child PIDs from parent `vigil-launch` entries (placeholders also make complete deterministic for cleanup).

---

## Problem statement

Release confidence today splits across:

- unit / faux child smoke / nesting faux e2e (mechanistic, no LLM), and
- a manual live-agent wait smoke (Aug 9: paste prompt into Pi; TUI checks).

We want a **deterministic, CI-friendly** stand-in for the *mechanistic* half of that smoke: a real Pi parent, using the faux model, that launches staggered faux children, waits, completes, lists — then Vitest asserts the parent ledger. No real LLM auth; no TUI assertions.

## End goal

1. Extend faux script/matcher:
   - optional `delayMs?: number` on each step (sleep before emitting the matched response);
   - substitute `$launch[N].id` in tool-call argument trees from prior vigil launch tool results in context.
2. Helper to spawn a **detached one-shot Pi parent** with local Vigil + faux + env (script path, session dir, bootstrap runner as needed for children).
3. New `test/faux-acceptance/` case (orchestration smoke):
   - parent script: launch Fast, launch Slow, wait, wait, complete `$launch[0].id`, complete `$launch[1].id`, list `includeCompleted: true`, final text;
   - child steps: marker-specific `delayMs` + marker text replies;
   - after parent exits: assert parent JSONL ledger.
4. Document in faux README; keep `npm run test:faux` as the runner (no new npm script required unless useful).
5. Non-goals: TUI, nesting, live LLM skill, child JSONL deep asserts.

## Public / test-only contract

### Step shape (additive)

```ts
type VigilFauxStep = {
  when: { userTextIncludes: string };
  then: VigilFauxStepThen;
  reusable?: boolean;
  delayMs?: number; // optional; sleep before response; integer >= 0
};
```

### Placeholder (v1)

- Only `$launch[N].id` where `N` is a decimal integer `>= 0`.
- Resolution: scan conversation context for `vigil` tool results that correspond to successful launches (prefer structured `details.id` when present; else parse `id: vigil-…` from tool result text). Order = first-seen launch successes.
- Unresolved placeholder → controlled matcher/runtime error (fail the test loudly).
- Do not invent other placeholder kinds in v1.

### Parent spawn (test helper)

Something like `spawnVigilFauxParentPi({ sessionId, cwd, sessionDir, scriptPath, prompt, model?, timeoutMs? })` that runs:

```bash
pi -ne \
  -e <repo>/src/index.ts \
  -e <faux>/extension.ts \
  --mode json -p \
  --session-id <sessionId> \
  --name <optional> \
  --model vigil-faux/scripted \
  "<prompt>"
```

with env: `PI_VIGIL_FAUX_SCRIPT`, `PI_VIGIL_SESSION_DIR`, and `PI_VIGIL_FAUX_BOOTSTRAP_RUNNER=1` so child launches get the faux process runner + `loadLocalVigil`.

Wait for parent exit (timeout); return `{ exitCode, sessionPath }` (or equivalent). Best-effort terminate on timeout.

### Orchestration script sketch (fixture in test)

Markers (unique per test via UUID suffix):

- `ORCH_MARK` — parent user prompt / parent steps
- `FAST_MARK` — Fast child message / reply
- `SLOW_MARK` — Slow child message / reply

Parent steps (all `when.userTextIncludes: ORCH_MARK`, one-shot order):

1. `toolCall` vigil launch name `Orch Fast`, message includes `FAST_MARK`, model faux
2. `toolCall` vigil launch name `Orch Slow`, message includes `SLOW_MARK`, model faux
3. `toolCall` vigil `wait` `{ timeoutMs: 120000 }` (unscoped)
4. `toolCall` vigil `wait` `{ timeoutMs: 120000 }` (unscoped)
5. `toolCall` vigil `complete` `{ id: "$launch[0].id" }`
6. `toolCall` vigil `complete` `{ id: "$launch[1].id" }`
7. `toolCall` vigil `list` `{ includeCompleted: true }`
8. `text` `"orchestration smoke done"`

Child steps:

- Fast: `delayMs` short (e.g. 200–500), then `text: FAST_MARK` (or `fast-ok` + marker)
- Slow: `delayMs` longer (e.g. 1500–2500), then text with `SLOW_MARK`

Choose delays so both finish under wait timeouts but Slow is clearly later than Fast (first unscoped wait can settle one; second settles the other).

### Parent ledger asserts (minimum)

After parent exit code 0:

- Exactly two `vigil-launch` entries for this parent session with names `Orch Fast` / `Orch Slow` (or the names chosen in the test).
- Exactly two `vigil-complete` entries whose `id`s match the two launch ids (order may follow complete order = `$launch[0]` then `$launch[1]`).
- Optional: at least one wait tool path exercised (if wait leaves no custom entry, do not require a custom type — rely on completes implying waits succeeded, or parse assistant/tool messages if cheap). Prefer **custom entries only** when sufficient: launches + completes with matching ids is the bar.
- Final assistant text / tool trail need not be asserted beyond ledger if ledger is solid.

Teardown: kill any still-alive PIDs from launch records; rm temp dirs.

---

## Design details

### Placeholder substitution

Implement pure helper e.g. `substituteLaunchPlaceholders(value, launchIds: string[]): unknown` used when building `toolCall` / `textAndToolCall` arguments. Walk objects/arrays/strings; replace exact string matches or substrings? **Prefer whole-string equality** on string values: only replace when the string is exactly `$launch[N].id` (avoid partial corruption). Document that.

Capture `launchIds` in matcher from context each `match()` call (recompute from full message list, don’t trust stale state across processes — in-process matcher state is fine for one Pi process).

### `delayMs`

In matcher `match()`: after selecting a step, if `delayMs > 0`, sleep (sync or async — faux core may be sync; use Atomics.wait / busy-safe sleep or make factory async if `createFauxCore` allows async factories — **follow existing faux extension async factory pattern** already used in `extension.ts`). Cap delayMs in parse validation (e.g. max 60_000) to avoid hung tests.

### Bootstrap runner

Parent must set `PI_VIGIL_FAUX_BOOTSTRAP_RUNNER=1` so when parent Vigil launches children, child’s faux extension installs `createVigilFauxProcessRunner({ loadLocalVigil: true })` (already in Slice N). Parent spawn itself is the test helper’s argv, not Vigil’s process runner.

### Interaction with existing tests

- Do not break smoke / nesting faux tests.
- Unit-test placeholder + delayMs in `test/unit/vigil-faux/` without spawning Pi when possible.
- Orchestration e2e goes under `test/faux-acceptance/` and `npm run test:faux`.

---

## Phase 0 — Red: placeholder + delayMs unit tests

- [x] Failing unit tests for `substituteLaunchPlaceholders` / capture-from-context (or matcher integration):
  - exact `$launch[0].id` → first id
  - `$launch[1].id` → second id
  - unresolved index throws controlled error
  - non-placeholder strings unchanged
- [x] Failing unit tests for `delayMs` on step: matched step delays before response (mock clock or assert elapsed ≥ delay).
- [x] Record red evidence in Progress notes.

### Progress notes — Phase 0

**Command:** `npx vitest run --project unit test/unit/vigil-faux/launch-placeholders.test.ts test/unit/vigil-faux/script-matcher.test.ts`

**Result:** 2 files, 8 tests failed | 9 passed (17).

**Stubs added (no real placeholder/delay logic):**
- `test/helpers/vigil-faux/placeholders.ts` — `VigilFauxPlaceholderError`, passthrough `substituteLaunchPlaceholders`, empty `extractLaunchIdsFromContext`
- `test/unit/vigil-faux/launch-placeholders.test.ts` — placeholder + capture + matcher integration tests
- `test/unit/vigil-faux/script-matcher.test.ts` — `delayMs` elapsed-time test

**Exact red failures:**

1. `substituteLaunchPlaceholders > substitutes exact $launch[0].id with the first launch id` — `AssertionError: expected { id: '$launch[0].id' } to deeply equal { id: 'vigil-11111111-1111-1111-1111-111111111111' }`
2. `substituteLaunchPlaceholders > substitutes exact $launch[1].id with the second launch id` — `AssertionError: expected { id: '$launch[1].id' } to deeply equal { id: 'vigil-22222222-2222-2222-2222-222222222222' }`
3. `substituteLaunchPlaceholders > throws a controlled error when the launch index is unresolved` — `AssertionError: expected function to throw an error, but it didn't`
4. `extractLaunchIdsFromContext > captures successful vigil launch ids in first-seen order` — `AssertionError: expected [] to deeply equal [LAUNCH_ID_0, LAUNCH_ID_1]`
5. `createScriptMatcher launch placeholders > substitutes $launch[0].id in toolCall arguments from context` — `AssertionError: expected { action: 'complete', id: '$launch[0].id' } to deeply equal { action: 'complete', id: LAUNCH_ID_0 }`
6. `createScriptMatcher launch placeholders > substitutes $launch[1].id in toolCall arguments from context` — `AssertionError: expected { action: 'complete', id: '$launch[1].id' } to deeply equal { action: 'complete', id: LAUNCH_ID_1 }`
7. `createScriptMatcher launch placeholders > throws a controlled error when a placeholder index is unresolved in context` — `AssertionError: expected function to throw an error, but it didn't`
8. `createScriptMatcher > delays before emitting a matched step when delayMs is set on the step` — `AssertionError: expected 0.007083999999963453 to be greater than or equal to 65`

**Passing (baseline / non-placeholder unchanged):** `substituteLaunchPlaceholders > leaves non-placeholder strings unchanged` plus existing script-matcher tests.

---

## Phase 1 — Green: matcher/script support

- [ ] Extend `VigilFauxStep` + parse validation for optional `delayMs`.
- [ ] Implement placeholder substitution + launch-id capture from context.
- [ ] Wire into matcher response build for toolCall args.
- [ ] Green Phase 0 tests; update faux README briefly.
- [ ] Record green evidence.

### Progress notes — Phase 1

_(implementer fills)_

---

## Phase 2 — Red/green: parent spawn helper + orchestration e2e

- [ ] Add failing orchestration faux-acceptance test (parent Pi spawn + ledger asserts).
- [ ] Implement `spawnVigilFauxParentPi` (or equivalent) helper.
- [ ] Green with `npm run test:faux`; keep independent of `PI_VIGIL_LIVE`.
- [ ] Record evidence: how wait/complete ordering behaved; any timing knobs tuned.
- [ ] Teardown: temp dirs + child PIDs from parent launches.

### Progress notes — Phase 2

_(implementer fills)_

---

## Phase 3 — Close-out

- [ ] `npm run typecheck`, `npm test` (modulo known unrelated), `npm run test:faux`, `npm run pack:verify`.
- [ ] Note in `optional-followups.md` / Slice F residual: mechanistic release smoke via faux parent; live TUI skill still deferred.
- [ ] Progress log: Slice O complete.

### Progress notes — Phase 3

_(implementer fills)_

---

## Follow-ups (out of scope)

- [ ] Live self-test skill (TUI wait partials).
- [ ] Nested allow/deny inside orchestration smoke.
- [ ] Named launch captures (`$launch["Orch Fast"].id`).
- [ ] Child JSONL assertions / multi-wait progress fingerprints.

---

## Progress log

- 2026-08-25: Plan drafted after design discussion. Real Pi parent + faux; `$launch[N].id`; step `delayMs`; two unscoped waits; list includeCompleted; parent-ledger asserts only. Implementation gated on user approval.
