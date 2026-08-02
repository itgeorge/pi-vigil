import { describe, expect, it } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import type {
  ChildSessionNamer,
  ChildSessionReader,
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
  type VigilCompletionRecord,
  type VigilLaunchRecord,
  type VigilReadResult,
  type VigilSearchResult,
  type VigilTurnRecord,
} from "../../../src/vigil/types";
import { createInMemoryTranscriptReader, transcriptFromEntries } from "../../helpers/transcript-fake";

function messageEntry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T12:00:02.000Z",
    message:
      role === "assistant"
        ? {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.5",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1722513602000,
          }
        : {
            role: "user",
            content: [{ type: "text", text }],
            timestamp: 1722513601000,
          },
  };
}

function createHarness(options?: {
  launches?: VigilLaunchRecord[];
  completions?: VigilCompletionRecord[];
  turns?: VigilTurnRecord[];
  transcripts?: Record<string, ReturnType<typeof transcriptFromEntries> | { error: string }>;
  alive?: boolean;
  turnComplete?: boolean;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: { customType: string; data: unknown }[] = [];
  const spawnInputs: SpawnChildInput[] = [];
  const terminatedPids: number[] = [];
  let alive = options?.alive ?? false;

  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  for (const record of options?.launches ?? []) {
    appendEntry("vigil-launch", record);
  }
  for (const record of options?.turns ?? []) {
    appendEntry("vigil-turn", record);
  }
  for (const record of options?.completions ?? []) {
    appendEntry("vigil-complete", record);
  }

  const parentLedger = createSessionParentLedger(sessionManager, appendEntry);

  const processRunner: ProcessRunner = {
    async spawnDetached(input) {
      spawnInputs.push(input);
      alive = true;
      return { pid: 9000 + spawnInputs.length };
    },
    isAlive: () => alive,
    async terminateAndWait(pid) {
      terminatedPids.push(pid);
      alive = false;
    },
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: "latest",
        turnComplete: options?.turnComplete ?? true,
        lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        activity: { steps: 2, messages: 2, lastActivity: "assistant response", lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Task" };
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: options?.transcripts
      ? createInMemoryTranscriptReader(options.transcripts)
      : createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger,
  });

  return { service, captured, spawnInputs, terminatedPids, sessionManager, appendEntry };
}

describe("VigilService.search", () => {
  it("searches active children by default and supports includeCompleted", async () => {
    const activeLaunch: VigilLaunchRecord = {
      id: "vigil-active",
      sessionId: "vigil-active",
      name: "Active task",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };
    const completedLaunch: VigilLaunchRecord = {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "Done task",
      pid: 101,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T09:00:00.000Z",
    };
    const completion: VigilCompletionRecord = {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "[completed] Done task",
      cwd: "/parent/default",
      completedAt: "2026-08-01T11:00:00.000Z",
    };

    const { service } = createHarness({
      launches: [activeLaunch, completedLaunch],
      completions: [completion],
      transcripts: {
        "vigil-active": transcriptFromEntries([
          messageEntry("active-entry", null, "assistant", "ACTIVE_MARKER alpha"),
        ]),
        "vigil-done": transcriptFromEntries([
          messageEntry("done-entry", null, "assistant", "COMPLETED_MARKER beta"),
        ]),
      },
    });

    const activeOnly = await service.search({ query: "marker" });
    expect(isVigilError(activeOnly)).toBe(false);
    expect((activeOnly as VigilSearchResult).matches.map((match) => match.id)).toEqual(["vigil-active"]);

    const withCompleted = await service.search({ query: "marker", includeCompleted: true });
    expect((withCompleted as VigilSearchResult).matches.map((match) => match.id)).toEqual([
      "vigil-done",
      "vigil-active",
    ]);
  });

  it("restricts search to an explicit id and rejects unknown or excluded completed ids", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-target",
      sessionId: "vigil-target",
      name: "Target",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };
    const other: VigilLaunchRecord = {
      id: "vigil-other",
      sessionId: "vigil-other",
      name: "Other",
      pid: 101,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T09:00:00.000Z",
    };

    const { service } = createHarness({
      launches: [launch, other],
      transcripts: {
        "vigil-target": transcriptFromEntries([
          messageEntry("target-entry", null, "assistant", "TARGET_ONLY marker"),
        ]),
        "vigil-other": transcriptFromEntries([
          messageEntry("other-entry", null, "assistant", "OTHER marker"),
        ]),
      },
    });

    const restricted = await service.search({ query: "marker", id: "vigil-target" });
    expect((restricted as VigilSearchResult).matches).toHaveLength(1);
    expect((restricted as VigilSearchResult).matches[0]?.id).toBe("vigil-target");

    expect(await service.search({ query: "marker", id: "vigil-missing" })).toEqual({
      error: "Unknown vigil id: vigil-missing",
    });

    const completedLaunch: VigilLaunchRecord = {
      id: "vigil-completed",
      sessionId: "vigil-completed",
      name: "Completed",
      pid: 102,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T08:00:00.000Z",
    };
    const { service: completedService } = createHarness({
      launches: [completedLaunch],
      completions: [
        {
          id: "vigil-completed",
          sessionId: "vigil-completed",
          name: "[completed] Completed",
          cwd: "/parent/default",
          completedAt: "2026-08-01T12:00:00.000Z",
        },
      ],
      transcripts: {
        "vigil-completed": transcriptFromEntries([
          messageEntry("completed-entry", null, "assistant", "done marker"),
        ]),
      },
    });

    expect(await completedService.search({ query: "marker", id: "vigil-completed" })).toEqual({
      error: "Completed vigil child excluded: vigil-completed (pass includeCompleted: true)",
    });
  });

  it("returns zero matches without error and errors when a candidate transcript is unavailable", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-empty",
      sessionId: "vigil-empty",
      name: "Empty",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };

    const { service } = createHarness({
      launches: [launch],
      transcripts: {
        "vigil-empty": transcriptFromEntries([
          messageEntry("entry-1", null, "assistant", "nothing relevant"),
        ]),
      },
    });

    expect(await service.search({ query: "missing-text" })).toEqual({ matches: [] });

    const { service: missingService } = createHarness({
      launches: [launch],
      transcripts: {
        "vigil-empty": { error: "missing file" },
      },
    });

    expect(await missingService.search({ query: "anything" })).toEqual({
      error: "Child session transcript unavailable for vigil: vigil-empty",
    });
  });

  it("does not append ledger entries, spawn, reap, rename, or mutate sessions during search", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-readonly-search",
      sessionId: "vigil-readonly-search",
      name: "Readonly",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };

    const { service, captured, spawnInputs, terminatedPids, sessionManager } = createHarness({
      launches: [launch],
      transcripts: {
        "vigil-readonly-search": transcriptFromEntries([
          messageEntry("entry-1", null, "assistant", "FINDME marker"),
        ]),
      },
    });

    const entriesBefore = sessionManager.getEntries().length;
    await service.search({ query: "FINDME" });
    expect(captured).toHaveLength(1);
    expect(spawnInputs).toHaveLength(0);
    expect(terminatedPids).toHaveLength(0);
    expect(sessionManager.getEntries()).toHaveLength(entriesBefore);
  });

  it("ignores tampered ledger records that do not match canonical identity", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-canonical",
      sessionId: "vigil-canonical",
      name: "Canonical",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };

    const { service, appendEntry } = createHarness({
      launches: [launch],
      transcripts: {
        "vigil-canonical": transcriptFromEntries([
          messageEntry("canonical-entry", null, "assistant", "CANON marker"),
        ]),
        "vigil-evil-session": transcriptFromEntries([
          messageEntry("evil-entry", null, "assistant", "EVIL marker"),
        ]),
      },
    });

    appendEntry("vigil-turn", {
      id: "vigil-canonical",
      sessionId: "vigil-evil-session",
      pid: 999,
      cwd: "/parent/default",
      sentAt: "2026-08-01T11:00:00.000Z",
    });

    const result = await service.search({ query: "marker", id: "vigil-canonical" });
    expect((result as VigilSearchResult).matches[0]?.entryId).toBe("canonical-entry");
  });
});

