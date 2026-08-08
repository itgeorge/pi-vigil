import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessRunner, TerminateAndWaitOptions } from "./ports";
import {
  boundStderrExcerpt,
  classifyPersistedBootstrapFailure,
  DEFAULT_BOOTSTRAP_WATCHDOG_TIMEOUT_MS,
  MAX_STDERR_EXCERPT_CHARS,
  parsePiStderrFailure,
} from "./child-failure";
import { buildPiChildArgs } from "./node-runtime";

export interface PersistedBootstrapFailureInput {
  vigilId: string;
  sessionId: string;
  error: string;
  stderrExcerpt?: string;
  source: "bootstrap";
}

export interface PersistedBootstrapStartInput {
  vigilId: string;
  sessionId: string;
  cwd: string;
  message: string;
  model?: string;
  sessionDir?: string;
  name?: string;
  parentSessionId?: string;
  onFailed?: (input: PersistedBootstrapFailureInput) => void;
}

export type PersistedBootstrapOutcome =
  | { status: "started" }
  | { status: "failed"; error: string }
  | { status: "timeout" };

export interface PersistedBootstrapObserver {
  start(input: PersistedBootstrapStartInput): Promise<{ pid: number; activate(): void }>;
  waitForOutcome(vigilId: string, options: { timeoutMs: number }): Promise<PersistedBootstrapOutcome>;
  shutdown(options?: TerminateAndWaitOptions): Promise<void>;
}

type ActiveObservation = {
  vigilId: string;
  sessionId: string;
  cwd: string;
  sessionDir?: string;
  pid: number;
  child: ChildProcess;
  activated: boolean;
  closed: boolean;
  stderr: string;
  finalized: boolean;
  outcome: PersistedBootstrapOutcome | null;
  outcomeWaiters: Array<(outcome: PersistedBootstrapOutcome) => void>;
  sessionCheckTimer?: NodeJS.Timeout;
  bootstrapWatchdogTimer?: NodeJS.Timeout;
  sessionCheckInFlight?: boolean;
  aggressiveSessionPolling: boolean;
  onFailed?: (input: PersistedBootstrapFailureInput) => void;
  cleanup: () => void;
};

const DEFAULT_SESSION_POLL_INTERVAL_MS = 50;

function resolveOutcomeWaiters(
  observation: ActiveObservation,
  outcome: PersistedBootstrapOutcome,
): void {
  observation.outcome = outcome;
  for (const waiter of observation.outcomeWaiters) {
    waiter(outcome);
  }
  observation.outcomeWaiters = [];
}

