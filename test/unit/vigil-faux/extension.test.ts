import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  VIGIL_FAUX_MODEL_ID,
  VIGIL_FAUX_PROVIDER_ID,
} from "../../helpers/vigil-faux/index.js";
import vigilFauxExtension from "../../helpers/vigil-faux/extension.js";

interface CapturedProviderRegistration {
  providerId: string;
  config: ProviderConfig;
}

function createMockExtensionAPI(): {
  api: ExtensionAPI;
  registrations: CapturedProviderRegistration[];
} {
  const registrations: CapturedProviderRegistration[] = [];

  const api = {
    registerProvider(providerId: string, config: ProviderConfig) {
      registrations.push({ providerId, config });
    },
    on() {},
  } as unknown as ExtensionAPI;

  return { api, registrations };
}

function contextWithUserText(text: string): Context {
  return {
    messages: [{ role: "user", content: text, timestamp: 1 }],
  };
}

function getTextContent(message: AssistantMessage): string | undefined {
  const block = message.content.find((part) => part.type === "text");
  return block?.type === "text" ? block.text : undefined;
}

function streamModelFromRegistration(
  models: ProviderModelConfig[],
  api: Api,
  provider: string,
): Model<Api> {
  const registered = models.find((model) => model.id === VIGIL_FAUX_MODEL_ID);
  if (!registered) {
    throw new Error(`Missing registered model: ${VIGIL_FAUX_MODEL_ID}`);
  }

  return {
    id: registered.id,
    name: registered.name,
    api,
    provider,
    baseUrl: "faux://localhost",
    reasoning: registered.reasoning,
    input: registered.input,
    cost: registered.cost,
    contextWindow: registered.contextWindow,
    maxTokens: registered.maxTokens,
  };
}

describe("vigil-faux extension", () => {
  const previousScriptPath = process.env.PI_VIGIL_FAUX_SCRIPT;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vigil-faux-ext-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (previousScriptPath === undefined) {
      delete process.env.PI_VIGIL_FAUX_SCRIPT;
    } else {
      process.env.PI_VIGIL_FAUX_SCRIPT = previousScriptPath;
    }
  });

  function writeScript(script: unknown): string {
    const scriptPath = join(tempDir, "script.json");
    writeFileSync(scriptPath, JSON.stringify(script), "utf8");
    process.env.PI_VIGIL_FAUX_SCRIPT = scriptPath;
    return scriptPath;
  }

  it("throws when PI_VIGIL_FAUX_SCRIPT is missing", () => {
    delete process.env.PI_VIGIL_FAUX_SCRIPT;
    const { api } = createMockExtensionAPI();

    expect(() => vigilFauxExtension(api)).toThrow("PI_VIGIL_FAUX_SCRIPT is required");
  });

  it("registers vigil-faux provider with scripted model", () => {
    writeScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: "marker-abc" },
          then: { type: "text", text: "scripted reply" },
        },
      ],
    });

    const { api, registrations } = createMockExtensionAPI();
    vigilFauxExtension(api);

    expect(registrations).toHaveLength(1);
    const { providerId, config } = registrations[0]!;
    expect(providerId).toBe(VIGIL_FAUX_PROVIDER_ID);
    expect(config.name).toBe("Vigil Faux");
    expect(config.apiKey).toBe("vigil-faux-test-key");
    expect(config.models?.map((model) => model.id)).toContain(VIGIL_FAUX_MODEL_ID);
    expect(config.streamSimple).toBeTypeOf("function");
  });

  it("streams scripted text when the latest user message matches", async () => {
    writeScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: "marker-abc" },
          then: { type: "text", text: "scripted reply" },
        },
      ],
    });

    const { api, registrations } = createMockExtensionAPI();
    vigilFauxExtension(api);
    const { config } = registrations[0]!;

    const model = streamModelFromRegistration(
      config.models ?? [],
      config.api ?? ("vigil-faux-api" as Api),
      VIGIL_FAUX_PROVIDER_ID,
    );
    const stream = config.streamSimple!(model, contextWithUserText("please handle marker-abc now"));
    const result = await stream.result();

    expect(getTextContent(result)).toBe("scripted reply");
    expect(result.stopReason).toBe("stop");
  });

  it("streams fallback text when no script step matches", async () => {
    writeScript({ version: 1, steps: [] });

    const { api, registrations } = createMockExtensionAPI();
    vigilFauxExtension(api);
    const { config } = registrations[0]!;

    const model = streamModelFromRegistration(
      config.models ?? [],
      config.api ?? ("vigil-faux-api" as Api),
      VIGIL_FAUX_PROVIDER_ID,
    );
    const stream = config.streamSimple!(model, contextWithUserText("unmatched prompt"));
    const result = await stream.result();

    expect(getTextContent(result)).toBe(VIGIL_FAUX_DEFAULT_FALLBACK_TEXT);
    expect(result.stopReason).toBe("stop");
  });
});
