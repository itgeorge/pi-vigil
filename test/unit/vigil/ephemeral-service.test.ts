import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { createFakeEphemeralChildObserver } from "../../../src/vigil/ephemeral-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import { createEmptyChildSessionTranscriptReader, createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
import {
  formatEphemeralObservationUnavailableError,
  formatEphemeralSendRejectedError,
  formatEphemeralTranscriptUnavailableError,
  isVigilError,
  type VigilSnapshot,
} from "../../../src/vigil/types";

function createEphemeralHarness(options?: { parentSessionId?: string }) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const observer = createFakeEphemeralChildObserver();
  const settledEntries: unknown[] = [];
  const appendEntry = (customType: string, data: unknown) => {
    sessionManager.appendCustomEntry(customType, data);
    if (customType === "vigil-settle") {
      settledEntries.push(data);
    }
  };

  const parentLedger = createSessionParentLedger(sessionManager, appendEntry);

  const processRunner: ProcessRunner = {
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
    currentParentSessionId: options?.parentSessionId ?? "parent-session-id",
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
      parentCwd: "/parent/default",
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
      parentCwd: "/parent/default",
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
      parentCwd: "/parent/default",
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
      parentCwd: "/parent/default",
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
      parentCwd: "/parent/default",
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
      parentCwd: "/parent/default",
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
    for (const update of progressUpdates) {
      const items = (update as { items?: Array<{ recentMessages?: unknown[]; steps?: number }> }).items ?? [];
      for (const item of items) {
        expect(item.recentMessages).toEqual([]);
        expect(item.steps).toBe(0);
      }
    }
  });

  it("does not append vigil-settle after parent shutdown even if stdout arrives later", async () => {
    const { service, observer, settledEntries } = createEphemeralHarness();
    await service.launch({
      name: "Shutdown race",
      message: "Reply",
      parentCwd: "/parent/default",
      ephemeral: true,
    });

    await observer.shutdown();
    observer.pushStdout("vigil-ephemeral-test", assistantSettledChunk("LATE"));

    expect(settledEntries).toHaveLength(0);
    expect(await service.poll("vigil-ephemeral-test")).toEqual({
      error: formatEphemeralObservationUnavailableError("vigil-ephemeral-test"),
    });
  });
});
