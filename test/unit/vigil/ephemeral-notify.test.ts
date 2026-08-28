import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { createFakeEphemeralChildObserver } from "../../../src/vigil/ephemeral-observer";
import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "../../../src/vigil/ports";
import { createRecordingParentNotifier } from "../../../src/vigil/parent-notifier";
import { createEmptyChildSessionTranscriptReader, createSessionParentLedger, VigilService } from "../../../src/vigil/node-runtime";
import { isVigilError } from "../../../src/vigil/types";

const TEST_MODEL = "openai-codex/gpt-5.5";

function assistantSettledChunk(text: string): string {
  return `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"stopReason":"stop"}}\n{"type":"agent_settled"}\n`;
}

function assistantErrorSettledChunk(errorMessage: string): string {
  return `{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"${errorMessage}"}}\n{"type":"agent_settled"}\n`;
}

function createEphemeralNotifyHarness(options?: {
  dontNotify?: boolean;
  parentNotifier?: ReturnType<typeof createRecordingParentNotifier>;
}) {
  const sessionManager = SessionManager.inMemory("/parent/default");
  const observer = createFakeEphemeralChildObserver();
  const parentNotifier = options?.parentNotifier ?? createRecordingParentNotifier();
  const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
    sessionManager.appendCustomEntry(customType, data);
  });

  const processRunner: ProcessRunner = {
    async spawnDetached() {
      throw new Error("persisted spawn should not be used for ephemeral launch");
    },
    isAlive: () => false,
    async terminateAndWait() {},
  };

  const childSessionReader: ChildSessionReader = {
    async readChildSessionState() {
      throw new Error("child session reader should not be used for ephemeral observation");
    },
  };

  const childSessionNamer: ChildSessionNamer = {
    async markCompleted() {
      throw new Error("child session rename should not run for ephemeral complete");
    },
  };

  const service = new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
    childSessionNamer,
    parentLedger,
    descendantInspector: createZeroDescendantInspector(),
    ephemeralChildObserver: observer,
    parentNotifier,
    createId: () => "vigil-ephemeral-notify",
    bootstrapFailFastTimeoutMs: 25,
    currentParentSessionId: "parent-session-id",
  });

  return { service, observer, parentNotifier, sessionManager };
}

describe("ephemeral settle parent notify", () => {
  it("notifies once on default ephemeral settle", async () => {
    const { service, observer, parentNotifier } = createEphemeralNotifyHarness();

    const launched = await service.launch({
      name: "Quick task",
      message: "Reply DONE",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      ephemeral: true,
    });
    expect(isVigilError(launched)).toBe(false);

    observer.pushStdout("vigil-ephemeral-notify", assistantSettledChunk("DONE"));

    expect(parentNotifier.calls).toHaveLength(1);
    expect(parentNotifier.calls[0]).toEqual({
      id: "vigil-ephemeral-notify",
      name: "Quick task",
      state: "waiting",
      latestResponse: "DONE",
    });
  });

  it("skips notify when launch opts out with dontNotify", async () => {
    const { service, observer, parentNotifier } = createEphemeralNotifyHarness();

    await service.launch({
      name: "Silent child",
      message: "Reply DONE",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      ephemeral: true,
      dontNotify: true,
    });

    observer.pushStdout("vigil-ephemeral-notify", assistantSettledChunk("DONE"));
    expect(parentNotifier.calls).toHaveLength(0);
  });

  it("notifies on failed ephemeral settle unless opted out", async () => {
    const { service, observer, parentNotifier } = createEphemeralNotifyHarness();

    await service.launch({
      name: "Broken child",
      message: "Fail",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      ephemeral: true,
    });

    observer.pushStdout(
      "vigil-ephemeral-notify",
      assistantErrorSettledChunk("assistant blew up"),
    );

    expect(parentNotifier.calls).toHaveLength(1);
    expect(parentNotifier.calls[0]?.state).toBe("failed");
    expect(parentNotifier.calls[0]?.error).toBe("assistant blew up");
  });

  it("does not double-notify when settle callback is invoked twice", async () => {
    let capturedOnSettled: ((result: {
      latestResponse: string | null;
      settledAt: string;
      error?: string;
    }) => void) | undefined;

    const wrappingObserver = createFakeEphemeralChildObserver({
      onStart(input) {
        capturedOnSettled = input.onSettled;
      },
    });

    const sessionManager = SessionManager.inMemory("/parent/default");
    const parentLedger = createSessionParentLedger(sessionManager, (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    });
    const recordingNotifier = createRecordingParentNotifier();
    const notifyService = new VigilService({
      processRunner: {
        async spawnDetached() {
          throw new Error("unused");
        },
        isAlive: () => false,
        async terminateAndWait() {},
      },
      childSessionReader: {
        async readChildSessionState() {
          throw new Error("unused");
        },
      },
      childSessionTranscriptReader: createEmptyChildSessionTranscriptReader(),
      childSessionNamer: {
        async markCompleted() {
          throw new Error("unused");
        },
      },
      descendantInspector: createZeroDescendantInspector(),
      parentLedger,
      ephemeralChildObserver: wrappingObserver,
      parentNotifier: recordingNotifier,
      createId: () => "vigil-dedupe",
      bootstrapFailFastTimeoutMs: 25,
      currentParentSessionId: "parent-session-id",
    });

    await notifyService.launch({
      name: "Dedupe",
      message: "Work",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      ephemeral: true,
    });

    const settledAt = "2026-08-28T12:00:00.000Z";
    capturedOnSettled?.({
      latestResponse: "Done",
      settledAt,
    });
    capturedOnSettled?.({
      latestResponse: "Done",
      settledAt,
    });

    expect(recordingNotifier.calls).toHaveLength(1);
  });

  it("does not notify after ephemeral observer shutdown", async () => {
    const { service, observer, parentNotifier } = createEphemeralNotifyHarness();

    await service.launch({
      name: "Shutdown child",
      message: "Work",
      model: TEST_MODEL,
      parentCwd: "/parent/default",
      ephemeral: true,
    });

    await observer.shutdown();
    observer.pushStdout("vigil-ephemeral-notify", assistantSettledChunk("LATE"));
    expect(parentNotifier.calls).toHaveLength(0);
  });
});
