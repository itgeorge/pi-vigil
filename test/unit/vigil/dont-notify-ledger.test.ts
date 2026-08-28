import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import { createEmptyChildSessionTranscriptReader, createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
import { shouldNotifyOnSettle } from "../../../src/vigil/lifecycle";
import { getLifecycleFromSessionManager } from "../../../src/vigil/node-runtime";
import type { VigilLaunchRecord, VigilTurnRecord } from "../../../src/vigil/types";
import { createFakePersistedBootstrapObserver } from "../../../src/vigil/persisted-bootstrap-observer";

const TEST_MODEL = "openai-codex/gpt-5.5";

function createServiceHarness() {
  const sessionManager = SessionManager.inMemory("/parent/project");
  const launches: VigilLaunchRecord[] = [];
  const turns: VigilTurnRecord[] = [];
  const bootstrapObserver = createFakePersistedBootstrapObserver();

  const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
    sessionManager.appendCustomEntry(customType, data);
    if (customType === "vigil-launch") {
      launches.push(data as VigilLaunchRecord);
    }
    if (customType === "vigil-turn") {
      turns.push(data as VigilTurnRecord);
    }
  });

  const processRunner: ProcessRunner = {
    spawnDetached: async () => ({ pid: 4242 }),
    isAlive: () => true,
    terminateAndWait: async () => undefined,
  };

  const childSessionReader: ChildSessionReader = {
    readChildSessionState: async () => ({
      latestResponse: "Done.",
      turnComplete: true,
      lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
      activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
    }),
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Test" };
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger,
    persistedBootstrapObserver: bootstrapObserver,
    bootstrapFailFastTimeoutMs: 100,
  });

  return { service, sessionManager, launches, turns, bootstrapObserver };
}

describe("vigil dontNotify ledger preference", () => {
  afterEach(() => {
    // no shared state
  });

  it("launch without dontNotify omits the stamp and shouldNotifyOnSettle is true", async () => {
    const { service, sessionManager, launches } = createServiceHarness();

    const result = await service.launch({
      name: "Notify child",
      message: "Work",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
    });

    expect("error" in result).toBe(false);
    expect(launches[0]).not.toHaveProperty("dontNotify");

    const lifecycle = getLifecycleFromSessionManager(sessionManager, launches[0]!.id);
    expect(lifecycle).not.toBeNull();
    expect(shouldNotifyOnSettle(lifecycle!)).toBe(true);
  });

  it("launch with dontNotify: true stamps opt-out and shouldNotifyOnSettle is false", async () => {
    const { service, sessionManager, launches } = createServiceHarness();

    await service.launch({
      name: "Silent child",
      message: "Work",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
      dontNotify: true,
    });

    expect(launches[0]?.dontNotify).toBe(true);

    const lifecycle = getLifecycleFromSessionManager(sessionManager, launches[0]!.id);
    expect(shouldNotifyOnSettle(lifecycle!)).toBe(false);
  });

  it("send with dontNotify: true stamps opt-out on the turn record", async () => {
    const { service, sessionManager, turns } = createServiceHarness();

    const launched = await service.launch({
      name: "Child",
      message: "Start",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
    });
    expect("error" in launched).toBe(false);

    await service.send({
      vigilId: (launched as { id: string }).id,
      message: "Continue",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
      dontNotify: true,
    });

    expect(turns[0]?.dontNotify).toBe(true);

    const lifecycle = getLifecycleFromSessionManager(sessionManager, (launched as { id: string }).id);
    expect(shouldNotifyOnSettle(lifecycle!)).toBe(false);
  });

  it("send omitting dontNotify after a prior opt-out re-enables notify for the new turn", async () => {
    const { service, sessionManager } = createServiceHarness();

    const launched = await service.launch({
      name: "Child",
      message: "Start",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
      dontNotify: true,
    });
    expect("error" in launched).toBe(false);
    const vigilId = (launched as { id: string }).id;

    await service.send({
      vigilId,
      message: "Continue silently",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
      dontNotify: true,
    });

    let lifecycle = getLifecycleFromSessionManager(sessionManager, vigilId);
    expect(shouldNotifyOnSettle(lifecycle!)).toBe(false);

    await service.send({
      vigilId,
      message: "Continue with notify",
      model: TEST_MODEL,
      parentCwd: "/parent/project",
    });

    lifecycle = getLifecycleFromSessionManager(sessionManager, vigilId);
    expect(shouldNotifyOnSettle(lifecycle!)).toBe(true);
    expect(lifecycle?.runtimeRecord).not.toHaveProperty("dontNotify");
  });
});
