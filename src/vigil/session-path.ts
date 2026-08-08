import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

function expandTildePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function getDefaultAgentDir(): string {
  const envDir = process.env[ENV_AGENT_DIR]?.trim();
  if (envDir) {
    return resolve(expandTildePath(envDir));
  }
  return join(homedir(), ".pi", "agent");
}

/** Mirrors pi-coding-agent default session dir encoding for a cwd. */
function getDefaultSessionDirForCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getDefaultAgentDir(), "sessions", safePath);
}

function resolveSessionDir(cwd: string, sessionDir?: string): string {
  return sessionDir ? resolve(expandTildePath(sessionDir)) : getDefaultSessionDirForCwd(cwd);
}

function sessionFileSuffix(sessionId: string): string {
  return `_${sessionId}.jsonl`;
}

/**
 * Locate a child session JSONL by id without parsing every session file in the directory.
 * Pi names files `{timestamp}_{sessionId}.jsonl`.
 */
export async function findChildSessionFilePath(
  sessionId: string,
  cwd: string,
  sessionDir?: string,
): Promise<string | null> {
  const dir = resolveSessionDir(cwd, sessionDir);
  if (!existsSync(dir)) {
    return null;
  }

  const suffix = sessionFileSuffix(sessionId);
  try {
    const entries = await readdir(dir);
    const match = entries.find((entry) => entry.endsWith(suffix));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

export async function childSessionExists(
  sessionId: string,
  cwd: string,
  sessionDir?: string,
): Promise<boolean> {
  return (await findChildSessionFilePath(sessionId, cwd, sessionDir)) !== null;
}

/**
 * Resolve a child session JSONL path by id. Uses a cheap directory scan first, then
 * falls back to SessionManager listing for fixture/legacy filenames.
 */
export async function findChildSessionPath(
  sessionId: string,
  cwd: string,
  sessionDir?: string,
): Promise<string | null> {
  const cheap = await findChildSessionFilePath(sessionId, cwd, sessionDir);
  if (cheap) {
    return cheap;
  }

  const sessions = sessionDir
    ? await SessionManager.listAll(sessionDir)
    : await SessionManager.list(cwd);
  const match = sessions.find((session) => session.id === sessionId);
  return match?.path ?? null;
}
