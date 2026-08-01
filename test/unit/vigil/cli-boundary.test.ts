import { describe, expect, it } from "vitest";
import { buildPiChildArgs } from "../../../src/vigil/node-runtime";

describe("buildPiChildArgs", () => {
  it("selects noninteractive JSON print mode with the exact session id and cwd message", () => {
    const args = buildPiChildArgs({
      sessionId: "vigil-cli-boundary",
      message: "Inspect the repository",
      cwd: "/parent/default",
    });

    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-cli-boundary",
      "Inspect the repository",
    ]);
  });

  it("includes optional model and session directory flags when requested", () => {
    const args = buildPiChildArgs({
      sessionId: "vigil-cli-boundary",
      message: "Run checks",
      cwd: "/child/override",
      model: "openai-codex/gpt-5.5:high",
      sessionDir: "/tmp/vigil-session-dir",
    });

    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-cli-boundary",
      "--model",
      "openai-codex/gpt-5.5:high",
      "--session-dir",
      "/tmp/vigil-session-dir",
      "Run checks",
    ]);
  });
});
