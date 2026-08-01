import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import {
  lifecycleStateToListItem,
  reconstructVigilLifecycleFromEntries,
  sortLifecycleStatesMostRecentFirst,
  type VigilLifecycleState,
} from "./lifecycle";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ChildSessionState,
  ParentLedger,
  ProcessRunner,
  SpawnChildInput,
  TerminateAndWaitOptions,
  VigilServiceDeps,
} from "./ports";
import { extractLatestAssistantState, deriveVigilState, getTurnStartedAt } from "./session-text";
import {
  createVigilId,
  normalizeVigilName,
  type CompleteInput,
  type LaunchInput,
  type SendInput,
  type VigilCompletionRecord,
  type VigilLaunchRecord,
  type VigilListItem,
  type VigilListOrError,
  type VigilResult,
  type VigilRuntimeRecord,
  type VigilSnapshot,
  type VigilTurnRecord,
} from "./types";

const DEFAULT_REAP_TIMEOUT_MS = 5000;
const REAP_POLL_INTERVAL_MS = 50;

export class VigilService {
  private readonly deps: VigilServiceDeps;

  constructor(deps: VigilServiceDeps) {
    this.deps = deps;
  }

  async launch(input: LaunchInput): Promise<VigilResult> {
    const normalizedName = normalizeVigilName(input.name);
    if (!normalizedName) {
      return { error: "launch requires name" };
    }

    if (!input.message.trim()) {
      return { error: "launch requires message" };
    }

    const id = this.deps.createId?.() ?? createVigilId();
    const sessionId = id;
    const cwd = input.cwd ?? input.parentCwd;
    const turnStartedAt = new Date().toISOString();

    let pid: number;
    try {
      ({ pid } = await this.deps.processRunner.spawnDetached({
        sessionId,
        message: input.message,
        cwd,
        model: input.model,
        sessionDir: this.deps.sessionDir,
        name: normalizedName,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to launch Pi child: ${message}` };
    }

    const record: VigilLaunchRecord = {
      id,
      sessionId,
      name: normalizedName,
      pid,
      cwd,
      model: input.model,
      sessionDir: this.deps.sessionDir,
      launchedAt: turnStartedAt,
    };

    this.deps.parentLedger.appendLaunch(record);

    return {
      id,
      sessionId,
      name: normalizedName,
      cwd,
      state: "running",
      latestResponse: null,
    };
  }

  async poll(vigilId: string): Promise<VigilResult> {
    const lifecycle = this.getLifecycleState(vigilId);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${vigilId}` };
    }

    if (lifecycle.completionRecord) {
      return this.buildCompletedSnapshot(lifecycle);
    }

    return this.buildActiveSnapshot(lifecycle);
  }

  async send(input: SendInput): Promise<VigilResult> {
    if (!input.message.trim()) {
      return { error: "send requires message" };
    }

    const lifecycle = this.getLifecycleState(input.vigilId);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${input.vigilId}` };
    }

    if (lifecycle.completionRecord) {
      return { error: `Vigil child is completed: ${input.vigilId}` };
    }

    const record = lifecycle.runtimeRecord;
    const snapshot = await this.buildActiveSnapshot(lifecycle);

    if (snapshot.state === "running") {
      return { error: `Vigil child is still running: ${input.vigilId}` };
    }

    if (this.deps.processRunner.isAlive(record.pid)) {
      try {
        await this.deps.processRunner.terminateAndWait(record.pid, {
          timeoutMs: this.deps.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to reap settled Pi child before send: ${message}` };
      }
    }

