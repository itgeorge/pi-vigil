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
import { isVigilError, type VigilSnapshot } from "../../../src/vigil/types";
import { createDeterministicTestTheme } from "../../helpers/test-theme";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

function createPersistedSpawnHarness() {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: Array<{ customType: string; data: unknown }> = [];
  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  const bootstrapObserver = createFakePersistedBootstrapObserver();
  const processRunner: ProcessRunner = {
    async spawnDetached() {
      return { pid: 5151 };
    },
    isAlive: () => false,
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse: "Done.",
        turnComplete: true,
        lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      return { completedName: "[completed] Nested spawn child" };
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

  return { service, bootstrapObserver, captured };
}

describe("VigilService nested spawn wiring", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  it("passes noSubagents on default persisted launch and stamps allowSubagents false on the launch record", async () => {
    const { service, bootstrapObserver, captured } = createPersistedSpawnHarness();

    const result = await service.launch({
      name: "Default deny child",
      message: "hello",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(false);
    if (isVigilError(result)) {
      return;
    }
    expect(bootstrapObserver.started).toHaveLength(1);
    expect(bootstrapObserver.started[0]?.noSubagents).toBe(true);
    expect(captured).toContainEqual({
      customType: "vigil-launch",
      data: expect.objectContaining({
        id: result.id,
        allowSubagents: false,
      }),
    });
  });

  it("omits noSubagents and the deny stamp when allowSubagents is true", async () => {
    const { service, bootstrapObserver, captured } = createPersistedSpawnHarness();

    const result = await service.launch({
      name: "Allow nested child",
      message: "hello",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      allowSubagents: true,
    });

    expect(isVigilError(result)).toBe(false);
    if (isVigilError(result)) {
      return;
    }
    expect(bootstrapObserver.started).toHaveLength(1);
    expect(bootstrapObserver.started[0]?.noSubagents).toBeUndefined();
    const launchEntry = captured.find((entry) => entry.customType === "vigil-launch");
    expect(launchEntry?.data).toMatchObject({ id: result.id });
    expect(launchEntry?.data).not.toHaveProperty("allowSubagents");
  });

  it("passes noSubagents on default ephemeral launch", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    const appendEntry = (customType: string, data: unknown) => {
      sessionManager.appendCustomEntry(customType, data);
    };
    const observer = createFakeEphemeralChildObserver();
    const parentLedger = createSessionParentLedger(sessionManager, appendEntry);

    const processRunner: ProcessRunner = {
      async spawnDetached() {
        return { pid: 9000 };
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
      createId: () => "vigil-ephemeral-deny",
      bootstrapFailFastTimeoutMs: 100,
    });

    const result = await service.launch({
      name: "Ephemeral deny",
      message: "hello",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      ephemeral: true,
    });

    expect(isVigilError(result)).toBe(false);
    expect(observer.started).toHaveLength(1);
    expect(observer.started[0]?.noSubagents).toBe(true);
  });

  it("re-applies noSubagents on send when the launch record denied nesting", async () => {
    const { service, bootstrapObserver } = createPersistedSpawnHarness();

    const launched = await service.launch({
      name: "Send deny child",
      message: "first turn",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
    });
    expect(isVigilError(launched)).toBe(false);
    bootstrapObserver.started.length = 0;

    const sent = await service.send({
      vigilId: (launched as VigilSnapshot).id,
      message: "second turn",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(sent)).toBe(false);
    expect(bootstrapObserver.started).toHaveLength(1);
    expect(bootstrapObserver.started[0]?.noSubagents).toBe(true);
  });

  it("omits noSubagents on send when the launch record allowed nesting", async () => {
    const { service, bootstrapObserver } = createPersistedSpawnHarness();

    const launched = await service.launch({
      name: "Send allow child",
      message: "first turn",
      model: "openai-codex/gpt-5.5", parentCwd: "/parent/default",
      allowSubagents: true,
    });
    expect(isVigilError(launched)).toBe(false);
    bootstrapObserver.started.length = 0;

    const sent = await service.send({
      vigilId: (launched as VigilSnapshot).id,
      message: "second turn",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(sent)).toBe(false);
    expect(bootstrapObserver.started).toHaveLength(1);
    expect(bootstrapObserver.started[0]?.noSubagents).toBeUndefined();
  });
});

describe("vigil extension adapter nested spawn wiring", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  const testTheme = createDeterministicTestTheme();

  function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, "");
  }

  it("forwards allowSubagents to the service launch path", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const bootstrapObserver = createFakePersistedBootstrapObserver();

    setVigilRuntimeOverrides({
      descendantInspector: createZeroDescendantInspector(),
      persistedBootstrapObserver: bootstrapObserver,
      processRunner: {
        spawnDetached: async () => ({ pid: 5151 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      bootstrapFailFastTimeoutMs: 100,
    });

    const result = await harness.execute({
      action: "launch",
      name: "Adapter allow child",
      message: "hello",
      model: "openai-codex/gpt-5.5",
      allowSubagents: true,
    });

    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(bootstrapObserver.started).toHaveLength(1);
    expect(bootstrapObserver.started[0]?.noSubagents).toBeUndefined();
  });

  it("shows allow subagents in compact launch render only when allowSubagents is true", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    const rendered = stripAnsi(
      harness.tool
        .renderCall!(
          { action: "launch", name: "Nested task", allowSubagents: true },
          testTheme,
          {
            lastComponent: undefined,
            args: { action: "launch", name: "Nested task", allowSubagents: true },
          } as never,
        )
        .render(120)
        .join("\n"),
    );

    expect(rendered).toContain("allow subagents");
  });

  it("omits allow subagents from compact launch render by default", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    const rendered = stripAnsi(
      harness.tool
        .renderCall!(
          { action: "launch", name: "Default task" },
          testTheme,
          { lastComponent: undefined, args: { action: "launch", name: "Default task" } } as never,
        )
        .render(120)
        .join("\n"),
    );

    expect(rendered).not.toContain("allow subagents");
  });
});
