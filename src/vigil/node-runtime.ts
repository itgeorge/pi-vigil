import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import type {
  ChildSessionReader,
  ChildSessionState,
  ParentLedger,
  ProcessRunner,
  SpawnChildInput,
  VigilServiceDeps,
} from "./ports";
import { extractLatestAssistantState } from "./session-text";
import { createVigilId, type LaunchInput, type VigilLaunchRecord, type VigilResult } from "./types";

export class VigilService {
  private readonly deps: VigilServiceDeps;

  constructor(deps: VigilServiceDeps) {
    this.deps = deps;
  }

  async launch(input: LaunchInput): Promise<VigilResult> {
    const id = this.deps.createId?.() ?? createVigilId();
    const sessionId = id;
    const cwd = input.cwd ?? input.parentCwd;

    let pid: number;
    try {
      ({ pid } = await this.deps.processRunner.spawnDetached({
        sessionId,
        message: input.message,
        cwd,
        model: input.model,
        sessionDir: this.deps.sessionDir,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to launch Pi child: ${message}` };
    }

    const record: VigilLaunchRecord = {
      id,
      sessionId,
      pid,
      cwd,
      model: input.model,
      sessionDir: this.deps.sessionDir,
      launchedAt: new Date().toISOString(),
    };

    this.deps.parentLedger.appendLaunch(record);

    return {
      id,
      sessionId,
      cwd,
      state: "running",
      latestResponse: null,
    };
  }

  async poll(vigilId: string): Promise<VigilResult> {
    const record = this.deps.parentLedger.findLaunch(vigilId);
    if (!record) {
      return { error: `Unknown vigil id: ${vigilId}` };
    }

    const { latestResponse, turnComplete } = await this.deps.childSessionReader.readChildSessionState({
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir,
    });

    const alive = this.deps.processRunner.isAlive(record.pid);
    const state = !alive || turnComplete ? "waiting" : "running";

    return {
      id: record.id,
      sessionId: record.sessionId,
      cwd: record.cwd,
      state,
      latestResponse,
    };
  }
}

export function buildPiChildArgs(input: SpawnChildInput): string[] {
  const args = ["--mode", "json", "-p", "--session-id", input.sessionId];
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

export function createNodeProcessRunner(options?: { piExecutable?: string }): ProcessRunner {
  const piExecutable = options?.piExecutable ?? "pi";

  return {
    spawnDetached(input) {
      return spawnDetachedPiChild(piExecutable, input);
    },
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
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
        return { latestResponse: null, turnComplete: false };
      }
      return readChildSessionStateFromFile(sessionPath);
    },
  };
}

export function findLaunchInSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  vigilId: string,
): VigilLaunchRecord | null {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== "vigil-launch") {
      continue;
    }

    const data = entry.data as VigilLaunchRecord | undefined;
    if (data?.id === vigilId) {
      return data;
    }
  }

  return null;
}

export function createSessionParentLedger(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  appendEntry: (customType: string, data: unknown) => void,
): ParentLedger {
  return {
    appendLaunch(record) {
      appendEntry("vigil-launch", record);
    },
    findLaunch(vigilId) {
      return findLaunchInSessionManager(sessionManager, vigilId);
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
}): VigilService {
  return new VigilService({
    processRunner: options.processRunner ?? createNodeProcessRunner(),
    childSessionReader: options.childSessionReader ?? createNodeChildSessionReader(),
    parentLedger: createSessionParentLedger(options.sessionManager, options.appendEntry),
    sessionDir: options.sessionDir,
  });
}
