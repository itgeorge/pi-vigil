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

  it("includes --vigil-no-subagents when noSubagents is requested", () => {
    expect(
      buildPiChildArgs({
        sessionId: "vigil-cli-boundary",
        message: "No nesting",
        cwd: "/parent/default",
        noSubagents: true,
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-cli-boundary",
      "--vigil-no-subagents",
      "No nesting",
    ]);
  });

  it("omits --vigil-no-subagents by default", () => {
    expect(
      buildPiChildArgs({
        sessionId: "vigil-cli-boundary",
        message: "Allow nesting",
        cwd: "/parent/default",
      }),
    ).not.toContain("--vigil-no-subagents");
  });

  it("builds ephemeral args with --no-session only", () => {
    expect(
      buildPiEphemeralChildArgs({
        message: "Quick reply",
        name: "Ephemeral",
      }),
    ).toEqual(["--mode", "json", "-p", "--no-session", "--name", "Ephemeral", "Quick reply"]);
  });

  it("includes --vigil-no-subagents on ephemeral args when requested", () => {
    expect(
      buildPiEphemeralChildArgs({
        message: "No nesting",
        name: "Ephemeral",
        noSubagents: true,
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--name",
      "Ephemeral",
      "--vigil-no-subagents",
      "No nesting",
    ]);
  });
});
