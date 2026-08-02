import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ParentLedger,
  ProcessRunner,
  SpawnChildInput,
} from "../../../src/vigil/ports";
import {
  createSessionParentLedger,
  VigilService,
} from "../../../src/vigil/node-runtime";
import {
  isVigilError,
  type VigilCompletionRecord,
  type VigilLaunchRecord,
  type VigilListResult,
  type VigilSnapshot,
  type VigilTurnRecord,
} from "../../../src/vigil/types";

function createHarness(options?: {
  pid?: number;
  alive?: boolean;
  latestResponse?: string | null;
  turnComplete?: boolean;
  createId?: () => string;
  sessionDir?: string;
  spawnError?: Error;
  terminateError?: Error;
  renameError?: string;
  renamedTo?: string;
  initialRecord?: VigilLaunchRecord;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const captured: { customType: string; data: unknown }[] = [];
  const spawnInputs: SpawnChildInput[] = [];
  const terminatedPids: number[] = [];
  let nextPid = options?.pid ?? 4242;
  let alive = options?.alive ?? true;
  let lastConversationTimestamp = "2099-01-01T00:00:00.000Z";
  const latestResponse = options?.latestResponse ?? null;
  const turnComplete = options?.turnComplete ?? false;

  const appendEntry = (customType: string, data: unknown) => {
    captured.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  if (options?.initialRecord) {
    appendEntry("vigil-launch", options.initialRecord);
  }

  const parentLedger: ParentLedger = createSessionParentLedger(sessionManager, appendEntry);

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
        activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null },
      };
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      if (options?.renameError) {
        return { error: options.renameError };
      }
      return { completedName: options?.renamedTo ?? "[completed] Test vigil" };
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionNamer,
    parentLedger,
    createId: options?.createId,
    sessionDir: options?.sessionDir,
  });

  return {
    service,
    sessionManager,
    captured,
    spawnInputs,
    terminatedPids,
    setAlive(value: boolean) {
      alive = value;
    },
  };
}

function expectSnapshot(result: unknown): asserts result is VigilSnapshot {
  expect(isVigilError(result as never)).toBe(false);
}

function expectList(result: unknown): asserts result is VigilListResult {
  expect(isVigilError(result as never)).toBe(false);
}

describe("VigilService.launch name validation", () => {
  it("requires a nonblank name in addition to message", async () => {
    const { service } = createHarness({ createId: () => "vigil-name-required" });

    const missing = await service.launch({
      name: "",
      message: "hello",
      parentCwd: "/parent/default",
    });
    expect(isVigilError(missing)).toBe(true);
    if (isVigilError(missing)) {
      expect(missing.error).toContain("name");
    }

    const whitespace = await service.launch({
      name: "   ",
      message: "hello",
      parentCwd: "/parent/default",
    });
    expect(isVigilError(whitespace)).toBe(true);
  });

  it("returns and persists the normalized launch name", async () => {
    const { service, captured } = createHarness({ createId: () => "vigil-named" });

    const snapshot = await service.launch({
      name: "  Refactor auth  ",
      message: "hello",
      parentCwd: "/parent/default",
    });

    expectSnapshot(snapshot);
    expect(snapshot.name).toBe("Refactor auth");
    expect((captured[0]?.data as VigilLaunchRecord).name).toBe("Refactor auth");
  });

  it("passes --name only for launch and not for send", async () => {
    const { service, spawnInputs } = createHarness({
      createId: () => "vigil-cli-name",
      pid: 7000,
      alive: true,
      latestResponse: "Done.",
      turnComplete: true,
    });

    await service.launch({
      name: "Auth refactor",
      message: "first turn",
      parentCwd: "/parent/default",
    });

    const launched = await service.poll("vigil-cli-name");
    expectSnapshot(launched);

    await service.send({
      vigilId: "vigil-cli-name",
      message: "second turn",
      parentCwd: "/parent/default",
    });

    expect(spawnInputs[0]?.name).toBe("Auth refactor");
    expect(spawnInputs[1]?.name).toBeUndefined();
  });
});

