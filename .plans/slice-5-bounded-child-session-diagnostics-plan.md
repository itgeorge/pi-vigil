# Slice 5 — Bounded child-session diagnostics (`search` + entry `read`)

## How agents should use this plan

Read this entire plan before changing code. Find the next unchecked `[ ]` item and complete it as a coherent, testable chunk. Add newly discovered relevant TODOs under the active phase before continuing. Mark completed work `[x]`, and record assumptions, deviations, and test notes in this file. Commit plan/checklist updates with the corresponding code and tests so the handoff remains accurate.

This plan is limited to synchronous, read-only diagnostics over persisted Vigil child-session JSONL. Do **not** implement fuzzy/semantic/regex search, LLM summaries, token streaming, child continuation/branching, session mutation, file watchers, subscriptions, background workers, retries/supervision, process groups, an external registry, or arbitrary session-file access.

---

## What this work is

A `poll` response intentionally contains only the most recent assistant response. For troubleshooting a running or waiting child, a parent needs a bounded way to find earlier conversation/tool activity and then inspect the matching persisted entry with a little nearby context—without manually finding child session files and reproducing Pi JSONL/tree parsing.

Pi v3 session entries have stable per-file entry `id` and `parentId` values. Their physical JSONL append order is useful for audit/troubleshooting, but a tree may branch, so a universal “next conversation message” is ambiguous. This slice uses **stable entry IDs**, never mutable array indices, and explicitly defines nearby read context in JSONL append order.

## End goal of this plan

Add two read-only actions to the existing tool:

```ts
vigil({
  action: "search",
  query,                         // required nonblank literal query
  id?,                            // optional Vigil child restriction
  includeCompleted?: false,       // completed child corpus is opt-in
  maxResults?,                    // bounded: default 20, maximum 50
})

vigil({
  action: "read",
  id,                             // required Vigil child ID
  entryId,                        // required stable Pi child-session entry ID from search
  before?,                        // nearby JSONL entries before, default 1, maximum 10
  after?,                         // nearby JSONL entries after, default 1, maximum 10
  includeCompleted?: false,       // required to inspect an explicitly completed child
})
```

`search` performs case-insensitive **literal substring** matching over safe, searchable persisted textual surfaces from the complete child-session file/tree. It defaults to current active (`running`/`waiting`) Vigil children, and adds retained completed children only when `includeCompleted: true`. Each result identifies the Vigil child and exact `entryId`/`parentId`, with type/role/timestamp and a bounded excerpt around the first match.

`read` resolves a single canonical Vigil child and exact child-session `entryId`, then returns a bounded append-order window. Every returned entry includes identity/tree metadata and a bounded factual detail/excerpt representation. It does not change the child session leaf, parent ledger, name, state, process, or file.

Example final text may be approximately:

```text
matches: 2

Slice 5 implementation [vigil-abc…] · entry 1a2b3c4d · parent 0f1e2d3c
message/toolResult · 2026-08-02T00:12:00.000Z
… npm test failed: expected 3 …
```

```text
child: Slice 5 implementation [vigil-abc…]
anchor: 1a2b3c4d · window: 1 before, 2 after · order: JSONL append order

1a2b3c4d · message/toolResult · …
<bounded entry detail>
```

Exact DTO/format names can improve during implementation, but result identity, bounds, and read-only semantics are contract requirements.

## Key working assumptions

