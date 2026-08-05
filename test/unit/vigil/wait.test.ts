import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, VigilSessionActivity, WaitScheduler } from "../../../src/vigil/ports";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { createEmptyChildSessionTranscriptReader, createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
import { createInMemoryDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { fingerprintWaitProgress, formatWaitProgressText, type VigilWaitProgress } from "../../../src/vigil/wait-progress";
import { isVigilError, type VigilCompletionRecord, type VigilLaunchRecord, type VigilWaitResult } from "../../../src/vigil/types";

class FakeScheduler implements WaitScheduler {
  time = 0;
  readonly sleeps: number[] = [];
  onSleep?: (sleepCount: number) => void;

  now(): number {
    return this.time;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled"> {
    this.sleeps.push(ms);
    this.time += ms;
    this.onSleep?.(this.sleeps.length);
    return signal?.aborted ? "cancelled" : "elapsed";
  }
}

const defaultActivity = (
  overrides?: Partial<VigilSessionActivity>,
): VigilSessionActivity => ({
  steps: 0,
  messages: 0,
  lastActivity: null,
  lastActivityTimestamp: null,
  recentMessages: [],
  ...overrides,
});

function launchRecord(id: string, pid: number, launchedAt = "2026-08-01T10:00:00.000Z"): VigilLaunchRecord {
  return { id, sessionId: id, name: `Task ${id}`, pid, cwd: "/parent", launchedAt };
}

function createHarness(options?: {
  records?: VigilLaunchRecord[];
  stateFor?: (id: string) => {
    latestResponse: string | null;
    turnComplete: boolean;
    activity?: VigilSessionActivity;
  };
  aliveFor?: (pid: number) => boolean;
}) {
  const sessionManager = SessionManager.inMemory("/parent");
  const captured: { customType: string; data: unknown }[] = [];
  for (const record of options?.records ?? []) {
    sessionManager.appendCustomEntry("vigil-launch", record);
  }

  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };
  const scheduler = new FakeScheduler();
  let spawned = 0;
  let reaped = 0;
  let renamed = 0;
  const reader: ChildSessionReader = {
    async readChildSessionState({ sessionId }) {
      const state = options?.stateFor?.(sessionId) ?? { latestResponse: null, turnComplete: false };
      return {
        latestResponse: state.latestResponse,
        turnComplete: state.turnComplete,
        lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        activity: state.activity ?? defaultActivity(),
      };
    },
  };
  const runner: ProcessRunner = {
    spawnDetached: async () => {
      spawned += 1;
      return { pid: 9999 };
    },
    isAlive: (pid) => options?.aliveFor?.(pid) ?? true,
    terminateAndWait: async () => {
      reaped += 1;
    },
  };
  const namer: ChildSessionNamer = {
    markCompleted: async () => {
      renamed += 1;
      return { completedName: "[completed] unused" };
    },
  }; 
  const service = new VigilService({
    processRunner: runner,
    childSessionReader: reader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer: namer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger: createSessionParentLedger(sessionManager, appendEntry),
    waitScheduler: scheduler,
  });

  return {
    service,
    scheduler,
    sessionManager,
    captured,
    mutations: () => ({ spawned, reaped, renamed }),
  };
}

function expectWait(result: unknown): asserts result is VigilWaitResult {
  expect(isVigilError(result as never)).toBe(false);
}

describe("VigilService.wait", () => {
  it("returns empty immediately when the current parent has no active child", async () => {
    const { service, scheduler } = createHarness();

    const result = await service.wait({});

    expectWait(result);
    expect(result).toEqual({ outcome: "empty", waitedMs: 0 });
    expect(scheduler.sleeps).toEqual([]);
  });

  it("returns all children already waiting in the immediate scan with full snapshots", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-a", 1), launchRecord("vigil-b", 2)],
      stateFor: (id) => ({ latestResponse: `response ${id}`, turnComplete: true }),
    });

    const result = await service.wait({});

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 0,
      settled: [
        expect.objectContaining({ id: "vigil-a", state: "waiting", latestResponse: "response vigil-a" }),
        expect.objectContaining({ id: "vigil-b", state: "waiting", latestResponse: "response vigil-b" }),
      ],
    });
    expect(scheduler.sleeps).toEqual([]);
  });

  it("does not treat already completed children as a wait cohort", async () => {
    const record = launchRecord("vigil-completed", 1);
    const { service, sessionManager } = createHarness({ records: [record] });
    const completion: VigilCompletionRecord = {
      id: record.id,
      sessionId: record.sessionId,
      name: "[completed] Task",
      cwd: record.cwd,
      completedAt: "2026-08-01T11:00:00.000Z",
    };
    sessionManager.appendCustomEntry("vigil-complete", completion);

    const result = await service.wait({});

    expectWait(result);
    expect(result).toEqual({ outcome: "empty", waitedMs: 0 });
  });

  it("waits for an initially-running child and returns its persisted response once settled", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-later", 1)],
      stateFor: () => ({
        latestResponse: scheduler.sleeps.length >= 2 ? "Finished after polling." : null,
        turnComplete: scheduler.sleeps.length >= 2,
      }),
    });

    const result = await service.wait({ timeoutMs: 5_000, initialDelayMs: 100, maxDelayMs: 500 });

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 300,
      settled: [expect.objectContaining({ id: "vigil-later", state: "waiting", latestResponse: "Finished after polling." })],
    });
    expect(scheduler.sleeps).toEqual([100, 200]);
  });

  it("treats a completion recorded for a watched id as settled without appending anything", async () => {
    const record = launchRecord("vigil-completes", 1);
    const { service, scheduler, sessionManager, captured } = createHarness({ records: [record] });
    scheduler.onSleep = () => {
      sessionManager.appendCustomEntry("vigil-complete", {
        id: record.id,
        sessionId: record.sessionId,
        name: "[completed] Task vigil-completes",
        cwd: record.cwd,
        completedAt: "2026-08-01T11:00:00.000Z",
      } satisfies VigilCompletionRecord);
    };

    const result = await service.wait({ timeoutMs: 1_000, initialDelayMs: 100, maxDelayMs: 100 });

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 100,
      settled: [expect.objectContaining({ id: record.id, state: "completed" })],
    });
    expect(captured).toEqual([]);
  });

  it("returns concise pending items at timeout and observes a settlement at the deadline", async () => {
    const timedOut = createHarness({ records: [launchRecord("vigil-timeout", 1)] });
    const timeoutResult = await timedOut.service.wait({ timeoutMs: 250, initialDelayMs: 100, maxDelayMs: 200 });
    expectWait(timeoutResult);
    expect(timeoutResult).toEqual({
      outcome: "timeout",
      waitedMs: 250,
      pending: [expect.objectContaining({ id: "vigil-timeout", state: "running" })],
    });
    expect(timeoutResult.outcome === "timeout" && timeoutResult.pending[0]).not.toHaveProperty("latestResponse");

    const deadline = createHarness({
      records: [launchRecord("vigil-deadline", 2)],
      stateFor: () => ({ latestResponse: "At deadline", turnComplete: deadline.scheduler.time >= 250 }),
    });
    const deadlineResult = await deadline.service.wait({ timeoutMs: 250, initialDelayMs: 100, maxDelayMs: 200 });
    expectWait(deadlineResult);
    expect(deadlineResult).toEqual({
      outcome: "settled",
      waitedMs: 250,
      settled: [expect.objectContaining({ id: "vigil-deadline", latestResponse: "At deadline" })],
    });
  });

  it("keeps the initial cohort fixed when a new child is recorded during the wait", async () => {
    const initial = launchRecord("vigil-initial", 1);
    const { service, scheduler, sessionManager } = createHarness({ records: [initial] });
    scheduler.onSleep = () => {
      sessionManager.appendCustomEntry("vigil-launch", launchRecord("vigil-new", 2));
    };

    const result = await service.wait({ timeoutMs: 100, initialDelayMs: 100, maxDelayMs: 100 });

    expectWait(result);
    expect(result).toEqual({
      outcome: "timeout",
      waitedMs: 100,
      pending: [expect.objectContaining({ id: "vigil-initial" })],
    });
  });

  it("uses capped exponential delays and truncates the final sleep to the timeout", async () => {
    const { service, scheduler } = createHarness({ records: [launchRecord("vigil-backoff", 1)] });

    const result = await service.wait({ timeoutMs: 1_800, initialDelayMs: 500, maxDelayMs: 700 });

    expectWait(result);
    expect(result).toMatchObject({ outcome: "timeout", waitedMs: 1_800 });
    expect(scheduler.sleeps).toEqual([500, 700, 600]);
  });

  it("returns cancelled during sleep without mutations or follow-on work", async () => {
    const controller = new AbortController();
    const { service, scheduler, captured, mutations } = createHarness({ records: [launchRecord("vigil-cancel", 1)] });
    scheduler.onSleep = () => controller.abort();

    const result = await service.wait(
      { timeoutMs: 5_000, initialDelayMs: 100, maxDelayMs: 500 },
      controller.signal,
    );

    expectWait(result);
    expect(result).toEqual({
      outcome: "cancelled",
      waitedMs: 100,
      pending: [expect.objectContaining({ id: "vigil-cancel", state: "running" })],
    });
    expect(scheduler.sleeps).toEqual([100]);
    expect(captured).toEqual([]);
    expect(mutations()).toEqual({ spawned: 0, reaped: 0, renamed: 0 });
  });

  it("validates finite safe positive timing values and a coherent delay range", async () => {
    const { service } = createHarness({ records: [launchRecord("vigil-validate", 1)] });
    for (const input of [
      { timeoutMs: 0 },
      { timeoutMs: Number.NaN },
      { timeoutMs: 300_001 },
      { initialDelayMs: 1.5 },
      { maxDelayMs: 30_001 },
      { initialDelayMs: 500, maxDelayMs: 499 },
      { progress: "verbose" as never },
      { progressIntervalMs: 0 },
      { progressIntervalMs: 60_001 },
    ]) {
      const result = await service.wait(input);
      expect(isVigilError(result)).toBe(true);
    }
  });
});

