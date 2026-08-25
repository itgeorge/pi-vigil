# Slice N — Subagent nesting policy (allowSubagents)

## How agents should use this plan

Read this entire plan before changing code. Also skim Slice F (`.plans/slice-f-vigil-faux-harness-plan.md`) — this slice **reuses** the `vigil-faux` harness for e2e.

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

1. **Policy:** first valid `vigil-policy` entry wins (append-only); skip malformed while searching; ignore later entries. (“Any false” in older wording was informal.)
2. **Launch record:** `allowSubagents?: boolean` — omit when nesting allowed; set `false` when deny stamped. Launch-record enough for v1; `send` reads lifecycle launch / `runtimeRecord` — prefer smaller of copy-flag-onto-turn-records vs always consult launch record.
3. **Gate error (exact, lock for tests):** `Vigil nested launch is disabled for this session. Launch with allowSubagents: true from the parent if nesting is intended.`
4. **Faux child load:** prefer always `-ne` + `-e <repo>/src/index.ts` + `-e <faux>` via Slice N–oriented option (`loadLocalVigil: true` / factory); don’t silently change smoke without updating expectations.
5. **Allow e2e (v1):** Option A — nested launch ok + grandchild visible on child ledger / parent `list.directSubagents`; grandchild need not settle under faux. Bootstrap fail ≠ allow-failure if launch accepted + ledger entry; prefer model that won’t fail-fast if easy; else assert child tool result + `vigil-launch` via search/read. Record observation in Phase 4 notes.
6. **Primary asserts:** deny → gate text in child tool result / `latestResponse`; parent list → that child’s `directSubagents` empty/0. Allow → prefer shallow `directSubagents` grandchild; search/read secondary.
7. **Ephemeral:** unit deny (flag-only) yes; faux e2e no.
8. **Human `--vigil-no-subagents` on root:** intentional; same stamp + gate.

---

## Problem statement

Today every Vigil-capable Pi session may `vigil({ action: "launch", ... })`, including sessions that were themselves launched as Vigil children. Nested orchestration is useful, but accidental deep nesting is easy and hard to supervise.

Desired product rule (confirmed):

| Context | Effective policy |
|---------|------------------|
| Session with **no** `vigil-policy` entry (normal interactive / non-Vigil-spawned) | **allow** |
| Vigil-spawned child when `allowSubagents` omitted/false | **deny** by default |
| Vigil-spawned child when `allowSubagents: true` | **allow** |

Session storage remains the source of truth. Do **not** pre-create child JSONL from the parent. Instead: pass a CLI flag on spawn; child Vigil on `session_start` stamps a durable session custom entry; launch gating reads that policy (flag as bootstrap fallback).

## End goal

1. `launch` accepts optional `allowSubagents?: boolean` (default **false for the spawn path’s deny stamp**; absence of policy in a session still means allow).
2. Register extension flag `vigil-no-subagents` (`type: "boolean"`).
3. When launching a **persisted** child without `allowSubagents: true`, append `--vigil-no-subagents` to the child Pi argv.
4. On child `session_start`: if flag is set and no policy entry yet → `appendEntry("vigil-policy", { allowSubagents: false })`.
5. Gate `action: "launch"` when effective policy is deny; return a clear controlled error.
6. Ephemeral children: flag-only (no session persistence); same launch gate using flag/process policy.
7. Two faux-acceptance e2e tests (no real LLM):
   - default deny: child attempts nested `vigil launch` → rejected; no grandchild in parent shallow view / error visible in child transcript
   - explicit allow: child nested launch succeeds; grandchild appears

## Public contract (target)

### Launch parameter

```ts
vigil({
  action: "launch",
  name,
  message,
  allowSubagents?: boolean, // default false → stamp deny on spawned child
  // ...existing fields
})
```

Semantics:

- `allowSubagents: true` → do **not** pass `--vigil-no-subagents`; do not write deny policy (absence remains allow).
- `allowSubagents: false` / omitted → pass `--vigil-no-subagents`; child stamps `{ allowSubagents: false }`.

Interactive root sessions never receive the flag unless a human passes it; absence of `vigil-policy` ⇒ allow.

