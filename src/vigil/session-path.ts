import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function getDefaultAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** Mirrors pi-coding-agent default session dir encoding for a cwd. */
function getDefaultSessionDirForCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(getDefaultAgentDir(), "sessions", safePath);
}

function resolveSessionDir(cwd: string, sessionDir?: string): string {
  return sessionDir ? resolve(sessionDir) : getDefaultSessionDirForCwd(cwd);
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
