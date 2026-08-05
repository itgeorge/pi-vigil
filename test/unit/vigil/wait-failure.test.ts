import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { formatVigilChildFailedError } from "../../../src/vigil/child-failure";
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

function createWaitFailureHarness() {
  const sessionManager = SessionManager.inMemory("/parent");
  const appendEntry = (customType: string, data: unknown) => {
    sessionManager.appendCustomEntry(customType, data);
  };

  sessionManager.appendCustomEntry("vigil-launch", {
    id: "vigil-wait-active",
    sessionId: "vigil-wait-active",
    name: "Active",
    pid: 100,
    cwd: "/parent",
    launchedAt: "2026-08-01T12:00:00.000Z",
  });
  sessionManager.appendCustomEntry("vigil-launch", {
    id: "vigil-wait-failed",
    sessionId: "vigil-wait-failed",
    name: "Failed",
    pid: 101,
    cwd: "/parent",
    launchedAt: "2026-08-01T10:00:00.000Z",
  });
  sessionManager.appendCustomEntry("vigil-fail", {
    id: "vigil-wait-failed",
    sessionId: "vigil-wait-failed",
    failedAt: "2026-08-01T10:00:01.000Z",
    error: "bootstrap failed",
    source: "bootstrap",
  });

  const processRunner: ProcessRunner = {
    async spawnDetached() {
      return { pid: 200 };
    },
    isAlive: () => false,
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState({ sessionId }) {
      return {
        latestResponse: sessionId === "vigil-wait-active" ? "done" : null,
        turnComplete: sessionId === "vigil-wait-active",
        lastConversationTimestamp: "2026-08-01T12:00:01.000Z",
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed]" };
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger: createSessionParentLedger(sessionManager, appendEntry),
    waitScheduler: new ImmediateScheduler(),
  });

  return service;
}

describe("VigilService.wait failure detection", () => {
  it("returns error immediately for targeted failed child", async () => {
    const service = createWaitFailureHarness();
    const result = await service.wait({ id: "vigil-wait-failed", timeoutMs: 1000 });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(formatVigilChildFailedError("vigil-wait-failed", "bootstrap failed"));
    }
  });

  it("returns error during cohort wait when a watched child fails", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    appendEntry("vigil-launch", {
      id: "vigil-wait-one",
      sessionId: "vigil-wait-one",
      name: "One",
      pid: 100,
      cwd: "/parent",
      launchedAt: "2026-08-01T12:00:00.000Z",
    });
    appendEntry("vigil-launch", {
      id: "vigil-wait-two",
      sessionId: "vigil-wait-two",
      name: "Two",
      pid: 101,
      cwd: "/parent",
      launchedAt: "2026-08-01T11:00:00.000Z",
    });

    let reads = 0;
    let alive = true;
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 200 };
        },
        isAlive: () => alive,
        async terminateAndWait() {},
      },
      childSessionReader: {
        async readChildSessionState() {
          reads += 1;
          if (reads >= 2) {
            appendEntry("vigil-fail", {
              id: "vigil-wait-two",
              sessionId: "vigil-wait-two",
              failedAt: "2026-08-01T11:00:01.000Z",
              error: "bootstrap failed",
              source: "bootstrap",
            });
            alive = false;
          }
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
      parentLedger: createSessionParentLedger(sessionManager, appendEntry),
      waitScheduler: new ImmediateScheduler(),
    });

    const result = await service.wait({ timeoutMs: 1000, initialDelayMs: 1, maxDelayMs: 1 });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("vigil-wait-two");
    }
  });

  it("excludes failed children from default active cohort", async () => {
    const service = createWaitFailureHarness();
    const result = await service.wait({ id: "vigil-wait-active", timeoutMs: 1000 });
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.outcome).toBe("settled");
    }
  });
});
