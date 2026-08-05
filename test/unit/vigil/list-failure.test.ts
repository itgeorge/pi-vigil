import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";

function createListFailureService() {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const appendEntry = (customType: string, data: unknown) => {
    sessionManager.appendCustomEntry(customType, data);
  };

  appendEntry("vigil-launch", {
    id: "vigil-list-active",
    sessionId: "vigil-list-active",
    name: "Active",
    pid: 100,
    cwd: "/parent/default",
    launchedAt: "2026-08-01T12:00:00.000Z",
  });
  appendEntry("vigil-launch", {
    id: "vigil-list-failed",
    sessionId: "vigil-list-failed",
    name: "Failed",
    pid: 101,
    cwd: "/parent/default",
    launchedAt: "2026-08-01T10:00:00.000Z",
  });
  appendEntry("vigil-fail", {
    id: "vigil-list-failed",
    sessionId: "vigil-list-failed",
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
      return { completedName: "[completed]" };
    },
  };

  return new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger: createSessionParentLedger(sessionManager, appendEntry),
  });
}

describe("VigilService.list failure detection", () => {
  it("includes failed child with state failed in includeCompleted listing", async () => {
    const service = createListFailureService();
    const result = await service.list({ includeCompleted: true });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      const failed = result.vigils.find((item) => item.id === "vigil-list-failed");
      expect(failed?.state).toBe("failed");
    }
  });

  it("excludes failed child from default active listing", async () => {
    const service = createListFailureService();
    const result = await service.list();
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.vigils.map((item) => item.id)).toEqual(["vigil-list-active"]);
    }
  });
});