describe("VigilService.list", () => {
  it("includes active children by default and excludes completed ones", async () => {
    const { service } = createHarness({
      createId: () => "vigil-active",
      initialRecord: {
        id: "vigil-done",
        sessionId: "vigil-done",
        name: "Done",
        pid: 100,
        cwd: "/parent/default",
        launchedAt: "2026-08-01T09:00:00.000Z",
      },
      alive: false,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Done",
    });

    const activeLaunch = await service.launch({
      name: "Active task",
      message: "work",
      parentCwd: "/parent/default",
    });
    expectSnapshot(activeLaunch);

    await service.complete({ vigilId: "vigil-done", parentCwd: "/parent/default" });

    const defaultList = await service.list(false);
    expectList(defaultList);
    expect(defaultList.vigils.map((item) => item.id)).toEqual(["vigil-active"]);
    for (const item of defaultList.vigils) {
      expect(item).not.toHaveProperty("latestResponse");
    }
  });

  it("includes completed children when includeCompleted is true", async () => {
    const { service } = createHarness({
      createId: () => "vigil-list-complete",
      alive: false,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Named task",
    });

    const launched = await service.launch({
      name: "Named task",
      message: "work",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    await service.complete({ vigilId: launched.id, parentCwd: "/parent/default" });

    const all = await service.list(true);
    expectList(all);
    expect(all.vigils).toHaveLength(1);
    expect(all.vigils[0]).toEqual({
      id: launched.id,
      sessionId: launched.sessionId,
      name: "[completed] Named task",
      cwd: "/parent/default",
      state: "completed",
      completedAt: expect.any(String),
    });
  });
});

describe("VigilService.complete", () => {
  it("completes a waiting child, appends one vigil-complete record, and keeps the session readable", async () => {
    const { service, captured, terminatedPids } = createHarness({
      createId: () => "vigil-complete-waiting",
      pid: 8100,
      alive: true,
      latestResponse: "Final answer.",
      turnComplete: true,
      renamedTo: "[completed] Ship feature",
    });

    const launched = await service.launch({
      name: "Ship feature",
      message: "work",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const completed = await service.complete({ vigilId: launched.id, parentCwd: "/parent/default" });
    expectSnapshot(completed);
    expect(completed.state).toBe("completed");
    expect(completed.name).toBe("[completed] Ship feature");
    expect(completed.latestResponse).toBe("Final answer.");
    expect(terminatedPids).toEqual([8100]);

    const completeEntry = captured.find((entry) => entry.customType === "vigil-complete");
    expect(completeEntry?.data).toEqual(
      expect.objectContaining({
        id: launched.id,
        sessionId: launched.sessionId,
        name: "[completed] Ship feature",
      }),
    );
  });

  it("rejects running children without renaming or appending completion", async () => {
    const { service, captured } = createHarness({
      createId: () => "vigil-complete-running",
      alive: true,
      latestResponse: "Working",
      turnComplete: false,
    });

    const launched = await service.launch({
      name: "Running task",
      message: "work",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const result = await service.complete({ vigilId: launched.id, parentCwd: "/parent/default" });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("running");
    }
    expect(captured.some((entry) => entry.customType === "vigil-complete")).toBe(false);
  });

  it("is idempotent, rejects send, and poll reports completed", async () => {
    const { service } = createHarness({
      createId: () => "vigil-complete-idempotent",
      alive: false,
      latestResponse: "Done.",
      turnComplete: true,
      renamedTo: "[completed] Retire me",
    });

    const launched = await service.launch({
      name: "Retire me",
      message: "work",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const first = await service.complete({ vigilId: launched.id, parentCwd: "/parent/default" });
    expectSnapshot(first);

    const second = await service.complete({ vigilId: launched.id, parentCwd: "/parent/default" });
    expectSnapshot(second);
    expect(second).toEqual(first);

    const polled = await service.poll(launched.id);
    expectSnapshot(polled);
    expect(polled.state).toBe("completed");

    const sendResult = await service.send({
      vigilId: launched.id,
      message: "too late",
      parentCwd: "/parent/default",
    });
    expect(isVigilError(sendResult)).toBe(true);
    if (isVigilError(sendResult)) {
      expect(sendResult.error).toContain("completed");
    }
  });

  it("returns a clear error and does not append vigil-complete when rename fails", async () => {
    const { service, captured } = createHarness({
      createId: () => "vigil-complete-rename-fail",
      alive: false,
      latestResponse: "Done.",
      turnComplete: true,
      renameError: "Child session not found: vigil-complete-rename-fail",
    });

    const launched = await service.launch({
      name: "Missing child",
      message: "work",
      parentCwd: "/parent/default",
    });
    expectSnapshot(launched);

    const result = await service.complete({ vigilId: launched.id, parentCwd: "/parent/default" });
    expect(isVigilError(result)).toBe(true);
    if (isVigilError(result)) {
      expect(result.error).toContain("Child session not found");
    }
    expect(captured.some((entry) => entry.customType === "vigil-complete")).toBe(false);
  });
});
