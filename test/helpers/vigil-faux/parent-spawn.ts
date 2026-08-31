import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildPiChildArgs,
  terminateTrackedProcess,
} from "../../../src/vigil/node-runtime.js";
import { buildPiSpawnArgs, resolvePiSpawnCommand } from "../../../src/vigil/pi-spawn-command.js";
import { findChildSessionPath } from "../../../src/vigil/session-path.js";
import type { VigilCompletionRecord, VigilLaunchRecord } from "../../../src/vigil/types.js";
import { insertVigilFauxExtensionArgs } from "./process-runner.js";

const DEFAULT_FAUX_MODEL_ID = "vigil-faux/scripted";

const DEFAULT_PARENT_TIMEOUT_MS = 55_000;
const PARENT_KILL_TIMEOUT_MS = 5_000;

export interface SpawnVigilFauxParentPiInput {
  sessionId: string;
  cwd: string;
  sessionDir: string;
  scriptPath: string;
  prompt: string;
  name?: string;
  model?: string;
  timeoutMs?: number;
  piExecutable?: string;
}

export interface SpawnVigilFauxParentPiResult {
  exitCode: number | null;
  sessionPath: string | null;
  pid: number;
  timedOut: boolean;
}

export interface VigilLedgerEntries {
  launches: VigilLaunchRecord[];
  completions: VigilCompletionRecord[];
}

export interface VigilNotifySessionEntry {
  id: string;
  customType: string;
  content: string;
  details?: unknown;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(exitCode);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? 1));
  });
}

export async function spawnVigilFauxParentPi(
  input: SpawnVigilFauxParentPiInput,
): Promise<SpawnVigilFauxParentPiResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PARENT_TIMEOUT_MS;
  const model = input.model ?? DEFAULT_FAUX_MODEL_ID;
  const piExecutable = input.piExecutable ?? "pi";

  const childArgs = buildPiChildArgs({
    sessionId: input.sessionId,
    message: input.prompt,
    cwd: input.cwd,
    model,
    sessionDir: input.sessionDir,
    name: input.name,
  });

  const spawnCommand = resolvePiSpawnCommand({ piExecutable });
  const args = insertVigilFauxExtensionArgs(buildPiSpawnArgs(spawnCommand, childArgs), {
    loadLocalVigil: true,
  });

  const child = spawn(spawnCommand.command, args, {
    cwd: input.cwd,
    env: {
      ...process.env,
      PI_VIGIL_FAUX_SCRIPT: input.scriptPath,
      PI_VIGIL_SESSION_DIR: input.sessionDir,
      PI_VIGIL_FAUX_BOOTSTRAP_RUNNER: "1",
    },
    stdio: "ignore",
  });

  const pid = child.pid ?? 0;
  const exitCode = await waitForChildExit(child, timeoutMs);
  let timedOut = false;

  if (exitCode === null) {
    timedOut = true;
    if (pid > 0 && isProcessAlive(pid)) {
      try {
        await terminateTrackedProcess(isProcessAlive, pid, { timeoutMs: PARENT_KILL_TIMEOUT_MS });
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process may have exited between checks.
        }
      }
    }
  }

  const sessionPath = await findChildSessionPath(input.sessionId, input.cwd, input.sessionDir);

  return {
    exitCode: timedOut ? null : exitCode,
    sessionPath,
    pid,
    timedOut,
  };
}

export function readVigilLedgerFromSessionFile(sessionPath: string): VigilLedgerEntries {
  const content = readFileSync(sessionPath, "utf8");
  const entries = parseSessionEntries(content).filter(
    (entry) => entry.type !== "session",
  ) as SessionEntry[];

  const launches: VigilLaunchRecord[] = [];
  const completions: VigilCompletionRecord[] = [];

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    if (entry.customType === "vigil-launch") {
      launches.push(entry.data as VigilLaunchRecord);
    } else if (entry.customType === "vigil-complete") {
      completions.push(entry.data as VigilCompletionRecord);
    }
  }

  return { launches, completions };
}

export function readVigilNotifyEntriesFromSessionFile(sessionPath: string): VigilNotifySessionEntry[] {
  const content = readFileSync(sessionPath, "utf8");
  const entries = parseSessionEntries(content).filter(
    (entry) => entry.type !== "session",
  ) as SessionEntry[];

  const notifications: VigilNotifySessionEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== "vigil-notify") {
      continue;
    }

    const contentText =
      typeof entry.content === "string"
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
          : "";

    notifications.push({
      id: entry.id,
      customType: entry.customType,
      content: contentText,
      details: entry.details,
    });
  }

  return notifications;
}