- Literal case-insensitive substring is sufficient for v1. A future, explicitly separate slice may add fuzzy/semantic search after cost, ranking, privacy, and API semantics are designed; do not reserve a provider/model parameter now.
- Search covers the complete retained **child session file/tree**, not merely its active leaf. This is intentional for troubleshooting; `parentId` lets a caller identify branches. Normal Vigil print-mode children are typically linear, but diagnostics must not silently discard alternate persisted branches.
- `read` context is file/JSONL append order, not “the unique conversational next entry.” At a branch, callers receive entry IDs/parent IDs and can issue another exact read; no implicit branch traversal/leaf mutation occurs.
- A completed child is excluded by default from both actions. `includeCompleted: true` is explicit for a search corpus or a direct read. If an explicitly requested completed ID is excluded, return a concise deliberate error rather than silently reading it.
- `search.id`, `read.id`, and `read.entryId` are exact IDs. Do not accept file paths, raw session IDs, prefixes, indexes, or arbitrary user-selected files. Canonical lifecycle reconstruction remains the authorization/source-of-truth boundary.
- `search` result ordering is deterministic: child lifecycle order (the existing most-recent-first order), then child file append order. Stop when the global result limit is reached. One matching entry produces one result even if the query occurs multiple times in it.
- Searchable surfaces are factual persisted text: user/assistant text, assistant tool-call name plus safely serialized arguments, tool-result text, bash command/output where Pi persists `bashExecution`, custom-message text, compaction summaries/retained textual summaries, branch summaries, model/thinking change metadata, and labels. Do not search/surface assistant thinking blocks or opaque extension `custom.data` fields. Do not parse images.
- This is a same-parent-session diagnostics feature, not a redaction/security boundary. A parent able to invoke Vigil can already locate retained child JSONL; nevertheless never echo opaque `custom.data`, image/base64 bytes, or unbounded JSON.
- All output is bounded. Recommended initial constants: default/max search results `20`/`50`, max search excerpt `500` visible characters, default/max read `before`/`after` `1`/`10`, maximum returned window `21`, and max rendered detail per entry `4,000` visible characters. Exact constants may evolve only with tests and README documentation.
- Search/read use no partial updates in this slice; they are bounded foreground reads expected to finish promptly. They are never background tasks.
- Existing lifecycle, launch/send/complete, polling, wait progress, JSON/print output, and 4.6 renderer semantics remain compatible. Extend compact call rendering only as necessary for new actions; do not change existing action output semantics.

---

# Phase 0 — Specify public diagnostic behavior with failing tests

## Todos

- [ ] Read accepted Slice 1–4.6 plans, current service/ports/session-text/adapter/rendering code, Pi session-format/tree documentation, fixtures, and live acceptance setup before implementation.
- [ ] Add failing schema/adapter tests for both actions:
  - `search` requires nonblank `query`; `read` requires nonblank `id` and `entryId`;
  - all proposed optional parameters are Pi-compatible and forwarding preserves omitted/default semantics;
  - `search` and `read` return structured details plus self-sufficient bounded text;
  - malformed values/ranges produce concise errors before file access;
  - unknown child/session entry IDs and an excluded completed child report clear errors.
- [ ] Add failing service tests for corpus selection and lifecycle integrity:
  - default search sees active running/waiting children only;
  - `includeCompleted: true` adds retained completed children;
  - explicit `id` restricts search deterministically;
  - completed direct read requires `includeCompleted: true`;
  - duplicate/malformed/tampered parent ledger records cannot redirect a diagnostic operation to a noncanonical child session;
  - no ledger append, spawning, reaping, rename, child process state check/mutation, or session-tree leaf mutation occurs.
- [ ] Add failing transcript-parser/search tests for case-insensitive literal behavior, all searchable surfaces, excluded thinking/opaque custom data/images, deterministic ordering, single-result-per-entry behavior, correct match excerpts, and global max-result truncation.
- [ ] Add failing exact-read tests for stable child `entryId`, parent ID/type/role/timestamp metadata, append-order before/after window, tree branches, missing anchor, per-entry truncation, and numeric bounds.
- [ ] Add failing renderer tests for compact safe summaries of `search` and `read` calls (query/child identity/entry identity as appropriate), including unknown IDs and long/newline query/ID values.

## Agent notes / assumptions

- Use deterministic in-memory lifecycle records and a fake transcript reader. Tests must not depend on machine session directories, wall clock, or actual Pi child processes.
- Outcome-focused tests should assert observable result DTO/text and no mutation, rather than private parser/map call sequences.

---

# Phase 1 — Model bounded child transcript entries and node reader port

## Todos

- [ ] Add narrowly scoped internal/domain types, preferably in a new module such as `src/vigil/transcript.ts`, for parsed searchable child entries and safe renderable details. Keep them separate from parent lifecycle records and `ChildSessionState` used by poll/wait.
- [ ] Introduce a read-only `ChildSessionTranscriptReader` port, separate from the lightweight state reader, along the lines of:

  ```ts
  interface ChildSessionTranscriptReader {
    readChildTranscript(input: {
      sessionId: string;
      cwd: string;
      sessionDir?: string;
    }): Promise<ChildSessionTranscript | { error: string }>;
  }
  ```

  It may return entries in persisted JSONL order, each retaining only needed stable metadata/content projections. Exact names may change; it must not expose writable `SessionManager` or raw file paths through public results.
