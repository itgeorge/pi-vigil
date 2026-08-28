import { shouldNotifyOnSettle } from "./lifecycle";
import type { ParentNotifier } from "./parent-notifier";
import type {
  ChildSessionReader,
  ParentLedger,
  ProcessRunner,
  WaitScheduler,
} from "./ports";
import { deriveVigilState } from "./session-text";

const DEFAULT_POLL_INITIAL_DELAY_MS = 500;
const DEFAULT_POLL_MAX_DELAY_MS = 5_000;

export interface PersistedSettleWatcher {
  arm(input: { vigilId: string; turnStartedAt: string }): void;
  disarm(vigilId: string): void;
  shutdown(): void;
}

export interface PersistedSettleWatcherDeps {
  parentLedger: ParentLedger;
  childSessionReader: ChildSessionReader;
  processRunner: ProcessRunner;
  parentNotifier: ParentNotifier;
  sessionDir?: string;
  scheduler?: WaitScheduler;
  wasNotified: (key: string) => boolean;
  markNotified: (key: string) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

type ActiveWatch = {
  turnStartedAt: string;
  /** Launch/send returned running; first terminal observation may notify. */
  armedWhileRunning: boolean;
};

export function buildPersistedSettleNotifyKey(input: {
  vigilId: string;
  turnStartedAt: string;
  pid: number;
}): string {
  return `${input.vigilId}:${input.turnStartedAt}:${input.pid}`;
}

export function createNoopPersistedSettleWatcher(): PersistedSettleWatcher {
  return {
    arm() {},
    disarm() {},
    shutdown() {},
  };
}

export function createPersistedSettleWatcher(deps: PersistedSettleWatcherDeps): PersistedSettleWatcher {
  const scheduler = deps.scheduler ?? createDefaultWaitScheduler();
  const initialDelayMs = deps.initialDelayMs ?? DEFAULT_POLL_INITIAL_DELAY_MS;
  const maxDelayMs = deps.maxDelayMs ?? DEFAULT_POLL_MAX_DELAY_MS;
  const watches = new Map<string, ActiveWatch>();
  let shutdownRequested = false;

  const notifyFailed = (vigilId: string, watch: ActiveWatch): "stop" => {
    const lifecycle = deps.parentLedger.getLifecycle(vigilId);
    if (!lifecycle?.failRecord) {
      return "stop";
    }

    const record = lifecycle.runtimeRecord;
    const notifyKey = buildPersistedSettleNotifyKey({
      vigilId,
      turnStartedAt: watch.turnStartedAt,
      pid: record.pid,
    });

    if (!watch.armedWhileRunning || deps.wasNotified(notifyKey) || !shouldNotifyOnSettle(lifecycle)) {
      return "stop";
    }

    deps.markNotified(notifyKey);
    deps.parentNotifier.notifySettled({
      id: lifecycle.id,
      name: lifecycle.launchName,
      state: "failed",
      latestResponse: null,
      error: lifecycle.failRecord.error,
    });
    return "stop";
  };

  const pollOnce = async (vigilId: string, watch: ActiveWatch): Promise<"continue" | "stop"> => {
    const lifecycle = deps.parentLedger.getLifecycle(vigilId);
    if (!lifecycle || lifecycle.completionRecord) {
      return "stop";
    }

    if (lifecycle.failRecord) {
      return notifyFailed(vigilId, watch);
    }

    const record = lifecycle.runtimeRecord;
    const notifyKey = buildPersistedSettleNotifyKey({
      vigilId,
      turnStartedAt: watch.turnStartedAt,
      pid: record.pid,
    });

    const childState = await deps.childSessionReader.readChildSessionState({
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir ?? deps.sessionDir,
    });

    const refreshed = deps.parentLedger.getLifecycle(vigilId);
    if (!refreshed || refreshed.completionRecord) {
      return "stop";
    }
    if (refreshed.failRecord) {
      return notifyFailed(vigilId, watch);
    }

    const alive = deps.processRunner.isAlive(record.pid);
    const state = deriveVigilState({
      alive,
      turnComplete: childState.turnComplete,
      lastConversationTimestamp: childState.lastConversationTimestamp,
      turnStartedAt: watch.turnStartedAt,
    });

    if (state === "running") {
      watch.armedWhileRunning = true;
      return "continue";
    }

    if (!watch.armedWhileRunning || deps.wasNotified(notifyKey) || !shouldNotifyOnSettle(refreshed)) {
      return "stop";
    }

    deps.markNotified(notifyKey);
    deps.parentNotifier.notifySettled({
      id: refreshed.id,
      name: refreshed.launchName,
      state: "waiting",
      latestResponse: childState.latestResponse,
    });
    return "stop";
  };

  const pollLoop = async (vigilId: string): Promise<void> => {
    let delayMs = initialDelayMs;
    while (!shutdownRequested) {
      const watch = watches.get(vigilId);
      if (!watch) {
        return;
      }

      const sleepResult = await scheduler.sleep(delayMs);
      if (shutdownRequested || !watches.has(vigilId)) {
        return;
      }
      if (sleepResult === "cancelled") {
        return;
      }

      const outcome = await pollOnce(vigilId, watch);
      if (outcome === "stop") {
        watches.delete(vigilId);
        return;
      }

      delayMs = Math.min(Math.max(delayMs * 2, 1), maxDelayMs);
    }
  };

  return {
    arm({ vigilId, turnStartedAt }) {
      if (shutdownRequested) {
        return;
      }
      watches.set(vigilId, { turnStartedAt, armedWhileRunning: true });
      void pollLoop(vigilId);
    },
    disarm(vigilId) {
      watches.delete(vigilId);
    },
    shutdown() {
      shutdownRequested = true;
      watches.clear();
    },
  };
}

function createDefaultWaitScheduler(): WaitScheduler {
  return {
    now: () => Date.now(),
    sleep(ms, signal) {
      if (signal?.aborted) {
        return Promise.resolve("cancelled");
      }
      return new Promise((resolve) => {
        let done = false;
        const finish = (result: "elapsed" | "cancelled") => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => finish("cancelled");
        const timer = setTimeout(() => finish("elapsed"), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
