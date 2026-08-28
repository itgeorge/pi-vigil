import { EventEmitter, PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import {
  createFakeEphemeralChildObserver,
  createNodeEphemeralChildObserver,
} from "../../../src/vigil/ephemeral-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, WaitScheduler } from "../../../src/vigil/ports";
import { createEmptyChildSessionTranscriptReader, createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
import {
  formatEphemeralObservationUnavailableError,
  formatEphemeralSendRejectedError,
  formatEphemeralTranscriptUnavailableError,
  isVigilError,
  type VigilSnapshot,
  type VigilWaitResult,
} from "../../../src/vigil/types";
import {
  EPHEMERAL_WAIT_PROGRESS_STATUS,
  formatWaitProgressText,
  type VigilWaitProgress,
} from "../../../src/vigil/wait-progress";

function createMockChildProcess(pid = 12_345): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, pid });
  child.unref = () => child;
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

function assistantSettledStdout(text: string): string {
  return `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"stopReason":"stop"}}\n{"type":"agent_settled"}\n`;
}

function createEphemeralHarness(options?: {
  parentSessionId?: string;
  waitScheduler?: WaitScheduler;
  processRunner?: ProcessRunner;
  observer?: ReturnType<typeof createFakeEphemeralChildObserver>;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const observer = options?.observer ?? createFakeEphemeralChildObserver();
  const settledEntries: unknown[] = [];
  const appendEntry = (customType: string, data: unknown) => {
    sessionManager.appendCustomEntry(customType, data);
    if (customType === "vigil-settle") {
      settledEntries.push(data);
    }
  };

  const parentLedger = createSessionParentLedger(sessionManager, appendEntry);

  const processRunner: ProcessRunner = options?.processRunner ?? {
    async spawnDetached() {
      throw new Error("persisted spawn should not be used for ephemeral launch");
    },
    isAlive: () => false,
    async terminateAndWait() {
      // No-op in unit tests.
    },
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      throw new Error("child session reader should not be used for ephemeral observation");
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      throw new Error("child session rename should not run for ephemeral complete");
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    parentLedger,
    descendantInspector: createZeroDescendantInspector(),
    ephemeralChildObserver: observer,
    createId: () => "vigil-ephemeral-test",
    bootstrapFailFastTimeoutMs: 25,
    currentParentSessionId: options?.parentSessionId ?? "parent-session-id",
    ...(options?.waitScheduler ? { waitScheduler: options.waitScheduler } : {}),
  });

  return { service, observer, sessionManager, settledEntries };
}

function assistantSettledChunk(text: string): string {
  return `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"stopReason":"stop"}}\n{"type":"agent_settled"}\n`;
}

