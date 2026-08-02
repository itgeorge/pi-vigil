import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ChildSessionDescendantInspector,
  VigilDirectSubagentInspection,
} from "../../../src/vigil/descendant-inspector";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ProcessRunner,
  VigilSessionActivity,
  WaitScheduler,
} from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import {
  isVigilError,
  type VigilCompletionRecord,
  type VigilLaunchRecord,
} from "../../../src/vigil/types";

class FakeScheduler implements WaitScheduler {
  time = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<"elapsed" | "cancelled"> {
    this.sleeps.push(ms);
    this.time += ms;
    return "elapsed";
  }
}

const defaultActivity = (): VigilSessionActivity => ({
  steps: 0,
  messages: 0,
  lastActivity: null,
  lastActivityTimestamp: null,
  recentMessages: [],
});

function siblingRecord(id: string, pid: number): VigilLaunchRecord {
  return { id, sessionId: id, name: `Task ${id}`, pid, cwd: "/parent", launchedAt: "2026-08-01T10:00:00.000Z" };
}

function selfSessionRecord(
  parentSessionId: string,
  options?: { vigilId?: string; pid?: number; cwd?: string },
): VigilLaunchRecord {
  return {
    id: options?.vigilId ?? "vigil-self-alias",
    sessionId: parentSessionId,
    name: "Current session target",
    pid: options?.pid ?? 4242,
    cwd: options?.cwd ?? "/parent",
    launchedAt: "2026-08-01T10:00:00.000Z",
  };
}

function createHarness(options: {
  parentSessionId: string;
  records: VigilLaunchRecord[];
  completionFor?: VigilCompletionRecord;
  turnComplete?: boolean;
  latestResponse?: string | null;
}) {
  const sessionManager = SessionManager.inMemory("/parent");
  const captured: { customType: string; data: unknown }[] = [];
  for (const record of options.records) {
    sessionManager.appendCustomEntry("vigil-launch", record);
  }
  if (options.completionFor) {
    sessionManager.appendCustomEntry("vigil-complete", options.completionFor);
  }

  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  let readerCalls = 0;
  let inspectorCalls = 0;
  let spawned = 0;
  let reaped = 0;
  let renamed = 0;

  const reader: ChildSessionReader = {
    async readChildSessionState() {
      readerCalls += 1;
      return {
        latestResponse: options.latestResponse ?? "Child response.",
        turnComplete: options.turnComplete ?? true,
        lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        activity: defaultActivity(),
      };
    },
  };

  const descendantInspector: ChildSessionDescendantInspector = {
    inspectDirectSubagents: async () => {
      inspectorCalls += 1;
      return {
        inspection: "available",
        total: 0,
        incomplete: 0,
        running: 0,
        waiting: 0,
        completed: 0,
        unknown: 0,
        items: [],
        omittedCount: 0,
      } satisfies VigilDirectSubagentInspection;
    },
  };

  const runner: ProcessRunner = {
    spawnDetached: async () => {
      spawned += 1;
      return { pid: 9999 };
    },
    isAlive: () => true,
    terminateAndWait: async () => {
      reaped += 1;
    },
  };

  const namer: ChildSessionNamer = {
    markCompleted: async () => {
      renamed += 1;
      return { completedName: "[completed] Current session target" };
    },
  };

  const scheduler = new FakeScheduler();
  const service = new VigilService({
    processRunner: runner,
    childSessionReader: reader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer: namer,
    descendantInspector,
    parentLedger: createSessionParentLedger(sessionManager, appendEntry),
    waitScheduler: scheduler,
    currentParentSessionId: options.parentSessionId,
  });

  return {
    service,
    scheduler,
    captured,
    mutations: () => ({ readerCalls, inspectorCalls, spawned, reaped, renamed }),
  };
}

