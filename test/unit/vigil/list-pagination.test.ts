import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createZeroDescendantInspector,
  type ChildSessionDescendantInspector,
} from "../../../src/vigil/descendant-inspector";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import {
  DEFAULT_LIST_MAX_RESULTS,
  formatListText,
  isVigilError,
  MAX_LIST_MAX_RESULTS,
  resolveListPolicy,
  type VigilLaunchRecord,
  type VigilListResult,
} from "../../../src/vigil/types";
import {
  formatVigilCallSummary,
  formatVigilShortId,
} from "../../../src/vigil/render-call";

function makeLaunchRecords(count: number): VigilLaunchRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const id = `vigil-${String(ordinal).padStart(3, "0")}`;
    return {
      id,
      sessionId: id,
      name: `Task ${ordinal}`,
      pid: 1000 + ordinal,
      cwd: "/parent/default",
      launchedAt: new Date(Date.UTC(2026, 7, 2, 12, index)).toISOString(),
    };
  });
}

function createHarness(options?: {
  recordCount?: number;
  includeCompletedRecord?: VigilLaunchRecord;
  descendantInspector?: ChildSessionDescendantInspector;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: { customType: string; data: unknown }[] = [];
  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  for (const record of makeLaunchRecords(options?.recordCount ?? 25)) {
    appendEntry("vigil-launch", record);
  }

  if (options?.includeCompletedRecord) {
    appendEntry("vigil-launch", options.includeCompletedRecord);
    appendEntry("vigil-complete", {
      id: options.includeCompletedRecord.id,
      sessionId: options.includeCompletedRecord.sessionId,
      name: "[completed] Done task",
      cwd: options.includeCompletedRecord.cwd,
      completedAt: "2026-08-02T13:00:00.000Z",
    });
  }

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: null,
        turnComplete: true,
        lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const processRunner: ProcessRunner = {
    spawnDetached: async () => ({ pid: 9001 }),
    isAlive: () => false,
    terminateAndWait: async () => undefined,
  };

  const childSessionNamer: ChildSessionNamer = {
    markCompleted: async () => ({ completedName: "[completed] unused" }),
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    parentLedger: createSessionParentLedger(sessionManager, appendEntry),
    descendantInspector: options?.descendantInspector ?? createZeroDescendantInspector(),
  });

  return { service, captured, sessionManager };
}

function expectList(result: unknown): asserts result is VigilListResult {
  expect(isVigilError(result as never)).toBe(false);
}

describe("resolveListPolicy", () => {
  it("defaults maxResults to 20 and rejects out-of-range values before list work", () => {
    expect(resolveListPolicy({})).toEqual({ includeCompleted: false, maxResults: DEFAULT_LIST_MAX_RESULTS });
    expect(resolveListPolicy({ maxResults: 51 })).toEqual({
      error: `maxResults must be a positive safe integer no greater than ${MAX_LIST_MAX_RESULTS}`,
    });
    expect(resolveListPolicy({ maxResults: 0 })).toEqual({
      error: `maxResults must be a positive safe integer no greater than ${MAX_LIST_MAX_RESULTS}`,
    });
    expect(resolveListPolicy({ maxResults: 1.5 })).toEqual({
      error: `maxResults must be a positive safe integer no greater than ${MAX_LIST_MAX_RESULTS}`,
    });
  });

  it("rejects whitespace-invalid skipToId before list work", () => {
    expect(resolveListPolicy({ skipToId: " vigil-001" })).toEqual({
      error: "skipToId must not contain leading or trailing whitespace",
    });
    expect(resolveListPolicy({ skipToId: "" })).toEqual({
      error: "skipToId must be nonblank when supplied",
    });
  });
});

