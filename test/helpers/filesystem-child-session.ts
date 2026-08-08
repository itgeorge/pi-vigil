import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../src/vigil/descendant-inspector";
import type { ChildSessionNamer, ProcessRunner } from "../../src/vigil/ports";
import type { PersistedBootstrapObserver } from "../../src/vigil/persisted-bootstrap-observer";
import {
  createNodeChildSessionNamer,
  createNodeChildSessionReader,
  createNodeChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../src/vigil/node-runtime";
import type { VigilLaunchRecord } from "../../src/vigil/types";

export interface FilesystemChildSessionFixture {
  tempRoot: string;
  sessionDir: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  userEntryId: string;
  assistantEntryId: string;
  assistantText: string;
  launchedAt: string;
  launchName: string;
}

export function createFilesystemChildSessionFixture(options?: {
  sessionId?: string;
  assistantText?: string;
  cwd?: string;
  launchedAt?: string;
  launchName?: string;
  prefix?: string;
}): FilesystemChildSessionFixture {
  const tempRoot = mkdtempSync(join(tmpdir(), options?.prefix ?? "vigil-fs-child-"));
  const sessionDir = join(tempRoot, "sessions");
  const sessionId = options?.sessionId ?? "vigil-fs-child-session";
  const cwd = options?.cwd ?? "/parent";
  const launchedAt = options?.launchedAt ?? "2026-08-08T12:00:00.000Z";
  const assistantText = options?.assistantText ?? "Filesystem child response";
  const userEntryId = "user-fs-1";
  const assistantEntryId = "asst-fs-1";
  const launchName = options?.launchName ?? "Filesystem child";

  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, `20260101_${sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-08-01T12:00:00.000Z",
        cwd,
      }),
      JSON.stringify({
        type: "message",
        id: userEntryId,
        parentId: null,
        timestamp: "2026-08-08T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      }),
      JSON.stringify({
        type: "message",
        id: assistantEntryId,
        parentId: userEntryId,
        timestamp: "2026-08-08T12:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          stopReason: "stop",
          timestamp: 2,
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  return {
    tempRoot,
    sessionDir,
    sessionId,
    sessionFile,
    cwd,
    userEntryId,
    assistantEntryId,
    assistantText,
    launchedAt,
    launchName,
  };
}

export function createFilesystemChildLaunchRecord(fixture: FilesystemChildSessionFixture, pid = 4242): VigilLaunchRecord {
  return {
    id: fixture.sessionId,
    sessionId: fixture.sessionId,
    name: fixture.launchName,
    pid,
    cwd: fixture.cwd,
    sessionDir: fixture.sessionDir,
    launchedAt: fixture.launchedAt,
  };
}

export function createFilesystemChildVigilService(
  fixture: FilesystemChildSessionFixture,
  options?: {
    pid?: number;
    isAlive?: boolean;
    persistedBootstrapObserver?: PersistedBootstrapObserver;
    bootstrapFailFastTimeoutMs?: number;
    childSessionNamer?: ChildSessionNamer;
  },
) {
  const sessionManager = SessionManager.inMemory(fixture.cwd);
  const record = createFilesystemChildLaunchRecord(fixture, options?.pid ?? 4242);
  sessionManager.appendCustomEntry("vigil-launch", record);

  const parentLedger = createSessionParentLedger(sessionManager, (type, data) => {
    sessionManager.appendCustomEntry(type, data);
  });

  let alive = options?.isAlive ?? true;
  const processRunner: ProcessRunner = {
    async spawnDetached() {
      alive = true;
      return { pid: 9999 };
    },
    isAlive: () => alive,
    async terminateAndWait() {
      alive = false;
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader: createNodeChildSessionReader(),
    childSessionTranscriptReader: createNodeChildSessionTranscriptReader(),
    childSessionNamer: options?.childSessionNamer ?? createNodeChildSessionNamer(),
    descendantInspector: createZeroDescendantInspector(),
    parentLedger,
    sessionDir: fixture.sessionDir,
    ...(options?.persistedBootstrapObserver
      ? {
          persistedBootstrapObserver: options.persistedBootstrapObserver,
          bootstrapFailFastTimeoutMs: options.bootstrapFailFastTimeoutMs ?? 25,
        }
      : {}),
  });

  return { service, sessionManager, record, processRunner, setAlive: (value: boolean) => { alive = value; } };
}
