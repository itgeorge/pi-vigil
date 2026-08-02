import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import type { ChildSessionNamer, ChildSessionReader, ChildSessionTranscriptReader, ProcessRunner, VigilSessionActivity, WaitScheduler } from "../../../src/vigil/ports";
import { readLatestAssistantTextFromFile, readChildSessionStateFromFile } from "../../../src/vigil/node-runtime";
import {
  formatMutationSnapshotText,
  formatSnapshotText,
  type VigilLaunchRecord,
  type VigilListResult,
  type VigilReadResult,
  type VigilSearchResult,
  type VigilSnapshot,
} from "../../../src/vigil/types";
import { formatVigilShortId } from "../../../src/vigil/render-call";
import { createInMemoryTranscriptReader, transcriptFromEntries } from "../../helpers/transcript-fake";
import { createDeterministicTestTheme } from "../../helpers/test-theme";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

describe("vigil extension adapter", () => {
  beforeEach(() => {
    setVigilRuntimeOverrides({ descendantInspector: createZeroDescendantInspector() });
  });

  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  const emptyActivity: VigilSessionActivity = {
    steps: 0,
    messages: 0,
    lastActivity: null,
    lastActivityTimestamp: null,
    recentMessages: [],
  };

  const testTheme = createDeterministicTestTheme();

  function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, "");
  }

  it("renderCall identifies a launched child after execute refreshes the display-name cache", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 5151 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Adapter render child",
      message: "Do work",
    });
    const launched = launchResult.details as VigilSnapshot;

    const rendered = stripAnsi(
      harness.tool
        .renderCall!(
          { action: "poll", id: launched.id },
          testTheme,
          { lastComponent: undefined, args: { action: "poll", id: launched.id } } as never,
        )
        .render(120)
        .join("\n"),
    );

    expect(rendered).toContain("Adapter render child");
    expect(rendered).toContain(`[${formatVigilShortId(launched.id)}]`);
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
      text: formatMutationSnapshotText(snapshot),
    });
    expect((result.content[0] as { text?: string }).text).not.toContain("sessionId:");
    expect((result.content[0] as { text?: string }).text).not.toContain("latestResponse:");

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
          activity: emptyActivity,
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
          activity: emptyActivity,
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
    expect(listed.vigils[0]).toEqual(
      expect.objectContaining({
        id: launched.id,
        sessionId: launched.sessionId,
        name: "Listed task",
        cwd: "/parent/project",
        state: "waiting",
        directSubagents: expect.objectContaining({ inspection: "available", total: 0 }),
      }),
    );
    expect(listed.vigils[0]).not.toHaveProperty("latestResponse");
    expect(listed.omittedCount).toBe(0);
    expect(listed.nextSkipToId).toBeUndefined();
  });

  it("list rejects invalid maxResults before observational work", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    const result = await harness.execute({ action: "list", maxResults: 51 });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.details as { error?: string }).error).toContain("maxResults");
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
          activity: emptyActivity,
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
          activity: emptyActivity,
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
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("outcome: settled");
    expect(text).toContain(`id: ${launched.id}`);
    expect(text).toContain("latestResponse: Waited response.");
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
          activity: emptyActivity,
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
    const cancelledText = cancelled.content[0]?.type === "text" ? cancelled.content[0].text : "";
    expect(cancelledText).toContain("outcome: cancelled");
    expect(cancelledText).toContain(`id: ${launched.id}`);
    expect(cancelledText).toContain("name: Wait outcomes");
    expect(cancelledText).toContain("state: running");

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
    const timeoutText = timeout.content[0]?.type === "text" ? timeout.content[0].text : "";
    expect(timeoutText).toContain("outcome: timeout");
    expect(timeoutText).toContain(`id: ${launched.id}`);
    expect(timeoutText).toContain("name: Wait outcomes");
    expect(timeoutText).toContain("state: running");
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

  it("captures partial wait progress updates before the final settled result", async () => {
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
    let readCount = 0;

    setVigilRuntimeOverrides({
      waitScheduler: scheduler,
      processRunner: {
        spawnDetached: async () => ({ pid: 9400 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => {
          readCount += 1;
          return {
            latestResponse: sleeps.length > 0 ? "Waited response." : null,
            turnComplete: sleeps.length > 0,
            lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
            activity: {
              steps: readCount === 1 ? 1 : 2,
              messages: 1,
              lastActivity: "user message",
              lastActivityTimestamp: "2026-08-01T12:00:01.000Z",
              recentMessages: [],
            },
          };
        },
      },
    });

    const launch = await harness.execute({ action: "launch", name: "Progress adapter", message: "Work" });
    const launched = launch.details as VigilSnapshot;
    const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
    readCount = 0;
    const result = await harness.execute({ action: "wait" }, undefined, (update) => updates.push(update));

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]?.details).toEqual(
      expect.objectContaining({
        waitedMs: 0,
        items: [expect.objectContaining({ id: launched.id, state: "running", steps: 1, messages: 1 })],
      }),
    );
    expect(updates[0]?.content[0]?.text).toContain(`[${launched.id}]`);
    expect(result.details).toEqual({
      outcome: "settled",
      waitedMs: 500,
      settled: [expect.objectContaining({ id: launched.id, latestResponse: "Waited response." })],
    });
    const finalText = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(finalText).toContain("outcome: settled");
    expect(finalText).toContain("latestResponse: Waited response.");
    expect(finalText).not.toContain("steps:");
  });

  it("does not emit partial wait updates when progress is none", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 9500 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
          activity: { steps: 3, messages: 2, lastActivity: "user message", lastActivityTimestamp: "t", recentMessages: [] },
        }),
      },
    });
    await harness.execute({ action: "launch", name: "Silent progress", message: "Work" });
    const updates: unknown[] = [];
    const result = await harness.execute({ action: "wait", progress: "none", timeoutMs: 50, initialDelayMs: 50, maxDelayMs: 50 }, undefined, (update) => updates.push(update));
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(updates).toEqual([]);
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

  it("wait with id targets one direct child and returns an unknown-id error without mutation", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    let time = 0;
    setVigilRuntimeOverrides({
      waitScheduler: {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
          return "elapsed";
        },
      },
      processRunner: {
        spawnDetached: async () => ({ pid: 9400 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: time > 0 ? "Target settled." : null,
          turnComplete: time > 0,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
          activity: emptyActivity,
        }),
      },
    });

    const launchA = await harness.execute({ action: "launch", name: "Target child", message: "Work A" });
    await harness.execute({ action: "launch", name: "Other child", message: "Work B" });
    const target = launchA.details as VigilSnapshot;

    const result = await harness.execute({
      action: "wait",
      id: target.id,
      timeoutMs: 5_000,
      initialDelayMs: 100,
      maxDelayMs: 100,
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details).toEqual({
      outcome: "settled",
      waitedMs: 100,
      settled: [expect.objectContaining({ id: target.id, latestResponse: "Target settled." })],
    });

    const unknown = await harness.execute({ action: "wait", id: "vigil-missing" });
    expect((unknown as { isError?: boolean }).isError).toBe(true);
    expect(unknown.content[0]).toEqual({
      type: "text",
      text: "Unknown vigil id: vigil-missing",
    });
  });

  it("search requires a nonblank query and returns structured matches with bounded text", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const record: VigilLaunchRecord = {
      id: "vigil-adapter-search",
      sessionId: "vigil-adapter-search",
      name: "Adapter search",
      pid: 7070,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T12:00:00.000Z",
    };
    harness.sessionManager.appendCustomEntry("vigil-launch", record);

    const transcriptReader: ChildSessionTranscriptReader = createInMemoryTranscriptReader({
      "vigil-adapter-search": transcriptFromEntries([
        {
          type: "message",
          id: "entry-search-1",
          parentId: null,
          timestamp: "2026-08-01T12:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Adapter SEARCH marker" }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.5",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1722513602000,
          },
        },
      ]),
    });

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 0 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
      childSessionTranscriptReader: transcriptReader,
    });

    const missingQuery = await harness.execute({ action: "search", query: "   " });
    expect((missingQuery as { isError?: boolean }).isError).toBe(true);
    expect(missingQuery.content[0]).toEqual({ type: "text", text: "search requires query" });

    const result = await harness.execute({ action: "search", query: "search marker", id: record.id });
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const details = result.details as VigilSearchResult;
    expect(details.matches[0]?.id).toBe(record.id);
    expect(details.matches[0]?.entryId).toBe("entry-search-1");
    expect((result.content[0] as { text?: string }).text).toContain("matches: 1");
    expect((result.content[0] as { text?: string }).text).toContain("SEARCH marker");
  });

  it("read requires id and entryId and returns bounded context from search output", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const record: VigilLaunchRecord = {
      id: "vigil-adapter-read",
      sessionId: "vigil-adapter-read",
      name: "Adapter read",
      pid: 8080,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T12:00:00.000Z",
    };
    harness.sessionManager.appendCustomEntry("vigil-launch", record);

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 0 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
      childSessionTranscriptReader: createInMemoryTranscriptReader({
        "vigil-adapter-read": transcriptFromEntries([
          {
            type: "message",
            id: "entry-before",
            parentId: null,
            timestamp: "2026-08-01T12:00:01.000Z",
            message: { role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 },
          },
          {
            type: "message",
            id: "entry-anchor",
            parentId: "entry-before",
            timestamp: "2026-08-01T12:00:02.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "READ anchor marker" }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.5",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: 1722513602000,
            },
          },
        ]),
      }),
    });

    const missingId = await harness.execute({ action: "read", entryId: "entry-anchor" });
    expect((missingId as { isError?: boolean }).isError).toBe(true);

    const search = await harness.execute({ action: "search", query: "anchor", id: record.id });
    const match = (search.details as VigilSearchResult).matches[0]!;

    const read = await harness.execute({
      action: "read",
      id: match.id,
      entryId: match.entryId,
      before: 1,
      after: 0,
    });
    expect((read as { isError?: boolean }).isError).toBeFalsy();
    const details = read.details as VigilReadResult;
    expect(details.entries.map((entry) => entry.entryId)).toEqual(["entry-before", "entry-anchor"]);
    expect((read.content[0] as { text?: string }).text).toContain("JSONL append order");
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

  describe("compact mutation receipts", () => {
    const uniqueLatestResponse = `UNIQUE_LATEST_${"z".repeat(5000)}`;

    it("returns compact launch/send/complete content while preserving full snapshots in details", async () => {
      const harness = await createVigilTestHarness({ cwd: "/parent/project" });

      setVigilRuntimeOverrides({
        processRunner: {
          spawnDetached: async () => ({ pid: 5150 }),
          isAlive: () => true,
          terminateAndWait: async () => undefined,
        },
        childSessionReader: {
          readChildSessionState: async () => ({
            latestResponse: uniqueLatestResponse,
            turnComplete: true,
            lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
            activity: emptyActivity,
          }),
        },
        childSessionNamer: {
          markCompleted: async () => ({ completedName: "[completed] Compact child" }),
        },
      });

      const launchResult = await harness.execute({
        action: "launch",
        name: "Compact child",
        message: "Start work",
      });
      expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
      const launched = launchResult.details as VigilSnapshot;
      expect(launchResult.content[0]).toEqual({
        type: "text",
        text: formatMutationSnapshotText(launched),
      });
      expect(launchResult.content[0]).not.toEqual({
        type: "text",
        text: formatSnapshotText(launched),
      });

      const sendResult = await harness.execute({
        action: "send",
        id: launched.id,
        message: "Continue work",
      });
      expect((sendResult as { isError?: boolean }).isError).toBeFalsy();
      const sent = sendResult.details as VigilSnapshot;
      expect(sendResult.content[0]).toEqual({
        type: "text",
        text: formatMutationSnapshotText(sent),
      });
      expect((sendResult.content[0] as { text?: string }).text).not.toContain(uniqueLatestResponse.slice(0, 80));
      expect(sent.latestResponse).toBe(uniqueLatestResponse);

      const completeResult = await harness.execute({
        action: "complete",
        id: launched.id,
      });
      expect((completeResult as { isError?: boolean }).isError).toBeFalsy();
      const completed = completeResult.details as VigilSnapshot;
      expect(completeResult.content[0]).toEqual({
        type: "text",
        text: formatMutationSnapshotText(completed),
      });
      expect((completeResult.content[0] as { text?: string }).text).toContain("completedAt:");
      expect((completeResult.content[0] as { text?: string }).text).not.toContain("latestResponse:");
      expect(completed.latestResponse).toBe(uniqueLatestResponse);
    });

    it("keeps poll observation content unchanged", async () => {
      const harness = await createVigilTestHarness({ cwd: "/parent/project" });
      const record: VigilLaunchRecord = {
        id: "vigil-compact-poll",
        sessionId: "vigil-compact-poll",
        name: "Poll child",
        pid: 6060,
        cwd: "/parent/project",
        launchedAt: "2026-08-01T12:00:00.000Z",
      };
      harness.sessionManager.appendCustomEntry("vigil-launch", record);

      setVigilRuntimeOverrides({
        processRunner: {
          spawnDetached: async () => ({ pid: 0 }),
          isAlive: () => false,
          terminateAndWait: async () => undefined,
        },
        childSessionReader: {
          readChildSessionState: async () => ({
            latestResponse: uniqueLatestResponse,
            turnComplete: true,
            lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
            activity: emptyActivity,
          }),
        },
      });

      const pollResult = await harness.execute({ action: "poll", id: record.id });
      expect((pollResult as { isError?: boolean }).isError).toBeFalsy();
      const snapshot = pollResult.details as VigilSnapshot;
      expect(pollResult.content[0]).toEqual({
        type: "text",
        text: formatSnapshotText(snapshot),
      });
      expect((pollResult.content[0] as { text?: string }).text).toContain("latestResponse:");
    });
  });
});
