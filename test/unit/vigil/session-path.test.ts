import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  childSessionExists,
  findChildSessionFilePath,
  findChildSessionPath,
} from "../../../src/vigil/session-path";

describe("session-path", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it("finds a session file by id suffix without parsing other sessions", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vigil-session-path-"));
    const sessionDir = join(tempRoot, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "20260101_child-abc.jsonl"), '{"type":"session"}\n', "utf8");
    writeFileSync(join(sessionDir, "20260101_other.jsonl"), '{"type":"session"}\n', "utf8");

    const path = await findChildSessionFilePath("child-abc", "/ignored/cwd", sessionDir);
    expect(path).toBe(join(sessionDir, "20260101_child-abc.jsonl"));
    expect(await childSessionExists("child-abc", "/ignored/cwd", sessionDir)).toBe(true);
    expect(await childSessionExists("missing", "/ignored/cwd", sessionDir)).toBe(false);
  });

  it("finds sessions under PI_CODING_AGENT_DIR when no custom sessionDir is set", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vigil-agent-dir-"));
    process.env.PI_CODING_AGENT_DIR = join(tempRoot, "custom-agent");
    const cwd = join(tempRoot, "project");
    const sessionId = "vigil-agent-dir-child";
    const resolvedCwd = resolve(cwd);
    const encoded = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = join(process.env.PI_CODING_AGENT_DIR!, "sessions", encoded);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `20260101_${sessionId}.jsonl`);
    writeFileSync(sessionFile, '{"type":"session"}\n', "utf8");

    expect(await findChildSessionFilePath(sessionId, cwd)).toBe(sessionFile);
    expect(await findChildSessionPath(sessionId, cwd)).toBe(sessionFile);
  });

  it("does not call SessionManager.list when cheap suffix lookup succeeds", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "vigil-session-hot-"));
    const sessionDir = join(tempRoot, "sessions");
    const sessionId = "vigil-hot-path-child";
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `20260101_${sessionId}.jsonl`), '{"type":"session"}\n', "utf8");

    const listSpy = vi.spyOn(SessionManager, "list");
    const listAllSpy = vi.spyOn(SessionManager, "listAll");

    await findChildSessionPath(sessionId, "/ignored/cwd", sessionDir);

    expect(listSpy).not.toHaveBeenCalled();
    expect(listAllSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