describe("VigilService.list pagination", () => {
  it("caps the default page at 20 items and exposes nextSkipToId for older children", async () => {
    const { service } = createHarness({ recordCount: 25 });

    const result = await service.list({});
    expectList(result);
    expect(result.vigils).toHaveLength(DEFAULT_LIST_MAX_RESULTS);
    expect(result.vigils.map((item) => item.id)).toEqual([
      "vigil-025",
      "vigil-024",
      "vigil-023",
      "vigil-022",
      "vigil-021",
      "vigil-020",
      "vigil-019",
      "vigil-018",
      "vigil-017",
      "vigil-016",
      "vigil-015",
      "vigil-014",
      "vigil-013",
      "vigil-012",
      "vigil-011",
      "vigil-010",
      "vigil-009",
      "vigil-008",
      "vigil-007",
      "vigil-006",
    ]);
    expect(result.omittedCount).toBe(5);
    expect(result.nextSkipToId).toBe("vigil-005");
  });

  it("returns the inclusive next page from skipToId without duplicating prior items", async () => {
    const { service } = createHarness({ recordCount: 25 });

    const firstPage = await service.list({});
    expectList(firstPage);

    const secondPage = await service.list({ skipToId: firstPage.nextSkipToId });
    expectList(secondPage);
    expect(secondPage.vigils.map((item) => item.id)).toEqual([
      "vigil-005",
      "vigil-004",
      "vigil-003",
      "vigil-002",
      "vigil-001",
    ]);
    expect(secondPage.omittedCount).toBe(0);
    expect(secondPage.nextSkipToId).toBeUndefined();

    const firstIds = new Set(firstPage.vigils.map((item) => item.id));
    for (const item of secondPage.vigils) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });

  it("rejects skipToId for failed child without includeCompleted", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    const captured: { customType: string; data: unknown }[] = [];
    const appendEntry = (customType: string, data: unknown) => {
      captured.push({ customType, data });
      sessionManager.appendCustomEntry(customType, data);
    };
    appendEntry("vigil-launch", {
      id: "vigil-failed",
      sessionId: "vigil-failed",
      name: "Failed",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });
    appendEntry("vigil-fail", {
      id: "vigil-failed",
      sessionId: "vigil-failed",
      failedAt: "2026-08-01T10:00:01.000Z",
      error: "bootstrap failed",
      source: "bootstrap",
    });

    const service = new VigilService({
      processRunner: {
        spawnDetached: async () => ({ pid: 9001 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
      childSessionReader: {
        async readChildSessionState() {
          return {
            latestResponse: null,
            turnComplete: true,
            lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        markCompleted: async () => ({ completedName: "[completed] unused" }),
      },
      parentLedger: createSessionParentLedger(sessionManager, appendEntry),
      descendantInspector: createZeroDescendantInspector(),
    });

    const result = await service.list({ skipToId: "vigil-failed" });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("Failed vigil child excluded");
      expect(result.error).toContain("includeCompleted: true");
    }
  });

  it("rejects unknown, whitespace-invalid, and includeCompleted-excluded skipToId values", async () => {
    const { service } = createHarness({
      recordCount: 1,
      includeCompletedRecord: {
        id: "vigil-done",
        sessionId: "vigil-done",
        name: "Done task",
        pid: 2000,
        cwd: "/parent/default",
        launchedAt: "2026-08-01T08:00:00.000Z",
      },
    });

    const unknown = await service.list({ skipToId: "vigil-missing" });
    expect(isVigilError(unknown)).toBe(true);
    if (isVigilError(unknown)) {
      expect(unknown.error).toContain("Unknown vigil id");
    }

    const excluded = await service.list({ skipToId: "vigil-done" });
    expect(isVigilError(excluded)).toBe(true);
    if (isVigilError(excluded)) {
      expect(excluded.error).toContain("Completed vigil child excluded");
    }

    const whitespace = await service.list({ skipToId: " vigil-001" });
    expect(isVigilError(whitespace)).toBe(true);
    if (isVigilError(whitespace)) {
      expect(whitespace.error).toContain("skipToId must not contain leading or trailing whitespace");
    }
  });

  it("does not append ledger entries when paginating with skipToId", async () => {
    const { service, captured } = createHarness({ recordCount: 25 });
    const before = captured.length;

    const result = await service.list({ skipToId: "vigil-010", maxResults: 5 });
    expectList(result);
    expect(captured).toHaveLength(before);
    expect(result.vigils[0]?.id).toBe("vigil-010");
  });

  it("hydrates direct subagent summaries only for returned page items", async () => {
    const inspectDirectSubagents = vi.fn(async () => ({
      inspection: "available" as const,
      total: 0,
      incomplete: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      unknown: 0,
      items: [],
      omittedCount: 0,
    }));
    const { service } = createHarness({
      recordCount: 25,
      descendantInspector: { inspectDirectSubagents },
    });

    await service.list({ maxResults: 5 });
    expect(inspectDirectSubagents).toHaveBeenCalledTimes(5);
  });

  it("keeps backward-compatible vigils fields and reports zero omission for exhaustive pages", async () => {
    const { service } = createHarness({ recordCount: 3 });

    const result = await service.list({ maxResults: 10 });
    expectList(result);
    expect(result.vigils).toHaveLength(3);
    expect(result.omittedCount).toBe(0);
    expect(result.nextSkipToId).toBeUndefined();
    for (const item of result.vigils) {
      expect(item).toEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^vigil-/),
          sessionId: expect.any(String),
          name: expect.any(String),
          cwd: "/parent/default",
          state: expect.any(String),
        }),
      );
      expect(item).not.toHaveProperty("latestResponse");
    }
  });
});

describe("formatListText pagination", () => {
  it("reports truncation with actionable guidance and a safe next skipToId", () => {
    const result: VigilListResult = {
      vigils: [
        {
          id: "vigil-025",
          sessionId: "vigil-025",
          name: "Task 25",
          cwd: "/parent/default",
          state: "waiting",
        },
      ],
      omittedCount: 4,
      nextSkipToId: "vigil-024",
    };

    const text = formatListText(result);
    expect(text).toContain("4 more children omitted.");
    expect(text).toContain("Use maxResults to expand this page or skipToId to retrieve older children.");
    expect(text).toContain(`next skipToId: vigil-024`);
  });

  it("omits truncation guidance for exhaustive and empty lists", () => {
    expect(
      formatListText({
        vigils: [],
        omittedCount: 0,
      }),
    ).toBe("vigils: (none)");

    expect(
      formatListText({
        vigils: [
          {
            id: "vigil-001",
            sessionId: "vigil-001",
            name: "Only task",
            cwd: "/parent/default",
            state: "waiting",
          },
        ],
        omittedCount: 0,
      }),
    ).not.toContain("more children omitted");
  });
});

describe("formatVigilCallSummary list pagination", () => {
  it("exposes bounded maxResults and skipToId in compact list summaries", () => {
    expect(formatVigilCallSummary({ action: "list", maxResults: 50, skipToId: "vigil-005" })).toBe(
      `list · active · max 50 · from ${formatVigilShortId("vigil-005")}`,
    );
    expect(formatVigilCallSummary({ action: "list", includeCompleted: true, maxResults: 10 })).toBe(
      "list · including completed · max 10",
    );
  });
});
