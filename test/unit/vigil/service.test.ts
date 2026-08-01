import { afterEach, describe, expect, it } from "vitest";
import type { ChildSessionReader, ParentLedger, ProcessRunner } from "../../../src/vigil/ports";
import { VigilService } from "../../../src/vigil/node-runtime";
import { isVigilError, type VigilLaunchRecord, type VigilSnapshot } from "../../../src/vigil/types";

function createFakeDeps(options?: {
  pid?: number;
  alive?: boolean;
  latestResponse?: string | null;
  turnComplete?: boolean;
  createId?: () => string;
  sessionDir?: string;
  spawnError?: Error;
}) {
  const launches: VigilLaunchRecord[] = [];
  let nextPid = options?.pid ?? 4242;
  let alive = options?.alive ?? true;
  const latestResponse = options?.latestResponse ?? null;
  const turnComplete = options?.turnComplete ?? false;

  const processRunner: ProcessRunner = {
    async spawnDetached(_input) {
      if (options?.spawnError) {
        throw options.spawnError;
      }
      return { pid: nextPid };
    },
    isAlive() {
      return alive;
    },
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      return { latestResponse, turnComplete };
    },
  };

  const parentLedger: ParentLedger = {
    appendLaunch(record) {
      launches.push(record);
    },
    findLaunch(vigilId) {
      return launches.find((launch) => launch.id === vigilId) ?? null;
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    parentLedger,
    createId: options?.createId,
    sessionDir: options?.sessionDir,
  });

  return {
    service,
    launches,
    setAlive(value: boolean) {
      alive = value;
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
      message: "hello",
      parentCwd: "/parent/a",
    });
    const second = await service.launch({
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
      message: "do work",
      parentCwd: "/parent/default",
      cwd: "/child/work",
      model: "openai-codex/gpt-5.5",
    });

    expect(launches).toHaveLength(1);
    expect(launches[0]).toEqual({
      id: "vigil-launch-record",
      sessionId: "vigil-launch-record",
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
      message: "hello",
      parentCwd: "/parent/default",
    });

    const polled = await service.poll((launched as VigilSnapshot).id);
    expectSnapshot(polled);
    expect(polled.latestResponse).toBeNull();
  });

  it("returns a clear error for an unknown vigil id", async () => {
    const { service } = createFakeDeps();

    const result = await service.poll("vigil-missing");
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("Unknown vigil id");
    }
  });
});
