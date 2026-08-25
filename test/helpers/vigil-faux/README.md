# Vigil faux model harness (test-only)

Scripted LLM provider for deterministic Vigil acceptance tests. Not shipped in the npm package.

## Child process setup

1. Write a script JSON file (see `script.ts` types).
2. Set env before starting Pi:

```bash
export PI_VIGIL_FAUX_SCRIPT=/absolute/path/to/script.json
```

3. Load the extension and model:

```bash
pi --extension /absolute/path/to/test/helpers/vigil-faux/extension.ts \
   --model vigil-faux/scripted
```

Provider id: `vigil-faux`. Model id: `scripted`. Unmatched prompts receive the default fallback: `fake model: doesn't support this request`.
