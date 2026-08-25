import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createInMemoryDescendantInspector } from "../../../src/vigil/descendant-inspector";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { formatListText, isVigilError, type VigilListResult } from "../../../src/vigil/types";

function createHarness(options?: {
  descendantSummary?: import("../../../src/vigil/descendant-inspector").VigilDirectSubagentInspection;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: { customType: string; data: unknown }[] = [];
  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: "Done.",
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
    descendantInspector: createInMemoryDescendantInspector({
      summaries: new Map([
        [
          "vigil-with-subs",
          options?.descendantSummary ?? {
            inspection: "available",
            total: 2,
            incomplete: 2,
            running: 1,
            waiting: 1,
            completed: 0,
            unknown: 0,
            items: [
              { id: "vigil-a1", sessionId: "vigil-a1", name: "Research API", state: "running" },
              { id: "vigil-a2", sessionId: "vigil-a2", name: "Write tests", state: "waiting" },
            ],
            omittedCount: 0,
          },
        ],
      ]),
    }),
    createId: () => "vigil-with-subs",
  });

  return { service };
}

function expectList(result: unknown): asserts result is VigilListResult {
  expect(isVigilError(result as never)).toBe(false);
}

describe("VigilService.list shallow descendant visibility", () => {
  it("hydrates each direct child with a bounded direct-subagent summary in structured output and text", async () => {
    const { service } = createHarness();
    await service.launch({ name: "Implement feature A", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });

    const result = await service.list({ includeCompleted: false });
    expectList(result);
    expect(result.vigils).toHaveLength(1);
    expect(result.vigils[0]?.directSubagents).toEqual(
      expect.objectContaining({
        inspection: "available",
        incomplete: 2,
        running: 1,
        waiting: 1,
      }),
    );

    const text = formatListText(result);
    expect(text).toContain("direct subagents: 2 incomplete (1 running, 1 waiting)");
    expect(text).toContain("Research API");
    expect(text).toContain("Write tests");
  });

  it("retains the root child with unavailable inspection rather than failing the entire list", async () => {
    const { service } = createHarness({
      descendantSummary: {
        inspection: "unavailable",
        error: "Child session ledger unavailable for direct subagent inspection",
      },
    });
    await service.launch({ name: "Broken ledger child", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });

    const result = await service.list({ includeCompleted: false });
    expectList(result);
    expect(result.vigils[0]?.directSubagents).toEqual({
      inspection: "unavailable",
      error: "Child session ledger unavailable for direct subagent inspection",
    });

    const text = formatListText(result);
    expect(text).toContain("direct subagents: inspection unavailable");
  });
});
