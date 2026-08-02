import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, SpawnChildInput } from "../../../src/vigil/ports";
import { createEmptyChildSessionTranscriptReader, createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
import {
  isVigilError,
  type VigilLaunchRecord,
  type VigilSnapshot,
  type VigilTurnRecord,
} from "../../../src/vigil/types";

const TEST_VIGIL_NAME = "Test vigil";

function createFakeDeps(options?: {
  pid?: number;
  alive?: boolean;
  latestResponse?: string | null;
  turnComplete?: boolean;
  createId?: () => string;
  sessionDir?: string;
  spawnError?: Error;
  terminateError?: Error;
  initialRecord?: VigilLaunchRecord;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const launches: VigilLaunchRecord[] = [];
  const turns: VigilTurnRecord[] = [];
  const spawnInputs: SpawnChildInput[] = [];
  const terminatedPids: number[] = [];
  let nextPid = options?.pid ?? 4242;
  let alive = options?.alive ?? true;
  let lastConversationTimestamp = "2099-01-01T00:00:00.000Z";
  const latestResponse = options?.latestResponse ?? null;
  const turnComplete = options?.turnComplete ?? false;

  const appendEntry = (customType: string, data: unknown) => {
    sessionManager.appendCustomEntry(customType, data);
  };

  if (options?.initialRecord) {
    appendEntry("vigil-launch", options.initialRecord);
    launches.push(options.initialRecord);
  }

  const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
    appendEntry(customType, data);
    if (customType === "vigil-launch") {
      launches.push(data as VigilLaunchRecord);
    }
    if (customType === "vigil-turn") {
      turns.push(data as VigilTurnRecord);
    }
  });

  const processRunner: ProcessRunner = {
    async spawnDetached(input) {
      spawnInputs.push(input);
      if (options?.spawnError) {
        throw options.spawnError;
      }
      const pid = nextPid;
      nextPid += 1;
      alive = true;
      return { pid };
    },
    isAlive() {
      return alive;
    },
    async terminateAndWait(pid) {
      if (options?.terminateError) {
        throw options.terminateError;
      }
      terminatedPids.push(pid);
      alive = false;
    },
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return {
        latestResponse,
        turnComplete,
        lastConversationTimestamp,
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
    parentLedger,
    createId: options?.createId,
    sessionDir: options?.sessionDir,
  });

  return {
    service,
    launches,
    turns,
    spawnInputs,
    terminatedPids,
    setAlive(value: boolean) {
      alive = value;
    },
    setLastConversationTimestamp(value: string) {
      lastConversationTimestamp = value;
    },
  };
}

function expectSnapshot(result: unknown): asserts result is VigilSnapshot {
  expect(isVigilError(result as never)).toBe(false);
}

describe("VigilService.launch", () => {
  it("returns a running snapshot with a unique vigil- id", async () => {
    const ids = ["vigil-test-id-1", "vigil-test-id-2"];
    const { service } = createFakeDeps({
      createId: () => ids.shift() ?? "vigil-fallback",
    });

    const first = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/a",
    });
    const second = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello again",
      parentCwd: "/parent/a",
    });

    expectSnapshot(first);
    expectSnapshot(second);
    expect(first.id).toMatch(/^vigil-/);
    expect(second.id).toMatch(/^vigil-/);
    expect(first.id).not.toBe(second.id);
    expect(first.state).toBe("running");
    expect(first.latestResponse).toBeNull();
  });

  it("uses parent cwd when no override is supplied", async () => {
    const { service, launches } = createFakeDeps({ createId: () => "vigil-parent-cwd" });

    const snapshot = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
    });

    expectSnapshot(snapshot);
    expect(snapshot.cwd).toBe("/parent/default");
    expect(launches[0]?.cwd).toBe("/parent/default");
  });

  it("uses explicit cwd when supplied", async () => {
    const { service, launches } = createFakeDeps({ createId: () => "vigil-explicit-cwd" });

    const snapshot = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
      cwd: "/child/override",
    });

    expectSnapshot(snapshot);
    expect(snapshot.cwd).toBe("/child/override");
    expect(launches[0]?.cwd).toBe("/child/override");
  });

  it("preserves the requested model as launch metadata", async () => {
    const { service, launches } = createFakeDeps({ createId: () => "vigil-model-meta" });

    await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
      model: "openai-codex/gpt-5.5:high",
    });

    expect(launches[0]?.model).toBe("openai-codex/gpt-5.5:high");
  });

  it("records one durable parent vigil-launch entry with child identity, pid, cwd, and model", async () => {
    const { service, launches } = createFakeDeps({
      createId: () => "vigil-launch-record",
      pid: 9001,
      sessionDir: "/tmp/vigil-sessions",
    });

    await service.launch({
      name: TEST_VIGIL_NAME,
      message: "do work",
      parentCwd: "/parent/default",
      cwd: "/child/work",
      model: "openai-codex/gpt-5.5",
    });

    expect(launches).toHaveLength(1);
    expect(launches[0]).toEqual({
      id: "vigil-launch-record",
      sessionId: "vigil-launch-record",
      name: TEST_VIGIL_NAME,
      pid: 9001,
      cwd: "/child/work",
      model: "openai-codex/gpt-5.5",
      sessionDir: "/tmp/vigil-sessions",
      launchedAt: expect.any(String),
    });
  });

  it("returns a clear error when the child process cannot be spawned", async () => {
    const { service } = createFakeDeps({
      spawnError: new Error("spawn pi ENOENT"),
    });

    const result = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("Failed to launch Pi child");
      expect(result.error).toContain("ENOENT");
    }
  });
});

