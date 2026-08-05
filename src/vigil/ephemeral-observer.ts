import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessRunner, TerminateAndWaitOptions } from "./ports";
import { MAX_ENTRY_DETAIL_CHARS } from "./transcript";

export const MAX_EPHEMERAL_JSON_LINE_BYTES = 256 * 1024;
export const MAX_EPHEMERAL_LATEST_RESPONSE_CHARS = MAX_ENTRY_DETAIL_CHARS;

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

export interface EphemeralObserverSettleResult {
  latestResponse: string | null;
  settledAt: string;
  stopReason?: string;
  error?: string;
}

export interface EphemeralLiveState {
  state: "running" | "waiting";
  latestResponse: string | null;
}

export interface EphemeralLaunchInput {
  vigilId: string;
  parentSessionId: string;
  message: string;
  cwd: string;
  model?: string;
  name?: string;
  onSettled: (result: EphemeralObserverSettleResult) => void;
}

export interface EphemeralStartResult {
  pid: number;
  activate(): void;
}

export type EphemeralBootstrapOutcome =
  | { status: "started" }
  | { status: "failed"; error: string }
  | { status: "timeout" };

export interface EphemeralChildObserver {
  start(input: EphemeralLaunchInput): Promise<EphemeralStartResult>;
  waitForOutcome(vigilId: string, options: { timeoutMs: number }): Promise<EphemeralBootstrapOutcome>;
  getLiveState(vigilId: string): EphemeralLiveState | null;
  isObserving(vigilId: string): boolean;
  shutdown(options?: TerminateAndWaitOptions): Promise<void>;
}

export interface ParsedEphemeralObserverState {
  latestResponse: string | null;
  turnComplete: boolean;
  settled: boolean;
  stopReason?: string;
  error?: string;
}

export interface PiJsonStreamEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractVisibleTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  let text = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const typed = part as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      text += typed.text;
    }
  }
  return text;
}