describe("VigilService.wait progress", () => {
  it("emits an initial status update for an active cohort by default", async () => {
    const { service } = createHarness({
      records: [launchRecord("vigil-progress", 1)],
      stateFor: () => ({
        latestResponse: null,
        turnComplete: false,
        activity: defaultActivity({ steps: 2, messages: 1, lastActivity: "user message", lastActivityTimestamp: "2026-08-01T12:00:01.000Z" }),
      }),
    });
    const updates: unknown[] = [];

    const result = await service.wait({ timeoutMs: 100, initialDelayMs: 100, maxDelayMs: 100 }, undefined, (progress) => {
      updates.push(progress);
    });

    expectWait(result);
    expect(result.outcome).toBe("timeout");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        waitedMs: 0,
        nextPollInMs: 100,
        items: [
          expect.objectContaining({
            id: "vigil-progress",
            state: "running",
            steps: 2,
            messages: 1,
            lastActivity: "user message",
          }),
        ],
      }),
    );
    expect(updates[1]).toEqual(expect.objectContaining({ waitedMs: 100 }));
  });

  it("is silent under progress none but returns the same final outcome", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-silent", 1)],
      stateFor: () => ({ latestResponse: "Done", turnComplete: true }),
    });
    const updates: unknown[] = [];

    const result = await service.wait({ progress: "none" }, undefined, (progress) => updates.push(progress));

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 0,
      settled: [expect.objectContaining({ id: "vigil-silent", state: "waiting", latestResponse: "Done" })],
    });
    expect(updates).toEqual([]);
    expect(scheduler.sleeps).toEqual([]);
  });

  it("emits after every poll even when child progress fingerprint is unchanged", async () => {
    const { service } = createHarness({
      records: [launchRecord("vigil-fingerprint", 1)],
      stateFor: () => ({
        latestResponse: null,
        turnComplete: false,
        activity: defaultActivity({
          steps: 1,
          messages: 1,
          lastActivity: "user message",
          lastActivityTimestamp: "2026-08-01T12:00:01.000Z",
        }),
      }),
    });
    const updates: unknown[] = [];

    const result = await service.wait(
      { timeoutMs: 500, initialDelayMs: 100, maxDelayMs: 100, progressIntervalMs: 10_000 },
      undefined,
      (progress) => updates.push(progress),
    );

    expectWait(result);
    expect(result.outcome).toBe("timeout");
    expect(updates.map((update) => (update as { waitedMs: number }).waitedMs)).toEqual([
      0, 100, 200, 300, 400, 500,
    ]);
  });

  it("emits on fingerprint change before heartbeat expiry", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-fingerprint", 1)],
      stateFor: () => ({
        latestResponse: null,
        turnComplete: false,
        activity: defaultActivity({
          steps: scheduler.sleeps.length + 1,
          messages: 1,
          lastActivity: scheduler.sleeps.length === 0 ? "user message" : "assistant response",
          lastActivityTimestamp: `2026-08-01T12:00:0${scheduler.sleeps.length}.000Z`,
        }),
      }),
    });
    const updates: unknown[] = [];

    const result = await service.wait(
      { timeoutMs: 500, initialDelayMs: 100, maxDelayMs: 100, progressIntervalMs: 10_000 },
      undefined,
      (progress) => updates.push(progress),
    );

    expectWait(result);
    expect(result.outcome).toBe("timeout");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]).toEqual(expect.objectContaining({ waitedMs: 0 }));
    expect(updates[1]).toEqual(expect.objectContaining({ waitedMs: 100 }));
  });

  it("emits a heartbeat when state is unchanged after progressIntervalMs", async () => {
    const { service, scheduler } = createHarness({ records: [launchRecord("vigil-heartbeat", 1)] });
    const updates: unknown[] = [];

    const result = await service.wait(
      { timeoutMs: 250, initialDelayMs: 200, maxDelayMs: 200, progressIntervalMs: 200 },
      undefined,
      (progress) => updates.push(progress),
    );

    expectWait(result);
    expect(result.outcome).toBe("timeout");
    expect(updates.map((update) => (update as { waitedMs: number }).waitedMs)).toEqual([0, 200, 250]);
    expect(updates.map((update) => (update as { nextPollInMs: number }).nextPollInMs)).toEqual([200, 50, 0]);
    expect(scheduler.sleeps).toEqual([200, 50]);
  });

  it("reports nextPollInMs for initial, post-scan backoff, and terminal settlement hints", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-backoff-hint", 1)],
      stateFor: () => ({
        latestResponse: scheduler.sleeps.length >= 2 ? "Done" : null,
        turnComplete: scheduler.sleeps.length >= 2,
        activity: defaultActivity({
          steps: scheduler.sleeps.length + 1,
          messages: 1,
          lastActivity: scheduler.sleeps.length >= 2 ? "assistant response" : "user message",
          lastActivityTimestamp: `2026-08-01T12:00:0${scheduler.sleeps.length}.000Z`,
        }),
      }),
    });
    const updates: VigilWaitProgress[] = [];

    const result = await service.wait(
      { timeoutMs: 5_000, initialDelayMs: 500, maxDelayMs: 700, progressIntervalMs: 10_000 },
      undefined,
      (progress) => updates.push(progress),
    );

    expectWait(result);
    expect(result.outcome).toBe("settled");
    expect(updates.map((update) => update.nextPollInMs)).toEqual([500, 700, 0]);
    expect(updates.map((update) => update.waitedMs)).toEqual([0, 500, 1_200]);
  });

  it("does not emit progress after timeout or cancellation returns", async () => {
    const controller = new AbortController();
    const { service, scheduler } = createHarness({ records: [launchRecord("vigil-after-return", 1)] });
    scheduler.onSleep = () => controller.abort();
    const updates: unknown[] = [];

    await service.wait(
      { timeoutMs: 1_000, initialDelayMs: 100, maxDelayMs: 100 },
      controller.signal,
      (progress) => updates.push(progress),
    );

    expect(updates).toHaveLength(1);
  });

  it("emits when recent message previews change before heartbeat expiry", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-recent", 1)],
      stateFor: () => ({
        latestResponse: null,
        turnComplete: false,
        activity: defaultActivity({
          steps: scheduler.sleeps.length + 1,
          messages: scheduler.sleeps.length + 1,
          lastActivity: "user message",
          lastActivityTimestamp: "2026-08-01T12:00:01.000Z",
          recentMessages:
            scheduler.sleeps.length === 0
              ? [{ label: "user", excerpt: "first prompt" }]
              : [{ label: "assistant", excerpt: "working on it" }],
        }),
      }),
    });
    const updates: VigilWaitProgress[] = [];

    const result = await service.wait(
      { timeoutMs: 500, initialDelayMs: 100, maxDelayMs: 100, progressIntervalMs: 10_000 },
      undefined,
      (progress) => updates.push(progress),
    );

    expectWait(result);
    expect(result.outcome).toBe("timeout");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates[0]?.items[0]?.recentMessages).toEqual([{ label: "user", excerpt: "first prompt" }]);
    expect(updates[1]?.items[0]?.recentMessages).toEqual([{ label: "assistant", excerpt: "working on it" }]);
  });
});