describe("VigilService.poll", () => {
  it("returns running and the latest persisted assistant text while the turn is incomplete", async () => {
    const { service } = createFakeDeps({
      createId: () => "vigil-running",
      alive: true,
      latestResponse: "Partial progress is persisted.",
      turnComplete: false,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const polled = await service.poll((launched as VigilSnapshot).id);
    expectSnapshot(polled);
    expect(polled.state).toBe("running");
    expect(polled.latestResponse).toBe("Partial progress is persisted.");
  });

  it("returns waiting when the child turn is complete even if the Pi process remains alive", async () => {
    const { service } = createFakeDeps({
      createId: () => "vigil-turn-complete",
      alive: true,
      latestResponse: "Final answer from child.",
      turnComplete: true,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
    });

    const polled = await service.poll((launched as VigilSnapshot).id);
    expectSnapshot(polled);
    expect(polled.state).toBe("waiting");
    expect(polled.latestResponse).toBe("Final answer from child.");
  });

  it("returns waiting and the most recent complete assistant text after exit", async () => {
    const { service, setAlive } = createFakeDeps({
      createId: () => "vigil-waiting",
      alive: true,
      latestResponse: "Final answer from child.",
      turnComplete: false,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
    });
    setAlive(false);

    const polled = await service.poll((launched as VigilSnapshot).id);
    expectSnapshot(polled);
    expect(polled.state).toBe("waiting");
    expect(polled.latestResponse).toBe("Final answer from child.");
  });

  it("returns latestResponse null when the child session has no assistant message", async () => {
    const { service } = createFakeDeps({
      createId: () => "vigil-no-assistant",
      alive: false,
      latestResponse: null,
      turnComplete: false,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "hello",
      parentCwd: "/parent/default",
    });

    const polled = await service.poll((launched as VigilSnapshot).id);
    expectSnapshot(polled);
    expect(polled.latestResponse).toBeNull();
  });

  it("returns waiting when the child completes during spawn before the parent would have recorded turn start", async () => {
    const sessionManager = SessionManager.inMemory("/parent/default");
    const launches: VigilLaunchRecord[] = [];
    let latestResponse: string | null = null;
    let turnComplete = false;
    let lastConversationTimestamp: string | null = null;
    let alive = true;

    const processRunner: ProcessRunner = {
      async spawnDetached() {
        lastConversationTimestamp = new Date().toISOString();
        latestResponse = "Fast answer.";
        turnComplete = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { pid: 8801 };
      },
      isAlive: () => alive,
      terminateAndWait: async () => {
        alive = false;
      },
    };

    const childSessionReader: ChildSessionReader = {
      async readChildSessionState() {
        return {
          latestResponse,
          turnComplete,
          lastConversationTimestamp,
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        };
      },
    };

    const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
      if (customType === "vigil-launch") {
        launches.push(data as VigilLaunchRecord);
      }
    });

    const service = new VigilService({
      processRunner,
      childSessionReader,
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        async markCompleted() {
          return { completedName: "[completed] Test vigil" };
        },
      },
      parentLedger,
      createId: () => "vigil-fast-turn",
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "complete quickly",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const polled = await service.poll(launched.id);
    expectSnapshot(polled);
    expect(polled.state).toBe("waiting");
    expect(polled.latestResponse).toBe("Fast answer.");
    expect(launches[0]?.launchedAt).toBeTruthy();
    expect(lastConversationTimestamp).toBeTruthy();
    expect(launches[0]!.launchedAt <= lastConversationTimestamp!).toBe(true);
  });

  it("returns a clear error for an unknown vigil id", async () => {
    const { service } = createFakeDeps();

    const result = await service.poll("vigil-missing");
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("Unknown vigil id");
    }
  });

  it("stays running when a prior assistant response is complete but a newer user message started the next turn", async () => {
    const { service } = createFakeDeps({
      createId: () => "vigil-new-turn-running",
      alive: true,
      latestResponse: "First answer.",
      turnComplete: false,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
    });

    const polled = await service.poll((launched as VigilSnapshot).id);
    expectSnapshot(polled);
    expect(polled.state).toBe("running");
    expect(polled.latestResponse).toBe("First answer.");
  });
});

