import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createFakePersistedBootstrapObserver,
} from "../../../src/vigil/persisted-bootstrap-observer";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import {
  createFilesystemChildSessionFixture,
  createFilesystemChildVigilService,
} from "../../helpers/filesystem-child-session";
import { isVigilError, type VigilSnapshot, type VigilWaitResult } from "../../../src/vigil/types";

function expectSnapshot(result: unknown): asserts result is VigilSnapshot {
  expect(isVigilError(result as never)).toBe(false);
}

function expectWait(result: unknown): asserts result is VigilWaitResult {
  expect(isVigilError(result as never)).toBe(false);
}

describe("VigilService persisted-child actions with filesystem sessions", () => {
  it("poll reads waiting state and latestResponse from the child session file", async () => {
    const fixture = createFilesystemChildSessionFixture({ prefix: "vigil-fs-poll-" });
    const { service } = createFilesystemChildVigilService(fixture);

    const result = await service.poll(fixture.sessionId);
    expectSnapshot(result);
    expect(result).toMatchObject({
      id: fixture.sessionId,
      state: "waiting",
      latestResponse: fixture.assistantText,
    });
  });

  it("wait settles on the first poll when the child session file has a terminal assistant", async () => {
    const fixture = createFilesystemChildSessionFixture({ prefix: "vigil-fs-wait-" });
    const { service } = createFilesystemChildVigilService(fixture);

    const result = await service.wait({ id: fixture.sessionId, timeoutMs: 60_000, progress: "none" });
    expectWait(result);
    expect(result.outcome).toBe("settled");
    if (result.outcome !== "settled") {
      return;
    }
    expect(result.waitedMs).toBeLessThan(50);
    expect(result.settled).toEqual([
      expect.objectContaining({
        id: fixture.sessionId,
        state: "waiting",
        latestResponse: fixture.assistantText,
      }),
    ]);
  });

  it("list reports waiting rather than running for an active filesystem child", async () => {
    const fixture = createFilesystemChildSessionFixture({ prefix: "vigil-fs-list-" });
    const { service } = createFilesystemChildVigilService(fixture);

    const result = await service.list();
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.vigils).toEqual([
        expect.objectContaining({
          id: fixture.sessionId,
          state: "waiting",
        }),
      ]);
    }
  });

  it("complete retires a waiting filesystem child", async () => {
    const fixture = createFilesystemChildSessionFixture({
      prefix: "vigil-fs-complete-",
      launchName: "Retire me",
    });
    const { service, setAlive } = createFilesystemChildVigilService(fixture, { isAlive: true });

    const result = await service.complete({ vigilId: fixture.sessionId, parentCwd: fixture.cwd });
    expectSnapshot(result);
    expect(result).toMatchObject({
      id: fixture.sessionId,
      state: "completed",
      latestResponse: fixture.assistantText,
    });
    setAlive(false);
  });

  it("search finds literal matches in the child session transcript", async () => {
    const fixture = createFilesystemChildSessionFixture({
      prefix: "vigil-fs-search-",
      assistantText: "Needle in filesystem transcript",
    });
    const { service } = createFilesystemChildVigilService(fixture);

    const result = await service.search({ query: "filesystem transcript", id: fixture.sessionId });
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0]?.match).toContain("filesystem transcript");
    }
  });

  it("read returns transcript context around a stable child entry id", async () => {
    const fixture = createFilesystemChildSessionFixture({ prefix: "vigil-fs-read-" });
    const { service } = createFilesystemChildVigilService(fixture);

    const result = await service.read({
      id: fixture.sessionId,
      entryId: fixture.assistantEntryId,
      before: 1,
      after: 0,
    });
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.anchorEntryId).toBe(fixture.assistantEntryId);
      expect(result.entries.some((entry) => entry.entryId === fixture.userEntryId)).toBe(true);
      expect(result.entries.some((entry) => entry.entryId === fixture.assistantEntryId)).toBe(true);
    }
  });

  it("send respawns through bootstrap observer after a waiting filesystem child", async () => {
    const fixture = createFilesystemChildSessionFixture({ prefix: "vigil-fs-send-" });
    const bootstrapObserver = createFakePersistedBootstrapObserver();
    const { service } = createFilesystemChildVigilService(fixture, {
      isAlive: false,
      persistedBootstrapObserver: bootstrapObserver,
      bootstrapFailFastTimeoutMs: 100,
    });

    const sendPromise = service.send({
      vigilId: fixture.sessionId,
      message: "continue",
      parentCwd: fixture.cwd,
    });

    await Promise.resolve();
    bootstrapObserver.signalSessionExists(fixture.sessionId);

    const result = await sendPromise;
    expectSnapshot(result);
    expect(result).toMatchObject({
      id: fixture.sessionId,
      state: "running",
      latestResponse: fixture.assistantText,
    });
    expect(bootstrapObserver.started).toHaveLength(1);
  });
});

describe("VigilService launch/send bootstrap observer", () => {
  it("launch returns running once bootstrap observer signals session exists", async () => {
    const bootstrapObserver = createFakePersistedBootstrapObserver();
    const sessionManager = SessionManager.inMemory("/parent");
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          return { pid: 1001 };
        },
        isAlive: () => true,
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
      parentLedger: createSessionParentLedger(sessionManager, (type, data) => {
        sessionManager.appendCustomEntry(type, data);
      }),
      persistedBootstrapObserver: bootstrapObserver,
      bootstrapFailFastTimeoutMs: 100,
      createId: () => "vigil-launch-bootstrap-ok",
    });

    const launchPromise = service.launch({
      name: "Bootstrap launch",
      message: "hello",
      parentCwd: "/parent",
    });

    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-launch-bootstrap-ok");

    const result = await launchPromise;
    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result).toMatchObject({ id: "vigil-launch-bootstrap-ok", state: "running" });
    }
    expect(bootstrapObserver.started).toHaveLength(1);
  });
});