    let pid: number;
    const turnStartedAt = new Date().toISOString();
    try {
      ({ pid } = await this.deps.processRunner.spawnDetached({
        sessionId: record.sessionId,
        message: input.message,
        cwd: record.cwd,
        model: input.model,
        sessionDir: record.sessionDir ?? this.deps.sessionDir,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to launch Pi child: ${message}` };
    }

    const turnRecord: VigilTurnRecord = {
      id: record.id,
      sessionId: record.sessionId,
      pid,
      cwd: record.cwd,
      model: input.model,
      sessionDir: record.sessionDir ?? this.deps.sessionDir,
      sentAt: turnStartedAt,
    };

    this.deps.parentLedger.appendTurn(turnRecord);

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: lifecycle.launchName,
      cwd: record.cwd,
      state: "running",
      latestResponse: snapshot.latestResponse,
    };
  }

  async list(includeCompleted = false): Promise<VigilListOrError> {
    const items = await this.buildListItems(includeCompleted);
    return { vigils: items };
  }

  async complete(input: CompleteInput): Promise<VigilResult> {
    const lifecycle = this.getLifecycleState(input.vigilId);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${input.vigilId}` };
    }

    if (lifecycle.completionRecord) {
      return this.buildCompletedSnapshot(lifecycle);
    }

    const record = lifecycle.runtimeRecord;
    const activeSnapshot = await this.buildActiveSnapshot(lifecycle);

    if (activeSnapshot.state === "running") {
      return { error: `Vigil child is still running: ${input.vigilId}` };
    }

    if (this.deps.processRunner.isAlive(record.pid)) {
      try {
        await this.deps.processRunner.terminateAndWait(record.pid, {
          timeoutMs: this.deps.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to reap settled Pi child before complete: ${message}` };
      }
    }

    const renameResult = await this.deps.childSessionNamer.markCompleted({
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir ?? this.deps.sessionDir,
    });

    if ("error" in renameResult) {
      return { error: renameResult.error };
    }

    const completedAt = new Date().toISOString();
    const completionRecord: VigilCompletionRecord = {
      id: record.id,
      sessionId: record.sessionId,
      name: renameResult.completedName,
      cwd: record.cwd,
      sessionDir: record.sessionDir ?? this.deps.sessionDir,
      completedAt,
    };

    this.deps.parentLedger.appendComplete(completionRecord);

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: renameResult.completedName,
      cwd: record.cwd,
      state: "completed",
      latestResponse: activeSnapshot.latestResponse,
      completedAt,
    };
  }

  private getLifecycleState(vigilId: string): VigilLifecycleState | null {
    return this.deps.parentLedger.getLifecycle(vigilId);
  }

  private async buildListItems(includeCompleted: boolean): Promise<VigilListItem[]> {
    const states = this.deps.parentLedger.listLifecycleStates(includeCompleted);
    const items: VigilListItem[] = [];

    for (const lifecycle of states) {
      if (lifecycle.completionRecord) {
        items.push(lifecycleStateToListItem(lifecycle, "completed"));
        continue;
      }

      const activeSnapshot = await this.buildActiveSnapshot(lifecycle);
      items.push(
        lifecycleStateToListItem(lifecycle, activeSnapshot.state === "running" ? "running" : "waiting"),
      );
    }

    return items;
  }

  private async buildActiveSnapshot(lifecycle: VigilLifecycleState): Promise<VigilSnapshot> {
    const record = lifecycle.runtimeRecord;
    const { latestResponse, turnComplete, lastConversationTimestamp } =
      await this.deps.childSessionReader.readChildSessionState({
        sessionId: record.sessionId,
        cwd: record.cwd,
        sessionDir: record.sessionDir,
      });

    const alive = this.deps.processRunner.isAlive(record.pid);
    const state = deriveVigilState({
      alive,
      turnComplete,
      lastConversationTimestamp,
      turnStartedAt: getTurnStartedAt(record),
    });

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: lifecycle.launchName,
      cwd: record.cwd,
      state,
      latestResponse,
    };
  }

  private async buildCompletedSnapshot(lifecycle: VigilLifecycleState): Promise<VigilSnapshot> {
    const completion = lifecycle.completionRecord!;
    const record = lifecycle.runtimeRecord;
    const { latestResponse } = await this.deps.childSessionReader.readChildSessionState({
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir,
    });

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: completion.name,
      cwd: record.cwd,
      state: "completed",
      latestResponse,
      completedAt: completion.completedAt,
    };
  }
}

export function buildPiChildArgs(input: SpawnChildInput): string[] {
  const args = ["--mode", "json", "-p", "--session-id", input.sessionId];
  if (input.name) {
    args.push("--name", input.name);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.sessionDir) {
    args.push("--session-dir", input.sessionDir);
  }
  args.push(input.message);
  return args;
}

export function spawnDetachedPiChild(
  piExecutable: string,
  input: SpawnChildInput,
): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    const args = buildPiChildArgs(input);
    const child = spawn(piExecutable, args, {
      cwd: input.cwd,
      detached: true,
      stdio: "ignore",
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.once("spawn", () => {
      child.on("error", () => {
        // Detached children may fail after unref; never crash the parent Pi process.
      });
      child.unref();

      if (!child.pid) {
        reject(new Error("Failed to spawn detached Pi child process"));
        return;
      }

      resolve({ pid: child.pid });
    });
  });
}

export function attachDetachedChildErrorHandler(child: ChildProcess): void {
  child.on("error", () => {
    // Prevent unhandled 'error' events on detached children after unref().
  });
}

export async function terminateTrackedProcess(
  isAlive: (pid: number) => boolean,
  pid: number,
  options?: TerminateAndWaitOptions,
): Promise<void> {
  if (!isAlive(pid)) {
    return;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, REAP_POLL_INTERVAL_MS));
  }

  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

export function createNodeProcessRunner(options?: { piExecutable?: string }): ProcessRunner {
  const piExecutable = options?.piExecutable ?? "pi";

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    spawnDetached(input) {
      return spawnDetachedPiChild(piExecutable, input);
    },
    isAlive,
    terminateAndWait(pid, terminateOptions) {
      return terminateTrackedProcess(isAlive, pid, terminateOptions);
    },
  };
}

export async function findChildSessionPath(
  sessionId: string,
  cwd: string,
  sessionDir?: string,
): Promise<string | null> {
  const sessions = sessionDir
    ? await SessionManager.listAll(sessionDir)
    : await SessionManager.list(cwd);
  const match = sessions.find((session) => session.id === sessionId);
  return match?.path ?? null;
}

export function readChildSessionStateFromFile(sessionFile: string): ChildSessionState {
  const content = readFileSync(sessionFile, "utf8");
  const fileEntries = parseSessionEntries(content);
  const entries = fileEntries.filter((entry) => entry.type !== "session") as SessionEntry[];
  return extractLatestAssistantState(entries);
}

export function readLatestAssistantTextFromFile(sessionFile: string): string | null {
  return readChildSessionStateFromFile(sessionFile).latestResponse;
}

export function createNodeChildSessionReader(): ChildSessionReader {
  return {
    async readChildSessionState({ sessionId, cwd, sessionDir }) {
      const sessionPath = await findChildSessionPath(sessionId, cwd, sessionDir);
      if (!sessionPath) {
        return { latestResponse: null, turnComplete: false, lastConversationTimestamp: null };
      }
      return readChildSessionStateFromFile(sessionPath);
    },
  };
}

export function createNodeChildSessionNamer(): ChildSessionNamer {
  return {
    async markCompleted({ sessionId, cwd, sessionDir }) {
      const sessionPath = await findChildSessionPath(sessionId, cwd, sessionDir);
      if (!sessionPath) {
        return { error: `Child session not found: ${sessionId}` };
      }

      const sessionManager = SessionManager.open(sessionPath, sessionDir, cwd);
      const currentName = sessionManager.getSessionName();
      const completedName = currentName ? `[completed] ${currentName}` : "[completed]";
      sessionManager.appendSessionInfo(completedName);
      return { completedName };
    },
  };
}

export function getLifecycleFromSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  vigilId: string,
): VigilLifecycleState | null {
  const lifecycle = reconstructVigilLifecycleFromEntries(sessionManager.getEntries());
  return lifecycle.get(vigilId) ?? null;
}

export function listLifecycleStatesFromSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  includeCompleted: boolean,
): VigilLifecycleState[] {
  const lifecycle = reconstructVigilLifecycleFromEntries(sessionManager.getEntries());
  const sorted = sortLifecycleStatesMostRecentFirst(lifecycle.values());

  if (includeCompleted) {
    return sorted;
  }

  return sorted.filter((state) => !state.completionRecord);
}

export function findLatestTurnInSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  vigilId: string,
): VigilRuntimeRecord | null {
  return getLifecycleFromSessionManager(sessionManager, vigilId)?.runtimeRecord ?? null;
}

export function createSessionParentLedger(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  appendEntry: (customType: string, data: unknown) => void,
): ParentLedger {
  return {
    appendLaunch(record) {
      appendEntry("vigil-launch", record);
    },
    appendTurn(record) {
      appendEntry("vigil-turn", record);
    },
    appendComplete(record) {
      appendEntry("vigil-complete", record);
    },
    getLifecycle(vigilId) {
      return getLifecycleFromSessionManager(sessionManager, vigilId);
    },
    listLifecycleStates(includeCompleted) {
      return listLifecycleStatesFromSessionManager(sessionManager, includeCompleted);
    },
  };
}

export function createVigilServiceForContext(options: {
  parentCwd: string;
  sessionManager: Pick<SessionManagerType, "getEntries">;
  appendEntry: (customType: string, data: unknown) => void;
  sessionDir?: string;
  processRunner?: ProcessRunner;
  childSessionReader?: ChildSessionReader;
  childSessionNamer?: ChildSessionNamer;
  reapTimeoutMs?: number;
}): VigilService {
  return new VigilService({
    processRunner: options.processRunner ?? createNodeProcessRunner(),
    childSessionReader: options.childSessionReader ?? createNodeChildSessionReader(),
    childSessionNamer: options.childSessionNamer ?? createNodeChildSessionNamer(),
    parentLedger: createSessionParentLedger(options.sessionManager, options.appendEntry),
    sessionDir: options.sessionDir,
    reapTimeoutMs: options.reapTimeoutMs,
  });
}