describe("VigilService.wait targeted id", () => {
  it("waits only for a running target and excludes an unrelated waiting sibling", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-running", 1), launchRecord("vigil-waiting", 2)],
      stateFor: (id) =>
        id === "vigil-waiting"
          ? { latestResponse: "Sibling done.", turnComplete: true }
          : {
              latestResponse: scheduler.sleeps.length >= 1 ? "Target done." : null,
              turnComplete: scheduler.sleeps.length >= 1,
            },
    });

    const result = await service.wait({ id: "vigil-running", timeoutMs: 5_000, initialDelayMs: 100, maxDelayMs: 200 });

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 100,
      settled: [expect.objectContaining({ id: "vigil-running", state: "waiting", latestResponse: "Target done." })],
    });
    expect(scheduler.sleeps).toEqual([100]);
  });

  it("returns an already waiting target immediately with only that child snapshot", async () => {
    const { service, scheduler } = createHarness({
      records: [launchRecord("vigil-target", 1), launchRecord("vigil-other", 2)],
      stateFor: (id) =>
        id === "vigil-target"
          ? { latestResponse: "Target ready.", turnComplete: true }
          : { latestResponse: "Other ready.", turnComplete: true },
    });

    const result = await service.wait({ id: "vigil-target" });

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 0,
      settled: [expect.objectContaining({ id: "vigil-target", state: "waiting", latestResponse: "Target ready." })],
    });
    expect(scheduler.sleeps).toEqual([]);
  });

  it("returns a completed target immediately without requiring includeCompleted", async () => {
    const record = launchRecord("vigil-completed-target", 1);
    const { service, scheduler, sessionManager } = createHarness({ records: [record] });
    sessionManager.appendCustomEntry("vigil-complete", {
      id: record.id,
      sessionId: record.sessionId,
      name: "[completed] Task vigil-completed-target",
      cwd: record.cwd,
      completedAt: "2026-08-01T11:00:00.000Z",
    } satisfies VigilCompletionRecord);

    const result = await service.wait({ id: record.id });

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 0,
      settled: [expect.objectContaining({ id: record.id, state: "completed" })],
    });
    expect(scheduler.sleeps).toEqual([]);
  });

  it("rejects an unknown id without lifecycle mutation", async () => {
    const { service, scheduler, captured, mutations } = createHarness({
      records: [launchRecord("vigil-known", 1)],
    });

    const result = await service.wait({ id: "vigil-missing" });

    expect(result).toEqual({ error: "Unknown vigil id: vigil-missing" });
    expect(scheduler.sleeps).toEqual([]);
    expect(captured).toEqual([]);
    expect(mutations()).toEqual({ spawned: 0, reaped: 0, renamed: 0 });
  });

  it("falls back to deps sessionDir for targeted wait when the lifecycle record lacks sessionDir", async () => {
    const depsSessionDir = "/custom/vigil-sessions";
    const sessionManager = SessionManager.inMemory("/parent");
    const target = launchRecord("vigil-target", 1);
    const sibling = launchRecord("vigil-other", 2);
    sessionManager.appendCustomEntry("vigil-launch", target);
    sessionManager.appendCustomEntry("vigil-launch", sibling);
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    const scheduler = new FakeScheduler();
    const readCalls: Array<{ sessionId: string; sessionDir: string | undefined }> = [];
    const reader: ChildSessionReader = {
      async readChildSessionState({ sessionId, sessionDir }) {
        readCalls.push({ sessionId, sessionDir });
        return {
          latestResponse: sessionId === "vigil-target" ? "Target ready." : "Other ready.",
          turnComplete: sessionId === "vigil-target",
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
          activity: defaultActivity(),
        };
      },
    };
    const service = new VigilService({
      processRunner: {
        spawnDetached: async () => ({ pid: 9999 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: reader,
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        markCompleted: async () => ({ completedName: "[completed] unused" }),
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger: createSessionParentLedger(sessionManager, appendEntry),
      sessionDir: depsSessionDir,
      waitScheduler: scheduler,
    });
    const updates: VigilWaitProgress[] = [];

    const result = await service.wait({ id: "vigil-target", progress: "status" }, undefined, (progress) =>
      updates.push(progress),
    );

    expectWait(result);
    expect(result).toEqual({
      outcome: "settled",
      waitedMs: 0,
      settled: [expect.objectContaining({ id: "vigil-target", state: "waiting", latestResponse: "Target ready." })],
    });
    expect(readCalls.some((call) => call.sessionId === "vigil-target" && call.sessionDir === depsSessionDir)).toBe(
      true,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.items).toHaveLength(1);
    expect(updates[0]?.items[0]?.id).toBe("vigil-target");
  });

  it("scopes progress and final output to the selected child only", async () => {
    const { service } = createHarness({
      records: [launchRecord("vigil-target", 1), launchRecord("vigil-other", 2)],
      stateFor: (id) =>
        id === "vigil-target"
          ? { latestResponse: "Target ready.", turnComplete: true }
          : { latestResponse: null, turnComplete: false },
    });
    const updates: VigilWaitProgress[] = [];

    const result = await service.wait({ id: "vigil-target", progress: "status" }, undefined, (progress) => updates.push(progress));

    expectWait(result);
    expect(result.outcome).toBe("settled");
    if (result.outcome !== "settled") {
      return;
    }
    expect(result.settled).toHaveLength(1);
    expect(result.settled[0]?.id).toBe("vigil-target");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.items).toHaveLength(1);
    expect(updates[0]?.items[0]?.id).toBe("vigil-target");
  });
});

