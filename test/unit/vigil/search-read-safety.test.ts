import { describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ChildSessionTranscriptReader,
  ProcessRunner,
  SpawnChildInput,
} from "../../../src/vigil/ports";
import {
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { deriveDiagnosticChildIdentity } from "../../../src/vigil/lifecycle";
import {
  isVigilError,
  type VigilLaunchRecord,
  type VigilReadResult,
  type VigilSearchResult,
} from "../../../src/vigil/types";
import { createInMemoryTranscriptReader, transcriptFromEntries } from "../../helpers/transcript-fake";

function messageEntry(id: string, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-01T12:00:02.000Z",
    message: {
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
    },
  };
}

function createHarness(options: {
  launch: VigilLaunchRecord;
  transcript?: ReturnType<typeof transcriptFromEntries> | { error: string };
  reader?: ChildSessionTranscriptReader;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const appendEntry = (customType: string, data: unknown) => {
    sessionManager.appendCustomEntry(customType, data);
  };
  appendEntry("vigil-launch", options.launch);

  const isAlive = vi.fn(() => true);
  const readChildSessionState = vi.fn(async () => {
    throw new Error("child state reader must not be used by search/read");
  });

  const processRunner: ProcessRunner = {
    async spawnDetached(input: SpawnChildInput) {
      return { pid: 9000 };
    },
    isAlive,
    async terminateAndWait() {
      return undefined;
    },
  };

  const childSessionReader: ChildSessionReader = { readChildSessionState };
  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Task" };
    },
  };

  const childSessionTranscriptReader =
    options.reader ??
    createInMemoryTranscriptReader({
      [options.launch.sessionId]: options.transcript ?? transcriptFromEntries([messageEntry("entry-1", "FINDME")]),
    });

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader,
    childSessionNamer,
    parentLedger: createSessionParentLedger(sessionManager, appendEntry),
  });

  return { service, isAlive, readChildSessionState };
}

describe("VigilService search/read lifecycle-only diagnostics", () => {
  const launch: VigilLaunchRecord = {
    id: "vigil-diag",
    sessionId: "vigil-diag",
    name: "Diagnostic task",
    pid: 100,
    cwd: "/parent/default",
    launchedAt: "2026-08-01T10:00:00.000Z",
  };

  it("does not invoke isAlive or child state reader during search or read", async () => {
    const { service, isAlive, readChildSessionState } = createHarness({ launch });

    await service.search({ query: "FINDME", id: launch.id });
    await service.read({ id: launch.id, entryId: "entry-1" });

    expect(isAlive).not.toHaveBeenCalled();
    expect(readChildSessionState).not.toHaveBeenCalled();
  });

  it("returns lifecycle-derived diagnostic state without live poll semantics", async () => {
    const { service } = createHarness({ launch });
    const search = await service.search({ query: "FINDME", id: launch.id });
    expect((search as VigilSearchResult).matches[0]?.state).toBe("running");

    const read = await service.read({ id: launch.id, entryId: "entry-1" });
    expect((read as VigilReadResult).state).toBe("running");
  });

  it("returns controlled transcript errors for reader failures and rejected promises", async () => {
    const errorReader: ChildSessionTranscriptReader = {
      async readChildTranscript() {
        return { error: "missing file" };
      },
    };
    const rejectReader: ChildSessionTranscriptReader = {
      async readChildTranscript() {
        throw new Error("disk exploded");
      },
    };

    const { service: errorService } = createHarness({ launch, reader: errorReader });
    expect(await errorService.search({ query: "FINDME", id: launch.id })).toEqual({
      error: "Child session transcript unavailable for vigil: vigil-diag",
    });
    expect(await errorService.read({ id: launch.id, entryId: "entry-1" })).toEqual({
      error: "Child session transcript unavailable for vigil: vigil-diag",
    });

    const { service: rejectService } = createHarness({ launch, reader: rejectReader });
    expect(await rejectService.search({ query: "FINDME", id: launch.id })).toEqual({
      error: "Child session transcript unavailable for vigil: vigil-diag",
    });
    expect(await rejectService.read({ id: launch.id, entryId: "entry-1" })).toEqual({
      error: "Child session transcript unavailable for vigil: vigil-diag",
    });
  });

  it("rejects whitespace-padded ids at the service boundary", async () => {
    const { service } = createHarness({ launch });
    expect(await service.read({ id: " vigil-diag", entryId: "entry-1" })).toEqual({
      error: "read id must not contain leading or trailing whitespace",
    });
    expect(await service.search({ query: "FINDME", id: " vigil-diag" })).toEqual({
      error: "search id must not contain leading or trailing whitespace",
    });
    expect(isVigilError(await service.read({ id: launch.id, entryId: " entry-1" }))).toBe(true);
  });
});

describe("deriveDiagnosticChildIdentity", () => {
  it("marks completed children completed and active children lifecycle-active running", () => {
    const activeLifecycle = {
      id: "vigil-a",
      sessionId: "vigil-a",
      cwd: "/cwd",
      launchName: "Active",
      runtimeRecord: {
        id: "vigil-a",
        sessionId: "vigil-a",
        name: "Active",
        pid: 1,
        cwd: "/cwd",
        launchedAt: "2026-08-01T10:00:00.000Z",
      },
      completionRecord: null,
      lastUpdatedAt: "2026-08-01T10:00:00.000Z",
    };
    const active = deriveDiagnosticChildIdentity(activeLifecycle);
    expect(active.state).toBe("running");
    expect(active.name).toBe("Active");

    const completed = deriveDiagnosticChildIdentity({
      ...activeLifecycle,
      completionRecord: {
        id: "vigil-a",
        sessionId: "vigil-a",
        name: "[completed] Active",
        cwd: "/cwd",
        completedAt: "2026-08-01T11:00:00.000Z",
      },
      lastUpdatedAt: "2026-08-01T11:00:00.000Z",
    });
    expect(completed.state).toBe("completed");
    expect(completed.name).toBe("[completed] Active");
  });
});
