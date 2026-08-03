import { describe, expect, it } from "vitest";
import { buildPiChildArgs, buildPiEphemeralChildArgs } from "../../../src/vigil/node-runtime";

describe("buildPiChildArgs", () => {
  it("includes --name for launch and omits it for send", () => {
    const launchArgs = buildPiChildArgs({
      sessionId: "vigil-cli-boundary",
      message: "Inspect the repository",
      cwd: "/parent/default",
      name: "Inspect repo",
    });

    const sendArgs = buildPiChildArgs({
      sessionId: "vigil-cli-boundary",
      message: "Continue inspecting",
      cwd: "/parent/default",
      model: "openai-codex/gpt-5.5:high",
      sessionDir: "/tmp/vigil-session-dir",
    });

    expect(launchArgs).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-cli-boundary",
      "--name",
      "Inspect repo",
      "Inspect the repository",
    ]);

    expect(sendArgs).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-cli-boundary",
      "--model",
      "openai-codex/gpt-5.5:high",
      "--session-dir",
      "/tmp/vigil-session-dir",
      "Continue inspecting",
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

  it("builds ephemeral args with --no-session only", () => {
    expect(
      buildPiEphemeralChildArgs({
        message: "Quick reply",
        name: "Ephemeral",
      }),
    ).toEqual(["--mode", "json", "-p", "--no-session", "--name", "Ephemeral", "Quick reply"]);
  });
});
