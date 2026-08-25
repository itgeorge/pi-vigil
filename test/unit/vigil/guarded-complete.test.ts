import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ChildSessionDescendantInspector,
  VigilDirectSubagentInspection,
} from "../../../src/vigil/descendant-inspector";
import { createInMemoryDescendantInspector } from "../../../src/vigil/descendant-inspector";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ParentLedger,
  ProcessRunner,
  SpawnChildInput,
} from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import {
  isVigilError,
  type VigilLaunchRecord,
  type VigilSnapshot,
} from "../../../src/vigil/types";

function createHarness(options?: {
  pid?: number;
  alive?: boolean;
  latestResponse?: string | null;
  turnComplete?: boolean;
  createId?: () => string;
  descendantInspector?: ChildSessionDescendantInspector;
  descendantSummaries?: Map<string, VigilDirectSubagentInspection>;
  renameError?: string;
  renamedTo?: string;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: { customType: string; data: unknown }[] = [];
  const spawnInputs: SpawnChildInput[] = [];
  const terminatedPids: number[] = [];
  let nextPid = options?.pid ?? 4242;
  let alive = options?.alive ?? true;
  const latestResponse = options?.latestResponse ?? null;
  const turnComplete = options?.turnComplete ?? false;

  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  const parentLedger: ParentLedger = createSessionParentLedger(sessionManager, appendEntry);

  const processRunner: ProcessRunner = {
    async spawnDetached(input) {
      spawnInputs.push(input);
      const pid = nextPid;
      nextPid += 1;
      alive = true;
      return { pid };
    },
    isAlive() {
      return alive;
    },
    async terminateAndWait(pid) {
      terminatedPids.push(pid);
      alive = false;
    },
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse,
        turnComplete,
        lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      if (options?.renameError) {
        return { error: options.renameError };
      }
      return { completedName: options?.renamedTo ?? "[completed] Test vigil" };
    },
  };

  const descendantInspector =
    options?.descendantInspector ??
    createInMemoryDescendantInspector({
      summaries: options?.descendantSummaries ?? new Map(),
    });

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    parentLedger,
    descendantInspector,
    createId: options?.createId,
  });

  return { service, captured, terminatedPids, descendantInspector };
}

function expectSnapshot(result: unknown): asserts result is VigilSnapshot {
  expect(isVigilError(result as never)).toBe(false);
}

const incompleteSummary = {
  inspection: "available" as const,
  total: 2,
  incomplete: 2,
  running: 1,
  waiting: 1,
  completed: 0,
  unknown: 0,
  items: [
    { id: "vigil-a1", sessionId: "vigil-a1", name: "Research API", state: "running" as const },
    { id: "vigil-a2", sessionId: "vigil-a2", name: "Write tests", state: "waiting" as const },
  ],
  omittedCount: 0,
};