export function createNodePersistedBootstrapObserver(options: {
  processRunner: Pick<ProcessRunner, "isAlive" | "terminateAndWait">;
  piExecutable?: string;
  spawnChild?: (executable: string, args: string[], spawnOptions: { cwd: string }) => ChildProcess;
  sessionExists: (input: {
    sessionId: string;
    cwd: string;
    sessionDir?: string;
  }) => Promise<boolean>;
  onFailed?: (input: PersistedBootstrapFailureInput) => void;
  sessionPollIntervalMs?: number;
  bootstrapWatchdogTimeoutMs?: number;
  reapTimeoutMs?: number;
}): PersistedBootstrapObserver {
  const piExecutable = options.piExecutable ?? "pi";
  const sessionPollIntervalMs = options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  const bootstrapWatchdogTimeoutMs =
    options.bootstrapWatchdogTimeoutMs ?? DEFAULT_BOOTSTRAP_WATCHDOG_TIMEOUT_MS;
  const observations = new Map<string, ActiveObservation>();
  const completedOutcomes = new Map<string, PersistedBootstrapOutcome>();
  let shutdownRequested = false;

  const stopAggressiveSessionPolling = (observation: ActiveObservation): void => {
    observation.aggressiveSessionPolling = false;
    if (observation.sessionCheckTimer) {
      clearTimeout(observation.sessionCheckTimer);
      observation.sessionCheckTimer = undefined;
    }
    observation.sessionCheckInFlight = false;
  };

  const clearObservationTimers = (observation: ActiveObservation): void => {
    if (observation.sessionCheckTimer) {
      clearTimeout(observation.sessionCheckTimer);
      observation.sessionCheckTimer = undefined;
    }
    if (observation.bootstrapWatchdogTimer) {
      clearTimeout(observation.bootstrapWatchdogTimer);
      observation.bootstrapWatchdogTimer = undefined;
    }
  };

  const finalizeStarted = (observation: ActiveObservation): void => {
    if (observation.finalized) {
      return;
    }
    observation.finalized = true;
    clearObservationTimers(observation);
    resolveOutcomeWaiters(observation, { status: "started" });
    completedOutcomes.set(observation.vigilId, { status: "started" });
    observations.delete(observation.vigilId);
    observation.cleanup();
  };

  const finalizeFailed = (observation: ActiveObservation, error: string): void => {
    if (observation.finalized) {
      return;
    }
    observation.finalized = true;
    clearObservationTimers(observation);

    const stderrExcerpt = observation.stderr
      ? boundStderrExcerpt(observation.stderr, MAX_STDERR_EXCERPT_CHARS)
      : undefined;

    if (!shutdownRequested) {
      const reportFailed = observation.onFailed ?? options.onFailed;
      reportFailed?.({
        vigilId: observation.vigilId,
        sessionId: observation.sessionId,
        error,
        ...(stderrExcerpt ? { stderrExcerpt } : {}),
        source: "bootstrap",
      });
    }

    resolveOutcomeWaiters(observation, { status: "failed", error });
    completedOutcomes.set(observation.vigilId, { status: "failed", error });
    observations.delete(observation.vigilId);
    observation.cleanup();
  };

  const evaluateSessionExists = async (observation: ActiveObservation): Promise<boolean> => {
    return options.sessionExists({
      sessionId: observation.sessionId,
      cwd: observation.cwd,
      sessionDir: observation.sessionDir,
    });
  };

  const appendStderr = (observation: ActiveObservation, chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    observation.stderr = boundStderrExcerpt(
      observation.stderr + text,
      MAX_STDERR_EXCERPT_CHARS,
    );
  };

  const tryFinalizeFromStderr = (observation: ActiveObservation): boolean => {
    const parsed = parsePiStderrFailure(observation.stderr);
    if (!parsed) {
      return false;
    }

    finalizeFailed(observation, parsed);
    return true;
  };

  const attachStderrCapture = (observation: ActiveObservation): void => {
    const onStderr = (chunk: Buffer | string) => {
      appendStderr(observation, chunk);
      if (observation.activated && !observation.finalized) {
        tryFinalizeFromStderr(observation);
      }
    };

    observation.child.stderr?.on("data", onStderr);
    observation.cleanup = () => {
      observation.child.stderr?.off("data", onStderr);
      observation.child.stderr?.destroy();
    };
  };

  const finalizeOnClose = async (observation: ActiveObservation): Promise<void> => {
    if (observation.finalized) {
      return;
    }

    const sessionExists = await evaluateSessionExists(observation);
    if (sessionExists) {
      finalizeStarted(observation);
      return;
    }

    const error =
      classifyPersistedBootstrapFailure({
        alive: options.processRunner.isAlive(observation.pid),
        sessionExists: false,
        stderr: observation.stderr || undefined,
      }) ?? "Pi child exited before session was created";

    finalizeFailed(observation, error);
  };

  const reconcileOutcomeOnTimeout = async (
    observation: ActiveObservation,
  ): Promise<PersistedBootstrapOutcome> => {
    if (observation.finalized && observation.outcome) {
      return observation.outcome;
    }

    const sessionExists = await evaluateSessionExists(observation);
    if (sessionExists) {
      finalizeStarted(observation);
      return { status: "started" };
    }

    const parsed = observation.stderr ? parsePiStderrFailure(observation.stderr) : null;
    if (parsed) {
      finalizeFailed(observation, parsed);
      return { status: "failed", error: parsed };
    }

    if (!options.processRunner.isAlive(observation.pid)) {
      const error =
        classifyPersistedBootstrapFailure({
          alive: false,
          sessionExists: false,
          stderr: observation.stderr || undefined,
        }) ?? "Pi child exited before session was created";
      finalizeFailed(observation, error);
      return { status: "failed", error };
    }

    const timeoutOutcome: PersistedBootstrapOutcome = { status: "timeout" };
    observation.outcome = timeoutOutcome;
    observation.outcomeWaiters = [];
    stopAggressiveSessionPolling(observation);
    return timeoutOutcome;
  };

  const waitForObservationOutcome = (
    observation: ActiveObservation,
    timeoutMs: number,
  ): Promise<PersistedBootstrapOutcome> => {
    if (observation.outcome) {
      return Promise.resolve(observation.outcome);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        void reconcileOutcomeOnTimeout(observation).then(resolve);
      }, timeoutMs);

      observation.outcomeWaiters.push((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  };

  const scheduleSessionCheck = (observation: ActiveObservation): void => {
    if (
      observation.finalized ||
      !observation.aggressiveSessionPolling ||
      observation.sessionCheckInFlight
    ) {
      return;
    }

    observation.sessionCheckInFlight = true;
    void evaluateSessionExists(observation)
      .then((exists) => {
        if (exists) {
          finalizeStarted(observation);
        }
      })
      .finally(() => {
        observation.sessionCheckInFlight = false;
        if (!observation.finalized && observation.aggressiveSessionPolling) {
          observation.sessionCheckTimer = setTimeout(() => {
            scheduleSessionCheck(observation);
          }, sessionPollIntervalMs);
        }
      });
  };

  const activateObservation = (observation: ActiveObservation): void => {
    if (observation.activated) {
      return;
    }
    observation.activated = true;

    if (tryFinalizeFromStderr(observation)) {
      return;
    }

    if (observation.closed) {
      void finalizeOnClose(observation);
      return;
    }

    observation.sessionCheckTimer = setTimeout(() => {
      scheduleSessionCheck(observation);
    }, sessionPollIntervalMs);

    observation.bootstrapWatchdogTimer = setTimeout(() => {
      void evaluateSessionExists(observation).then(async (exists) => {
        if (observation.finalized || exists) {
          return;
        }
        if (options.processRunner.isAlive(observation.pid)) {
          try {
            await options.processRunner.terminateAndWait(observation.pid, {
              timeoutMs: options.reapTimeoutMs,
            });
          } catch {
            // Best-effort direct PID cleanup only.
          }
          finalizeFailed(
            observation,
            "Pi child did not create a session before bootstrap watchdog timeout",
          );
        }
      });
    }, bootstrapWatchdogTimeoutMs);
  };

  return {
    async start(input) {
      if (shutdownRequested) {
        throw new Error("Cannot start persisted bootstrap child after parent shutdown");
      }
      if (observations.has(input.vigilId)) {
        throw new Error(`Persisted bootstrap child already observed: ${input.vigilId}`);
      }

      const args = buildPiChildArgs({
        sessionId: input.sessionId,
        message: input.message,
        cwd: input.cwd,
        model: input.model,
        sessionDir: input.sessionDir,
        name: input.name,
      });

      const spawnChild =
        options.spawnChild ??
        ((executable, spawnArgs, spawnOptions) =>
          spawn(executable, spawnArgs, {
            cwd: spawnOptions.cwd,
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
          }));

      const child = spawnChild(piExecutable, args, { cwd: input.cwd });

      const pid = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.once("spawn", () => {
          child.on("error", () => {
            // Detached children may fail after unref; never crash the parent Pi process.
          });
          child.unref();
          if (!child.pid) {
            reject(new Error("Failed to spawn persisted Pi child process"));
            return;
          }
          resolve(child.pid);
        });
      });

      const observation: ActiveObservation = {
        vigilId: input.vigilId,
        sessionId: input.sessionId,
        cwd: input.cwd,
        sessionDir: input.sessionDir,
        pid,
        child,
        activated: false,
        closed: false,
        stderr: "",
        finalized: false,
        outcome: null,
        outcomeWaiters: [],
        aggressiveSessionPolling: true,
        onFailed: input.onFailed,
        cleanup: () => undefined,
      };

      attachStderrCapture(observation);

      observation.child.on("close", () => {
        observation.closed = true;
        if (observation.activated) {
          void finalizeOnClose(observation);
        }
      });

      observations.set(input.vigilId, observation);
      return {
        pid,
        activate: () => activateObservation(observation),
      };
    },

    waitForOutcome(vigilId, waitOptions) {
      const completed = completedOutcomes.get(vigilId);
      if (completed) {
        return Promise.resolve(completed);
      }

      const observation = observations.get(vigilId);
      if (!observation) {
        return Promise.resolve({ status: "timeout" });
      }
      return waitForObservationOutcome(observation, waitOptions.timeoutMs);
    },

    async shutdown(terminateOptions) {
      shutdownRequested = true;
      const active = [...observations.values()];
      await Promise.all(
        active.map(async (observation) => {
          try {
            if (options.processRunner.isAlive(observation.pid)) {
              await options.processRunner.terminateAndWait(observation.pid, terminateOptions);
            }
          } catch {
            // Best-effort direct PID cleanup only.
          } finally {
            clearObservationTimers(observation);
            observation.cleanup();
            observations.delete(observation.vigilId);
          }
        }),
      );
      completedOutcomes.clear();
    },
  };
}