describe("VigilService ephemeral actions", () => {
  it("launches asynchronously, appends vigil-launch, and settles into vigil-settle", async () => {
    const { service, observer, settledEntries } = createEphemeralHarness();

    const launched = await service.launch({
      name: "Quick task",
      message: "Reply DONE",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    expect(isVigilError(launched)).toBe(false);
    expect((launched as VigilSnapshot).state).toBe("running");
    expect((launched as VigilSnapshot).ephemeral).toBe(true);
    expect(observer.started).toHaveLength(1);

    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("DONE"));
    expect(settledEntries).toHaveLength(1);

    const polled = await service.poll("vigil-ephemeral-test");
    expect(isVigilError(polled)).toBe(false);
    expect((polled as VigilSnapshot).state).toBe("waiting");
    expect((polled as VigilSnapshot).latestResponse).toBe("DONE");
  });

  it("persists vigil-settle when observer settles synchronously during activate", async () => {
    const observer = createFakeEphemeralChildObserver({
      onStart(input) {
        observer.pushStdout(input.vigilId, assistantSettledChunk("SYNC"));
      },
    });
    const sessionManager = SessionManager.inMemory("/parent/default");
    const settledEntries: unknown[] = [];
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
      if (customType === "vigil-settle") {
        settledEntries.push(data);
      }
    };
    const parentLedger = createSessionParentLedger(sessionManager, appendEntry);
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          throw new Error("persisted spawn should not be used");
        },
        isAlive: () => false,
        async terminateAndWait() {},
      },
      childSessionReader: {
        async readChildSessionState() {
          throw new Error("child session reader should not be used");
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        async markCompleted() {
          throw new Error("child session rename should not run");
        },
      },
      parentLedger,
      descendantInspector: createZeroDescendantInspector(),
      ephemeralChildObserver: observer,
      createId: () => "vigil-ephemeral-sync",
      currentParentSessionId: "parent-session-id",
    });

    const launched = await service.launch({
      name: "Sync settle",
      message: "Reply SYNC",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    expect(isVigilError(launched)).toBe(false);
    expect(settledEntries).toHaveLength(1);

    const polled = await service.poll("vigil-ephemeral-sync");
    expect(isVigilError(polled)).toBe(false);
    expect((polled as VigilSnapshot).state).toBe("waiting");
    expect((polled as VigilSnapshot).latestResponse).toBe("SYNC");

    const listed = await service.list();
    expect(isVigilError(listed)).toBe(false);
    if (!isVigilError(listed)) {
      expect(listed.vigils[0]?.state).toBe("waiting");
      expect(listed.vigils[0]?.ephemeral).toBe(true);
    }
  });

  it("rejects send, search, and read for ephemeral children", async () => {
    const { service, observer } = createEphemeralHarness();
    await service.launch({
      name: "Quick task",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });
    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("DONE"));

    expect(await service.send({ vigilId: "vigil-ephemeral-test", message: "again", parentCwd: "/parent/default" })).toEqual({
      error: formatEphemeralSendRejectedError("vigil-ephemeral-test"),
    });
    expect(await service.search({ query: "DONE", id: "vigil-ephemeral-test" })).toEqual({
      error: formatEphemeralTranscriptUnavailableError("vigil-ephemeral-test"),
    });
    expect(await service.read({ id: "vigil-ephemeral-test", entryId: "entry-1" })).toEqual({
      error: formatEphemeralTranscriptUnavailableError("vigil-ephemeral-test"),
    });
  });

  it("completes without child rename and uses deterministic completed name", async () => {
    const { service, observer } = createEphemeralHarness();
    await service.launch({
      name: "Quick task",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });
    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("DONE"));

    const completed = await service.complete({ vigilId: "vigil-ephemeral-test", parentCwd: "/parent/default" });
    expect(isVigilError(completed)).toBe(false);
    expect((completed as VigilSnapshot).state).toBe("completed");
    expect((completed as VigilSnapshot).name).toBe("[completed] Quick task");
    expect((completed as VigilSnapshot).latestResponse).toBe("DONE");
  });

  it("lists ephemeral children with an ephemeral marker", async () => {
    const { service, observer } = createEphemeralHarness();
    await service.launch({
      name: "Quick task",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });
    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("DONE"));

    const listed = await service.list();
    expect(isVigilError(listed)).toBe(false);
    if (!isVigilError(listed)) {
      expect(listed.vigils[0]?.ephemeral).toBe(true);
      expect(listed.vigils[0]?.state).toBe("waiting");
    }
  });

  it("returns observation unavailable after reconstruction before settle", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-ephemeral-lost",
      sessionId: "vigil-ephemeral-lost",
      name: "Lost task",
      pid: 123,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
      ephemeral: true,
    });

    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 1 };
        },
        isAlive: () => false,
        async terminateAndWait() {},
      },
      childSessionReader: {
        async readChildSessionState() {
          return {
            latestResponse: null,
            turnComplete: false,
            lastConversationTimestamp: null,
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: { async markCompleted() { return { completedName: "[completed]" }; } },
      parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      }),
      descendantInspector: createZeroDescendantInspector(),
      ephemeralChildObserver: createFakeEphemeralChildObserver(),
    });

    expect(await service.poll("vigil-ephemeral-lost")).toEqual({
      error: formatEphemeralObservationUnavailableError("vigil-ephemeral-lost"),
    });
  });

  it("wait settles asynchronously without message previews for ephemeral children", async () => {
    const { service, observer } = createEphemeralHarness();
    await service.launch({
      name: "Quick task",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    const progressUpdates: unknown[] = [];
    const waitPromise = service.wait(
      { id: "vigil-ephemeral-test", timeoutMs: 2_000, initialDelayMs: 10, maxDelayMs: 20, progress: "status" },
      undefined,
      (progress) => progressUpdates.push(progress),
    );

    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("WAIT_DONE"));
    const waitResult = await waitPromise;

    expect(isVigilError(waitResult)).toBe(false);
    if (!isVigilError(waitResult) && waitResult.outcome === "settled") {
      expect(waitResult.settled[0]?.latestResponse).toBe("WAIT_DONE");
    }
    expect(progressUpdates.length).toBeGreaterThan(0);
    for (const update of progressUpdates) {
      const items =
        (update as { items?: Array<{ recentMessages?: unknown[]; steps?: number; ephemeral?: true }> }).items ?? [];
      for (const item of items) {
        expect(item.recentMessages).toEqual([]);
        expect(item.steps).toBe(0);
        expect(item.ephemeral).toBe(true);
      }
      expect(formatWaitProgressText(update as VigilWaitProgress, Date.now())).toContain(
        EPHEMERAL_WAIT_PROGRESS_STATUS,
      );
    }
  });

  it("does not append vigil-settle after parent shutdown even if stdout arrives later", async () => {
    const { service, observer, settledEntries } = createEphemeralHarness();
    await service.launch({
      name: "Shutdown race",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    await observer.shutdown();
    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("LATE"));

    expect(settledEntries).toHaveLength(0);
    expect(await service.poll("vigil-ephemeral-test")).toEqual({
      error: formatEphemeralObservationUnavailableError("vigil-ephemeral-test"),
    });
  });

  it("keeps poll durable during delayed terminateAndWait after settle", async () => {
    let releaseTerminate!: () => void;
    const terminateGate = new Promise<void>((resolve) => {
      releaseTerminate = resolve;
    });

    const sessionManager = SessionManager.inMemory("/parent/default");
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    const parentLedger = createSessionParentLedger(sessionManager, appendEntry);
    const mockChild = createMockChildProcess();

    const processRunner: ProcessRunner = {
      async spawnDetached() {
        throw new Error("persisted spawn should not be used");
      },
      isAlive: () => true,
      async terminateAndWait() {
        await terminateGate;
      },
    };

    const service = new VigilService({
      processRunner,
      childSessionReader: {
        async readChildSessionState() {
          throw new Error("child session reader should not be used");
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        async markCompleted() {
          throw new Error("child session rename should not run");
        },
      },
      parentLedger,
      descendantInspector: createZeroDescendantInspector(),
      ephemeralChildObserver: createNodeEphemeralChildObserver({
        processRunner,
        spawnChild: () => mockChild,
      }),
      createId: () => "vigil-ephemeral-delay",
      currentParentSessionId: "parent-session-id",
    });

    const launched = await service.launch({
      name: "Delayed reap",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });
    expect(isVigilError(launched)).toBe(false);

    (mockChild.stdout as PassThrough).write(assistantSettledStdout("DELAYED"));
    await Promise.resolve();

    const polled = await service.poll("vigil-ephemeral-delay");
    expect(isVigilError(polled)).toBe(false);
    expect((polled as VigilSnapshot).state).toBe("waiting");
    expect((polled as VigilSnapshot).latestResponse).toBe("DELAYED");

    const waitPromise = service.wait({
      id: "vigil-ephemeral-delay",
      timeoutMs: 100,
      initialDelayMs: 10,
      maxDelayMs: 20,
    });
    const waitResult = await waitPromise;
    expect(isVigilError(waitResult)).toBe(false);
    if (!isVigilError(waitResult) && waitResult.outcome === "settled") {
      expect(waitResult.settled[0]?.latestResponse).toBe("DELAYED");
    }

    releaseTerminate();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("includes ephemeral marker on timeout and cancelled wait pending items", async () => {
    class FakeScheduler implements WaitScheduler {
      time = 0;

      now(): number {
        return this.time;
      }

      async sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled"> {
        this.time += ms;
        return signal?.aborted ? "cancelled" : "elapsed";
      }
    }

    const scheduler = new FakeScheduler();
    const { service } = createEphemeralHarness({ waitScheduler: scheduler });

    await service.launch({
      name: "Running task",
      message: "Reply",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    const timeoutResult = await service.wait({
      id: "vigil-ephemeral-test",
      timeoutMs: 250,
      initialDelayMs: 100,
      maxDelayMs: 200,
    });

    expect(isVigilError(timeoutResult)).toBe(false);
    if (!isVigilError(timeoutResult) && timeoutResult.outcome === "timeout") {
      expect(timeoutResult.pending).toEqual([
        expect.objectContaining({ id: "vigil-ephemeral-test", state: "running", ephemeral: true }),
      ]);
      expect(timeoutResult.pending[0]).not.toHaveProperty("latestResponse");
    }

    const controller = new AbortController();
    const abortScheduler = new (class implements WaitScheduler {
      time = 0;
      sleepCount = 0;

      now(): number {
        return this.time;
      }

      async sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled"> {
        this.sleepCount += 1;
        this.time += ms;
        if (this.sleepCount === 1) {
          controller.abort();
        }
        return signal?.aborted ? "cancelled" : "elapsed";
      }
    })();

    const { service: cancelService } = createEphemeralHarness({ waitScheduler: abortScheduler });
    await cancelService.launch({
      name: "Cancel task",
      message: "Reply",
      parentCwd: "/parent/default",
      model: "openai-codex/gpt-5.5",
      ephemeral: true,
    });

    const cancelledResult = await cancelService.wait(
      { id: "vigil-ephemeral-test", timeoutMs: 5_000, initialDelayMs: 100, maxDelayMs: 500 },
      controller.signal,
    );

    expect(isVigilError(cancelledResult)).toBe(false);
    if (!isVigilError(cancelledResult) && cancelledResult.outcome === "cancelled") {
      expect(cancelledResult.pending).toEqual([
        expect.objectContaining({ id: "vigil-ephemeral-test", state: "running", ephemeral: true }),
      ]);
    }
  });
});
