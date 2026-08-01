import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createNodeChildSessionNamer, findChildSessionPath } from "../../../src/vigil/node-runtime";

function createPersistedChildSession(options: {
  cwd: string;
  sessionDir: string;
  sessionId: string;
  name?: string;
}): string {
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(options.sessionDir, `${fileTimestamp}_${options.sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp,
      cwd: options.cwd,
    })}\n`,
  );

  const sessionManager = SessionManager.open(sessionFile, options.sessionDir, options.cwd);
  if (options.name) {
    sessionManager.appendSessionInfo(options.name);
  }

  return sessionFile;
}

describe("createNodeChildSessionNamer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefixes the current Pi session display name", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-namer-cwd-"));
    const sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-namer-sessions-"));
    tempDirs.push(cwd, sessionDir);

    const sessionId = "vigil-namer-current-name";
    const sessionFile = createPersistedChildSession({
      cwd,
      sessionDir,
      sessionId,
      name: "Renamed during work",
    });

    const namer = createNodeChildSessionNamer();
    const result = await namer.markCompleted({ sessionId, cwd, sessionDir });

    expect(result).toEqual({ completedName: "[completed] Renamed during work" });

    expect(await findChildSessionPath(sessionId, cwd, sessionDir)).toBe(sessionFile);
    const reopened = SessionManager.open(sessionFile, sessionDir, cwd);
    expect(reopened.getSessionName()).toBe("[completed] Renamed during work");
  });

  it("uses [completed] when the child session has no current display name", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-namer-cwd-"));
    const sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-namer-sessions-"));
    tempDirs.push(cwd, sessionDir);

    const sessionId = "vigil-namer-blank-name";
    createPersistedChildSession({ cwd, sessionDir, sessionId });

    const namer = createNodeChildSessionNamer();
    const result = await namer.markCompleted({ sessionId, cwd, sessionDir });
    expect(result).toEqual({ completedName: "[completed]" });
  });

  it("returns a clear error when the child session cannot be found", async () => {
    const namer = createNodeChildSessionNamer();
    const result = await namer.markCompleted({
      sessionId: "vigil-missing-child",
      cwd: "/tmp/missing",
      sessionDir: "/tmp/missing-sessions",
    });

    expect(result).toEqual({ error: "Child session not found: vigil-missing-child" });
  });
});
