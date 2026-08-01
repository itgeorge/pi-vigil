import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import type { ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import { readLatestAssistantTextFromFile, readChildSessionStateFromFile } from "../../../src/vigil/node-runtime";
import type { VigilLaunchRecord, VigilSnapshot } from "../../../src/vigil/types";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

describe("vigil extension adapter", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  it("launch returns a running snapshot and appends a vigil-launch parent entry", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 5150 }),
        isAlive: () => true,
      },
    });

    const result = await harness.execute({
      action: "launch",
      message: "Summarize the repo",
      model: "openai-codex/gpt-5.5",
      cwd: "/child/worktree",
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const snapshot = result.details as VigilSnapshot;
    expect(snapshot.id).toMatch(/^vigil-/);
    expect(snapshot.sessionId).toBe(snapshot.id);
    expect(snapshot.state).toBe("running");
    expect(snapshot.cwd).toBe("/child/worktree");
    expect(snapshot.latestResponse).toBeNull();
    expect(result.content[0]).toEqual({
      type: "text",
      text: expect.stringContaining(`state: running`),
    });

    expect(harness.capturedEntries).toHaveLength(1);
    expect(harness.capturedEntries[0]).toEqual({
      customType: "vigil-launch",
      data: expect.objectContaining({
        id: snapshot.id,
        sessionId: snapshot.id,
        pid: 5150,
        cwd: "/child/worktree",
        model: "openai-codex/gpt-5.5",
      }),
    });

    const persisted = harness.sessionManager
      .getEntries()
      .find((entry) => entry.type === "custom" && entry.customType === "vigil-launch");
    expect(persisted?.type === "custom" ? persisted.data : undefined).toEqual(
      harness.capturedEntries[0]?.data,
    );
  });

  it("poll returns waiting with the latest assistant text from the child session", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const fixturePath = path.join(fixturesDir, "../../fixtures/child-session-with-assistant.jsonl");
    const record: VigilLaunchRecord = {
      id: "vigil-adapter-poll",
      sessionId: "vigil-adapter-poll",
      pid: 6060,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T12:00:00.000Z",
    };

    harness.sessionManager.appendCustomEntry("vigil-launch", record);

    const fakeReader: ChildSessionReader = {
      readChildSessionState: async () => readChildSessionStateFromFile(fixturePath),
    };

    const fakeRunner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 0 }),
      isAlive: () => false,
    };

    setVigilRuntimeOverrides({
      processRunner: fakeRunner,
      childSessionReader: fakeReader,
    });

    const result = await harness.execute({
      action: "poll",
      id: record.id,
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details).toEqual({
      id: record.id,
      sessionId: record.sessionId,
      cwd: record.cwd,
      state: "waiting",
      latestResponse: "Hello from the child session.",
    });
  });

  it("poll returns an error for an unknown vigil id", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    const result = await harness.execute({
      action: "poll",
      id: "vigil-missing",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Unknown vigil id: vigil-missing",
    });
  });
});
