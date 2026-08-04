import { describe, expect, it } from "vitest";
import { appendThinkingLevelToModel } from "../../../src/vigil/model";

describe("appendThinkingLevelToModel", () => {
  it("appends the parent thinking level when the model omits one", () => {
    expect(appendThinkingLevelToModel("cursor/composer-2.5-fast", "high")).toBe(
      "cursor/composer-2.5-fast:high",
    );
  });

  it("preserves an explicit thinking level suffix", () => {
    expect(appendThinkingLevelToModel("openai-codex/gpt-5.5:low", "high")).toBe(
      "openai-codex/gpt-5.5:low",
    );
  });

  it("appends after model ids that contain colons", () => {
    expect(appendThinkingLevelToModel("openrouter/some-model:exacto", "high")).toBe(
      "openrouter/some-model:exacto:high",
    );
  });

  it("returns undefined when no model was supplied", () => {
    expect(appendThinkingLevelToModel(undefined, "high")).toBeUndefined();
    expect(appendThinkingLevelToModel("   ", "high")).toBeUndefined();
  });

  it("returns the model unchanged when no thinking level is available", () => {
    expect(appendThinkingLevelToModel("cursor/composer-2.5-fast", undefined)).toBe(
      "cursor/composer-2.5-fast",
    );
  });
});