### Session custom entry

```ts
// customType: "vigil-policy"
interface VigilPolicyRecord {
  allowSubagents: boolean;
}
```

Append-only; **first valid entry wins** for v1 (do not rewrite; ignore subsequent policy entries). Skip malformed entries while searching for the first valid one. Effective deny only when that first valid record has `allowSubagents: false`; otherwise allow (including no valid policy).

### CLI flag

```ts
pi.registerFlag("vigil-no-subagents", {
  description: "Deny Vigil nested launch in this session (stamped into vigil-policy on session_start)",
  type: "boolean",
  default: false,
});
```

Presence sets true (Pi boolean flag semantics).

### Launch gate error (locked copy for unit + faux)

```text
Vigil nested launch is disabled for this session. Launch with allowSubagents: true from the parent if nesting is intended.
```

No separate error code required for v1 unless it falls out naturally.

### `send` / resume

Re-pass `--vigil-no-subagents` on `send` respawn when the child’s lifecycle/policy implies deny **or** always re-read child session policy before spawn. Prefer: if parent stamped deny at launch, also record `allowSubagents?: false` on `vigil-launch` / turn records **or** re-read child JSONL policy before `send`. Simplest v1: persist `allowSubagents?: false` on the parent `VigilLaunchRecord` when deny was requested, and have `send` re-append the CLI flag from that record. Opt-in allow omits the field/flag.

### Non-goals

- Depth budgets / max nesting levels (binary only).
- Pre-creating child session files from the parent.
- Killing / completing descendants when deny is set.
- Changing Slice 6 `allowIncompleteSubagents` completion override semantics.
- Shipping faux harness in npm package (already test-only).

---

## Design details

### Effective policy resolution (child process)

```text
1. Scan session entries in order for customType "vigil-policy" with valid boolean allowSubagents.
   Skip malformed. First valid entry wins:
   - allowSubagents === false → DENY
   - allowSubagents === true → ALLOW
   Ignore any later vigil-policy entries.
2. Else if getFlag("vigil-no-subagents") === true → DENY (and session_start should stamp)
3. Else → ALLOW
```

### `session_start` handler

Extend existing handler in `src/index.ts`:

- Register flag once at extension load.
- On `session_start`: if flag and no existing valid policy entry → `appendEntry("vigil-policy", { allowSubagents: false })`.

### Spawn argv

Extend `buildPiChildArgs` / `SpawnChildInput` with optional `extraArgs` **or** dedicated `noSubagents?: boolean` that inserts `--vigil-no-subagents` before the message (same splice style as faux `--extension`). Prefer a named field on `SpawnChildInput` over open-ended extraArgs for clarity.

Ephemeral observer spawn path must pass the same flag.

### Faux e2e (reuse Slice F)

Child script steps:

1. Match a marker → `toolCall` `vigil` `{ action: "launch", name, message, model: "vigil-faux/scripted", ... }`  
2. After tool result → text summarizing success/error (second step / reusable handling as needed so the turn settles).

Parent:

- Default-deny launch (`allowSubagents` omitted) → wait for child → assert nested launch error in child transcript (`search`/`read` or `latestResponse`) and `list` shows no incomplete grandchild under the child (or `directSubagents` none / unavailable appropriately).
- Allow launch (`allowSubagents: true`) → assert grandchild appears via child’s ledger / parent `list` shallow `directSubagents`.

**Child must load Vigil.** Today faux runner only injects the faux extension. Extend the faux process runner (or a Slice N test wrapper) to also pass `--extension <repo>/src/index.ts` **or** rely on installed `npm:pi-vigil` — prefer **explicit local** `-e` to workspace `src/index.ts` for testing unreleased policy code. Avoid double-registration: use `-ne` + `-e local-vigil` + `-e faux` if needed; record chosen approach in progress notes.

Grandchild model: same `vigil-faux/scripted` with a trivial text step so it settles.

---

## Phase 0 — Red: policy resolution + launch gate unit tests

