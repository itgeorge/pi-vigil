import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { formatVigilChildFailedError } from "../../../src/vigil/child-failure";
import { createFakeEphemeralChildObserver } from "../../../src/vigil/ephemeral-observer";
import {
  createFakePersistedBootstrapObserver,
  type PersistedBootstrapObserver,
} from "../../../src/vigil/persisted-bootstrap-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import { isVigilError } from "../../../src/vigil/types";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

function createLaunchFailureDeps(options: {
  bootstrapObserver: PersistedBootstrapObserver;
  createId?: () => string;
  bootstrapFailFastTimeoutMs?: number;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: Array<{ customType: string; data: unknown }> = [];

  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  const parentLedger = createSessionParentLedger(sessionManager, appendEntry);

  const processRunner: ProcessRunner = {
    async spawnDetached() {
      throw new Error("persisted spawn should not run when bootstrap observer is injected");
    },
    isAlive: () => false,
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: null,
        turnComplete: false,
        lastConversationTimestamp: null,
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Test vigil" };
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    parentLedger,
    persistedBootstrapObserver: options.bootstrapObserver,
    bootstrapFailFastTimeoutMs: options.bootstrapFailFastTimeoutMs,
    createId: options.createId,
  });

  return { service, captured, sessionManager };
}

describe("VigilService.launch failure detection", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  it("returns error when bootstrap observer reports failed within bootstrap window", async () => {
    const bootstrapObserver = createFakePersistedBootstrapObserver({
      onFailed: () => undefined,
    });
    const { service } = createLaunchFailureDeps({
      bootstrapObserver,
      createId: () => "vigil-launch-fail",
      bootstrapFailFastTimeoutMs: 100,
    });

    const launchPromise = service.launch({
      name: "Fail fast",
      message: "hello",
      parentCwd: "/parent/default",
      model: "bad/model",
    });

    await Promise.resolve();
    bootstrapObserver.pushStderr("vigil-launch-fail", 'Error: Model "bad" not found\n');

    const result = await launchPromise;
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(formatVigilChildFailedError("vigil-launch-fail", 'Model "bad" not found'));
    }
  });

  it("appends vigil-launch and vigil-fail on bootstrap failure but returns error", async () => {
    const captured: Array<{ customType: string; data: unknown }> = [];
    const sessionManager = SessionManager.inMemory("/parent/default");
    const appendEntry = (customType: string, data: unknown) => {
      captured.push({ customType, data });
      sessionManager.appendCustomEntry(customType, data);
    };
    const parentLedger = createSessionParentLedger(sessionManager, appendEntry);
    const bootstrapObserver = createFakePersistedBootstrapObserver({
      onFailed: (input) => {
        parentLedger.appendFail({
          id: input.vigilId,
          sessionId: input.sessionId,
          failedAt: "2026-08-01T10:00:01.000Z",
          error: input.error,
          source: input.source,
        });
      },
    });

    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          throw new Error("persisted spawn should not run");
        },
        isAlive: () => false,
        async terminateAndWait() {},
      },
      childSessionReader: {
        async readChildSessionState() {
          return {
            latestResponse: null,
            turnComplete: false,
            lastConversationTimestamp: null,
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed] Test vigil" };
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger,
      persistedBootstrapObserver: bootstrapObserver,
      bootstrapFailFastTimeoutMs: 100,
      createId: () => "vigil-audit-fail",
    });

    const launchPromise = service.launch({
      name: "Audit fail",
      message: "hello",
      parentCwd: "/parent/default",
    });

    await Promise.resolve();
    bootstrapObserver.pushClose("vigil-audit-fail", 1);

    const result = await launchPromise;
    expect(isVigilError(result)).toBe(true);
    expect(captured.map((entry) => entry.customType)).toEqual(["vigil-launch", "vigil-fail"]);
  });

  it("returns running snapshot when bootstrap observer reports timeout", async () => {
    const bootstrapObserver = createFakePersistedBootstrapObserver();
    const { service, captured } = createLaunchFailureDeps({
      bootstrapObserver,
      createId: () => "vigil-launch-timeout",
      bootstrapFailFastTimeoutMs: 25,
    });

    const result = await service.launch({
      name: "Slow start",
      message: "hello",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(false);
    if (!isVigilError(result)) {
      expect(result.state).toBe("running");
      expect(result.id).toBe("vigil-launch-timeout");
    }
    expect(captured.some((entry) => entry.customType === "vigil-launch")).toBe(true);
    expect(captured.some((entry) => entry.customType === "vigil-fail")).toBe(false);
  });

  it("surfaces spawn failures without recording launch metadata", async () => {
    const bootstrapObserver: PersistedBootstrapObserver = {
      async start() {
        throw new Error("spawn pi ENOENT");
      },
      async waitForOutcome() {
        return { status: "timeout" };
      },
      async shutdown() {},
    };
    const { service, captured } = createLaunchFailureDeps({
      bootstrapObserver,
      createId: () => "vigil-spawn-fail",
    });

    const result = await service.launch({
      name: "Spawn fail",
      message: "hello",
      parentCwd: "/parent/default",
    });

    expect(result).toEqual({ error: "Failed to launch Pi child: spawn pi ENOENT" });
    expect(captured).toHaveLength(0);
  });

  it("does not use persisted bootstrap observer for ephemeral launch", async () => {
    let bootstrapStartCalls = 0;
    const bootstrapObserver: PersistedBootstrapObserver = {
      async start() {
        bootstrapStartCalls += 1;
        return { pid: 1, activate() {} };
      },
      async waitForOutcome() {
        return { status: "timeout" };
      },
      async shutdown() {},
    };

    const sessionManager = SessionManager.inMemory("/parent/default");
    const service = new VigilService({
      processRunner: {
        async spawnDetached() {
          throw new Error("persisted spawn should not run");
        },
        isAlive: () => true,
        async terminateAndWait() {},
      },
      childSessionReader: {
        async readChildSessionState() {
          return {
            latestResponse: null,
            turnComplete: false,
            lastConversationTimestamp: null,
            activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
          };
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed]" };
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger: createSessionParentLedger(sessionManager, (customType, data) => {
        sessionManager.appendCustomEntry(customType, data);
      }),
      persistedBootstrapObserver: bootstrapObserver,
      ephemeralChildObserver: createFakeEphemeralChildObserver(),
      createId: () => "vigil-ephemeral-launch",
    });

    const result = await service.launch({
      name: "Ephemeral",
      message: "hello",
      parentCwd: "/parent/default",
      ephemeral: true,
    });

    expect(isVigilError(result)).toBe(false);
    expect(bootstrapStartCalls).toBe(0);
  });

  it("maps bootstrap failure through the extension adapter as isError", async () => {
    const bootstrapObserver = createFakePersistedBootstrapObserver({
      onFailed: () => undefined,
    });

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async () => ({ pid: 7001 }),
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
      persistedBootstrapObserver: bootstrapObserver,
      bootstrapFailFastTimeoutMs: 100,
    });

    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const launchPromise = harness.execute({
      action: "launch",
      name: "Adapter fail",
      message: "hello",
      model: "bad/model",
    });

    await Promise.resolve();
    const vigilId = bootstrapObserver.started[0]?.vigilId;
    expect(vigilId).toMatch(/^vigil-/);
    bootstrapObserver.pushStderr(vigilId!, 'Error: Model "bad" not found\n');

    const launchResult = await launchPromise;
    expect(launchResult.isError).toBe(true);
    expect(launchResult.content[0]?.text).toContain('Model "bad" not found');
  });
});