describe("VigilService.wait shallow descendant visibility", () => {
  function createSubagentHarness(options?: {
    summaries?: Map<string, import("../../../src/vigil/descendant-inspector").VigilDirectSubagentInspection>;
  }) {
    const sessionManager = SessionManager.inMemory("/parent");
    const record = launchRecord("vigil-parent", 1);
    sessionManager.appendCustomEntry("vigil-launch", record);
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    const scheduler = new FakeScheduler();
    const reader: ChildSessionReader = {
      async readChildSessionState() {
        return {
          latestResponse: "Done.",
          turnComplete: true,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
          activity: defaultActivity(),
        };
      },
    };
    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: () => false,
      terminateAndWait: async () => undefined,
    };
    const namer: ChildSessionNamer = {
      markCompleted: async () => ({ completedName: "[completed] unused" }),
    };
    const service = new VigilService({
      processRunner: runner,
      childSessionReader: reader,
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: namer,
      parentLedger: createSessionParentLedger(sessionManager, appendEntry),
      waitScheduler: scheduler,
      descendantInspector: createInMemoryDescendantInspector({
        summaries:
          options?.summaries ??
          new Map([
            [
              "vigil-parent",
              {
                inspection: "available",
                total: 1,
                incomplete: 1,
                running: 0,
                waiting: 1,
                completed: 0,
                unknown: 0,
                items: [{ id: "vigil-a1", sessionId: "vigil-a1", name: "Nested task", state: "waiting" }],
                omittedCount: 0,
              },
            ],
          ]),
      }),
    });
    return { service, scheduler };
  }

  it("includes direct-subagent summaries in wait progress and final pending/settled output without changing settlement", async () => {
    const { service } = createSubagentHarness();
    const updates: VigilWaitProgress[] = [];

    const result = await service.wait({ progress: "status" }, undefined, (progress) => updates.push(progress));

    expectWait(result);
    expect(result.outcome).toBe("settled");
    expect(updates[0]?.items[0]?.directSubagents).toEqual(
      expect.objectContaining({ inspection: "available", incomplete: 1, waiting: 1 }),
    );

    const progressText = formatWaitProgressText(updates[0]!, 0);
    expect(progressText).toContain("direct subagents: 1 incomplete (1 waiting)");
    expect(progressText).toContain("Nested task");

    if (result.outcome !== "settled") {
      return;
    }
    expect(result.settled[0]?.directSubagents).toEqual(
      expect.objectContaining({ inspection: "available", incomplete: 1, waiting: 1 }),
    );

    const { formatWaitText } = await import("../../../src/vigil/types");
    const waitText = formatWaitText(result);
    expect(waitText).toContain("direct subagents: 1 incomplete (1 waiting)");
    expect(waitText).toContain("Nested task");
  });

  it("changes wait progress fingerprint when direct-subagent summary changes without a heartbeat", () => {
    const base = [
      {
        id: "vigil-a",
        state: "waiting" as const,
        steps: 1,
        messages: 1,
        lastActivity: null,
        lastActivityTimestamp: null,
        recentMessages: [],
        directSubagents: {
          inspection: "available" as const,
          total: 1,
          incomplete: 1,
          running: 1,
          waiting: 0,
          completed: 0,
          unknown: 0,
          items: [{ id: "vigil-a1", sessionId: "vigil-a1", name: "Research API", state: "running" as const }],
          omittedCount: 0,
        },
      },
    ];
    const changedCounts = [
      {
        ...base[0]!,
        directSubagents: {
          inspection: "available" as const,
          total: 1,
          incomplete: 0,
          running: 0,
          waiting: 0,
          completed: 1,
          unknown: 0,
          items: [{ id: "vigil-a1", sessionId: "vigil-a1", name: "Research API", state: "completed" as const }],
          omittedCount: 0,
        },
      },
    ];
    const renamedSameCounts = [
      {
        ...base[0]!,
        directSubagents: {
          inspection: "available" as const,
          total: 1,
          incomplete: 1,
          running: 1,
          waiting: 0,
          completed: 0,
          unknown: 0,
          items: [{ id: "vigil-a1", sessionId: "vigil-a1", name: "Renamed task", state: "running" as const }],
          omittedCount: 0,
        },
      },
    ];
    expect(fingerprintWaitProgress(base)).not.toBe(fingerprintWaitProgress(changedCounts));
    expect(fingerprintWaitProgress(base)).not.toBe(fingerprintWaitProgress(renamedSameCounts));
  });
});