describe("VigilService.complete guarded subagent policy", () => {
  it("rejects a settled direct parent with incomplete subagents before any mutation", async () => {
    const vigilId = "vigil-parent-incomplete";
    const { service, captured, terminatedPids } = createHarness({
      createId: () => vigilId,
      pid: 8100,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Parent task",
      descendantSummaries: new Map([[vigilId, incompleteSummary]]),
    });

    const launched = await service.launch({
      name: "Parent task",
      message: "work",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const result = await service.complete({ vigilId, parentCwd: "/parent/default" });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(
        "Cannot complete Vigil child vigil-parent-incomplete: 2 incomplete direct subagents (1 running, 1 waiting). Prompt the child to finish them, or pass allowIncompleteSubagents: true.",
      );
    }
    expect(terminatedPids).toEqual([]);
    expect(captured.some((entry) => entry.customType === "vigil-complete")).toBe(false);
  });

  it("allows normal completion when all direct subagents are completed", async () => {
    const vigilId = "vigil-parent-all-done";
    const { service, captured, terminatedPids } = createHarness({
      createId: () => vigilId,
      pid: 8200,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Parent done",
      descendantSummaries: new Map([
        [
          vigilId,
          {
            inspection: "available",
            total: 1,
            incomplete: 0,
            running: 0,
            waiting: 0,
            completed: 1,
            unknown: 0,
            items: [{ id: "vigil-a1", sessionId: "vigil-a1", name: "Sub", state: "completed" }],
            omittedCount: 0,
          },
        ],
      ]),
    });

    await service.launch({ name: "Parent done", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });
    const completed = await service.complete({ vigilId, parentCwd: "/parent/default" });
    expectSnapshot(completed);
    expect(completed.state).toBe("completed");
    expect(terminatedPids).toEqual([8200]);
    expect(captured.some((entry) => entry.customType === "vigil-complete")).toBe(true);
  });

  it("completes only the requested parent when allowIncompleteSubagents is true", async () => {
    const vigilId = "vigil-parent-override";
    const { service, captured, terminatedPids } = createHarness({
      createId: () => vigilId,
      pid: 8300,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Parent override",
      descendantSummaries: new Map([[vigilId, incompleteSummary]]),
    });

    await service.launch({ name: "Parent override", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });
    const completed = await service.complete({
      vigilId,
      parentCwd: "/parent/default",
      allowIncompleteSubagents: true,
    });
    expectSnapshot(completed);
    expect(completed.state).toBe("completed");
    expect(terminatedPids).toEqual([8300]);
    expect(captured.filter((entry) => entry.customType === "vigil-complete")).toHaveLength(1);
  });

  it("fails closed when descendant ledger inspection is unavailable even with allowIncompleteSubagents", async () => {
    const vigilId = "vigil-parent-unavailable";
    const { service, captured, terminatedPids } = createHarness({
      createId: () => vigilId,
      pid: 8400,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
      descendantSummaries: new Map([
        [vigilId, { inspection: "unavailable", error: "Child session ledger unavailable for direct subagent inspection" }],
      ]),
    });

    await service.launch({ name: "Parent unavailable", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });
    const result = await service.complete({
      vigilId,
      parentCwd: "/parent/default",
      allowIncompleteSubagents: true,
    });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("ledger unavailable");
    }
    expect(terminatedPids).toEqual([]);
    expect(captured.some((entry) => entry.customType === "vigil-complete")).toBe(false);
  });

  it("rejects still-running parents before descendant inspection or completion mutation", async () => {
    const vigilId = "vigil-parent-running";
    const inspectCalls: string[] = [];
    const descendantInspector = createInMemoryDescendantInspector({
      summaries: new Map([[vigilId, incompleteSummary]]),
    });
    const wrappedInspector: ChildSessionDescendantInspector = {
      inspectDirectSubagents: async (input) => {
        inspectCalls.push(input.sessionId);
        return descendantInspector.inspectDirectSubagents(input);
      },
    };

    const { service, captured } = createHarness({
      createId: () => vigilId,
      alive: true,
      latestResponse: "Working",
      turnComplete: false,
      descendantInspector: wrappedInspector,
    });

    await service.launch({ name: "Running parent", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });
    const result = await service.complete({ vigilId, parentCwd: "/parent/default" });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("running");
    }
    expect(inspectCalls).toEqual([]);
    expect(captured.some((entry) => entry.customType === "vigil-complete")).toBe(false);
  });

  it("returns existing completion snapshot without re-inspecting descendants", async () => {
    const vigilId = "vigil-parent-idempotent";
    const inspectCalls: string[] = [];
    const descendantInspector = createInMemoryDescendantInspector({
      summaries: new Map([[vigilId, incompleteSummary]]),
    });
    const wrappedInspector: ChildSessionDescendantInspector = {
      inspectDirectSubagents: async (input) => {
        inspectCalls.push(input.sessionId);
        return descendantInspector.inspectDirectSubagents(input);
      },
    };

    const { service } = createHarness({
      createId: () => vigilId,
      pid: 8500,
      alive: false,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Already done",
      descendantInspector: wrappedInspector,
      descendantSummaries: new Map([[vigilId, incompleteSummary]]),
    });

    await service.launch({ name: "Already done", message: "work", model: "openai-codex/gpt-5.5", parentCwd: "/parent/default" });
    const first = await service.complete({ vigilId, parentCwd: "/parent/default", allowIncompleteSubagents: true });
    expectSnapshot(first);
    expect(inspectCalls).toHaveLength(1);

    inspectCalls.length = 0;
    const second = await service.complete({ vigilId, parentCwd: "/parent/default" });
    expectSnapshot(second);
    expect(second).toEqual(first);
    expect(inspectCalls).toEqual([]);
  });
});
