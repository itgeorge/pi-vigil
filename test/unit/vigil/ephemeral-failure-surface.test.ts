import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { formatVigilChildFailedError } from "../../../src/vigil/child-failure";
import { createFakeEphemeralChildObserver } from "../../../src/vigil/ephemeral-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, WaitScheduler } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { isVigilError } from "../../../src/vigil/types";

class ImmediateScheduler implements WaitScheduler {
  now() {
    return 0;
  }
  async sleep() {
    return "elapsed" as const;
  }
}

function createEphemeralFailureService(settleError?: string) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  sessionManager.appendCustomEntry("vigil-launch", {
    id: "vigil-ephemeral-fail",
    sessionId: "vigil-ephemeral-fail",
    name: "Ephemeral",
    pid: 100,
    cwd: "/parent/default",
    launchedAt: "2026-08-01T10:00:00.000Z",
    ephemeral: true,
  });
  if (settleError !== undefined) {
    sessionManager.appendCustomEntry("vigil-settle", {
      id: "vigil-ephemeral-fail",
      sessionId: "vigil-ephemeral-fail",
      latestResponse: null,
      settledAt: "2026-08-01T10:00:01.000Z",
      error: settleError,
    });
  }

  const processRunner: ProcessRunner = {
    async spawnDetached() {
      return { pid: 101 };
    },
    isAlive: () => false,
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: null,
        turnComplete: false,
        lastConversationTimestamp: null,
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Ephemeral" };
    },
  };

  return new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    }),
    ephemeralChildObserver: createFakeEphemeralChildObserver(),
    waitScheduler: new ImmediateScheduler(),
  });
}

describe("ephemeral failure surfacing", () => {
  it("returns poll error when settle record has error", async () => {
    const service = createEphemeralFailureService("ephemeral child exited (code 1)");
    const result = await service.poll("vigil-ephemeral-fail");
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(
        formatVigilChildFailedError("vigil-ephemeral-fail", "ephemeral child exited (code 1)"),
      );
    }
  });

  it("returns wait error when settle record has error", async () => {
    const service = createEphemeralFailureService("ephemeral child exited (code 1)");
    const result = await service.wait({ id: "vigil-ephemeral-fail", timeoutMs: 1000 });
    expect(isVigilError(result)).toBe(true);
  });

  it("returns waiting snapshot for successful ephemeral settle", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-ephemeral-ok",
      sessionId: "vigil-ephemeral-ok",
      name: "Ephemeral ok",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
      ephemeral: true,
    });
    sessionManager.appendCustomEntry("vigil-settle", {
      id: "vigil-ephemeral-ok",
      sessionId: "vigil-ephemeral-ok",
      latestResponse: "Done",
      settledAt: "2026-08-01T10:00:01.000Z",
    });

    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 101 };
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
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed]" };
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      }),
      ephemeralChildObserver: createFakeEphemeralChildObserver(),
    });

    const result = await service.poll("vigil-ephemeral-ok");
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.state).toBe("waiting");
      expect(result.latestResponse).toBe("Done");
    }
  });

  it("excludes ephemeral settle-error child from default active cohort", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-ephemeral-fail",
      sessionId: "vigil-ephemeral-fail",
      name: "Ephemeral",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
      ephemeral: true,
    });
    sessionManager.appendCustomEntry("vigil-settle", {
      id: "vigil-ephemeral-fail",
      sessionId: "vigil-ephemeral-fail",
      latestResponse: null,
      settledAt: "2026-08-01T10:00:01.000Z",
      error: "ephemeral child exited (code 1)",
    });
    sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-ephemeral-active",
      sessionId: "vigil-ephemeral-active",
      name: "Active",
      pid: 101,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T12:00:00.000Z",
      ephemeral: true,
    });
    sessionManager.appendCustomEntry("vigil-settle", {
      id: "vigil-ephemeral-active",
      sessionId: "vigil-ephemeral-active",
      latestResponse: "Done",
      settledAt: "2026-08-01T12:00:01.000Z",
    });

    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 102 };
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
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed]" };
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      }),
      ephemeralChildObserver: createFakeEphemeralChildObserver(),
      waitScheduler: new ImmediateScheduler(),
    });

    const activeList = await service.list();
    expect(isVigilError(activeList)).toBe(false);
    if (!isVigilError(activeList)) {
      expect(activeList.vigils.map((item) => item.id)).toEqual(["vigil-ephemeral-active"]);
    }

    const cohortWait = await service.wait({ id: "vigil-ephemeral-active", timeoutMs: 1000 });
    expect(isVigilError(cohortWait)).toBe(false);
  });

  it("lists ephemeral settle-error child as failed with includeCompleted", async () => {
    const service = createEphemeralFailureService("ephemeral child exited (code 1)");
    const result = await service.list({ includeCompleted: true });
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      const failed = result.vigils.find((item) => item.id === "vigil-ephemeral-fail");
      expect(failed?.state).toBe("failed");
      expect(failed?.ephemeral).toBe(true);
    }
  });

  it("returns launch error when ephemeral observer settles with error within bootstrap window", async () => {
    const ephemeralObserver = createFakeEphemeralChildObserver();
    const sessionManager = SessionManager.inMemory("/parent/default");
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 101 };
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
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed]" };
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      }),
      ephemeralChildObserver: ephemeralObserver,
      bootstrapFailFastTimeoutMs: 1000,
      createId: () => "vigil-ephemeral-launch-fail",
    });

    const launchPromise = service.launch({
      name: "Ephemeral fail",
      message: "hello",
      parentCwd: "/parent/default",
      ephemeral: true,
    });

    await Promise.resolve();
    ephemeralObserver.pushClose("vigil-ephemeral-launch-fail", 1);

    const result = await launchPromise;
    expect(isVigilError(result)).toBe(true);
  });

  it("returns running snapshot when ephemeral launch bootstrap times out", async () => {
    const ephemeralObserver = createFakeEphemeralChildObserver();
    const sessionManager = SessionManager.inMemory("/parent/default");
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 101 };
        },
        isAlive: () => true,
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
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed]" };
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      }),
      ephemeralChildObserver: ephemeralObserver,
      bootstrapFailFastTimeoutMs: 25,
      createId: () => "vigil-ephemeral-launch-timeout",
    });

    const result = await service.launch({
      name: "Ephemeral slow",
      message: "hello",
      parentCwd: "/parent/default",
      ephemeral: true,
    });
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.state).toBe("running");
    }
  });
});
