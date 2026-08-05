import { EventEmitter, PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createFakePersistedBootstrapObserver,
  createNodePersistedBootstrapObserver,
  type PersistedBootstrapFailureInput,
} from "../../../src/vigil/persisted-bootstrap-observer";

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

describe("fake persisted bootstrap observer", () => {
  it("reports failed when stderr has model error and child closes without session", async () => {
    const failures: PersistedBootstrapFailureInput[] = [];
    const observer = createFakePersistedBootstrapObserver({
      onFailed: (input) => failures.push(input),
    });

    const started = await observer.start({
      vigilId: "vigil-bootstrap-fail",
      sessionId: "vigil-bootstrap-fail",
      cwd: "/parent/project",
    });
    started.activate();
    observer.pushStderr("vigil-bootstrap-fail", 'Error: Model "bad" not found\n');
    observer.pushClose("vigil-bootstrap-fail", 1);

    await expect(observer.waitForOutcome("vigil-bootstrap-fail", { timeoutMs: 100 })).resolves.toEqual({
      status: "failed",
      error: 'Model "bad" not found',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBe('Model "bad" not found');
  });

  it("reports generic bootstrap failure when child closes without session or stderr", async () => {
    const observer = createFakePersistedBootstrapObserver();

    const started = await observer.start({
      vigilId: "vigil-generic-fail",
      sessionId: "vigil-generic-fail",
      cwd: "/parent/project",
    });
    started.activate();
    observer.pushClose("vigil-generic-fail", 1);

    await expect(observer.waitForOutcome("vigil-generic-fail", { timeoutMs: 100 })).resolves.toEqual({
      status: "failed",
      error: "Pi child exited before session was created",
    });
  });

  it("reports started when session appears before exit", async () => {
    const failures: PersistedBootstrapFailureInput[] = [];
    const observer = createFakePersistedBootstrapObserver({
      onFailed: (input) => failures.push(input),
    });

    const started = await observer.start({
      vigilId: "vigil-bootstrap-ok",
      sessionId: "vigil-bootstrap-ok",
      cwd: "/parent/project",
    });
    started.activate();
    observer.signalSessionExists("vigil-bootstrap-ok");
    observer.pushClose("vigil-bootstrap-ok", 0);

    await expect(observer.waitForOutcome("vigil-bootstrap-ok", { timeoutMs: 100 })).resolves.toEqual({
      status: "started",
    });
    expect(failures).toHaveLength(0);
  });

  it("returns timeout when no bootstrap signal arrives in time", async () => {
    const observer = createFakePersistedBootstrapObserver();

    const started = await observer.start({
      vigilId: "vigil-bootstrap-timeout",
      sessionId: "vigil-bootstrap-timeout",
      cwd: "/parent/project",
    });
    started.activate();

    await expect(observer.waitForOutcome("vigil-bootstrap-timeout", { timeoutMs: 25 })).resolves.toEqual({
      status: "timeout",
    });
  });

  it("ignores stderr before activate", async () => {
    const observer = createFakePersistedBootstrapObserver();

    const started = await observer.start({
      vigilId: "vigil-activate-guard",
      sessionId: "vigil-activate-guard",
      cwd: "/parent/project",
    });
    observer.pushStderr("vigil-activate-guard", 'Error: Model "bad" not found\n');
    observer.pushClose("vigil-activate-guard", 1);

    started.activate();

    await expect(observer.waitForOutcome("vigil-activate-guard", { timeoutMs: 100 })).resolves.toEqual({
      status: "failed",
      error: "Pi child exited before session was created",
    });
  });
});

describe("node persisted bootstrap observer", () => {
  it("captures stderr and reports failure on close without session", async () => {
    const failures: PersistedBootstrapFailureInput[] = [];
    const mockChild = createMockChildProcess();
    const observer = createNodePersistedBootstrapObserver({
      processRunner: {
        isAlive: () => false,
        async terminateAndWait() {},
      },
      spawnChild: () => mockChild,
      sessionExists: async () => false,
      onFailed: (input) => failures.push(input),
    });

    const started = await observer.start({
      vigilId: "vigil-node-fail",
      sessionId: "vigil-node-fail",
      cwd: "/parent/project",
      message: "hello",
    });
    started.activate();
    (mockChild.stderr as PassThrough).write('Error: Model "bad" not found\n');
    mockChild.emit("close", 1, null);

    await expect(observer.waitForOutcome("vigil-node-fail", { timeoutMs: 100 })).resolves.toEqual({
      status: "failed",
      error: 'Model "bad" not found',
    });
    expect(failures[0]?.stderrExcerpt).toContain('Model "bad" not found');
  });
});
