# Slice F — Vigil faux model harness (prerequisite)

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Work strictly in **red → green → refactor** order:

1. Add the smallest focused failing test for the current item.
2. Run the test and **record the exact red failure** in this file (test name + assertion/message).
3. Implement only the code required to turn it green.
4. Re-run the focused test and the nearest related suite; record green evidence.
5. Refactor only when green; keep diffs minimal and scoped.

Add newly discovered relevant TODOs beneath the active phase before continuing. Mark completed items `[x]`, and commit plan checkbox updates with the corresponding code/tests.

**Scope:** this repository only (`/Users/itgeorge/pi-vigil`). Do not modify Pi upstream packages.

**User approval (2026-08-25):** proceed with implementation. Orchestration uses `cursor/composer-2.5:high` as implementer; parent agent reviews after each phase, commits, then continues.

---

## Problem statement

Vigil acceptance today either:

- uses a **real LLM** behind `PI_VIGIL_LIVE=1` (slow, flaky, auth-gated), or
- uses **in-process fakes** that never exercise a real detached `pi` child with tool calls.

Upcoming nesting-policy work needs deterministic e2e proofs that a child session **attempts** `vigil({ action: "launch", ... })` without relying on an LLM. A reusable scripted model is the prerequisite.

## End goal

A **test-only** faux model harness, built on `@earendil-works/pi-ai`’s existing `faux` provider, that:

1. Can be loaded into a **detached child Pi process** via `--extension`.
2. Reads a **durable response script** (JSON file path via env).
3. On each model call, matches the latest user message text:
   - if a scripted step matches → emit the configured assistant content (text and/or `vigil` tool call);
   - otherwise → reply with exactly: `fake model: doesn't support this request`.
4. Supports **multi-step** queues (e.g. tool call, then after tool result, a final text reply) so turns settle cleanly.
5. Has unit coverage for matching/script parsing and an **acceptance-like smoke** that launches a real Vigil child with the faux model — **no** `PI_VIGIL_LIVE` and no real provider auth.

Production Vigil package surface (`files` / npm pack) must remain free of this harness.

## Design

### Build on pi-ai faux (do not invent a new stream protocol)

Use:

- `createFauxCore` / `fauxProvider` concepts from `@earendil-works/pi-ai`
- `fauxAssistantMessage`, `fauxToolCall`, `fauxText`
- Response factories that inspect `context`

Register into Pi via extension `pi.registerProvider(...)` with `streamSimple` from the faux core (custom `api` id is fine).

### Cross-process gap

In-process `setResponses([...])` does **not** reach Vigil-spawned children (separate processes). Therefore:

| Layer | Location | Role |
|-------|----------|------|
| Script format + matcher | `test/helpers/vigil-faux/` (pure TS) | Parse/validate script; choose response from context |
| Child extension | `test/helpers/vigil-faux/extension.ts` | On load: read script path from env, `registerProvider("vigil-faux", …)` |
| Parent test helpers | `test/helpers/vigil-faux/` | Write script file; resolve extension path; model id; wrap `ProcessRunner` to append `-e` + ensure model |
| Smoke tests | `test/acceptance/` or new vitest project | Real `launch` → `wait` with faux child |

### Script contract (v1)

Env var (child process):

```text
PI_VIGIL_FAUX_SCRIPT=/absolute/path/to/script.json
```

JSON shape:

```ts
interface VigilFauxScript {
  version: 1;
  /** Default when no step matches. Fixed product string unless overridden. */
  fallbackText?: string; // default: "fake model: doesn't support this request"
  steps: VigilFauxStep[];
}

type VigilFauxStep =
  | {
      when: { userTextIncludes: string };
      then:
        | { type: "text"; text: string }
        | {
            type: "toolCall";
            name: string; // e.g. "vigil"
            arguments: Record<string, unknown>;
          }
        | {
            type: "textAndToolCall";
            text?: string;
            name: string;
            arguments: Record<string, unknown>;
          };
      /** If true, step remains eligible after use (default false = consume once). */
      reusable?: boolean;
    };
```