- [ ] Implement the node adapter by resolving only the canonical child session through the existing `findChildSessionPath`/session-dir policy, parsing Pi JSONL with Pi’s parser, excluding the header, and retaining entry `id`, `parentId`, timestamp, type, role (where applicable), and safe textual projections.
- [ ] Define a pure entry projector for each supported Pi session entry/message role:
  - user/assistant visible text;
  - assistant tool-call name and safe deterministic argument serialization;
  - tool-result textual content and tool name;
  - persisted bash command/output;
  - custom-message text (not opaque custom entry data);
  - compaction/branch summary text, model/thinking metadata, labels;
  - safe type-only metadata for otherwise non-textual entries.
- [ ] Exclude assistant `thinking` blocks, image/base64 data, raw `details`, and opaque extension custom data from search/detail projection. Add defensive handling for malformed/unknown records without throwing or leaking raw JSON.
- [ ] Create pure helpers for safe single-line/multiline truncation and literal case folding. Ensure serialized tool arguments and text details have deterministic key ordering and bounded output.
- [ ] Wire the new reader through `VigilServiceDeps`, context factory, and test-only runtime overrides without changing `poll`/`wait` behavior or making their existing fakes read full transcripts.

## Agent notes / assumptions

- Existing `parseSessionEntries` and Pi `SessionEntry` types are the parser/type boundary. Do not reimplement JSONL parsing with line splitting.
- A missing child session file should become a concise controlled diagnostic error, not an empty successful search/read that conceals a lifecycle/storage problem.

---

# Phase 2 — Implement deterministic bounded literal search

## Todos

- [ ] Add public types and policy validation in `types.ts` (or an equally focused module), including `SearchInput`, a bounded `VigilSearchResult`, result item DTO, and error union. Validate:
  - `query.trim()` is nonblank;
  - optional `id` is nonblank when supplied;
  - `includeCompleted` defaults false;
  - `maxResults` is a positive safe integer in the documented maximum range.
- [ ] Add pure `searchTranscript(...)` behavior:
  - case-fold query and projected searchable text for literal matching—never construct/evaluate a regular expression;
  - use first match position to produce a bounded contextual excerpt with ellipses when text is omitted;
  - carry exact entry ID, parent ID, type/role/timestamp, child identity/state, and a clear `match`/detail field;
  - never include hidden thinking, image data, custom data, or unbounded argument/detail payloads;
  - deterministic entry order and one result per matching entry.
- [ ] Implement `VigilService.search`:
  1. resolve canonical lifecycle candidates from current parent ledger, using existing active/completed semantics and explicit-ID filtering;
  2. reject unknown/excluded explicit IDs clearly;
  3. scan only the fixed candidate set with the transcript-reader port;
  4. collect in deterministic child then entry order, globally stop at `maxResults`;
  5. return successful zero matches as `{ matches: [] }` rather than an error;
  6. make no process/lifecycle/ledger/session mutation.
- [ ] Decide/document controlled behavior if one candidate’s retained file is missing/unreadable. Recommended v1 behavior: return a clear error naming the affected canonical Vigil ID rather than silently presenting incomplete results; preserve this in tests.
- [ ] Add self-sufficient `formatSearchText` with a match count, child name/short ID, entry/parent identity, metadata, and bounded excerpt. Do not require a parent to inspect only structured details to use it.

## Agent notes / assumptions

- Search corpus size is bounded at the returned-result level, not by creating partial/background indexes. It remains a fresh read of the persisted selected transcript(s) per tool call.
- Complete child sessions are retained by Slice 3; `includeCompleted` governs their visibility, not deletion or any file state.

---

# Phase 3 — Implement exact entry reads with bounded append-order context

## Todos

- [ ] Add public `ReadInput`, `VigilReadResult`, and context-entry DTOs plus validation/default constants:
  - required canonical Vigil `id` and stable `entryId`;
  - `before`/`after` default to 1 and each are nonnegative safe integers no greater than the documented maximum;
  - reject a requested window exceeding the total allowed context window rather than silently expanding output;
  - `includeCompleted` default false and explicit completed-child gating.
- [ ] Implement `VigilService.read`:
  1. resolve canonical lifecycle for `id`, reject unknown/excluded completed child;
  2. load only that child transcript via the new port;
  3. find exact `entryId`, returning a clear unknown-entry error if absent;
  4. select `[anchorIndex - before, anchorIndex + after]` clamped to transcript bounds in persisted JSONL append order;
  5. return child identity/state, anchor identity, requested/effective context counts, order explanation, and bounded projected entry details;
  6. preserve exact stable IDs/parent IDs to allow branch-aware follow-up reads;
  7. make no mutation or child-process operation.