- [x] Add unit tests for pure policy helpers (new module e.g. `src/vigil/nesting-policy.ts`):
  - no entries + no flag → allow
  - valid deny entry → deny
  - flag only → deny
  - malformed entries ignored → allow
- [x] Add failing service/adapter tests: `launch` rejected when deny policy active (inject policy reader / flag).
- [x] Record exact red failures in Progress notes.

### Progress notes — Phase 0

**2026-08-25 — RED evidence** (`npm run test:unit -- test/unit/vigil/nesting-policy.test.ts test/unit/vigil/nesting-launch-gate.test.ts`)

1. **`test/unit/vigil/nesting-policy.test.ts`** — suite fails to load:
   - `Error: Cannot find module '../../../src/vigil/nesting-policy'` (module not created yet; 5 tests not collected)

2. **`VigilService nested launch gate > rejects persisted launch when session has a deny policy entry`**
   - `AssertionError: expected false to be true` at `expect(isVigilError(result)).toBe(true)` — launch returns success snapshot instead of gate error; bootstrap observer starts.

3. **`VigilService nested launch gate > rejects ephemeral launch when the no-subagents flag is active`**
   - `AssertionError: expected false to be true` at `expect(isVigilError(result)).toBe(true)` — ephemeral launch succeeds; observer `started` has length 1.

4. **`vigil extension adapter nested launch gate > rejects launch when deny policy is stamped in the session`**
   - `AssertionError: expected undefined to be true` at `expect((result as { isError?: boolean }).isError).toBe(true)` — adapter returns success; `spawnDetached` is called.

**Test files added:** `test/unit/vigil/nesting-policy.test.ts`, `test/unit/vigil/nesting-launch-gate.test.ts`

**Planned injection points (for Phase 1):** `resolveNestedLaunchAllowed({ entries, noSubagentsFlag })` in new `src/vigil/nesting-policy.ts`; `VigilServiceDeps.getNoSubagentsFlag?: () => boolean`; gate in `VigilService.launch` before spawn; `createVigilServiceForContext` reads `sessionManager.getEntries()` for policy.

---

## Phase 1 — Green: policy module + gate

- [x] Implement `nesting-policy.ts` (parse entries, resolve effective allow, format error).
- [x] Wire gate into `VigilService.launch` (and ephemeral launch path) before spawn.
- [x] Green Phase 0 tests; `src/index` / adapter schema still incomplete until later phases if needed — service-level gate first.
- [x] Record green evidence.

### Progress notes — Phase 1

**2026-08-25 — GREEN evidence** (`npm run test:unit -- test/unit/vigil/nesting-policy.test.ts test/unit/vigil/nesting-launch-gate.test.ts`; `npm run typecheck`)

- `nesting-policy.test.ts`: 9/9 passed (Phase 0 cases + supervisor feedback: first-valid-wins deny/allow, allow beats flag, malformed-then-deny).
- `nesting-launch-gate.test.ts`: 3/3 passed — persisted deny policy, ephemeral `getNoSubagentsFlag`, adapter deny via session `vigil-policy` entry.

**Implementation:** `src/vigil/nesting-policy.ts` (`resolveNestedLaunchAllowed`, `formatNestedLaunchDisabledError`, `NESTED_LAUNCH_DISABLED_ERROR`). Gate in `VigilService.launch` after name/message validation, before spawn. `VigilServiceDeps.getSessionEntries` / `getNoSubagentsFlag`; `createVigilServiceForContext` wires `sessionManager.getEntries()`; extension captures `pi.getFlag` at registration for flag fallback (Phase 2 will register the flag).

---

## Phase 2 — Flag registration + session_start stamp

- [x] Failing tests for: flag registration surface (harness mock), session_start appends `vigil-policy` when flag set and no prior entry; idempotent when entry exists.
- [x] `registerFlag("vigil-no-subagents", …)` in `registerVigilExtension`.
- [x] Extend `session_start` to stamp deny policy from flag.
- [x] Ensure harness `createVigilTestHarness` can simulate `getFlag` / `registerFlag` if needed for unit tests.
- [x] Green tests; record evidence.

### Progress notes — Phase 2

