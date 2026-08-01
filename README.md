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
vigil({ action: "wait", timeoutMs?, initialDelayMs?, maxDelayMs? })
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

Timing defaults are `timeoutMs: 60000`, `initialDelayMs: 500`, and `maxDelayMs: 5000`. All values must be positive safe integer milliseconds; `timeoutMs` is capped at `300000`, each delay is capped at `30000`, and `maxDelayMs >= initialDelayMs`. Final sleeps are clamped to the remaining timeout. Tool cancellation is passed to an abortable sleep: cancellation promptly returns the normal `cancelled` result, clears its timer/listener, and leaves children untouched. `wait` has no background watcher behavior after it returns, and children launched after the initial scan are not added to its cohort.

A typical orchestration loop is `list` → `wait` → inspect the settled snapshot or `poll` → `send` or `complete` → repeat. A `waiting` child is settled for orchestration but is not retired; only explicit `complete` retires it.

`complete` retires a waiting Vigil child without deleting its child session JSONL. It reaps a still-live settled tracked PID if needed, prefixes the child session's current Pi-native display name with `[completed]`, appends one parent `vigil-complete` record, and returns a `completed` snapshot. Repeating `complete` is idempotent. After completion, `send` rejects the id.

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

For automated TUI drivers, put each task in an atomic task file rather than relying on incremental terminal typing, and keep a small ID/role worklog alongside it. This makes resumed child-session orchestration auditable without adding controller or tmux automation.

## v1 limitations

- No live partial-output streaming, retry, search, or background watchers.
- A parent crash between child rename and `vigil-complete` append can leave a child renamed but still active in the parent ledger.
- A parent crash between child spawn and parent `vigil-launch` / `vigil-turn` append can lose the turn record.
- Detached Pi print-mode children may need explicit cleanup if you spawn many of them outside Vigil's lifecycle.
- PID reuse is an accepted limitation; Vigil reaps only the directly tracked Pi PID without an external process supervisor.