describe("VigilService.send", () => {
  it("returns a running snapshot with the same id, sessionId, and cwd for a waiting child", async () => {
    const { service } = createFakeDeps({
      createId: () => "vigil-send-resume",
      pid: 7000,
      alive: true,
      latestResponse: "First answer.",
      turnComplete: true,
      sessionDir: "/tmp/vigil-sessions",
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
      cwd: "/child/work",
    });
    expectSnapshot(launched);

    const sent = await service.send({
      vigilId: launched.id,
      message: "second turn",
      parentCwd: "/parent/default",
      model: "openai-codex/gpt-5.5:high",
    });

    expectSnapshot(sent);
    expect(sent.id).toBe(launched.id);
    expect(sent.sessionId).toBe(launched.sessionId);
    expect(sent.cwd).toBe("/child/work");
    expect(sent.state).toBe("running");
    expect(sent.latestResponse).toBe("First answer.");
  });

  it("appends a vigil-turn parent entry with the new pid and supplied model", async () => {
    const { service, turns, terminatedPids } = createFakeDeps({
      createId: () => "vigil-send-turn-record",
      pid: 7100,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
      sessionDir: "/tmp/vigil-sessions",
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
      cwd: "/child/work",
    });
    expectSnapshot(launched);
    const launchPid = 7100;

    const sent = await service.send({
      vigilId: launched.id,
      message: "second turn",
      parentCwd: "/parent/default",
      model: "openai-codex/gpt-5.5:high",
    });
    expectSnapshot(sent);

    expect(terminatedPids).toEqual([launchPid]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      id: launched.id,
      sessionId: launched.sessionId,
      pid: expect.any(Number),
      cwd: "/child/work",
      model: "openai-codex/gpt-5.5:high",
      sessionDir: "/tmp/vigil-sessions",
      sentAt: expect.any(String),
    });
    expect(turns[0]?.pid).not.toBe(launchPid);
  });

  it("rejects send while the current turn is still running", async () => {
    const { service, turns } = createFakeDeps({
      createId: () => "vigil-send-running",
      alive: true,
      latestResponse: "Working...",
      turnComplete: false,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const result = await service.send({
      vigilId: launched.id,
      message: "too early",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("running");
    }
    expect(turns).toHaveLength(0);
  });

  it("returns clear errors for unknown ids and missing arguments", async () => {
    const { service } = createFakeDeps({ createId: () => "vigil-send-errors" });

    const unknown = await service.send({
      vigilId: "vigil-missing",
      message: "hello",
      parentCwd: "/parent/default",
    });
    expect(isVigilError(unknown)).toBe(true);
    if (isVigilError(unknown)) {
      expect(unknown.error).toContain("Unknown vigil id");
    }

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const missingMessage = await service.send({
      vigilId: launched.id,
      message: "",
      parentCwd: "/parent/default",
    });
    expect(isVigilError(missingMessage)).toBe(true);
    if (isVigilError(missingMessage)) {
      expect(missingMessage.error).toContain("message");
    }
  });

  it("omits model from the turn record and spawn input when not supplied", async () => {
    const { service, turns, spawnInputs } = createFakeDeps({
      createId: () => "vigil-send-no-model",
      pid: 7200,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
      model: "openai-codex/gpt-5.5",
    });
    expectSnapshot(launched);

    const sent = await service.send({
      vigilId: launched.id,
      message: "second turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(sent);

    expect(turns[0]?.model).toBeUndefined();
    expect(spawnInputs.at(-1)?.model).toBeUndefined();
  });

  it("continues without termination failure when the tracked child has already exited", async () => {
    const { service, turns, terminatedPids, setAlive } = createFakeDeps({
      createId: () => "vigil-send-exited",
      pid: 7300,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);
    setAlive(false);

    const sent = await service.send({
      vigilId: launched.id,
      message: "second turn",
      parentCwd: "/parent/default",
    });

    expectSnapshot(sent);
    expect(terminatedPids).toHaveLength(0);
    expect(turns).toHaveLength(1);
  });

  it("returns an error and does not append a turn when the settled child cannot be reaped", async () => {
    const { service, turns } = createFakeDeps({
      createId: () => "vigil-send-unreapable",
      pid: 7400,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
      terminateError: new Error("Process 7401 did not exit within 5000ms"),
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const result = await service.send({
      vigilId: launched.id,
      message: "second turn",
      parentCwd: "/parent/default",
    });

    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("reap");
    }
    expect(turns).toHaveLength(0);
  });

  it("uses the latest vigil-turn record when polling after send", async () => {
    const { service, setLastConversationTimestamp } = createFakeDeps({
      createId: () => "vigil-send-poll-latest",
      pid: 7500,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
    });

    const launched = await service.launch({
      name: TEST_VIGIL_NAME,
      message: "first turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const sent = await service.send({
      vigilId: launched.id,
      message: "second turn",
      parentCwd: "/parent/default",
    });
    expectSnapshot(sent);

    setLastConversationTimestamp("2026-08-01T12:00:02.000Z");

    const polled = await service.poll(launched.id);
    expectSnapshot(polled);
    expect(polled.state).toBe("running");
  });
});
