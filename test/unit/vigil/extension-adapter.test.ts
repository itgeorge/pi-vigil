import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, WaitScheduler } from "../../../src/vigil/ports";
import { readLatestAssistantTextFromFile, readChildSessionStateFromFile } from "../../../src/vigil/node-runtime";
import type { VigilLaunchRecord, VigilListResult, VigilSnapshot } from "../../../src/vigil/types";
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
        terminateAndWait: async () => undefined,
      },
    });

    const result = await harness.execute({
      action: "launch",
      name: "Summarize repo",
      message: "Summarize the repo",
      model: "openai-codex/gpt-5.5",
      cwd: "/child/worktree",
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const snapshot = result.details as VigilSnapshot;
    expect(snapshot.id).toMatch(/^vigil-/);
    expect(snapshot.sessionId).toBe(snapshot.id);
    expect(snapshot.name).toBe("Summarize repo");
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
        name: "Summarize repo",
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
      name: "Adapter poll",
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
      terminateAndWait: async () => undefined,
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
      name: "Adapter poll",
      cwd: record.cwd,
      state: "waiting",
      latestResponse: "Hello from the child session.",
    });
  });

  it("send returns a running snapshot and appends a vigil-turn parent entry", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const launchPid = 8181;
    const sendPid = 8282;
    let spawnCount = 0;
    let terminatedPid: number | undefined;

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async (input) => {
          spawnCount += 1;
          if (spawnCount === 1) {
            return { pid: launchPid };
          }
          expect(input.sessionId).toMatch(/^vigil-/);
          expect(input.name).toBeUndefined();
          expect(input.message).toBe("Continue the work");
          expect(input.cwd).toBe("/child/worktree");
          expect(input.model).toBe("openai-codex/gpt-5.5:high");
          return { pid: sendPid };
        },
        isAlive: (pid) => pid === launchPid,
        terminateAndWait: async (pid) => {
          terminatedPid = pid;
        },
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: "First answer.",
          turnComplete: true,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        }),
      },
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Continue work",
      message: "Start work",
      cwd: "/child/worktree",
      model: "openai-codex/gpt-5.5",
    });

    const launched = launchResult.details as VigilSnapshot;

    const sendResult = await harness.execute({
      action: "send",
      id: launched.id,
      message: "Continue the work",
      model: "openai-codex/gpt-5.5:high",
    });

    expect((sendResult as { isError?: boolean }).isError).toBeFalsy();
    expect(sendResult.details).toEqual({
      id: launched.id,
      sessionId: launched.sessionId,
      name: "Continue work",
      cwd: "/child/worktree",
      state: "running",
      latestResponse: "First answer.",
    });
    expect(terminatedPid).toBe(launchPid);

    const turnEntry = harness.capturedEntries.find((entry) => entry.customType === "vigil-turn");
    expect(turnEntry?.data).toEqual(
      expect.objectContaining({
        id: launched.id,
        sessionId: launched.sessionId,
        pid: sendPid,
        cwd: "/child/worktree",
        model: "openai-codex/gpt-5.5:high",
      }),
    );
  });

  it("list returns concise active items without latestResponse", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 9000 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: "Large response body",
          turnComplete: true,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        }),
      },
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Listed task",
      message: "Do work",
    });
    const launched = launchResult.details as VigilSnapshot;

    const listResult = await harness.execute({ action: "list" });
    const listed = listResult.details as VigilListResult;
    expect(listed.vigils).toHaveLength(1);
    expect(listed.vigils[0]).toEqual({
      id: launched.id,
      sessionId: launched.sessionId,
      name: "Listed task",
      cwd: "/parent/project",
      state: "waiting",
    });
    expect(listed.vigils[0]).not.toHaveProperty("latestResponse");
  });

  it("complete returns a completed snapshot and rejects send afterward", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const namer: ChildSessionNamer = {
      markCompleted: async () => ({ completedName: "[completed] Retire in adapter" }),
    };

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 9100 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: "Done.",
          turnComplete: true,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        }),
      },
      childSessionNamer: namer,
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Retire in adapter",
      message: "Do work",
    });
    const launched = launchResult.details as VigilSnapshot;

    const completeResult = await harness.execute({
      action: "complete",
      id: launched.id,
    });

    expect((completeResult as { isError?: boolean }).isError).toBeFalsy();
    expect(completeResult.details).toEqual(
      expect.objectContaining({
        id: launched.id,
        state: "completed",
        name: "[completed] Retire in adapter",
      }),
    );

    const sendResult = await harness.execute({
      action: "send",
      id: launched.id,
      message: "Too late",
    });
    expect((sendResult as { isError?: boolean }).isError).toBe(true);
  });

  it("wait needs no id or message, uses its default delay, and returns structured settled details", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    let time = 0;
    const sleeps: number[] = [];
    const scheduler: WaitScheduler = {
      now: () => time,
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
        return "elapsed";
      },
    };

    setVigilRuntimeOverrides({
      waitScheduler: scheduler,
      processRunner: {
        spawnDetached: async () => ({ pid: 9200 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: sleeps.length > 0 ? "Waited response." : null,
          turnComplete: sleeps.length > 0,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        }),
      },
    });

    const launch = await harness.execute({ action: "launch", name: "Wait adapter", message: "Work" });
    const launched = launch.details as VigilSnapshot;
    const result = await harness.execute({ action: "wait" });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details).toEqual({
      outcome: "settled",
      waitedMs: 500,
      settled: [expect.objectContaining({ id: launched.id, latestResponse: "Waited response." })],
    });
    expect(result.content[0]).toEqual({ type: "text", text: expect.stringContaining("outcome: settled") });
    expect(sleeps).toEqual([500]);
  });

  it("returns normal timeout and cancelled wait results through the adapter", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    let time = 0;
    const controller = new AbortController();
    const scheduler: WaitScheduler = {
      now: () => time,
      sleep: async (ms, signal) => {
        time += ms;
        if (ms === 100) {
          controller.abort();
        }
        return signal?.aborted ? "cancelled" : "elapsed";
      },
    };
    setVigilRuntimeOverrides({
      waitScheduler: scheduler,
      processRunner: {
        spawnDetached: async () => ({ pid: 9300 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        }),
      },
    });
    const launch = await harness.execute({ action: "launch", name: "Wait outcomes", message: "Work" });
    const launched = launch.details as VigilSnapshot;

    const cancelled = await harness.execute(
      { action: "wait", timeoutMs: 1_000, initialDelayMs: 100, maxDelayMs: 100 },
      controller.signal,
    );
    expect((cancelled as { isError?: boolean }).isError).toBeFalsy();
    expect(cancelled.details).toEqual({
      outcome: "cancelled",
      waitedMs: 100,
      pending: [expect.objectContaining({ id: launched.id, state: "running" })],
    });

    time = 0;
    const timeout = await harness.execute({
      action: "wait",
      timeoutMs: 50,
      initialDelayMs: 50,
      maxDelayMs: 50,
    });
    expect((timeout as { isError?: boolean }).isError).toBeFalsy();
    expect(timeout.details).toEqual({
      outcome: "timeout",
      waitedMs: 50,
      pending: [expect.objectContaining({ id: launched.id, state: "running" })],
    });
  });

  it("returns concise errors for invalid wait timing", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    const result = await harness.execute({ action: "wait", initialDelayMs: 500, maxDelayMs: 100 });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "maxDelayMs must be greater than or equal to initialDelayMs",
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

  it("send returns an error for an unknown vigil id", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    const result = await harness.execute({
      action: "send",
      id: "vigil-missing",
      message: "Continue",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Unknown vigil id: vigil-missing",
    });
  });
});
