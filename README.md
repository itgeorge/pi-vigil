# pi-vigil

Minimal Pi extension for asynchronous, turn-based subagents.

Vigil launches and observes resumable Pi child sessions. Its v1 state model is session-only: parent-session custom entries record launches and explicit completion, while each child Pi session retains its full conversation and model history.

## Public API

The extension registers a single tool:

```ts
vigil({ action: "launch", message, model?, cwd? })
vigil({ action: "poll", id })
```

`launch` starts a detached Pi child (`pi --mode json -p --session-id <id>`), appends a parent `vigil-launch` custom entry, and returns a `running` snapshot.

`poll` returns:

- `running` while the child process is alive **and** its latest assistant turn is still incomplete (`stopReason: pending`)
- `waiting` once the child exits **or** the latest assistant turn is complete in the child session JSONL (Pi print-mode children often remain alive after `agent_settled`)

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

Opt-in end-to-end tests spawn a real Pi child and require authenticated Pi access:

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

Preflight uses Pi JSON print mode and treats `agent_settled` plus the expected marker as success; it does not wait for the Pi CLI process to exit (print-mode Pi often stays alive until signalled).

Test-only child session isolation uses `PI_VIGIL_SESSION_DIR` (read at tool execution time, passed as `--session-dir`). Production launches omit it and use Pi's default session storage.

## v1 limitations

- No live partial-output streaming, retry, or background watchers.
- A parent crash between child spawn and parent `vigil-launch` append can lose the launch record.
- Detached Pi print-mode children may need explicit cleanup if you spawn many of them outside Vigil's lifecycle.
