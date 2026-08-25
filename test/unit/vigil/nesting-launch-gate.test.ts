import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { createFakeEphemeralChildObserver } from "../../../src/vigil/ephemeral-observer";
import { createFakePersistedBootstrapObserver } from "../../../src/vigil/persisted-bootstrap-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import {
  createEmptyChildSessionTranscriptReader,
  createSessionParentLedger,
  createVigilServiceForContext,
  VigilService,
} from "../../../src/vigil/node-runtime";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import { isVigilError } from "../../../src/vigil/types";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

const NESTED_LAUNCH_DISABLED_ERROR =
  "Vigil nested launch is disabled for this session. Launch with allowSubagents: true from the parent if nesting is intended.";

function createPersistedLaunchGateHarness(options?: { denyPolicy?: boolean }) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  if (options?.denyPolicy) {
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: false });
  }

  const captured: Array<{ customType: string; data: unknown }> = [];
  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  const bootstrapObserver = createFakePersistedBootstrapObserver();
  let spawnCalled = false;

  const processRunner: ProcessRunner = {
    async spawnDetached() {
      spawnCalled = true;
      throw new Error("spawn should not run when nested launch is denied");
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
      return { completedName: "[completed] Nested gate child" };
    },
  };

  const service = createVigilServiceForContext({
    parentCwd: "/parent/default",
    sessionManager,
    appendEntry,
    processRunner,
    childSessionReader,
    childSessionNamer,
    descendantInspector: createZeroDescendantInspector(),
    persistedBootstrapObserver: bootstrapObserver,
    bootstrapFailFastTimeoutMs: 100,
  });

  return { service, bootstrapObserver, spawnCalled: () => spawnCalled, captured };
}

describe("VigilService nested launch gate", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  it("rejects persisted launch when session has a deny policy entry", async () => {
    const { service, bootstrapObserver, spawnCalled } = createPersistedLaunchGateHarness({ denyPolicy: true });

    const result = await service.launch({
      name: "Nested child",
      message: "hello",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(NESTED_LAUNCH_DISABLED_ERROR);
    }
    expect(spawnCalled()).toBe(false);
    expect(bootstrapObserver.started).toHaveLength(0);
  });

  it("rejects ephemeral launch when the no-subagents flag is active", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    const captured: Array<{ customType: string; data: unknown }> = [];
    const appendEntry = (customType: string, data: unknown) => {
      captured.push({ customType, data });
      sessionManager.appendCustomEntry(customType, data);
    };

    const observer = createFakeEphemeralChildObserver();
    const parentLedger = createSessionParentLedger(sessionManager, appendEntry);

    const processRunner: ProcessRunner = {
      async spawnDetached() {
        throw new Error("spawn should not run when nested launch is denied");
      },
      isAlive: () => false,
      async terminateAndWait() {},
    };

    const childSessionReader: ChildSessionReader = {
      async readChildSessionState() {
        throw new Error("child session reader should not be used");
      },
    };

    const childSessionNamer: ChildSessionNamer = {
      async markCompleted() {
        throw new Error("child session rename should not run");
      },
    };

    const service = new VigilService({
      processRunner,
      childSessionReader,
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer,
      descendantInspector: createZeroDescendantInspector(),
      parentLedger,
      ephemeralChildObserver: observer,
      getNoSubagentsFlag: () => true,
    });

    const result = await service.launch({
      name: "Ephemeral nested",
      message: "hello",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toBe(NESTED_LAUNCH_DISABLED_ERROR);
    }
    expect(observer.started).toHaveLength(0);
    expect(captured.filter((entry) => entry.customType === "vigil-launch")).toHaveLength(0);
  });
});

describe("vigil extension adapter nested launch gate", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  it("rejects launch when deny policy is stamped in the session", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    harness.sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: false });

    let spawnCalled = false;
    setVigilRuntimeOverrides({
      descendantInspector: createZeroDescendantInspector(),
      processRunner: {
        spawnDetached: async () => {
          spawnCalled = true;
          return { pid: 5151 };
        },
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
    });

    const result = await harness.execute({
      action: "launch",
      name: "Denied nested child",
      message: "try nested launch",
      model: "openai-codex/gpt-5.5",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: NESTED_LAUNCH_DISABLED_ERROR,
    });
    expect(spawnCalled).toBe(false);
  });
});
