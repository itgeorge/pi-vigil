import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { createFakePersistedBootstrapObserver } from "../../../src/vigil/persisted-bootstrap-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, WaitScheduler } from "../../../src/vigil/ports";
import { createRecordingParentNotifier } from "../../../src/vigil/parent-notifier";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { createPersistedSettleWatcher } from "../../../src/vigil/persisted-settle-watcher";
import { isVigilError } from "../../../src/vigil/types";

const TEST_MODEL = "openai-codex/gpt-5.5";
const SETTLED_TIMESTAMP = "2026-08-28T12:00:00.000Z";

class FakeScheduler implements WaitScheduler {
  time = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.time;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled"> {
    this.sleeps.push(ms);
    this.time += ms;
    return signal?.aborted ? "cancelled" : "elapsed";
  }
}

function defaultActivity() {
  return {
    steps: 0,
    messages: 0,
    lastActivity: null as string | null,
    lastActivityTimestamp: null as string | null,
    recentMessages: [] as Array<{
      role: string;
      excerpt: string;
      timestamp: string;
    }>,
  };
}

async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function createPersistedNotifyHarness(options?: {
  parentNotifier?: ReturnType<typeof createRecordingParentNotifier>;
  scheduler?: FakeScheduler;
  sessionState?: () => {
    latestResponse: string | null;
    turnComplete: boolean;
    lastConversationTimestamp: string | null;
  };
  alive?: () => boolean;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const bootstrapObserver = createFakePersistedBootstrapObserver();
  const parentNotifier = options?.parentNotifier ?? createRecordingParentNotifier();
  const scheduler = options?.scheduler ?? new FakeScheduler();
  const settleNotifyKeys = new Set<string>();
  const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
    sessionManager.appendCustomEntry(customType, data);
  });

  let alive = true;
  const processRunner: ProcessRunner = {
    async spawnDetached() {
      throw new Error("persisted spawn should not be used when bootstrap observer is injected");
    },
    isAlive: () => (options?.alive ? options.alive() : alive),
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      const state = options?.sessionState?.() ?? {
        latestResponse: null,
        turnComplete: false,
        lastConversationTimestamp: null,
      };
      return {
        latestResponse: state.latestResponse,
        turnComplete: state.turnComplete,
        lastConversationTimestamp: state.lastConversationTimestamp,
        activity: defaultActivity(),
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Test" };
    },
  };

  const persistedSettleWatcher = createPersistedSettleWatcher({
    parentLedger,
    childSessionReader,
    processRunner,
    parentNotifier,
    scheduler,
    wasNotified: (key) => settleNotifyKeys.has(key),
    markNotified: (key) => {
      settleNotifyKeys.add(key);
    },
    initialDelayMs: 0,
    maxDelayMs: 10,
  });

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger,
    persistedBootstrapObserver: bootstrapObserver,
    parentNotifier,
    persistedSettleWatcher,
    settleNotifyKeys,
    waitScheduler: scheduler,
    createId: () => "vigil-persisted-notify",
    bootstrapFailFastTimeoutMs: 25,
    currentParentSessionId: "parent-session-id",
  });

  return {
    service,
    bootstrapObserver,
    parentNotifier,
    scheduler,
    sessionManager,
    setAlive(next: boolean) {
      alive = next;
    },
  };
}

