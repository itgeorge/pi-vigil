import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  filterAvailableModels,
  formatAvailableModelsText,
  listAvailableModels,
  modelToAvailableItem,
  resolveModelsPolicy,
  type AvailableModelsSource,
} from "../../../src/vigil/available-models";

function fakeModel(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider">): Model<Api> {
  return {
    name: overrides.name ?? overrides.id,
    api: "openai-completions",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

function createSource(models: Model<Api>[], registryError?: string): AvailableModelsSource {
  return {
    getAvailable: () => models,
    getError: () => registryError,
  };
}

describe("resolveModelsPolicy", () => {
  it("defaults maxResults", () => {
    expect(resolveModelsPolicy({})).toEqual({ maxResults: 50 });
  });

  it("rejects blank query", () => {
    expect(resolveModelsPolicy({ query: "  " })).toEqual({ error: "models query must be nonblank when supplied" });
  });

  it("rejects invalid maxResults", () => {
    expect(resolveModelsPolicy({ maxResults: 0 })).toEqual({
      error: "maxResults must be a positive safe integer no greater than 100",
    });
  });
});

describe("listAvailableModels", () => {
  it("returns sorted available models with provider/id references", () => {
    const source = createSource([
      fakeModel({ provider: "cursor", id: "composer-2.5-fast", name: "Composer 2.5 Fast", reasoning: true }),
      fakeModel({ provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" }),
    ]);

    const result = listAvailableModels(source, { maxResults: 10 });
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }

    expect(result.models.map((model) => model.reference)).toEqual([
      "anthropic/claude-sonnet-4",
      "cursor/composer-2.5-fast",
    ]);
    expect(result.models[1]?.reasoning).toBe(true);
    expect(result.omittedCount).toBe(0);
  });

  it("filters by case-insensitive query and reports omittedCount", () => {
    const source = createSource([
      fakeModel({ provider: "cursor", id: "composer-2.5-fast" }),
      fakeModel({ provider: "cursor", id: "composer-2.5" }),
      fakeModel({ provider: "openai", id: "gpt-5.5" }),
    ]);

    const result = listAvailableModels(source, { query: "composer", maxResults: 1 });
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }

    expect(result.models).toHaveLength(1);
    expect(result.omittedCount).toBe(1);
  });

  it("includes registryWarning when models.json failed to load", () => {
    const result = listAvailableModels(createSource([], "invalid models.json"), {});
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }

    expect(result.registryError).toBe("invalid models.json");
    expect(formatAvailableModelsText(result)).toContain("registryWarning:");
    expect(formatAvailableModelsText(result)).toContain("models: (none)");
  });
});

describe("filterAvailableModels", () => {
  it("matches provider/id and display name", () => {
    const models = [
      fakeModel({ provider: "cursor", id: "composer-2.5-fast", name: "Composer Fast" }),
      fakeModel({ provider: "openai", id: "gpt-5.5", name: "GPT 5.5" }),
    ];

    expect(filterAvailableModels(models, "composer fast")).toHaveLength(1);
    expect(filterAvailableModels(models, "openai/gpt")).toHaveLength(1);
  });
});

describe("formatAvailableModelsText", () => {
  it("formats model rows and launch hint", () => {
    const text = formatAvailableModelsText({
      models: [modelToAvailableItem(fakeModel({ provider: "cursor", id: "composer-2.5-fast", reasoning: true }))],
      omittedCount: 0,
    });

    expect(text).toContain("cursor/composer-2.5-fast");
    expect(text).toContain("thinking · images");
    expect(text).toContain(":high");
  });
});
