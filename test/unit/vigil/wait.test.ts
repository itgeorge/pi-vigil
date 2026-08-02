import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, VigilSessionActivity, WaitScheduler } from "../../../src/vigil/ports";
import { createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
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
    childSessionNamer: namer,
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
    expect(updates).toHaveLength(1);
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

  it("emits on fingerprint change before heartbeat expiry and suppresses duplicate unchanged scans", async () => {
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
    expect(updates.map((update) => (update as { waitedMs: number }).waitedMs)).toEqual([0, 200]);
    expect(scheduler.sleeps).toEqual([200, 50]);
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
});