export interface FakePersistedBootstrapObserverOptions {
  onFailed?: (input: PersistedBootstrapFailureInput) => void;
}

type FakeObservationState = {
  activated: boolean;
  sessionExists: boolean;
  stderr: string;
  closed: boolean;
  exitCode?: number;
  finalized: boolean;
  outcome: PersistedBootstrapOutcome | null;
  outcomeWaiters: Array<(outcome: PersistedBootstrapOutcome) => void>;
  sessionId: string;
  onFailed?: (input: PersistedBootstrapFailureInput) => void;
};

export function createFakePersistedBootstrapObserver(
  options?: FakePersistedBootstrapObserverOptions,
): PersistedBootstrapObserver & {
  pushStderr: (vigilId: string, chunk: string) => void;
  pushClose: (vigilId: string, code?: number) => void;
  signalSessionExists: (vigilId: string) => void;
  started: PersistedBootstrapStartInput[];
} {
  const states = new Map<string, FakeObservationState>();
  const started: PersistedBootstrapStartInput[] = [];
  let nextPid = 9100;
  let shutdownRequested = false;

  const finalizeStarted = (state: FakeObservationState): void => {
    if (state.finalized) {
      return;
    }
    state.finalized = true;
    state.outcome = { status: "started" };
    for (const waiter of state.outcomeWaiters) {
      waiter(state.outcome);
    }
    state.outcomeWaiters = [];
  };

  const finalizeFailed = (state: FakeObservationState, error: string, vigilId: string): void => {
    if (state.finalized) {
      return;
    }
    state.finalized = true;
    if (!shutdownRequested) {
      const reportFailed = state.onFailed ?? options?.onFailed;
      reportFailed?.({
        vigilId,
        sessionId: state.sessionId,
        error,
        ...(state.stderr ? { stderrExcerpt: state.stderr } : {}),
        source: "bootstrap",
      });
    }
    state.outcome = { status: "failed", error };
    for (const waiter of state.outcomeWaiters) {
      waiter(state.outcome);
    }
    state.outcomeWaiters = [];
  };

  const finalizeOnClose = (vigilId: string, state: FakeObservationState): void => {
    if (state.sessionExists) {
      finalizeStarted(state);
      return;
    }

    const error =
      classifyPersistedBootstrapFailure({
        alive: false,
        sessionExists: false,
        stderr: state.stderr || undefined,
      }) ?? "Pi child exited before session was created";

    finalizeFailed(state, error, vigilId);
  };

  const activateState = (vigilId: string, state: FakeObservationState): void => {
    if (state.activated) {
      return;
    }
    state.activated = true;

    if (state.sessionExists) {
      finalizeStarted(state);
      return;
    }

    if (state.closed) {
      finalizeOnClose(vigilId, state);
    }
  };

  const observer: PersistedBootstrapObserver & {
    pushStderr: (vigilId: string, chunk: string) => void;
    pushClose: (vigilId: string, code?: number) => void;
    signalSessionExists: (vigilId: string) => void;
    started: PersistedBootstrapStartInput[];
  } = {
    get started() {
      return started;
    },

    async start(input) {
      if (shutdownRequested) {
        throw new Error("Cannot start persisted bootstrap child after parent shutdown");
      }

      started.push(input);

      states.set(input.vigilId, {
        activated: false,
        sessionExists: false,
        stderr: "",
        closed: false,
        finalized: false,
        outcome: null,
        outcomeWaiters: [],
        sessionId: input.sessionId,
        onFailed: input.onFailed,
      });

      const pid = nextPid;
      nextPid += 1;
      return {
        pid,
        activate: () => {
          const state = states.get(input.vigilId);
          if (!state) {
            return;
          }
          activateState(input.vigilId, state);
        },
      };
    },

    waitForOutcome(vigilId, waitOptions) {
      const state = states.get(vigilId);
      if (!state) {
        return Promise.resolve({ status: "timeout" });
      }
      if (state.outcome) {
        return Promise.resolve(state.outcome);
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ status: "timeout" });
        }, waitOptions.timeoutMs);

        state.outcomeWaiters.push((outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },

    async shutdown() {
      shutdownRequested = true;
      states.clear();
    },

    pushStderr(vigilId, chunk) {
      const state = states.get(vigilId);
      if (!state || !state.activated || state.finalized) {
        return;
      }

      state.stderr += chunk;
      const parsed = parsePiStderrFailure(state.stderr);
      if (parsed) {
        finalizeFailed(state, parsed, vigilId);
      }
    },

    pushClose(vigilId, code = 0) {
      const state = states.get(vigilId);
      if (!state || state.finalized) {
        return;
      }

      state.closed = true;
      state.exitCode = code;

      if (!state.activated) {
        return;
      }

      finalizeOnClose(vigilId, state);
    },

    signalSessionExists(vigilId) {
      const state = states.get(vigilId);
      if (!state || state.finalized) {
        return;
      }

      state.sessionExists = true;
      if (!state.activated) {
        return;
      }

      finalizeStarted(state);
    },
  };

  return observer;
}

export function createNoopPersistedBootstrapObserver(): PersistedBootstrapObserver {
  return {
    async start() {
      return { pid: 0, activate() {} };
    },
    async waitForOutcome() {
      return { status: "timeout" };
    },
    async shutdown() {},
  };
}

export function createProcessRunnerPersistedBootstrapObserver(
  processRunner: ProcessRunner,
): PersistedBootstrapObserver {
  return {
    async start(input) {
      const { pid } = await processRunner.spawnDetached({
        sessionId: input.sessionId,
        message: input.message,
        cwd: input.cwd,
        model: input.model,
        sessionDir: input.sessionDir,
        name: input.name,
      });
      return { pid, activate() {} };
    },
    async waitForOutcome() {
      return { status: "timeout" };
    },
    async shutdown() {},
  };
}