function boundLatestResponse(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= MAX_EPHEMERAL_LATEST_RESPONSE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_EPHEMERAL_LATEST_RESPONSE_CHARS)}…`;
}

function extractAssistantTextFromMessage(message: PiJsonStreamEvent["message"]): string | null {
  if (!message || message.role !== "assistant") {
    return null;
  }

  if (message.stopReason === "aborted" && (!Array.isArray(message.content) || message.content.length === 0)) {
    return null;
  }

  const text = extractVisibleTextParts(message.content).trim();
  return text || null;
}

function isTerminalAssistantMessage(message: PiJsonStreamEvent["message"]): boolean {
  if (!message || message.role !== "assistant") {
    return false;
  }
  return message.stopReason !== undefined && TERMINAL_STOP_REASONS.has(message.stopReason);
}

export function createInitialEphemeralObserverState(): ParsedEphemeralObserverState {
  return {
    latestResponse: null,
    turnComplete: false,
    settled: false,
  };
}

export function applyEphemeralJsonEvent(
  state: ParsedEphemeralObserverState,
  event: PiJsonStreamEvent,
): ParsedEphemeralObserverState {
  if (state.settled) {
    return state;
  }

  const next = { ...state };

  if (event.type === "message_end" || event.type === "turn_end") {
    const assistantText = extractAssistantTextFromMessage(event.message);
    if (assistantText !== null) {
      next.latestResponse = boundLatestResponse(assistantText);
    }
    if (isTerminalAssistantMessage(event.message)) {
      next.turnComplete = true;
      next.stopReason = event.message?.stopReason;
      if (event.message?.stopReason === "error") {
        next.error = event.message.errorMessage?.trim() || "assistant error";
      }
    }
    return next;
  }

  if (event.type === "agent_settled") {
    next.settled = true;
    if (next.turnComplete || next.latestResponse !== null) {
      return next;
    }
    next.error = next.error ?? "agent settled without terminal assistant response";
    return next;
  }

  return next;
}

export function parseEphemeralJsonLine(line: string): PiJsonStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    return parsed as PiJsonStreamEvent;
  } catch {
    return null;
  }
}

export class EphemeralJsonLineBuffer {
  private buffer = "";
  private readonly oversizedLines: string[] = [];

  feed(chunk: string): string[] {
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer += normalized;
    const lines: string[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        if (this.buffer.length > MAX_EPHEMERAL_JSON_LINE_BYTES) {
          this.oversizedLines.push(this.buffer);
          this.buffer = "";
        }
        break;
      }

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line.length > MAX_EPHEMERAL_JSON_LINE_BYTES) {
        this.oversizedLines.push(line);
        continue;
      }

      lines.push(line);
    }

    return lines;
  }

  flushPartial(): string[] {
    if (!this.buffer) {
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    if (line.length > MAX_EPHEMERAL_JSON_LINE_BYTES) {
      this.oversizedLines.push(line);
      return [];
    }
    return [line];
  }

  getOversizedLineCount(): number {
    return this.oversizedLines.length;
  }
}

export function deriveEphemeralLiveState(state: ParsedEphemeralObserverState): EphemeralLiveState {
  if (state.settled || state.turnComplete) {
    return {
      state: "waiting",
      latestResponse: state.latestResponse,
    };
  }

  return {
    state: "running",
    latestResponse: state.latestResponse,
  };
}

export function buildPiEphemeralChildArgs(input: {
  message: string;
  model?: string;
  name?: string;
}): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (input.name) {
    args.push("--name", input.name);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  args.push(input.message);
  return args;
}

type ActiveObservation = {
  vigilId: string;
  parentSessionId: string;
  pid: number;
  parserState: ParsedEphemeralObserverState;
  settled: boolean;
  onSettled: (result: EphemeralObserverSettleResult) => void;
  child: ChildProcess;
  cleanup: () => void;
  lineBuffer: EphemeralJsonLineBuffer;
  handleLines: (lines: string[]) => void;
  activated: boolean;
  outcome: EphemeralBootstrapOutcome | null;
  outcomeWaiters: Array<(outcome: EphemeralBootstrapOutcome) => void>;
};

export function createNodeEphemeralChildObserver(options: {
  piExecutable?: string;
  processRunner: Pick<ProcessRunner, "isAlive" | "terminateAndWait">;
  reapTimeoutMs?: number;
  spawnChild?: (
    piExecutable: string,
    args: string[],
    spawnOptions: { cwd: string },
  ) => ChildProcess;
}): EphemeralChildObserver {
  const piExecutable = options.piExecutable ?? "pi";
  const observations = new Map<string, ActiveObservation>();
  const completedOutcomes = new Map<string, EphemeralBootstrapOutcome>();
  let shutdownRequested = false;

  const resolveOutcome = (observation: ActiveObservation, outcome: EphemeralBootstrapOutcome): void => {
    observation.outcome = outcome;
    completedOutcomes.set(observation.vigilId, outcome);
    for (const waiter of observation.outcomeWaiters) {
      waiter(outcome);
    }
    observation.outcomeWaiters = [];
  };

  const finalizeObservation = async (
    observation: ActiveObservation,
    exitError?: string,
  ): Promise<void> => {
    if (observation.settled) {
      return;
    }
    observation.settled = true;

    const live = deriveEphemeralLiveState(observation.parserState);
    const result: EphemeralObserverSettleResult = {
      latestResponse: live.latestResponse,
      settledAt: new Date().toISOString(),
      ...(observation.parserState.stopReason ? { stopReason: observation.parserState.stopReason } : {}),
      ...(observation.parserState.error
        ? { error: observation.parserState.error }
        : exitError
          ? { error: exitError }
          : {}),
    };

    if (!shutdownRequested) {
      observation.onSettled(result);
    }

    const outcome: EphemeralBootstrapOutcome = result.error
      ? { status: "failed", error: result.error }
      : { status: "started" };
    resolveOutcome(observation, outcome);

    if (options.processRunner.isAlive(observation.pid)) {
      try {
        await options.processRunner.terminateAndWait(observation.pid, {
          timeoutMs: options.reapTimeoutMs,
        });
      } catch {
        // Best-effort direct PID cleanup only.
      }
    }
  };

  const attachStreamHandlers = (observation: ActiveObservation): void => {
    observation.lineBuffer = new EphemeralJsonLineBuffer();

    observation.handleLines = (lines: string[]) => {
      for (const line of lines) {
        const event = parseEphemeralJsonLine(line);
        if (!event) {
          continue;
        }
        observation.parserState = applyEphemeralJsonEvent(observation.parserState, event);
        if (observation.parserState.settled) {
          void finalizeObservation(observation);
          return;
        }
      }
    };

    const onStdout = (chunk: Buffer | string) => {
      observation.handleLines(
        observation.lineBuffer.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8")),
      );
    };

    const onStderr = () => {
      // Drain stderr for backpressure; never surface to parent model.
    };

    observation.child.stdout?.on("data", onStdout);
    observation.child.stderr?.on("data", onStderr);

    observation.cleanup = () => {
      observation.child.stdout?.off("data", onStdout);
      observation.child.stderr?.off("data", onStderr);
      observation.child.stdout?.destroy();
      observation.child.stderr?.destroy();
    };
  };

  const activateObservation = (observation: ActiveObservation): void => {
    if (observation.activated) {
      return;
    }
    observation.activated = true;
    attachStreamHandlers(observation);

    observation.child.on("close", (code, signal) => {
      if (observation.settled) {
        observations.delete(observation.vigilId);
        observation.cleanup();
        return;
      }

      observation.handleLines(observation.lineBuffer.flushPartial());
      if (observation.settled) {
        observations.delete(observation.vigilId);
        observation.cleanup();
        return;
      }

      void finalizeObservation(
        observation,
        code === 0
          ? undefined
          : `ephemeral child exited (${signal ?? `code ${code ?? "unknown"}`})`,
      ).finally(() => {
        observations.delete(observation.vigilId);
        observation.cleanup();
      });
    });
  };

  return {
    async start(input) {
      if (shutdownRequested) {
        throw new Error("Cannot start ephemeral child after parent shutdown");
      }
      if (observations.has(input.vigilId)) {
        throw new Error(`Ephemeral child already observed: ${input.vigilId}`);
      }

      const args = buildPiEphemeralChildArgs({
        message: input.message,
        model: input.model,
        name: input.name,
      });

      const spawnChild =
        options.spawnChild ??
        ((executable, spawnArgs, spawnOptions) =>
          spawn(executable, spawnArgs, {
            cwd: spawnOptions.cwd,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
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
            reject(new Error("Failed to spawn ephemeral Pi child process"));
            return;
          }
          resolve(child.pid);
        });
      });

      const observation: ActiveObservation = {
        vigilId: input.vigilId,
        parentSessionId: input.parentSessionId,
        pid,
        parserState: createInitialEphemeralObserverState(),
        settled: false,
        onSettled: input.onSettled,
        child,
        cleanup: () => undefined,
        lineBuffer: new EphemeralJsonLineBuffer(),
        handleLines: () => undefined,
        activated: false,
        outcome: null,
        outcomeWaiters: [],
      };

      observations.set(input.vigilId, observation);
      return {
        pid,
        activate: () => activateObservation(observation),
      };
    },

    getLiveState(vigilId) {
      const observation = observations.get(vigilId);
      if (!observation || observation.settled) {
        return null;
      }
      return deriveEphemeralLiveState(observation.parserState);
    },

    isObserving(vigilId) {
      const observation = observations.get(vigilId);
      return observation !== undefined && !observation.settled;
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
      if (observation.outcome) {
        return Promise.resolve(observation.outcome);
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ status: "timeout" });
        }, waitOptions.timeoutMs);

        observation.outcomeWaiters.push((outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
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
            observation.cleanup();
            observations.delete(observation.vigilId);
          }
        }),
      );
      completedOutcomes.clear();
    },
  };
}

export function createNoopEphemeralChildObserver(): EphemeralChildObserver {
  return {
    async start() {
      return { pid: 0, activate() {} };
    },
    async waitForOutcome() {
      return { status: "timeout" };
    },
    getLiveState() {
      return null;
    },
    isObserving() {
      return false;
    },
    async shutdown() {
      // No-op for persisted-child-only tests and contexts.
    },
  };
}

export interface FakeEphemeralChildObserverOptions {
  onStart?: (input: EphemeralLaunchInput) => void;
}

export function createFakeEphemeralChildObserver(options?: FakeEphemeralChildObserverOptions): EphemeralChildObserver & {
  pushStdout: (vigilId: string, chunk: string) => void;
  pushClose: (vigilId: string, code?: number) => void;
  started: EphemeralLaunchInput[];
  shutdownCalls: number;
} {
  const started: EphemeralLaunchInput[] = [];
  const states = new Map<string, ParsedEphemeralObserverState>();
  const lineBuffers = new Map<string, EphemeralJsonLineBuffer>();
  const activated = new Set<string>();
  let nextPid = 9000;
  let shutdownRequested = false;
  let shutdownCalls = 0;

  const notified = new Set<string>();
  const completedOutcomes = new Map<string, EphemeralBootstrapOutcome>();
  const outcomeWaiters = new Map<string, Array<(outcome: EphemeralBootstrapOutcome) => void>>();

  const processLines = (vigilId: string, lines: string[]) => {
    for (const line of lines) {
      const state = states.get(vigilId);
      if (!state || (state.settled && notified.has(vigilId))) {
        return;
      }
      const event = parseEphemeralJsonLine(line);
      if (!event) {
        continue;
      }
      const next = applyEphemeralJsonEvent(state, event);
      states.set(vigilId, next);
      if (next.settled) {
        settle(vigilId);
        return;
      }
    }
  };

  const settle = (vigilId: string) => {
    if (notified.has(vigilId)) {
      return;
    }
    const input = started.find((entry) => entry.vigilId === vigilId);
    const state = states.get(vigilId);
    if (!input || !state) {
      return;
    }
    notified.add(vigilId);
    const live = deriveEphemeralLiveState(state);
    const outcome: EphemeralBootstrapOutcome = state.error
      ? { status: "failed", error: state.error }
      : { status: "started" };
    completedOutcomes.set(vigilId, outcome);
    for (const waiter of outcomeWaiters.get(vigilId) ?? []) {
      waiter(outcome);
    }
    outcomeWaiters.delete(vigilId);
    if (!shutdownRequested) {
      input.onSettled({
        latestResponse: live.latestResponse,
        settledAt: new Date().toISOString(),
        ...(state.stopReason ? { stopReason: state.stopReason } : {}),
        ...(state.error ? { error: state.error } : {}),
      });
    }
  };

  const observer: EphemeralChildObserver & {
    pushStdout: (vigilId: string, chunk: string) => void;
    pushClose: (vigilId: string, code?: number) => void;
    started: EphemeralLaunchInput[];
    get shutdownCalls(): number;
  } = {
    get started() {
      return started;
    },
    get shutdownCalls() {
      return shutdownCalls;
    },
    async start(input) {
      if (shutdownRequested) {
        throw new Error("Cannot start ephemeral child after parent shutdown");
      }
      started.push(input);
      states.set(input.vigilId, createInitialEphemeralObserverState());
      lineBuffers.set(input.vigilId, new EphemeralJsonLineBuffer());
      const pid = nextPid;
      nextPid += 1;
      return {
        pid,
        activate: () => {
          if (activated.has(input.vigilId)) {
            return;
          }
          activated.add(input.vigilId);
          options?.onStart?.(input);
        },
      };
    },
    getLiveState(vigilId) {
      const state = states.get(vigilId);
      if (!state || state.settled) {
        return null;
      }
      return deriveEphemeralLiveState(state);
    },
    isObserving(vigilId) {
      const state = states.get(vigilId);
      return state !== undefined && !state.settled;
    },
    waitForOutcome(vigilId, waitOptions) {
      const completed = completedOutcomes.get(vigilId);
      if (completed) {
        return Promise.resolve(completed);
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ status: "timeout" });
        }, waitOptions.timeoutMs);

        const waiters = outcomeWaiters.get(vigilId) ?? [];
        waiters.push((outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
        outcomeWaiters.set(vigilId, waiters);
      });
    },
    async shutdown() {
      shutdownCalls += 1;
      shutdownRequested = true;
      states.clear();
      lineBuffers.clear();
      activated.clear();
      completedOutcomes.clear();
      outcomeWaiters.clear();
    },
    pushStdout(vigilId, chunk) {
      let buffer = lineBuffers.get(vigilId);
      if (!buffer) {
        buffer = new EphemeralJsonLineBuffer();
        lineBuffers.set(vigilId, buffer);
      }
      processLines(vigilId, buffer.feed(chunk));
    },
    pushClose(vigilId, code = 0) {
      const state = states.get(vigilId);
      if (!state || state.settled) {
        return;
      }

      const buffer = lineBuffers.get(vigilId);
      if (buffer) {
        processLines(vigilId, buffer.flushPartial());
      }

      const current = states.get(vigilId);
      if (!current || current.settled) {
        return;
      }
      if (code !== 0) {
        current.error = current.error ?? `ephemeral child exited (code ${code})`;
      }
      states.set(vigilId, { ...current, settled: true });
      settle(vigilId);
    },
  };

  return observer;
}
