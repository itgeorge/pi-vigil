import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { formatVigilChildFailedError } from "../../../src/vigil/child-failure";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { isVigilError } from "../../../src/vigil/types";

function createPollFailureService(failRecord?: {
  id: string;
  sessionId: string;
  error: string;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  sessionManager.appendCustomEntry("vigil-launch", {
    id: "vigil-poll-fail",
    sessionId: "vigil-poll-fail",
    name: "Failed child",
    pid: 100,
    cwd: "/parent/default",
    launchedAt: "2026-08-01T10:00:00.000Z",
  });
  if (failRecord) {
    sessionManager.appendCustomEntry("vigil-fail", {
      ...failRecord,
      failedAt: "2026-08-01T10:00:01.000Z",
      source: "bootstrap",
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
      return { completedName: "[completed] Failed child" };
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
  });

  return service;
}

describe("VigilService.poll failure detection", () => {
  it("returns error when lifecycle has vigil-fail", async () => {
    const service = createPollFailureService({
      id: "vigil-poll-fail",
      sessionId: "vigil-poll-fail",
      error: 'Model "bad" not found',
    });

    const result = await service.poll("vigil-poll-fail");
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(
        formatVigilChildFailedError("vigil-poll-fail", 'Model "bad" not found'),
      );
    }
  });

  it("keeps waiting semantics when child is dead without vigil-fail yet", async () => {
    const service = createPollFailureService();

    const result = await service.poll("vigil-poll-fail");
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.state).toBe("waiting");
      expect(result.latestResponse).toBeNull();
    }
  });

  it("returns error after vigil-fail is appended later", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    appendEntry("vigil-launch", {
      id: "vigil-poll-late-fail",
      sessionId: "vigil-poll-late-fail",
      name: "Late fail",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
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
      parentLedger: createSessionParentLedger(sessionManager, appendEntry),
    });

    const beforeFail = await service.poll("vigil-poll-late-fail");
    expect(isVigilError(beforeFail)).toBe(false);

    appendEntry("vigil-fail", {
      id: "vigil-poll-late-fail",
      sessionId: "vigil-poll-late-fail",
      failedAt: "2026-08-01T10:00:01.000Z",
      error: "bootstrap watchdog timeout",
      source: "bootstrap",
    });

    const afterFail = await service.poll("vigil-poll-late-fail");
    expect(isVigilError(afterFail)).toBe(true);
  });

  it("returns error on complete for failed child", async () => {
    const service = createPollFailureService({
      id: "vigil-poll-fail",
      sessionId: "vigil-poll-fail",
      error: "bootstrap failed",
    });

    const result = await service.complete({ vigilId: "vigil-poll-fail", parentCwd: "/parent/default" });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(formatVigilChildFailedError("vigil-poll-fail", "bootstrap failed"));
    }
  });
});
