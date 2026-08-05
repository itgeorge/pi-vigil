import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { formatVigilChildFailedError } from "../../../src/vigil/child-failure";
import {
  createFakePersistedBootstrapObserver,
  type PersistedBootstrapObserver,
} from "../../../src/vigil/persisted-bootstrap-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { isVigilError } from "../../../src/vigil/types";

function createSendFailureDeps(bootstrapObserver: PersistedBootstrapObserver) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  sessionManager.appendCustomEntry("vigil-launch", {
    id: "vigil-send-target",
    sessionId: "vigil-send-target",
    name: "Waiting child",
    pid: 100,
    cwd: "/parent/default",
    launchedAt: "2026-08-01T10:00:00.000Z",
  });

  let spawnCalls = 0;
  const processRunner: ProcessRunner = {
    async spawnDetached() {
      spawnCalls += 1;
      return { pid: 200 };
    },
    isAlive: () => false,
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: "prior",
        turnComplete: true,
        lastConversationTimestamp: "2026-08-01T10:00:01.000Z",
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
    parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    }),
    persistedBootstrapObserver: bootstrapObserver,
    bootstrapFailFastTimeoutMs: 2000,
  });

  return { service, getSpawnCalls: () => spawnCalls };
}

describe("VigilService.send failure detection", () => {
  it("rejects send when lifecycle has vigil-fail without spawning", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-send-failed",
      sessionId: "vigil-send-failed",
      name: "Failed",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });
    sessionManager.appendCustomEntry("vigil-fail", {
      id: "vigil-send-failed",
      sessionId: "vigil-send-failed",
      failedAt: "2026-08-01T10:00:01.000Z",
      error: "bootstrap failed",
      source: "bootstrap",
    });

    let spawnCalls = 0;
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          spawnCalls += 1;
          return { pid: 200 };
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
    });

    const result = await service.send({
      vigilId: "vigil-send-failed",
      message: "continue",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(true);
    expect(spawnCalls).toBe(0);
  });

  it("returns error when respawn bootstrap observer reports failure", async () => {
    const bootstrapObserver: PersistedBootstrapObserver = {
      async start() {
        return { pid: 6001, activate() {} };
      },
      async waitForOutcome() {
        return { status: "failed", error: 'Model "bad" not found' };
      },
      async shutdown() {},
    };
    const { service } = createSendFailureDeps(bootstrapObserver);

    const result = await service.send({
      vigilId: "vigil-send-target",
      message: "continue",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(formatVigilChildFailedError("vigil-send-target", 'Model "bad" not found'));
    }
  });

  it("returns running snapshot on successful send respawn", async () => {
    const bootstrapObserver = createFakePersistedBootstrapObserver();
    const { service } = createSendFailureDeps(bootstrapObserver);

    const result = await service.send({
      vigilId: "vigil-send-target",
      message: "continue",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.state).toBe("running");
    }
  });
});