**2026-08-25 — RED evidence** (`npm run test:unit -- test/unit/vigil/nesting-session-start.test.ts`)

1. **`registers the vigil-no-subagents flag as a boolean with default false`** — `AssertionError: expected undefined to deeply equal ArrayContaining{…}` (`harness.registeredFlags` undefined; flag not registered yet).
2. **`appends a deny vigil-policy entry on session_start when the flag is set and no valid policy exists`** — `AssertionError: expected [] to deep equally contain { customType: 'vigil-policy', data: { allowSubagents: false } }`.
3. **`does not append vigil-policy on session_start when only malformed policy entries exist`** — same empty `capturedEntries` assertion (stamp not implemented).
4. **`does not append vigil-policy on session_start when a valid policy entry already exists`** — passed vacuously (no stamp attempted).

**2026-08-25 — GREEN evidence** (`npm run test:unit -- test/unit/vigil/nesting-session-start.test.ts test/unit/vigil/nesting-policy.test.ts test/unit/vigil/nesting-launch-gate.test.ts`; `npm run typecheck`; full `npm run test:unit` 411/411)

- `nesting-session-start.test.ts`: 4/4 passed — flag registration surface, deny stamp on `session_start`, idempotent when valid policy exists, stamp after malformed-only entries.
- Harness: `registeredFlags`, `setFlag`, `noSubagentsFlag`, `skipSessionStart` options; mock `registerFlag` / `getFlag` on synthetic `ExtensionAPI`.
- `findFirstValidVigilPolicyAllowSubagents` exported from `nesting-policy.ts` and reused in `session_start` stamp guard + `resolveNestedLaunchAllowed`.
- `registerVigilExtension`: `pi.registerFlag("vigil-no-subagents", { type: "boolean", default: false, … })`; `session_start` appends `vigil-policy` `{ allowSubagents: false }` when flag set and no valid policy entry.

---

## Phase 3 — Spawn wiring + launch schema `allowSubagents`

- [x] Extend tool schema + `LaunchInput` with `allowSubagents?: boolean`.
- [x] When launching persisted/ephemeral child and `allowSubagents !== true`, pass `--vigil-no-subagents` via `SpawnChildInput`.
- [x] Persist enough on `VigilLaunchRecord` for `send` to re-apply the flag (e.g. `allowSubagents?: false` or `noSubagents?: true`).
- [x] `send` respawn re-applies flag when recorded.
- [x] Compact call rendering: show a bounded indicator when `allowSubagents: true` (and optionally when explicitly false — prefer only show opt-in).
- [x] Unit tests for argv building and schema/adapter dispatch.
- [x] README public API blurb for `allowSubagents`.
- [x] Record evidence.

### Progress notes — Phase 3

**2026-08-25 — GREEN evidence** (`npm run test:unit -- test/unit/vigil/cli-boundary.test.ts test/unit/vigil/nesting-spawn-wiring.test.ts test/unit/vigil/nesting-session-start.test.ts`; `npm run typecheck`)

- `buildPiChildArgs` / `buildPiEphemeralChildArgs` insert `--vigil-no-subagents` when `noSubagents: true`.
- `VigilService.launch` wires `noSubagents` for persisted + ephemeral paths; default launch records `allowSubagents: false`; opt-in allow omits field/flag.
- `VigilService.send` re-reads lifecycle launch policy and re-applies `noSubagents` on respawn.
- Tool schema + adapter dispatch `allowSubagents`; compact launch render shows `allow subagents` only when true.
- Renamed malformed-policy session_start test to reflect deny stamp after malformed entries.
- README documents `allowSubagents` default deny + send re-apply behavior.

---

## Phase 4 — Faux e2e deny + allow

- [x] Extend faux process runner / test helper to load **local Vigil** + faux extension into children (document `-ne` vs double-load choice).
- [x] Faux script support already has `toolCall`; add acceptance tests under `test/faux-acceptance/`:
  1. **default deny nesting**
  2. **allowSubagents: true nesting**
- [x] Prove red then green with `npm run test:faux` (may add a second file or cases in existing project).
- [x] Keep independent of `PI_VIGIL_LIVE`.
- [x] Record evidence; note any grandchild observation method used (`list.directSubagents`, child `search`, etc.).

