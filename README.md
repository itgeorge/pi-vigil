# pi-vigil

Minimal Pi extension for asynchronous, turn-based subagents.

Vigil launches and observes resumable Pi child sessions. Its v1 state model is session-only: parent-session custom entries record launches, follow-up turns, and explicit completions, while each child Pi session retains its full conversation and model history.

## Public API

The extension registers a single tool:

```ts
vigil({ action: "launch", name, message, model?, cwd? })
vigil({ action: "poll", id })
vigil({ action: "send", id, message, model? })
vigil({ action: "list", includeCompleted? })
vigil({ action: "complete", id })
vigil({ action: "wait", timeoutMs?, initialDelayMs?, maxDelayMs?, progress?, progressIntervalMs? })
vigil({ action: "search", query, id?, includeCompleted?, maxResults? })
vigil({ action: "read", id, entryId, before?, after?, includeCompleted? })
```

`launch` requires a nonblank human-readable `name`, starts a detached Pi child (`pi --mode json -p --session-id <id> --name <name>`), appends a parent `vigil-launch` custom entry, and returns a `running` snapshot.

`send` continues the same child Pi session with a new prompt. It is allowed only while the current turn is `waiting`. If the settled one-shot Pi process is still alive, Vigil terminates and waits for that tracked PID before spawning the next turn. Each successful `send` appends one durable parent `vigil-turn` entry with the new tracked PID and optional model. `send` does not pass `--name`, so a child session renamed during work keeps its current Pi display name.

`poll` returns:

- `running` while the child process is alive **and** the latest relevant conversation message is still incomplete (for example a newer user message after a prior assistant reply, or an assistant `toolUse` / `pending` stop reason)
- `waiting` once the child exits **or** the latest relevant conversation message is a terminal assistant result (`stop`, `length`, `error`, or `aborted`)
- `completed` after the parent records a `vigil-complete` tombstone for that id

`poll` does not terminate child processes; reaping a settled-but-alive Pi process happens during `send` and `complete`.

`list` reconstructs Vigil children from append-only entries in the current parent session file. By default it returns active (`running` / `waiting`) items only, sorted most recently updated first. Pass `includeCompleted: true` to include completed children. List items are concise (`id`, `sessionId`, `name`, `cwd`, `state`, optional `completedAt`) and omit large `latestResponse` text; use `poll` for response bodies.

`wait` is a foreground, bounded convenience loop over the fixed active (`running` / `waiting`) child cohort from the current parent session. It scans immediately, then polls with capped exponential backoff until any watched child is `waiting` or is observed `completed`. It returns structured details with one normal outcome: `settled` (full snapshots, including `latestResponse`), `timeout` (concise pending list items), `empty`, or `cancelled` (concise pending list items). It never calls `send`, `complete`, reaping, spawning, renaming, or ledger append operations.

While a `wait` invocation remains active, Pi renders optional foreground partial tool results when `progress` is `"status"` (default). These updates report persisted child-session facts—state, step/message counts, and the latest persisted activity line—and are visible in the TUI/RPC partial tool-result stream and JSON `tool_execution_update` events. They do not append parent ledger records, mutate child sessions, or replace the final wait result. Pass `progress: "none"` to suppress partial updates while preserving normal wait behavior.

Progress defaults are `progress: "status"` and `progressIntervalMs: 30000` (maximum `60000`). Updates emit immediately after the initial scan, then when a watched child's progress fingerprint changes or after the heartbeat interval while state is unchanged. `steps` counts persisted non-header session entries; `messages` counts persisted `message` entries. These are persisted-session observations, not live token streaming or inferred reasoning summaries. Output is capped at 20 child lines per update plus an omitted-count line, with safe single-line truncation for untrusted names/metadata.

Timing defaults are `timeoutMs: 60000`, `initialDelayMs: 500`, and `maxDelayMs: 5000`. All values must be positive safe integer milliseconds; `timeoutMs` is capped at `300000`, each delay is capped at `30000`, and `maxDelayMs >= initialDelayMs`. Final sleeps are clamped to the remaining timeout. Tool cancellation is passed to an abortable sleep: cancellation promptly returns the normal `cancelled` result, clears its timer/listener, and leaves children untouched. `wait` has no background watcher behavior after it returns, and children launched after the initial scan are not added to its cohort.