Matching rules:

- Inspect the **latest user message** text in `context.messages` (concatenate text blocks; ignore images).
- Evaluate `steps` in order; first match whose `userTextIncludes` is a case-sensitive substring wins.
- Consumed one-shot steps are skipped on later calls.
- If nothing matches → fallback text with `stopReason: "stop"`.
- Tool-call steps use `stopReason: "toolUse"` (via faux helpers).

Provider/model ids:

```text
provider: vigil-faux
model id: scripted
CLI: --model vigil-faux/scripted
```

Auth: register with a dummy `apiKey` (literal) so Pi treats the model as available without real credentials.

### Child spawn wiring (test-only)

Do **not** change production `launch` schema in this slice.

Add a test helper that wraps `createNodeProcessRunner()` / `spawnDetachedPiChild` so child args include:

```text
--extension <absolute-path-to-test/helpers/vigil-faux/extension.ts>
```

and the launch uses `model: "vigil-faux/scripted"`.

Inject via existing `setVigilRuntimeOverrides({ processRunner })`.

Ensure the child also loads Vigil itself (global `npm:pi-vigil` or explicit `-e` to local `src/index.ts`). Prefer **explicit local** `-e <repo>/src/index.ts` in faux acceptance so tests exercise the workspace tree, and use `-ne` only if needed to avoid duplicate Vigil registration — record the chosen approach in progress notes after the first green smoke.

### Vitest layout

- Unit: `test/unit/vigil-faux/*.test.ts` under existing `unit` project (no live gate).
- Acceptance-like smoke: either
  - new vitest project `faux-acceptance` **without** `PI_VIGIL_LIVE` setup, or
  - tests under `test/acceptance/` that **skip** the live setup gate when tagged/faux-only.

Prefer a **separate project** `faux-acceptance` so `npm run test:acceptance` stays live-opt-in and CI can run `test:faux` without auth.

Suggested scripts:

```json
"test:faux": "vitest run --project faux-acceptance"
```

Keep `npm test` / `npm run check` on unit + typecheck + pack:verify (do not force faux spawn into `check` unless reliably fast/offline on this machine).

### Non-goals

- Nesting-policy / `allowSubagents` / CLI flag `vigil-no-subagents` (Slice N).
- Shipping faux code in the npm package.
- Fuzzy/semantic matching; regex; multi-message history matching beyond “latest user text”.
- Token streaming fidelity beyond what pi-ai faux already provides.
- Changing live LLM acceptance tests except incidental shared helper reuse.
- Modifying `@earendil-works/pi-coding-agent` or `pi-ai` packages.

---

## Phase 0 — Red: lock script matcher contract

- [x] Add `test/unit/vigil-faux/script-matcher.test.ts` with failing tests for:
  - default fallback string when no step matches;
  - `userTextIncludes` match returns text step;
  - match returns toolCall step with name/arguments;
  - one-shot steps are consumed (second call with same text → fallback or next step);
  - reusable steps can match again;
  - invalid script (bad version / missing steps) throws a controlled error.
- [x] Add minimal exported stubs or leave imports failing — record the **exact red** output in Progress notes.
- [x] Do not implement matcher logic yet beyond what is required for TypeScript to typecheck the test file if needed; prefer red from missing module / failing assertions.

### Progress notes — Phase 0

**Command:** `npx vitest run --project unit test/unit/vigil-faux/script-matcher.test.ts`

**Result:** 1 file, 8 tests failed (8).

**Stubs added (no real matcher/parse logic):**
- `test/helpers/vigil-faux/script.ts` — types, `VigilFauxScriptError`, `VIGIL_FAUX_DEFAULT_FALLBACK_TEXT`, passthrough `parseVigilFauxScript`
- `test/helpers/vigil-faux/matcher.ts` — `createScriptMatcher` returns `fauxAssistantMessage("NOT_IMPLEMENTED")`
- `test/helpers/vigil-faux/index.ts` — re-exports

