import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createInMemoryDescendantInspector,
  createNodeChildSessionDescendantInspector,
  inspectDirectSubagentsFromEntries,
  MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS,
  type VigilDirectSubagentSummary,
} from "../../../src/vigil/descendant-inspector";
import type { VigilCompletionRecord, VigilLaunchRecord } from "../../../src/vigil/types";

function appendLaunch(sessionManager: SessionManager, record: VigilLaunchRecord): void {
  sessionManager.appendCustomEntry("vigil-launch", record);
}

function appendComplete(sessionManager: SessionManager, record: VigilCompletionRecord): void {
  sessionManager.appendCustomEntry("vigil-complete", record);
}

function launchRecord(
  id: string,
  overrides?: Partial<VigilLaunchRecord>,
): VigilLaunchRecord {
  return {
    id,
    sessionId: id,
    name: `Task ${id}`,
    pid: 100,
    cwd: "/parent/intermediate",
    launchedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("inspectDirectSubagentsFromEntries", () => {
  it("produces a one-level direct-descendant summary with deterministic counts", async () => {
    const sessionManager = SessionManager.inMemory("/parent/intermediate");
    appendLaunch(sessionManager, launchRecord("vigil-a1", { name: "Research API", pid: 201 }));
    appendLaunch(sessionManager, launchRecord("vigil-a2", { name: "Write tests", pid: 202 }));
    appendLaunch(sessionManager, launchRecord("vigil-a3", { name: "Docs", pid: 203 }));
    appendComplete(sessionManager, {
      id: "vigil-a3",
      sessionId: "vigil-a3",
      name: "[completed] Docs",
      cwd: "/parent/intermediate",
      completedAt: "2026-08-01T12:00:00.000Z",
    });

    const reader: ChildSessionReader = {
      async readChildSessionState({ sessionId }) {
        if (sessionId === "vigil-a1") {
          return {
            latestResponse: "Working",
            turnComplete: false,
            lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        }
        if (sessionId === "vigil-a2") {
          return {
            latestResponse: "Done.",
            turnComplete: true,
            lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        }
        return {
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: null,
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        };
      },
    };

    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: (pid) => pid === 201,
      terminateAndWait: async () => undefined,
    };

    const result = await inspectDirectSubagentsFromEntries(sessionManager.getEntries(), reader, runner);

    expect(result.inspection).toBe("available");
    if (result.inspection !== "available") {
      return;
    }
    expect(result.total).toBe(3);
    expect(result.incomplete).toBe(2);
    expect(result.running).toBe(1);
    expect(result.waiting).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.unknown).toBe(0);
    expect(result.items.map((item) => item.id).sort()).toEqual(["vigil-a1", "vigil-a2", "vigil-a3"]);
    expect(result.items.find((item) => item.id === "vigil-a1")).toEqual(
      expect.objectContaining({ name: "Research API", state: "running" }),
    );
    expect(result.items.find((item) => item.id === "vigil-a2")).toEqual(
      expect.objectContaining({ name: "Write tests", state: "waiting" }),
    );
    expect(result.items.find((item) => item.id === "vigil-a3")).toEqual(
      expect.objectContaining({ name: "[completed] Docs", state: "completed" }),
    );
  });

  it("does not inspect deeper than one level even when a direct descendant session contains nested ledger records", async () => {
    const sessionManager = SessionManager.inMemory("/parent/intermediate");
    appendLaunch(sessionManager, launchRecord("vigil-a1", { name: "Parent subtask", pid: 301 }));

    const nestedSessionManager = SessionManager.inMemory("/parent/intermediate");
    appendLaunch(nestedSessionManager, launchRecord("vigil-grandchild", { name: "Should not appear", pid: 401 }));

    const reader: ChildSessionReader = {
      async readChildSessionState({ sessionId }) {
        if (sessionId === "vigil-a1") {
          return {
            latestResponse: null,
            turnComplete: false,
            lastConversationTimestamp: null,
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        }
        return {
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: null,
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        };
      },
    };

    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: () => true,
      terminateAndWait: async () => undefined,
    };

    const result = await inspectDirectSubagentsFromEntries(sessionManager.getEntries(), reader, runner);

    expect(result.inspection).toBe("available");
    if (result.inspection !== "available") {
      return;
    }
    expect(result.total).toBe(1);
    expect(result.items.some((item) => item.id === "vigil-grandchild")).toBe(false);
  });

  it("inherits lifecycle reconstruction hardening for malformed and duplicate descendant records", async () => {
    const sessionManager = SessionManager.inMemory("/parent/intermediate");
    sessionManager.appendCustomEntry("vigil-launch", { id: "broken" });
    appendLaunch(sessionManager, launchRecord("vigil-valid", { name: "Valid", pid: 501 }));
    appendLaunch(sessionManager, launchRecord("vigil-valid", { name: "Duplicate", pid: 502 }));

    const reader: ChildSessionReader = {
      async readChildSessionState() {
        return {
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: null,
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        };
      },
    };

    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: () => false,
      terminateAndWait: async () => undefined,
    };

    const result = await inspectDirectSubagentsFromEntries(sessionManager.getEntries(), reader, runner);

    expect(result.inspection).toBe("available");
    if (result.inspection !== "available") {
      return;
    }
    expect(result.total).toBe(1);
    expect(result.items[0]?.id).toBe("vigil-valid");
  });

  it("returns verified zero when the intermediate child has no direct descendants", async () => {
    const sessionManager = SessionManager.inMemory("/parent/intermediate");
    sessionManager.appendCustomEntry("other-extension", { id: "noise" });

    const reader: ChildSessionReader = {
      async readChildSessionState() {
        return {
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: null,
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        };
      },
    };

    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: () => false,
      terminateAndWait: async () => undefined,
    };

    const result = await inspectDirectSubagentsFromEntries(sessionManager.getEntries(), reader, runner);

    expect(result).toEqual({
      inspection: "available",
      total: 0,
      incomplete: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      unknown: 0,
      items: [],
      omittedCount: 0,
    });
  });

  it("reports unknown state for a direct descendant whose live session cannot be inspected", async () => {
    const sessionManager = SessionManager.inMemory("/parent/intermediate");
    appendLaunch(sessionManager, launchRecord("vigil-a1", { name: "Opaque child", pid: 601 }));

    const reader: ChildSessionReader = {
      async readChildSessionState() {
        throw new Error("session read failed");
      },
    };

    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: () => true,
      terminateAndWait: async () => undefined,
    };

    const result = await inspectDirectSubagentsFromEntries(sessionManager.getEntries(), reader, runner);

    expect(result.inspection).toBe("available");
    if (result.inspection !== "available") {
      return;
    }
    expect(result.unknown).toBe(1);
    expect(result.incomplete).toBe(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ id: "vigil-a1", name: "Opaque child", state: "unknown" }),
    );
  });

  it("bounds the display item list while keeping full counts", async () => {
    const sessionManager = SessionManager.inMemory("/parent/intermediate");
    for (let index = 0; index < MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS + 5; index += 1) {
      appendLaunch(
        sessionManager,
        launchRecord(`vigil-item-${index}`, {
          name: `Sub ${index}`,
          pid: 700 + index,
          launchedAt: `2026-08-01T10:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    const reader: ChildSessionReader = {
      async readChildSessionState() {
        return {
          latestResponse: null,
          turnComplete: false,
          lastConversationTimestamp: null,
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        };
      },
    };

    const runner: ProcessRunner = {
      spawnDetached: async () => ({ pid: 9999 }),
      isAlive: () => false,
      terminateAndWait: async () => undefined,
    };

    const result = (await inspectDirectSubagentsFromEntries(
      sessionManager.getEntries(),
      reader,
      runner,
    )) as VigilDirectSubagentSummary;

    expect(result.total).toBe(MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS + 5);
    expect(result.incomplete).toBe(MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS + 5);
    expect(result.items).toHaveLength(MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS);
    expect(result.omittedCount).toBe(5);
  });
});

describe("createInMemoryDescendantInspector", () => {
  it("distinguishes unavailable child-ledger inspection from verified zero descendants", async () => {
    const available = createInMemoryDescendantInspector({
      summaries: new Map([
        [
          "vigil-parent",
          {
            inspection: "available",
            total: 0,
            incomplete: 0,
            running: 0,
            waiting: 0,
            completed: 0,
            unknown: 0,
            items: [],
            omittedCount: 0,
          },
        ],
        [
          "vigil-missing",
          { inspection: "unavailable", error: "Child session ledger unavailable" },
        ],
      ]),
    });

    const zero = await available.inspectDirectSubagents({
      sessionId: "vigil-parent",
      cwd: "/parent",
    });
    expect(zero.inspection).toBe("available");
    if (zero.inspection === "available") {
      expect(zero.total).toBe(0);
    }

    const unavailable = await available.inspectDirectSubagents({
      sessionId: "vigil-missing",
      cwd: "/parent",
    });
    expect(unavailable).toEqual({
      inspection: "unavailable",
      error: "Child session ledger unavailable",
    });
  });
});

describe("formatDirectSubagentItemLine", () => {
  it("uses fixed safe placeholders when sanitizer output is empty instead of raw name/id", async () => {
    const { formatDirectSubagentItemLine } = await import("../../../src/vigil/descendant-inspector");
    const maliciousName = "\u0007\u001b[31m\nhidden\u001b[0m";
    const maliciousId = "\u0007\u001b[31m\nhidden-id\u001b[0m";

    const line = formatDirectSubagentItemLine({
      id: maliciousId,
      sessionId: maliciousId,
      name: maliciousName,
      state: "waiting",
    });

    expect(line).not.toContain("hidden");
    expect(line).not.toMatch(/\u001b|\u0007/);
    expect(line).toContain("[unnamed subagent]");
    expect(line).toContain("[id unavailable]");
  });
});

describe("createNodeChildSessionDescendantInspector", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createPersistedIntermediateSession(options: {
    cwd: string;
    sessionDir: string;
    sessionId: string;
    launches: VigilLaunchRecord[];
  }): string {
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(options.sessionDir, `${fileTimestamp}_${options.sessionId}.jsonl`);
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: options.sessionId,
        timestamp,
        cwd: options.cwd,
      })}\n`,
    );

    const sessionManager = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
    for (const launch of options.launches) {
      sessionManager.appendCustomEntry("vigil-launch", launch);
    }
    return sessionFile;
  }

  it("maps a direct descendant with a missing session file to unknown while retaining the intermediate ledger summary", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-descendant-cwd-"));
    const sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-descendant-sessions-"));
    tempDirs.push(cwd, sessionDir);

    const intermediateSessionId = "vigil-intermediate-parent";
    createPersistedIntermediateSession({
      cwd,
      sessionDir,
      sessionId: intermediateSessionId,
      launches: [launchRecord("vigil-a1", { name: "Missing session child", pid: 801 })],
    });

    const inspector = createNodeChildSessionDescendantInspector({
      childSessionReader: {
        async readChildSessionState() {
          throw new Error("poll reader must not be used for descendant inspection");
        },
      },
      processRunner: {
        spawnDetached: async () => ({ pid: 1 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
    });

    const result = await inspector.inspectDirectSubagents({
      sessionId: intermediateSessionId,
      cwd,
      sessionDir,
    });

    expect(result.inspection).toBe("available");
    if (result.inspection !== "available") {
      return;
    }
    expect(result.total).toBe(1);
    expect(result.unknown).toBe(1);
    expect(result.incomplete).toBe(1);
    expect(result.waiting).toBe(0);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ id: "vigil-a1", name: "Missing session child", state: "unknown" }),
    );
  });

  it("returns unavailable when the intermediate child session cannot be resolved", async () => {
    const inspector = createNodeChildSessionDescendantInspector({
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
      processRunner: {
        spawnDetached: async () => ({ pid: 1 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
    });

    const result = await inspector.inspectDirectSubagents({
      sessionId: "vigil-nonexistent",
      cwd: "/parent/intermediate",
    });

    expect(result.inspection).toBe("unavailable");
    if (result.inspection === "unavailable") {
      expect(result.error).toContain("ledger");
      expect(result.error).not.toMatch(/\/Users\//);
    }
  });
});
