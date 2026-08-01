# pi-vigil

Minimal Pi extension for asynchronous, turn-based subagents.

Vigil launches and observes resumable Pi child sessions. Its v1 state model is session-only: parent-session custom entries record launches and follow-up turns, while each child Pi session retains its full conversation and model history.

## Public API

The extension registers a single tool:

```ts
vigil({ action: "launch", message, model?, cwd? })
vigil({ action: "poll", id })
vigil({ action: "send", id, message, model? })
```

`launch` starts a detached Pi child (`pi --mode json -p --session-id <id>`), appends a parent `vigil-launch` custom entry, and returns a `running` snapshot.

`send` continues the same child Pi session with a new prompt. It is allowed only while the current turn is `waiting`. If the settled one-shot Pi process is still alive, Vigil terminates and waits for that tracked PID before spawning the next turn. Each successful `send` appends one durable parent `vigil-turn` entry with the new tracked PID and optional model.

`poll` returns:

- `running` while the child process is alive **and** the latest relevant conversation message is still incomplete (for example a newer user message after a prior assistant reply, or an assistant `toolUse` / `pending` stop reason)
- `waiting` once the child exits **or** the latest relevant conversation message is a terminal assistant result (`stop`, `length`, `error`, or `aborted`)

`poll` does not terminate child processes; reaping a settled-but-alive Pi process happens during `send`.

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

Opt-in end-to-end tests spawn a real Pi child, resume it with `send`, and require authenticated Pi access:

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

## v1 limitations

- No live partial-output streaming, retry, or background watchers.
- A parent crash between child spawn and parent `vigil-launch` / `vigil-turn` append can lose the turn record.
- Detached Pi print-mode children may need explicit cleanup if you spawn many of them outside Vigil's lifecycle.
- PID reuse is an accepted limitation; Vigil reaps only the directly tracked Pi PID without an external process supervisor.
