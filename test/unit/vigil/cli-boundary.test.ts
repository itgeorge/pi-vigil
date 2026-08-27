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
    const args = buildPiChildArgs({
      sessionId: "vigil-cli-boundary",
      message: "No nesting",
      cwd: "/parent/default",
      name: "Deny nesting",
      model: "openai-codex/gpt-5.5",
      noSubagents: true,
    });

    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-cli-boundary",
      "--vigil-no-subagents",
      "--name",
      "Deny nesting",
      "--model",
      "openai-codex/gpt-5.5",
      "No nesting",
    ]);
    // Pi boolean flags consume the next non-flag token; never place the bare
    // deny flag immediately before the positional prompt.
    expect(args.at(-1)).toBe("No nesting");
    expect(args.at(-2)).not.toBe("--vigil-no-subagents");
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
    const args = buildPiEphemeralChildArgs({
      message: "No nesting",
      name: "Ephemeral",
      model: "openai-codex/gpt-5.5",
      noSubagents: true,
    });

    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--vigil-no-subagents",
      "--name",
      "Ephemeral",
      "--model",
      "openai-codex/gpt-5.5",
      "No nesting",
    ]);
    expect(args.at(-1)).toBe("No nesting");
    expect(args.at(-2)).not.toBe("--vigil-no-subagents");
  });
});