A typical orchestration loop is `list` → `wait` (use TUI partial progress while it runs) → inspect the settled snapshot or `poll` → `send` or `complete` → repeat. A `waiting` child is settled for orchestration but is not retired; only explicit `complete` retires it.

`complete` retires a waiting Vigil child without deleting its child session JSONL. It reaps a still-live settled tracked PID if needed, prefixes the child session's current Pi-native display name with `[completed]`, appends one parent `vigil-complete` record, and returns a `completed` snapshot. Repeating `complete` is idempotent. After completion, `send` rejects the id.

`search` performs a synchronous, read-only, case-insensitive **literal substring** search over persisted child-session JSONL. It requires a nonblank `query`. By default it scans active (`running` / `waiting`) Vigil children from the current parent ledger, in most-recent-first lifecycle order; within each child it scans the complete retained session file in JSONL append order and stops at the global result limit. Pass `includeCompleted: true` to include completed children. Pass an exact Vigil `id` to restrict the corpus to one canonical child. Each match returns the Vigil `id`, child name/state, stable Pi `entryId`, `parentId`, entry type/role/timestamp, and a bounded excerpt around the first match. Zero matches is a normal `{ matches: [] }` result, not an error. Defaults/bounds: `maxResults` default `20`, maximum `50`; excerpt maximum `500` visible characters.

Searchable persisted text includes user/assistant visible text, assistant tool-call names plus safely serialized arguments, tool-result text, bash command/output, custom-message text, compaction and branch summaries, model/thinking-level metadata, and labels. It excludes assistant thinking blocks, image/base64 data, opaque extension `custom.data`, and raw session file paths. Fuzzy/semantic/regex search is not implemented in v1.

`read` resolves one canonical Vigil child and one stable Pi `entryId` (typically from `search`), then returns a bounded window of nearby entries in **JSONL append order** (not conversational branch order). Required: exact `id` and `entryId`. Optional `before` / `after` default to `1` and are capped at `10` each; the total returned window is at most `21` entries (`before + anchor + after`). Each returned entry includes stable ids, parent id, type/role/timestamp, and bounded detail text (maximum `4000` visible characters per entry). Completed children require `includeCompleted: true`. `read` is diagnostic-only: it does not move or rewrite the child Pi tree, append ledger records, or mutate process state.

Recommended troubleshooting flow:

```text
vigil search(query: "failure", id?: child)
→ select result.id + result.entryId
→ vigil read(id, entryId, before: 1, after: 2)
→ poll/send/complete as normal
```

In the interactive TUI, compact Vigil tool rows show the action, human-readable child name, and a shortened id (for example `vigil launch · Slice 4.5 implementation · model Pi default` or `vigil poll · Slice 4.5 implementation [vigil-bd02f54]`). Names are reconstructed from the current parent session branch; full arguments and results remain expandable. Launch rows always include a model indicator (`model <value>` when supplied, otherwise the honest fallback `model Pi default`). Send rows include a bounded message excerpt and show `model <value>` only when a continuation model was supplied. The launch `name` is the visual task identity; launch prompt text is deliberately not echoed in the compact row.

Completion uses the child session's **current** display name, not the original launch name. If the session was renamed during work, that renamed value is preserved and prefixed. A missing current name becomes `[completed]`.

Child session JSONL files are never deleted by Vigil. Pi's normal session UI/manual cleanup remains available.

## Dependencies

Runtime imports require peer packages:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai` (for `Type` / `StringEnum` tool schemas)

## Development

```bash
npm install
npm test          # deterministic unit tests
npm run typecheck
```

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

## v1 limitations

- No live token streaming, LLM-generated progress summaries, retry, fuzzy/semantic search, or background watchers.
- `search` is literal case-insensitive substring matching over persisted child JSONL only; `read` returns append-order context and does not traverse branches implicitly.
- Foreground `wait` partial updates are persisted-session activity reports only; they are transport/UI ephemera and do not change child or ledger state.
- A parent crash between child rename and `vigil-complete` append can leave a child renamed but still active in the parent ledger.
- A parent crash between child spawn and parent `vigil-launch` / `vigil-turn` append can lose the turn record.
- Detached Pi print-mode children may need explicit cleanup if you spawn many of them outside Vigil's lifecycle.
- PID reuse is an accepted limitation; Vigil reaps only the directly tracked Pi PID without an external process supervisor.