**Exact red failures:**

1. `parseVigilFauxScript > throws a controlled error for an unsupported version` — `AssertionError: expected function to throw an error, but it didn't`
2. `parseVigilFauxScript > throws a controlled error when steps is missing` — `AssertionError: expected function to throw an error, but it didn't`
3. `createScriptMatcher > returns the default fallback when no step matches` — `expected 'NOT_IMPLEMENTED' to be 'fake model: doesn\'t support this request'`
4. `createScriptMatcher > returns a text step when userTextIncludes matches the latest user message` — `expected 'NOT_IMPLEMENTED' to be 'scripted reply'`
5. `createScriptMatcher > returns a toolCall step with the configured name and arguments` — `expected undefined to be 'vigil'`
6. `createScriptMatcher > consumes one-shot steps so a second match falls back` — `expected 'NOT_IMPLEMENTED' to be 'first hit'`
7. `createScriptMatcher > advances to the next step after a consumed one-shot step matches again` — `expected 'NOT_IMPLEMENTED' to be 'step one'`
8. `createScriptMatcher > matches reusable steps on every call` — `expected 'NOT_IMPLEMENTED' to be 'repeatable'`

---

## Phase 1 — Green: script types + matcher

- [x] Implement `test/helpers/vigil-faux/script.ts` (types, parse/validate, default fallback constant).
- [x] Implement `test/helpers/vigil-faux/matcher.ts` (pure: script + context messages → AssistantMessage via faux helpers).
- [x] Export a small public helper surface from `test/helpers/vigil-faux/index.ts` (parse, match, constants, model id helpers).
- [x] Make Phase 0 unit tests green.
- [x] Record green command/output summary in Progress notes.

### Progress notes — Phase 1

**Command:** `npx vitest run --project unit test/unit/vigil-faux/script-matcher.test.ts`

**Result:** 1 file, 8 tests passed (8).

**Implemented:**
- `test/helpers/vigil-faux/script.ts` — `parseVigilFauxScript` validates `version: 1` and required `steps` array; throws `VigilFauxScriptError` on bad version or missing steps.
- `test/helpers/vigil-faux/matcher.ts` — `createScriptMatcher` extracts latest user text (string or text blocks), matches steps in order with one-shot consumption and reusable steps, returns `fauxAssistantMessage` / `fauxToolCall` / `fauxText` responses with correct `stopReason`.
- `test/helpers/vigil-faux/index.ts` — re-exports plus `VIGIL_FAUX_PROVIDER_ID` (`vigil-faux`), `VIGIL_FAUX_MODEL_ID` (`scripted`), `getVigilFauxModelId()` (`vigil-faux/scripted`).

**Production `src/` unchanged.**

---

## Phase 2 — Cross-process extension

- [x] Add failing unit/smoke test that loads the extension module’s registration function (or runs a tiny in-process Pi-style `registerProvider` mock) and asserts provider id `vigil-faux` / model `scripted`.
- [x] Implement `test/helpers/vigil-faux/extension.ts` as a Pi extension default export:
  - read `PI_VIGIL_FAUX_SCRIPT`;
  - parse script;
  - `createFauxCore` + `setResponses` with a factory that calls the matcher on each request (re-queue factory so every call goes through matcher — do not rely on a finite in-memory queue alone);
  - `pi.registerProvider("vigil-faux", { name, apiKey, api, models, streamSimple })`.
- [x] Document required env + `--model vigil-faux/scripted` in a short `test/helpers/vigil-faux/README.md`.
- [x] Green the extension registration test(s).

### Progress notes — Phase 2

**Red (initial run before `extension.ts` existed):**

**Command:** `npx vitest run --project unit test/unit/vigil-faux/extension.test.ts`

**Result:** 1 file failed; 0 tests (transform/import error).

**Exact red failure:** `Error: Failed to resolve import "../../helpers/vigil-faux/extension.js" from "test/unit/vigil-faux/extension.test.ts"` — module not found.