- [ ] Implement self-sufficient `formatReadText`, including the append-order/branch caveat and the anchor/window metadata. Format text safely without unbounded raw tool results or opaque JSON.
- [ ] Add unit tests for tree branching that prove the window is append order, not an invented linear branch; use exact IDs in follow-up reads and ensure indexes never appear as public anchors.
- [ ] Add unit tests proving a `read` result after search can be used directly with its returned `id`/`entryId` and does not depend on caller-visible child session paths.

## Agent notes / assumptions

- `poll` stays narrowly about current state/latest response. Do **not** add `entryId`, offsets, or transcript semantics to `poll`; a separate action gives callers a clear capability and preserves backwards compatibility.
- The structured read result can carry bounded multiline detail; compact TUI call rendering must still sanitize its argument summary to one line.

---

# Phase 4 — Extension adapter, compact call rendering, and docs

## Todos

- [ ] Add `search` and `read` to the Pi `StringEnum` action schema with required/optional parameter descriptions and dispatch branches. Preserve launch/send/poll/list/complete/wait validation and output behavior.
- [ ] Return normal non-error structured `details` and `formatSearchText`/`formatReadText` content; route validation/service failures through existing concise `isError` behavior.
- [ ] Extend `renderVigilCall` formatting/cache lookups as needed:
  - `search`: show bounded quoted query, active versus completed-inclusive scope, and restricted child name/short ID when `id` is supplied;
  - `read`: show child identity plus safely shortened entry ID and requested nearby context;
  - unknown/partial parameters must safely fall back with no renderer side effect.
- [ ] Update README public API, examples, default completed-child policy, exact ID semantics, literal case-insensitive behavior, all bounds, searchable/excluded content classes, entry/parent tree metadata, and append-order read caveat.
- [ ] Document recommended troubleshooting flow:

  ```text
  vigil search(query: "failure", id?: child)
  → select result.id + result.entryId
  → vigil read(id, entryId, before: 1, after: 2)
  → poll/send/complete as normal
  ```

- [ ] State explicitly that fuzzy/semantic search is possible future work but is not in v1, and that direct `read` is diagnostic-only and does not move/rewrite the child Pi tree.
- [ ] Update all test harness overrides/fakes/types necessary for the new port. Confirm existing non-search action tests remain focused and unchanged in behavior.

## Agent notes / assumptions

- Do not add a custom result renderer or partial updates for diagnostics. Standard final tool content/details are sufficient.
- Do not expose raw session file paths as a public API escape hatch.

---

# Phase 5 — Acceptance, independent review handoff, and completion

## Todos

- [ ] Extend authenticated opt-in live acceptance through the registered adapter:
  1. launch a uniquely named real child instructed to emit two unique, searchable markers in visible answer/tool-safe text;
  2. wait for it and prove default active-only literal search finds a marker with the launched Vigil ID and stable entry ID;
  3. use that exact search result in `read` and assert bounded context returns its anchor/metadata/marker;
  4. complete the child, then prove default search/direct read excludes it while `includeCompleted: true` permits retained-session search/read;
  5. retain existing launch/send/wait/list/rename/completion/session-retention assertions;
  6. keep test session-dir isolation, unique values, opt-in/auth preflight, and deterministic cleanup.
- [ ] Run and record:
  - `npm test`;
  - `npm run typecheck`;
  - `npm run test:acceptance` without opt-in, expecting the documented helpful prerequisite failure;
  - `PI_VIGIL_LIVE=1 npm run test:acceptance` when authenticated.
- [ ] Verify no parent/child custom ledger entries are appended by `search` or `read`, no child JSONL is modified, no tracked PID is queried/reaped/spawned, and no work persists after tool return.
- [ ] Update this plan’s checkboxes/assumptions/deviations/test notes. Commit plan updates with code/tests.
- [ ] Prepare implementation-review handoff for an independent reviewer: commit SHA(s), final action signatures/defaults/bounds, exact search corpus and exclusions, ordering/tree semantics, direct-completed gating, sample structured/text result, test/live status, and explicit non-goals.

## Future work (not implementation work for this handoff)

- Fuzzy/semantic search with deliberate ranking, privacy/cost, and model-policy design.
- LLM-generated progress summaries: separately opt-in, ephemeral/read-only, rate-limited model calls with cancellation/usage accounting.
- Any interactive child-session tree navigator, full raw JSON viewer, custom result cards, live token streaming, watchers, or search index.

## Progress notes

- 2026-08-02: Plan created after accepted Slice 4.6. User approved case-insensitive literal matching; default active (`running`/`waiting`) corpus with explicit `includeCompleted`; stable Pi entry IDs rather than array indices; and a separate bounded `read` action rather than changing `poll`. No Slice 5 implementation has started.
