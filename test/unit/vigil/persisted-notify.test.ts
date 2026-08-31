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
// Must be >= turnStartedAt from launch/send (real wall clock) or deriveVigilState stays running.
const SETTLED_TIMESTAMP = "2099-01-01T00:00:00.000Z";

class FakeScheduler implements WaitScheduler {
  time = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.time;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled"> {
    this.sleeps.push(ms);
    this.time += ms;
    // Yield so tests can mutate child state between polls (avoid busy-loop starvation).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return signal?.aborted ? "cancelled" : "elapsed";
  }
}

function defaultActivity() {
  return {
    steps: 0,
    messages: 0,
    lastActivity: null,
    lastActivityTimestamp: null,
    recentMessages: [] as [],
  };
}

async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function createStandaloneWatcher(options: {
  reader: ChildSessionReader;
  notifier: ReturnType<typeof createRecordingParentNotifier>;
  scheduler: FakeScheduler;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  sessionManager.appendCustomEntry("vigil-launch", {
    id: "vigil-race",
    sessionId: "child-session",
    name: "Race child",
    pid: 4242,
    cwd: "/parent/default",
    launchedAt: "2026-01-01T00:00:00.000Z",
  });
  const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
    sessionManager.appendCustomEntry(customType, data);
  });
  const notified = new Set<string>();
  return createPersistedSettleWatcher({
    parentLedger,
    childSessionReader: options.reader,
    processRunner: {
      async spawnDetached() { return { pid: 4242 }; },
      isAlive: () => false,
      async terminateAndWait() {},
    },
    parentNotifier: options.notifier,
    scheduler: options.scheduler,
    wasNotified: (key) => notified.has(key),
    markNotified: (key) => notified.add(key),
    initialDelayMs: 0,
    maxDelayMs: 10,
  });
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

    // send requires a waiting child — keep settled until send succeeds, then run the new turn
    const sendPromise = service.send({
      vigilId: "vigil-persisted-notify",
      message: "Second turn",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
    });
    await Promise.resolve();
    bootstrapObserver.signalSessionExists("vigil-persisted-notify");
    await sendPromise;

    setAlive(true);
    turnComplete = false;
    latestResponse = "FIRST";
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

    setAlive(true);
    turnComplete = false;
    await flushAsync(16);

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

  it("does not let stale old-turn work delete or notify the newly armed turn", async () => {
    const notifier = createRecordingParentNotifier();
    const scheduler = new FakeScheduler();
    let readCount = 0;
    let releaseFirstRead!: () => void;
    let firstReadStarted!: () => void;
    const firstReadReleased = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const firstReadStartedPromise = new Promise<void>((resolve) => { firstReadStarted = resolve; });
    const reader: ChildSessionReader = {
      async readChildSessionState() {
        readCount += 1;
        if (readCount === 1) {
          firstReadStarted();
          await firstReadReleased;
          return {
            latestResponse: "OLD",
            turnComplete: true,
            lastConversationTimestamp: "2026-01-02T00:00:00.000Z",
            activity: defaultActivity(),
          };
        }
        return {
          latestResponse: "NEW",
          turnComplete: true,
          lastConversationTimestamp: "2026-01-03T00:00:00.000Z",
          activity: defaultActivity(),
        };
      },
    };
    const watcher = createStandaloneWatcher({ reader, notifier, scheduler });

    watcher.arm({ vigilId: "vigil-race", turnStartedAt: "2026-01-01T00:00:00.000Z" });
    await firstReadStartedPromise;
    watcher.arm({ vigilId: "vigil-race", turnStartedAt: "2026-01-02T00:00:00.000Z" });
    releaseFirstRead();
    await flushAsync(16);

    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]?.latestResponse).toBe("NEW");
  });

  it("does not notify when shutdown races an in-flight child-session read", async () => {
    const notifier = createRecordingParentNotifier();
    const scheduler = new FakeScheduler();
    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
    const watcher = createStandaloneWatcher({
      notifier,
      scheduler,
      reader: {
        async readChildSessionState() {
          readStarted();
          await readReleased;
          return {
            latestResponse: "LATE",
            turnComplete: true,
            lastConversationTimestamp: "2026-01-02T00:00:00.000Z",
            activity: defaultActivity(),
          };
        },
      },
    });

    watcher.arm({ vigilId: "vigil-race", turnStartedAt: "2026-01-01T00:00:00.000Z" });
    await readStartedPromise;
    watcher.shutdown();
    releaseRead();
    await flushAsync(8);

    expect(notifier.calls).toHaveLength(0);
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
