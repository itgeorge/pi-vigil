import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childSessionExists, findChildSessionFilePath } from "../../../src/vigil/session-path";

describe("session-path", () => {
  let tempRoot: string;

  afterEach(() => {
    // temp dirs are left on disk; tests use unique prefixes per case.
  });

  it("finds a session file by id suffix without parsing other sessions", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "vigil-session-path-"));
    const sessionDir = join(tempRoot, "sessions");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "20260101_child-abc.jsonl"), '{"type":"session"}\n', "utf8");
    writeFileSync(join(sessionDir, "20260101_other.jsonl"), '{"type":"session"}\n', "utf8");

    const path = await findChildSessionFilePath("child-abc", "/ignored/cwd", sessionDir);
    expect(path).toBe(join(sessionDir, "20260101_child-abc.jsonl"));
    expect(await childSessionExists("child-abc", "/ignored/cwd", sessionDir)).toBe(true);
    expect(await childSessionExists("missing", "/ignored/cwd", sessionDir)).toBe(false);
  });
});