**Green:**

**Command:** `npx vitest run --project unit test/unit/vigil-faux/`

**Result:** 2 files, 12 tests passed (12) — `script-matcher.test.ts` (8) + `extension.test.ts` (4).

**Command:** `npm run typecheck`

**Result:** clean (`tsc --noEmit`).

**Implemented:**
- `test/helpers/vigil-faux/extension.ts` — reads `PI_VIGIL_FAUX_SCRIPT`, parses script, wires `createFauxCore` with re-queued matcher factory, registers `vigil-faux` provider + `scripted` model.
- `test/unit/vigil-faux/extension.test.ts` — mock `ExtensionAPI` captures `registerProvider`; asserts provider/model ids; streams once for scripted match and fallback via captured `streamSimple`.
- `test/helpers/vigil-faux/README.md` — env + `--extension` + `--model vigil-faux/scripted` usage.

---

## Phase 3 — Parent spawn helpers

- [x] Add failing unit tests for helpers that:
  - write a script JSON to a temp path;
  - return absolute extension path;
  - build/wrap a `ProcessRunner` whose spawned args include `--extension <ext>` and leave room for `--model vigil-faux/scripted` from launch input.
- [x] Implement `createVigilFauxProcessRunner` (name flexible) using existing `createNodeProcessRunner` / `spawnDetachedPiChild` patterns; keep production `buildPiChildArgs` unchanged unless a tiny optional `extraArgs` on `SpawnChildInput` is clearly cleaner — prefer **wrapper** over production API change.
- [x] Green helper tests.
- [x] Confirm `package.json` `files` still excludes `test/` (`npm run pack:verify`).

### Progress notes — Phase 3

**Red (initial run before `process-runner.ts` existed):**

**Command:** `npx vitest run --project unit test/unit/vigil-faux/process-runner.test.ts`

**Result:** 1 file failed; 0 tests (transform/import error).

**Exact red failure:** `Error: Failed to resolve import "../../helpers/vigil-faux/process-runner.js" from "test/unit/vigil-faux/process-runner.test.ts"` — module not found.

**Green:**

**Command:** `npx vitest run --project unit test/unit/vigil-faux/`

**Result:** 3 files, 18 tests passed (18) — `script-matcher.test.ts` (8) + `extension.test.ts` (4) + `process-runner.test.ts` (6).

**Command:** `npm run pack:verify`

**Result:** clean — packed tarball contains only `src/`, `README.md`, `LICENSE`; no `test/` paths.

**Implemented:**
- `test/helpers/vigil-faux/process-runner.ts` — `writeVigilFauxScript`, `getVigilFauxExtensionPath`, `insertVigilFauxExtensionArgs`, `createVigilFauxProcessRunner` (wraps `spawnDetachedPiChild` with `spawnChild` that splices `--extension` before the final message arg; delegates `isAlive` / `terminateAndWait` to base runner).
- `test/helpers/vigil-faux/index.ts` — re-exports process-runner helpers.
- `test/unit/vigil-faux/process-runner.test.ts` — script write, extension path, spawn arg injection, base delegation, and assertion that production `buildPiChildArgs` is unchanged.

**Production `src/vigil/buildPiChildArgs` unchanged.**

---

## Phase 4 — Faux acceptance smoke (real detached child)

- [x] Wire vitest project `faux-acceptance` (or equivalent) **without** live auth setup.
- [x] Add smoke test file that:
  1. Writes a script: when user text includes a unique marker → reply with that marker text;
  2. Sets `PI_VIGIL_FAUX_SCRIPT` for child env (processRunner must forward env);
  3. `setVigilRuntimeOverrides` with faux process runner + isolated `PI_VIGIL_SESSION_DIR`;
  4. `createVigilTestHarness` → `launch` with `model: "vigil-faux/scripted"` and message containing the marker;
  5. `wait` until settled; assert `latestResponse` contains the marker;
  6. Second launch/message with unmatched text → settled response contains `fake model: doesn't support this request`.
