# Vigil faux model harness (test-only)

Scripted LLM provider for deterministic Vigil acceptance tests. Not shipped in the npm package.

## Child process setup

1. Write a script JSON file (see `script.ts` types).
2. Set env before starting Pi:

```bash
export PI_VIGIL_FAUX_SCRIPT=/absolute/path/to/script.json
```

3. Load the extension and model (acceptance tests also load workspace Vigil for tool e2e):

```bash
pi -ne \
  -e /absolute/path/to/src/index.ts \
  -e /absolute/path/to/test/helpers/vigil-faux/extension.ts \
  --model vigil-faux/scripted
```

For parent harness spawns, prefer `createVigilFauxProcessRunner({ loadLocalVigil: true })` (inserts the same `-ne` + dual `-e` argv). Set `PI_VIGIL_FAUX_BOOTSTRAP_RUNNER=1` when descendants must spawn further faux children (nested launch e2e).

Provider id: `vigil-faux`. Model id: `scripted`. Unmatched prompts receive the default fallback: `fake model: doesn't support this request`.

The extension sets `baseUrl: "faux://localhost"` internally (required by pi-coding-agent for custom models); callers do not need to configure it.

## Running tests

```bash
npm run test:faux
```

Runs the `faux-acceptance` vitest project (real detached child smoke tests, no live LLM auth).