describe("VigilService.read", () => {
  it("reads a bounded append-order window by stable entry id", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-read",
      sessionId: "vigil-read",
      name: "Read task",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };

    const { service } = createHarness({
      launches: [launch],
      transcripts: {
        "vigil-read": transcriptFromEntries([
          messageEntry("entry-1", null, "user", "before"),
          messageEntry("entry-2", "entry-1", "assistant", "ANCHOR marker"),
          messageEntry("entry-3", "entry-2", "assistant", "after"),
        ]),
      },
    });

    const search = await service.search({ query: "ANCHOR", id: "vigil-read" });
    const match = (search as VigilSearchResult).matches[0]!;

    const read = await service.read({
      id: match.id,
      entryId: match.entryId,
      before: 1,
      after: 1,
    });

    expect(isVigilError(read)).toBe(false);
    const result = read as VigilReadResult;
    expect(result.entries.map((entry) => entry.entryId)).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(result.entries.find((entry) => entry.isAnchor)?.entryId).toBe("entry-2");
    expect(result.order).toBe("jsonl-append-order");
  });

  it("requires includeCompleted for completed children and rejects unknown entries", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-completed-read",
      sessionId: "vigil-completed-read",
      name: "Completed",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };

    const { service } = createHarness({
      launches: [launch],
      completions: [
        {
          id: "vigil-completed-read",
          sessionId: "vigil-completed-read",
          name: "[completed] Completed",
          cwd: "/parent/default",
          completedAt: "2026-08-01T12:00:00.000Z",
        },
      ],
      transcripts: {
        "vigil-completed-read": transcriptFromEntries([
          messageEntry("done-entry", null, "assistant", "retained marker"),
        ]),
      },
    });

    expect(
      await service.read({ id: "vigil-completed-read", entryId: "done-entry" }),
    ).toEqual({
      error: "Completed vigil child excluded: vigil-completed-read (pass includeCompleted: true)",
    });

    const allowed = await service.read({
      id: "vigil-completed-read",
      entryId: "done-entry",
      includeCompleted: true,
    });
    expect(isVigilError(allowed)).toBe(false);

    expect(await service.read({ id: "vigil-completed-read", entryId: "missing", includeCompleted: true })).toEqual({
      error: "Unknown child session entry: missing",
    });
  });

  it("does not mutate lifecycle or child process state during read", async () => {
    const launch: VigilLaunchRecord = {
      id: "vigil-readonly",
      sessionId: "vigil-readonly",
      name: "Readonly",
      pid: 100,
      cwd: "/parent/default",
      launchedAt: "2026-08-01T10:00:00.000Z",
    };

    const { service, captured, spawnInputs, terminatedPids, sessionManager } = createHarness({
      launches: [launch],
      transcripts: {
        "vigil-readonly": transcriptFromEntries([
          messageEntry("entry-1", null, "assistant", "READONLY marker"),
        ]),
      },
    });

    const entriesBefore = sessionManager.getEntries().length;
    await service.read({ id: "vigil-readonly", entryId: "entry-1" });
    expect(captured).toHaveLength(1);
    expect(spawnInputs).toHaveLength(0);
    expect(terminatedPids).toHaveLength(0);
    expect(sessionManager.getEntries()).toHaveLength(entriesBefore);
  });
});