- [x] Prove red then green; keep timeouts bounded (faux should be fast; default acceptance timeouts may be oversized — use tighter local defaults if safe).
- [x] If child fails to load extension/model, capture stderr approach notes; fix spawn/env/`stdio` only as needed for diagnosis (prefer not regressing production stderr discard; test runner may use a diagnostic spawn wrapper).
- [ ] Optional stretch (same phase if cheap): one toolCall script step that calls a no-op or `vigil` list — only if it does not expand scope into Slice N. Otherwise leave a checkbox under Follow-ups.

### Progress notes — Phase 4

**Red (initial run before extension `baseUrl` fix):**

**Command:** `npx vitest run --project faux-acceptance`

**Result:** 1 file, 2 tests failed (2).

**Exact red failures:**

1. `returns scripted marker text when the user message matches` — `latestResponse` was `null`; `toContain(marker)` failed with invalid assertion args.
2. `returns fallback text when the user message does not match any script step` — same (`latestResponse` null).

**Root cause (manual `pi` repro):** child stderr showed `Provider vigil-faux: "baseUrl" is required when defining custom models.` → extension failed to register → `Model "vigil-faux/scripted" not found`.

**Fix:** add `baseUrl: "faux://localhost"` to `test/helpers/vigil-faux/extension.ts` `registerProvider` config.

**Green:**

**Command:** `npx vitest run --project faux-acceptance`

**Result:** 1 file, 2 tests passed (2) — ~7s total.

**Command:** `npx vitest run --project unit test/unit/vigil-faux/`

**Result:** 3 files, 18 tests passed (18).

**Implemented:**
- `vitest.config.ts` — added `faux-acceptance` project (60s timeout, no live setup).
- `test/faux-acceptance/vigil-faux-smoke.test.ts` — marker-match and fallback smoke tests with per-test temp dirs, env (`PI_VIGIL_FAUX_SCRIPT`, `PI_VIGIL_SESSION_DIR`), `setVigilRuntimeOverrides({ processRunner: createVigilFauxProcessRunner() })`, targeted `wait` (`timeoutMs: 30000`, `initialDelayMs: 100`, `maxDelayMs: 1000`).
- `test/helpers/vigil-faux/extension.ts` — `baseUrl` required by pi-coding-agent provider composer for custom models.

**Spawn approach:** wrapper injects `--extension <faux ext>` before prompt; child inherits parent env for `PI_VIGIL_FAUX_SCRIPT`. No extra `-e` for local Vigil in child — smoke only needs faux model text replies, not nested `vigil` tool calls. Production `stdio: "ignore"` unchanged; stderr diagnosis via manual `pi` repro (no `PI_VIGIL_FAUX_DEBUG` wrapper needed after baseUrl fix).

---

## Phase 5 — Close-out

- [ ] Add `test:faux` npm script; document in Slice F progress / optional-followups pointer.
- [ ] Run `npm run typecheck`, `npm test`, `npm run pack:verify`, and `npm run test:faux`; record results.
- [ ] Mark all phase items complete; note residual risks for Slice N (nesting deny/allow e2e will reuse this harness).
- [ ] No production README marketing required; a one-line pointer in `optional-followups.md` under a “Faux harness” note is enough.

### Progress notes — Phase 5

_(implementer fills)_

---

## Follow-ups (out of scope for Slice F)

- [ ] Slice N: `allowSubagents` / `--vigil-no-subagents` / session `vigil-policy` + two faux e2e cases (default deny nested launch; explicit allow).
- [ ] Optional: faux script step for multi-turn `send` continuations.
- [ ] Optional: shared diagnostic spawn that captures child stderr only under test overrides.

---

## Progress log

- 2026-08-25: Plan created after design discussion. Build on pi-ai faux; cross-process via test extension + script file; default deny nesting deferred to Slice N. Implementer model: `cursor/composer-2.5:high`.
