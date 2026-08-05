import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessRunner, TerminateAndWaitOptions } from "./ports";
import {
  boundStderrExcerpt,
  classifyPersistedBootstrapFailure,
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
  stderr: string;
  finalized: boolean;
  outcome: PersistedBootstrapOutcome | null;
  outcomeWaiters: Array<(outcome: PersistedBootstrapOutcome) => void>;
  sessionCheckTimer?: NodeJS.Timeout;
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

function waitForObservationOutcome(
  observation: ActiveObservation,
  timeoutMs: number,
): Promise<PersistedBootstrapOutcome> {
  if (observation.outcome) {
    return Promise.resolve(observation.outcome);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: "timeout" });
    }, timeoutMs);

    observation.outcomeWaiters.push((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
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
  onFailed: (input: PersistedBootstrapFailureInput) => void;
  sessionPollIntervalMs?: number;
}): PersistedBootstrapObserver {
  const piExecutable = options.piExecutable ?? "pi";
  const sessionPollIntervalMs = options.sessionPollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  const observations = new Map<string, ActiveObservation>();
  const completedOutcomes = new Map<string, PersistedBootstrapOutcome>();
  let shutdownRequested = false;

  const finalizeStarted = (observation: ActiveObservation): void => {
    if (observation.finalized) {
      return;
    }
    observation.finalized = true;
    if (observation.sessionCheckTimer) {
      clearInterval(observation.sessionCheckTimer);
      observation.sessionCheckTimer = undefined;
    }
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
    if (observation.sessionCheckTimer) {
      clearInterval(observation.sessionCheckTimer);
      observation.sessionCheckTimer = undefined;
    }

    const stderrExcerpt = observation.stderr
      ? boundStderrExcerpt(observation.stderr, MAX_STDERR_EXCERPT_CHARS)
      : undefined;

    if (!shutdownRequested) {
      options.onFailed({
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

  const attachStreamHandlers = (observation: ActiveObservation): void => {
    const onStderr = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      observation.stderr = boundStderrExcerpt(
        observation.stderr + text,
        MAX_STDERR_EXCERPT_CHARS,
      );

      const parsed = parsePiStderrFailure(observation.stderr);
      if (parsed) {
        void finalizeFailed(observation, parsed);
      }
    };

    observation.child.stderr?.on("data", onStderr);

    observation.cleanup = () => {
      observation.child.stderr?.off("data", onStderr);
      observation.child.stderr?.destroy();
    };
  };

  const activateObservation = (observation: ActiveObservation): void => {
    if (observation.activated) {
      return;
    }
    observation.activated = true;
    attachStreamHandlers(observation);

    observation.sessionCheckTimer = setInterval(() => {
      void evaluateSessionExists(observation).then((exists) => {
        if (exists) {
          finalizeStarted(observation);
        }
      });
    }, sessionPollIntervalMs);

    observation.child.on("close", () => {
      void finalizeOnClose(observation);
    });
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
        stderr: "",
        finalized: false,
        outcome: null,
        outcomeWaiters: [],
        cleanup: () => undefined,
      };

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
            if (observation.sessionCheckTimer) {
              clearInterval(observation.sessionCheckTimer);
            }
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
};

export function createFakePersistedBootstrapObserver(
  options?: FakePersistedBootstrapObserverOptions,
): PersistedBootstrapObserver & {
  pushStderr: (vigilId: string, chunk: string) => void;
  pushClose: (vigilId: string, code?: number) => void;
  signalSessionExists: (vigilId: string) => void;
} {
  const states = new Map<string, FakeObservationState>();
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
      options?.onFailed?.({
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
  } = {
    async start(input) {
      if (shutdownRequested) {
        throw new Error("Cannot start persisted bootstrap child after parent shutdown");
      }

      states.set(input.vigilId, {
        activated: false,
        sessionExists: false,
        stderr: "",
        closed: false,
        finalized: false,
        outcome: null,
        outcomeWaiters: [],
        sessionId: input.sessionId,
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