### Progress notes — Phase 4

**2026-08-25 — RED evidence** (before `loadLocalVigil` + nesting faux tests; `npx vitest run --project faux-acceptance test/faux-acceptance/vigil-nesting-faux.test.ts`)

1. **`rejects nested launch by default…`** — would fail: module / harness missing `loadLocalVigil`; child Pi process would not load workspace `src/index.ts`, so scripted `vigil` toolCall never runs (no gate / no transcript match).
2. **`allows nested launch when allowSubagents is true…`** — same; without `-ne -e <repo>/src/index.ts -e <faux>` on spawn and `PI_VIGIL_FAUX_BOOTSTRAP_RUNNER=1` in descendants, nested grandchild spawn would not inject faux extensions.

**Harness choice (documented):** use **`-ne -e <repo>/src/index.ts -e <faux>`** via `createVigilFauxProcessRunner({ loadLocalVigil: true })` so auto-discovered `pi-vigil` is not double-registered alongside the explicit workspace extension. Default faux-only spawn keeps `--extension <faux>` for unit arg tests; acceptance tests (smoke + nesting) opt into `loadLocalVigil: true` because a real child agent shell is required. Nested spawns from a loaded child re-use the same runner via `PI_VIGIL_FAUX_BOOTSTRAP_RUNNER=1` handled in `test/helpers/vigil-faux/extension.ts`.

**2026-08-25 — GREEN evidence** (`npm run test:faux`; `npm run test:unit -- test/unit/vigil-faux/process-runner.test.ts`; `npm run typecheck`)

- `test/faux-acceptance/vigil-nesting-faux.test.ts`: 2/2 passed.
  - **Deny:** child scripted `vigil launch` rejected; parent `search` finds locked gate text in child transcript; parent `list` shows `directSubagents` `{ inspection: "available", total: 0, incomplete: 0 }`; child `latestResponse` contains settle text.
  - **Allow:** parent launch with `allowSubagents: true`; child nested launch accepted; parent `list.directSubagents` shows grandchild by name (`total: 1`, `incomplete: 1`); primary observation via shallow list (search/read not required).
- `test/faux-acceptance/vigil-faux-smoke.test.ts`: 2/2 passed after aligning smoke spawn with `loadLocalVigil: true` + explicit `sessionDir` override (same `-ne` dual `-e` approach; avoids extension-discovery conflicts in this repo).
- `test/unit/vigil-faux/process-runner.test.ts`: 9/9 passed — includes `getLocalVigilExtensionPath` and `-ne` dual `-e` splice coverage.

**Implemented:**
- `test/helpers/vigil-faux/process-runner.ts` — `getLocalVigilExtensionPath`, `loadLocalVigil` option, updated `insertVigilFauxExtensionArgs` options object.
- `test/helpers/vigil-faux/extension.ts` — when `PI_VIGIL_FAUX_BOOTSTRAP_RUNNER=1`, sets `createVigilFauxProcessRunner({ loadLocalVigil: true })` for descendant spawns.
- `test/faux-acceptance/vigil-nesting-faux.test.ts` — deny + allow faux e2e cases.

---

## Phase 5 — Close-out

- [ ] `npm run typecheck`, `npm test` (modulo known unrelated failures), `npm run pack:verify`, `npm run test:faux`.
- [ ] Update optional-followups / Slice F follow-up checkboxes for completed nesting e2e items.
- [ ] Progress log: Slice N complete.

### Progress notes — Phase 5

_(implementer fills)_

---

## Follow-ups (out of scope)

- [ ] Depth-limited nesting budgets.
- [ ] Explicit allow policy entry audit trail (`{ allowSubagents: true }` stamp).
- [ ] Interactive TUI indicator of current session nesting policy.

---

## Progress log

- 2026-08-25: Plan drafted after Slice F completion. Binary policy; default deny for Vigil-spawned children via `--vigil-no-subagents` + `vigil-policy` session stamp; absence ⇒ allow; faux e2e for deny/allow. Implementation gated on user approval.