describe("VigilService current-session lifecycle guard", () => {
  it("poll rejects a canonical self-session target before child observation", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const record = selfSessionRecord(parentSessionId);
    const { service, mutations } = createHarness({ parentSessionId, records: [record] });

    const result = await service.poll(record.id);

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Cannot poll the current Vigil session.");
    }
    expect(mutations()).toEqual({
      readerCalls: 0,
      inspectorCalls: 0,
      spawned: 0,
      reaped: 0,
      renamed: 0,
    });
  });

  it("send rejects a canonical self-session target before reaping or spawning", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const record = selfSessionRecord(parentSessionId);
    const { service, captured, mutations } = createHarness({ parentSessionId, records: [record] });

    const result = await service.send({
      vigilId: record.id,
      message: "continue",
      parentCwd: "/parent",
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Cannot send the current Vigil session.");
    }
    expect(captured).toEqual([]);
    expect(mutations()).toEqual({
      readerCalls: 0,
      inspectorCalls: 0,
      spawned: 0,
      reaped: 0,
      renamed: 0,
    });
  });

  it("complete rejects a settled self-session target before descendant inspection or mutation", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const record = selfSessionRecord(parentSessionId);
    const { service, captured, mutations } = createHarness({
      parentSessionId,
      records: [record],
      turnComplete: true,
    });

    const result = await service.complete({ vigilId: record.id, parentCwd: "/parent" });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Cannot complete the current Vigil session.");
    }
    expect(captured).toEqual([]);
    expect(mutations()).toEqual({
      readerCalls: 0,
      inspectorCalls: 0,
      spawned: 0,
      reaped: 0,
      renamed: 0,
    });
  });

  it("complete rejects an already completed self-session target even with allowIncompleteSubagents", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const record = selfSessionRecord(parentSessionId);
    const completion: VigilCompletionRecord = {
      id: record.id,
      sessionId: record.sessionId,
      name: "[completed] Current session target",
      cwd: record.cwd,
      completedAt: "2026-08-01T12:00:00.000Z",
    };
    const { service, captured, mutations } = createHarness({
      parentSessionId,
      records: [record],
      completionFor: completion,
    });

    const result = await service.complete({
      vigilId: record.id,
      parentCwd: "/parent",
      allowIncompleteSubagents: true,
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Cannot complete the current Vigil session.");
    }
    expect(captured).toEqual([]);
    expect(mutations()).toEqual({
      readerCalls: 0,
      inspectorCalls: 0,
      spawned: 0,
      reaped: 0,
      renamed: 0,
    });
  });

  it("targeted wait rejects a self-session target before scan or process work", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const record = selfSessionRecord(parentSessionId);
    const { service, scheduler, mutations } = createHarness({ parentSessionId, records: [record] });

    const result = await service.wait({ id: record.id });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Cannot wait the current Vigil session.");
    }
    expect(scheduler.sleeps).toEqual([]);
    expect(mutations()).toEqual({
      readerCalls: 0,
      inspectorCalls: 0,
      spawned: 0,
      reaped: 0,
      renamed: 0,
    });
  });

  it("unselected wait fails closed when the active cohort includes a self-session target alongside a sibling", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const self = selfSessionRecord(parentSessionId, { vigilId: "vigil-self" });
    const sibling = siblingRecord("vigil-sibling", 2);
    const { service, scheduler, mutations } = createHarness({
      parentSessionId,
      records: [self, sibling],
      turnComplete: true,
    });

    const result = await service.wait({});

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Cannot wait the current Vigil session.");
    }
    expect(scheduler.sleeps).toEqual([]);
    expect(mutations()).toEqual({
      readerCalls: 0,
      inspectorCalls: 0,
      spawned: 0,
      reaped: 0,
      renamed: 0,
    });
  });

  it("preserves unknown-id ordering for poll before any self guard", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const { service, mutations } = createHarness({ parentSessionId, records: [] });

    const result = await service.poll("vigil-missing");

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe("Unknown vigil id: vigil-missing");
    }
    expect(mutations().readerCalls).toBe(0);
  });

  it("allows normal poll for a non-self sibling child", async () => {
    const sessionManager = SessionManager.inMemory("/parent");
    const parentSessionId = sessionManager.getSessionId();
    const sibling = siblingRecord("vigil-sibling", 2);
    const { service, mutations } = createHarness({
      parentSessionId,
      records: [sibling],
      turnComplete: true,
    });

    const result = await service.poll(sibling.id);

    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.id).toBe("vigil-sibling");
      expect(result.state).toBe("waiting");
    }
    expect(mutations().readerCalls).toBe(1);
  });
});