describe("persisted settle parent notify", () => {
  it("notifies once when persisted child settles after launch", async () => {
    let turnComplete = false;
    const { service, bootstrapObserver, parentNotifier } = createPersistedNotifyHarness({
      sessionState: () => ({
        latestResponse: turnComplete ? "DONE" : null,
        turnComplete,
        lastConversationTimestamp: turnComplete ? SETTLED_TIMESTAMP : null,
      }),
    });

    const launchPromise = service.launch({
      name: "Persisted task",
      message: "Reply DONE",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });

    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    const launched = await launchPromise;
    expect(isVigilError(launched)).toBe(false);

    await flushAsync(16);
    expect(parentNotifier.calls).toHaveLength(0);

    turnComplete = true;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(1);
    expect(parentNotifier.calls[0]).toEqual({
      id: "vigil-persisted-notify",
      name: "Persisted task",
      state: "waiting",
      latestResponse: "DONE",
    });
  });

  it("skips notify when launch opts out with dontNotify", async () => {
    let turnComplete = false;
    const { service, bootstrapObserver, parentNotifier } = createPersistedNotifyHarness({
      sessionState: () => ({
        latestResponse: turnComplete ? "DONE" : null,
        turnComplete,
        lastConversationTimestamp: turnComplete ? SETTLED_TIMESTAMP : null,
      }),
    });

    const launchPromise = service.launch({
      name: "Silent persisted",
      message: "Reply DONE",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      dontNotify: true,
    });

    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await launchPromise;

    turnComplete = true;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(0);
  });

  it("notifies again after send without opt-out", async () => {
    let turnComplete = true;
    let latestResponse = "FIRST";
    const { service, bootstrapObserver, parentNotifier, setAlive } = createPersistedNotifyHarness({
      sessionState: () => ({
        latestResponse,
        turnComplete,
        lastConversationTimestamp: turnComplete ? SETTLED_TIMESTAMP : null,
      }),
    });

    const launchPromise = service.launch({
      name: "Resumable",
      message: "First turn",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });
    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await launchPromise;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(1);

    setAlive(true);
    turnComplete = false;
    latestResponse = "FIRST";

    const sendPromise = service.send({
      vigilId: "vigil-persisted-notify",
      message: "Second turn",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });
    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await sendPromise;

    await flushAsync(16);
    expect(parentNotifier.calls).toHaveLength(1);

    latestResponse = "SECOND";
    turnComplete = true;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(2);
    expect(parentNotifier.calls[1]).toEqual({
      id: "vigil-persisted-notify",
      name: "Resumable",
      state: "waiting",
      latestResponse: "SECOND",
    });
  });

  it("skips notify when the latest send opts out with dontNotify", async () => {
    let turnComplete = true;
    const { service, bootstrapObserver, parentNotifier, setAlive } = createPersistedNotifyHarness({
      sessionState: () => ({
        latestResponse: "FIRST",
        turnComplete,
        lastConversationTimestamp: turnComplete ? SETTLED_TIMESTAMP : null,
      }),
    });

    const launchPromise = service.launch({
      name: "Mixed notify",
      message: "First turn",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });
    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await launchPromise;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(1);

    setAlive(true);
    turnComplete = false;
    const sendPromise = service.send({
      vigilId: "vigil-persisted-notify",
      message: "Silent second turn",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      dontNotify: true,
    });
    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await sendPromise;

    turnComplete = true;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(1);
  });

  it("notifies on persisted bootstrap failure unless opted out", async () => {
    const { service, bootstrapObserver, parentNotifier } = createPersistedNotifyHarness();

    const launchPromise = service.launch({
      name: "Bootstrap fail",
      message: "Fail",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });

    await Promise.resolve();
    bootstrapObserver.pushStderr("vigil-persisted-notify", 'Error: Model "bad" not found\n');
    const result = await launchPromise;

    expect(isVigilError(result)).toBe(true);
    await flushAsync(8);
    expect(parentNotifier.calls).toHaveLength(1);
    expect(parentNotifier.calls[0]?.state).toBe("failed");
  });

  it("does not notify after persisted settle watcher shutdown", async () => {
    let turnComplete = false;
    const { service, bootstrapObserver, parentNotifier } = createPersistedNotifyHarness({
      sessionState: () => ({
        latestResponse: turnComplete ? "LATE" : null,
        turnComplete,
        lastConversationTimestamp: turnComplete ? SETTLED_TIMESTAMP : null,
      }),
    });

    const launchPromise = service.launch({
      name: "Shutdown child",
      message: "Work",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });
    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await launchPromise;

    service.shutdownSettleWatchers();
    turnComplete = true;
    await flushAsync(32);
    expect(parentNotifier.calls).toHaveLength(0);
  });
});
