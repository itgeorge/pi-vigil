import { EventEmitter, PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import {
  createNodeChildSessionNamer,
  createNodeChildSessionReader,
  createNodeChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { createNodePersistedBootstrapObserver } from "../../../src/vigil/persisted-bootstrap-observer";
import { isVigilError, type VigilSnapshot } from "../../../src/vigil/types";
import {
  createFilesystemChildSessionFixture,
  type FilesystemChildSessionFixture,
} from "../../helpers/filesystem-child-session";

function createMockChildProcess(pid = 12_345): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdout, stderr, pid });
  child.unref = () => child;
  queueMicrotask(() => {
    child.emit("spawn");
  });
  return child;
}

function createBootstrapTimeoutLaunchService(fixture: FilesystemChildSessionFixture) {
  const sessionManager = SessionManager.inMemory(fixture.cwd);
  const vigilId = fixture.sessionId;
  let childAlive = true;
  let reportSessionExists = false;

  const bootstrapObserver = createNodePersistedBootstrapObserver({
    processRunner: {
      isAlive: () => childAlive,
      async terminateAndWait() {
        childAlive = false;
      },
    },
    spawnChild: () => createMockChildProcess(),
    sessionExists: async () => reportSessionExists,
    sessionPollIntervalMs: 10,
    bootstrapWatchdogTimeoutMs: 60_000,
  });

  const service = new VigilService({
    processRunner: {
      async spawnDetached() {
        childAlive = true;
        return { pid: 4242 };
      },
      isAlive: () => childAlive,
      async terminateAndWait() {
        childAlive = false;
      },
    },
    childSessionReader: createNodeChildSessionReader(),
    childSessionTranscriptReader: createNodeChildSessionTranscriptReader(),
    childSessionNamer: createNodeChildSessionNamer(),
    descendantInspector: createZeroDescendantInspector(),
    parentLedger: createSessionParentLedger(sessionManager, (type, data) => {
      sessionManager.appendCustomEntry(type, data);
    }),
    persistedBootstrapObserver: bootstrapObserver,
    bootstrapFailFastTimeoutMs: 25,
    sessionDir: fixture.sessionDir,
    createId: () => vigilId,
  });

  return {
    service,
    vigilId,
    bootstrapObserver,
    setReportSessionExists: (value: boolean) => {
      reportSessionExists = value;
    },
    setChildAlive: (value: boolean) => {
      childAlive = value;
    },
  };
}

function expectSnapshot(result: unknown): asserts result is VigilSnapshot {
  expect(isVigilError(result as never)).toBe(false);
}

describe("bootstrap timeout send race", () => {
  it("allows send after launch bootstrap times out while the child session file is already readable", async () => {
    const fixture = createFilesystemChildSessionFixture({
      prefix: "vigil-bootstrap-race-",
      sessionId: "vigil-bootstrap-race-child",
      assistantText: '{"status":"ok","task":"spawn_test"}',
    });
    const { service, vigilId, setReportSessionExists, setChildAlive } = createBootstrapTimeoutLaunchService(fixture);

    const launched = await service.launch({
      name: "Bootstrap race launch",
      message: "Reply with exactly: spawn_test",
      model: "openai-codex/gpt-5.5", parentCwd: fixture.cwd,
      cwd: fixture.cwd,
    });
    expectSnapshot(launched);
    expect(launched).toMatchObject({ id: vigilId, state: "running" });

    setReportSessionExists(true);
    setChildAlive(false);

    const waited = await service.wait({ id: vigilId, timeoutMs: 5_000, progress: "none" });
    expect(isVigilError(waited)).toBe(false);
    if (!isVigilError(waited)) {
      expect(waited.outcome).toBe("settled");
      if (waited.outcome === "settled") {
        expect(waited.settled[0]).toMatchObject({
          id: vigilId,
          state: "waiting",
          latestResponse: fixture.assistantText,
        });
      }
    }

    const sent = await service.send({
      vigilId,
      message: '{"status":"ok","phase":"follow_up"}',
      parentCwd: fixture.cwd,
    });

    expect(isVigilError(sent)).toBe(false);
    if (!isVigilError(sent)) {
      expect(sent).toMatchObject({
        id: vigilId,
        state: "running",
        latestResponse: fixture.assistantText,
      });
    }
  });
});
