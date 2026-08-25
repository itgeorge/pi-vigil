# pi-vigil

Minimal Pi extension for asynchronous, turn-based subagents.

# Install

```bash
pi install npm:pi-vigil
```

# Why Vigil?

To paraphrase *(and steal Pi's original tagline)*:
> This is my subagents extension. There are many like it, but this one is **mine**.

Vigil allows Pi agents to launch and observe resumable Pi subagent (child) sessions. 
It is simple and worklfow-agnostic, like Pi.

With Vigil, each of your Pi sessions can:
- Launch a "subagent" (or several), monitor it, and send follow-ups
- List running/waiting/completed subagents, search, and read through their sessions
- And, yes, each launched subagent can launch it's own subagents

Each launched agent gets its own Pi session *(unless you say otherwise)*. You can use Pi `/resume` to manually review or continue persisted agent sessions.
All orchestration data lives inside the sessions.

That's it.

It **does not** force your agents to use git worktrees, or git for that matter, or plans, or specs, or any other workflow.
It doesn't limit permissions, doesn't require configuration, doesn't pollute your TUI or your file system.
It doesn't have personas, or roles, or multi-step interfaces.
It doesn't require you to read a bunch of documentation to understand how to use it or how it works.

The harness handles the commands, lifecycle, wiring and bookkeeping - you and your skills handle the workflow by prompting your agents. 

## But why "Vigil"?

Ah, it was available (no pi package) and I like Mass Effect, needed a name, also the VI term is more apt than AI for where we are with LLMs.

I should go.

---
END OF HUMAN-WRITTEN (allegedly) TEXT. HERE BE DRAGONS.

---

V1 state model is session-only: parent-session custom entries record launches, follow-up turns, and explicit completions, while each child Pi session retains its full conversation and model history.

## Public API

The extension registers a single tool:

```ts
vigil({ action: "launch", name, message, model?, cwd?, ephemeral?: true, allowSubagents?: boolean })
vigil({ action: "poll", id })
vigil({ action: "send", id, message, model? })
vigil({ action: "list", includeCompleted?, maxResults?, skipToId? })
vigil({ action: "complete", id, allowIncompleteSubagents? })
vigil({ action: "wait", id?, timeoutMs? })
vigil({ action: "search", query, id?, includeCompleted?, maxResults? })
vigil({ action: "read", id, entryId, before?, after?, includeCompleted? })
vigil({ action: "models", query?, maxResults? })
```

`launch` requires a nonblank human-readable `name`, starts a detached Pi child, appends a parent `vigil-launch` custom entry, and returns a `running` snapshot.

By default (`ephemeral` absent/false), Vigil launches `pi --mode json -p --session-id <id> --name <name>` and the child retains a normal Pi session JSONL plus a `/resume` entry.

With `ephemeral: true`, Vigil launches `pi --mode json -p --no-session --name <name>` instead. The child has no session JSONL or `/resume` entry. A parent-owned internal JSON-output observer drains stdout for backpressure only, records one bounded `vigil-settle` entry when the child settles, and never streams token deltas to the parent model, TUI, RPC, or wait partial-result channel. Ephemeral children are single-turn: `send`, `search`, and `read` reject; `complete` skips child-session rename and descendant inspection; parent exit or crash before settlement loses any in-flight observer/result. On parent `session_shutdown`, Vigil stops observers and best-effort terminates/reaps each directly tracked ephemeral PID (never process groups or descendants).

`allowSubagents` controls whether a Vigil-spawned child may launch its own Vigil subagents. Default (`allowSubagents` omitted or `false`) passes `--vigil-no-subagents` to the child Pi argv and records `allowSubagents: false` on the parent `vigil-launch` entry; the child stamps a matching `vigil-policy` session entry on startup. Pass `allowSubagents: true` to omit the CLI flag and leave the child session without a deny stamp (absence of valid policy still means allow). Nested launch attempts in a deny-stamped child fail with a stable error. `send` re-applies `--vigil-no-subagents` on respawn when the original launch denied nesting.

`send` continues the same child Pi session with a new prompt. It is allowed only while the current turn is `waiting`. If the settled one-shot Pi process is still alive, Vigil terminates and waits for that tracked PID before spawning the next turn. Each successful `send` appends one durable parent `vigil-turn` entry with the new tracked PID and optional model. `send` does not pass `--name`, so a child session renamed during work keeps its current Pi display name.

`poll` returns:

- `running` while the child process is alive **and** the latest relevant conversation message is still incomplete (for example a newer user message after a prior assistant reply, or an assistant `toolUse` / `pending` stop reason)
- `waiting` once the child exits **or** the latest relevant conversation message is a terminal assistant result (`stop`, `length`, `error`, or `aborted`)
- `completed` after the parent records a `vigil-complete` tombstone for that id

`poll` does not terminate child processes; reaping a settled-but-alive Pi process happens during `send` and `complete`.

`poll`, `send`, `complete`, and `wait` fail closed when a resolved canonical lifecycle target's `sessionId` matches the current parent Pi session header id (for example a malformed ledger record pointing at the parent itself). Each returns `Cannot <action> the current Vigil session.` after id resolution and before child observation, descendant inspection, process work, or ledger mutation. Unselected `wait` rejects when the fixed active cohort includes such a target rather than silently excluding it. `search` and `read` are unchanged.

`list` reconstructs Vigil children from append-only entries in the current parent session file. By default it returns active (`running` / `waiting`) items only, sorted most recently updated first, capped at **20** items per page (`maxResults`, maximum **50**). Pass `includeCompleted: true` to include completed children. Pass `skipToId` with an exact direct canonical Vigil child id to begin the page **inclusively** at that item in the filtered, ordered list; use the prior page's `nextSkipToId` to retrieve older children. Unknown ids, whitespace-invalid ids, or ids excluded by `includeCompleted: false` return a controlled error. Structured list results add `omittedCount` and optional `nextSkipToId` (the first omitted eligible item when more exist). Text output reports truncation with actionable guidance when items are omitted. List pagination is a fresh observational scan on each call—not a transactional snapshot when the ledger changes between pages. List items are concise (`id`, `sessionId`, `name`, `cwd`, `state`, optional `completedAt`, optional `directSubagents`) and omit large `latestResponse` text; use `poll` for response bodies.

Each listed direct child may include a **one-level** `directSubagents` summary of that child's own direct Vigil children (root grandchildren only). Ephemeral list items include an `ephemeral` marker in structured results and compact text; they omit `directSubagents`. Counts (`total`, `incomplete`, `running`, `waiting`, `completed`, `unknown`) reflect the full shallow ledger inspection; `items` is capped at 20 display entries with `omittedCount`. Text output uses lines such as `direct subagents: none`, `direct subagents: 2 incomplete (1 running, 1 waiting; 1 completed)`, followed by bounded item lines. If the intermediate child ledger cannot be read, the root child is retained with `directSubagents: { inspection: "unavailable", error }` rather than failing the entire list. Deeper descendants are never traversed.

`wait` is a foreground, bounded convenience loop over the fixed active (`running` / `waiting`) child cohort from the current parent session, or over one targeted direct child when `id` is supplied. It scans immediately, then polls with capped exponential backoff until any watched child is `waiting` or is observed `completed`. A targeted wait accepts a direct child in any lifecycle state (`running`, `waiting`, or `completed`) and returns immediately when that child is already `waiting` or `completed`. It returns structured details with one normal outcome: `settled` (full snapshots, including `latestResponse`), `timeout` (concise pending list items), `empty`, or `cancelled` (concise pending list items). It never calls `send`, `complete`, reaping, spawning, renaming, or ledger append operations.

While a `wait` invocation remains active, Pi renders foreground partial tool results with factual persisted-activity updates. These report child-session facts—state, step/message counts, the latest persisted activity line, and up to the last three persisted child `message` previews (oldest→newest within the preview)—and are visible in the TUI/RPC partial tool-result stream and JSON `tool_execution_update` events. They do not append parent ledger records, mutate child sessions, or replace the final wait result.

Polling uses capped exponential backoff with Vigil-internal defaults (`initialDelayMs: 500`, `maxDelayMs: 5000`) and a progress heartbeat interval of `30000` ms for unchanged child-state detail. Updates emit immediately after the initial scan, then after every subsequent wait poll (so elapsed timing and next-poll hints stay current), and also when a watched child's progress fingerprint changes between polls. `steps` counts persisted non-header session entries; `messages` counts persisted `message` entries. Recent previews use factual role labels (`user`, `assistant`, `tool result`, `bash execution`, `custom`, etc.), exclude assistant thinking and image/base64 payloads, and show a safe one-line excerpt of up to 50 visible characters (with `…` only when truncated). These are persisted-session observations, not live token streaming or inferred reasoning summaries. Output is capped at 20 child status blocks per update (each with at most three preview lines) plus an omitted-count line, with safe single-line truncation for untrusted names/metadata.

`timeoutMs` defaults to `60000` and must be a positive safe integer no greater than `300000`. Final sleeps are clamped to the remaining timeout. Tool cancellation is passed to an abortable sleep: cancellation promptly returns the normal `cancelled` result, clears its timer/listener, and leaves children untouched. `wait` has no background watcher behavior after it returns, and children launched after the initial scan are not added to its cohort.

A typical orchestration loop is `list` → `wait` (use TUI partial progress while it runs) → inspect the settled snapshot or `poll` → `send` or `complete` → repeat. A `waiting` child is settled for orchestration but is not retired; only explicit `complete` retires it.

`complete` retires a waiting Vigil child without deleting its child session JSONL. Before any reaping, rename, or parent `vigil-complete` append, Vigil inspects the requested direct child's **one-level** Vigil ledger. Default completion rejects when incomplete direct subagents remain:

```text
Cannot complete Vigil child vigil-a: 2 incomplete direct subagents (1 running, 1 waiting).
Prompt the child to finish them, or pass allowIncompleteSubagents: true.
```

Pass `allowIncompleteSubagents: true` to acknowledge incomplete direct subagents and complete **only** the requested direct child. This override never kills, completes, renames, or otherwise modifies descendants. If the intermediate child ledger cannot be verified, completion fails closed even with the override. The guard runs after existing running/completed checks; idempotent repeat `complete` on an already completed parent returns the existing snapshot without re-inspecting descendants. After completion, `send` rejects the id.

`search` performs a synchronous, read-only, case-insensitive **literal substring** search over persisted child-session JSONL. It requires a nonblank `query` (trimmed). By default it scans active (`running` / `waiting`) Vigil children from the current parent ledger, in most-recent-first lifecycle order; within each child it scans the complete retained session file in JSONL append order and stops at the global result limit. Pass `includeCompleted: true` to include completed children. Pass an exact Vigil `id` to restrict the corpus to one canonical child. `search.id`, `read.id`, and `read.entryId` must match exactly—leading or trailing whitespace is rejected; `query` alone is trimmed. Each match returns the Vigil `id`, child name/state, stable Pi `entryId`, `parentId`, entry type/role/timestamp, and a bounded excerpt around the first match. Zero matches is a normal `{ matches: [] }` result, not an error. Defaults/bounds: `maxResults` default `20`, maximum `50`; excerpt maximum `500` visible characters.

Diagnostic `state` in search/read results is lifecycle-derived, not live poll state: `completed` when tombstoned; otherwise `running` means lifecycle-active (eligible for the default active corpus), distinct from poll's live `running`/`waiting` semantics. Search/read never query tracked PIDs, child state readers, or session-tree mutation.

Formatted search/read text escapes C0/C1/ANSI/OSC controls visibly (tabs, CR, DEL/C1, ESC sequences; only LF preserved in read detail) and caps transcript-derived names, metadata, and excerpts. Structured results keep exact stable ids; detail/match fields use safe bounded display projections. Transcript matching retains full raw searchable text internally, including complete deterministic valid JSON for tool-call arguments; bounded display excerpts for tool arguments are separately truncated and are not valid JSON when truncated.

Searchable persisted text includes user/assistant visible text, assistant tool-call names plus safely serialized arguments, tool-result text, bash command/output, custom-message text, compaction and branch summaries, model/thinking-level metadata, and labels. It excludes assistant thinking blocks, image/base64 data, opaque extension `custom.data`, and raw session file paths. Fuzzy/semantic/regex search is not implemented in v1.

`read` resolves one canonical Vigil child and one stable Pi `entryId` (typically from `search`), then returns a bounded window of nearby entries in **JSONL append order** (not conversational branch order). Required: exact `id` and `entryId` (no leading/trailing whitespace). Optional `before` / `after` default to `1` and are capped at `10` each; the total returned window is at most `21` entries (`before + anchor + after`). Each returned entry includes stable ids, parent id, type/role/timestamp, and bounded detail text (maximum `4000` visible characters per entry; newlines preserved deliberately in detail). Completed children require `includeCompleted: true`. Missing/unreadable transcripts and rejected reader promises return a controlled diagnostic error rather than failing tool execution. `read` is diagnostic-only: it does not move or rewrite the child Pi tree, append ledger records, or mutate process state.

`models` refreshes the parent Pi `modelRegistry` and lists authenticated models available for `launch`/`send`. Each row includes a `provider/id` reference string suitable for the `model` argument (for example `cursor/composer-2.5-fast`). Optional `query` filters by case-insensitive substring over provider, model id, and display name. Optional `maxResults` defaults to `50` (maximum `100`). Append an optional `:thinking` suffix when launching or sending (for example `:high`).

Recommended troubleshooting flow:

```text
vigil search(query: "failure", id?: child)
→ select result.id + result.entryId
→ vigil read(id, entryId, before: 1, after: 2)
→ poll/send/complete as normal
```

In the interactive TUI, compact Vigil tool rows show the action, human-readable child name, and a shortened id (for example `vigil launch · Slice 4.5 implementation · model Pi default` or `vigil poll · Slice 4.5 implementation [vigil-bd02f54]`). Names are reconstructed from the current parent session branch; full arguments and results remain expandable. Launch rows always include a model indicator (`model <value>` when supplied, otherwise the honest fallback `model Pi default`). Send rows include a bounded message excerpt and show `model <value>` only when a continuation model was supplied. The launch `name` is the visual task identity; launch prompt text is deliberately not echoed in the compact row.

Successful `launch`, `send`, and `complete` tool **content** returned to the model is a compact mutation receipt (`id`, `name`, `state`, plus `completedAt` for complete only). It omits `sessionId`, `cwd`, and `latestResponse`. The full structured `VigilSnapshot` remains in result `details` for compatibility. Use `poll` or a settled `wait` when the orchestrator needs the latest child response in model context. In the interactive TUI, successful mutation results render that compact receipt by default; expandable detail is visual only. Expanded `launch` shows the original `message` argument; expanded `send` shows the original `message` argument; expanded `complete` may show `details.latestResponse`. Expandable detail is terminal-safe and capped at 4000 visible characters per block.

Completion uses the child session's **current** display name, not the original launch name. If the session was renamed during work, that renamed value is preserved and prefixed. A missing current name becomes `[completed]`.

Child session JSONL files are never deleted by Vigil. Pi's normal session UI/manual cleanup remains available.

## Install

Pi loads this extension from source TypeScript (`pi.extensions` → `./src/index.ts`). Point your Pi host at an npm package version, a Git source pinned to a commit or tag, or a local clone for development.

**npm (pinned):** `pi install npm:pi-vigil@0.1.0` — initial public release.

**npm (latest):** `pi install npm:pi-vigil`

**Git source (pinned):** `pi install https://github.com/itgeorge/pi-vigil.git@<commit-or-tag>` (replace `<commit-or-tag>` with a release tag or full commit SHA). Shorthand: `pi install git:github.com/itgeorge/pi-vigil@<commit-or-tag>`.

**Local development:** clone this repository and reference the checkout path in your Pi extension settings so Pi resolves `./src/index.ts` from your working tree.

## Requirements

- Node.js **>= 22.19** (see `engines` in `package.json`).
- A Pi host runtime that already provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` (Vigil imports all three at runtime).
- Pi configured to load extensions from this package's `src/index.ts` entry.

## Dependencies

Runtime imports use **host-provided Pi core peers** (declared in `peerDependencies` as `"*"` — resolved from your Pi installation, not bundled or npm-installed as runtime deps):

- `@earendil-works/pi-coding-agent` — extension/tool APIs, session types, TUI helpers
- `@earendil-works/pi-ai` — `Type` / `StringEnum` tool schemas
- `@earendil-works/pi-tui` — TUI components for compact tool call/result rendering

For local development and CI, the same Pi packages are listed as **version-pinned `devDependencies`** so `npm run typecheck` and unit tests resolve types/modules without implying a separate runtime install step.

## Development

```bash
npm install
npm test          # deterministic unit tests
npm run typecheck
npm run check     # typecheck + unit tests + faux acceptance + package surface verification
```

## License

MIT — see [LICENSE](LICENSE).

## Live acceptance tests

Opt-in end-to-end tests spawn a real Pi child, observe each turn with `wait`, resume it with `send`, list/complete it, and require authenticated Pi access:

```bash
export PI_VIGIL_LIVE=1
# optional overrides
export PI_VIGIL_TEST_MODEL=openai-codex/gpt-5.5
export PI_VIGIL_PREFLIGHT_TIMEOUT_MS=180000
export PI_VIGIL_ACCEPTANCE_TIMEOUT_MS=180000
export PI_VIGIL_ACCEPTANCE_POLL_MS=1000

npm run test:acceptance
```

Without `PI_VIGIL_LIVE=1`, `npm run test:acceptance` fails immediately with setup instructions rather than skipping tests.

Preflight uses Pi JSON print mode with `--no-session` (ephemeral) and treats `agent_settled` plus the expected marker as success; it does not wait for the Pi CLI process to exit (print-mode Pi often stays alive until signalled).

Test-only child session isolation uses `PI_VIGIL_SESSION_DIR` (read at tool execution time, passed as `--session-dir`). Production launches omit it and use Pi's default session storage.

## Runbook note

For automated TUI drivers, put each task in an atomic task file rather than relying on incremental terminal typing, and keep a small ID/role worklog alongside it. While a `wait` call is active, use its partial progress for controller visibility; after it settles, use the final result to `poll`, `send`, or `complete`. This makes resumed child-session orchestration auditable without adding controller or tmux automation.

## Child launch failures

Vigil detects Pi child bootstrap failures and surfaces them consistently:

- **Fail-fast:** persisted `launch` and `send` wait up to ~1.5s for bootstrap success; invalid models and immediate CLI errors return `{ error }` instead of a misleading `running` receipt.
- **Late detection:** if bootstrap is slow, `poll` and `wait` later return `{ error }` once a parent `vigil-fail` record exists (persisted children) or an ephemeral `vigil-settle.error` is recorded.
- **Failed state:** `list({ includeCompleted: true })` includes failed children with `state: failed`. Failed children are excluded from the default active cohort used by `wait`.
- **Guarded actions:** `send` and `complete` reject failed children.

Ephemeral failures are surfaced from `vigil-settle.error` directly; persisted failures append `vigil-launch` plus `vigil-fail` for auditability.

## v1 limitations

- No live token streaming, LLM-generated progress summaries, retry, fuzzy/semantic search, or background watchers.
- `search` is literal case-insensitive substring matching over persisted child JSONL only; `read` returns append-order context and does not traverse branches implicitly.
- Foreground `wait` partial updates are persisted-session activity reports only; they are transport/UI ephemera and do not change child or ledger state.
- A parent crash between child rename and `vigil-complete` append can leave a child renamed but still active in the parent ledger.
- A parent crash between child spawn and parent `vigil-launch` / `vigil-turn` append can lose the turn record.
- Detached Pi print-mode children may need explicit cleanup if you spawn many of them outside Vigil's lifecycle.
- PID reuse is an accepted limitation; Vigil reaps only the directly tracked Pi PID without an external process supervisor.
