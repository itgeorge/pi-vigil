import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resetVigilRuntimeOverrides } from "../../src/vigil/runtime-overrides";
import { findChildSessionPath, readLatestAssistantTextFromFile } from "../../src/vigil/node-runtime";
import type {
  VigilLaunchRecord,
  VigilListResult,
  VigilSnapshot,
  VigilTurnRecord,
  VigilWaitResult,
} from "../../src/vigil/types";
import {
  getAcceptanceTimeoutMs,
  getVigilTestModel,
  requireLiveAcceptanceEnv,
  verifyPiAuthentication,
} from "./live-prereq";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("live vigil acceptance", () => {
  let tempCwd = "";
  let sessionDir = "";
  const launchedChildPids: number[] = [];

  beforeAll(async () => {
    requireLiveAcceptanceEnv();
    await verifyPiAuthentication();
    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-live-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-live-sessions-"));
    process.env.PI_VIGIL_SESSION_DIR = sessionDir;
  });

  afterAll(() => {
    resetVigilRuntimeOverrides();
    delete process.env.PI_VIGIL_SESSION_DIR;

    for (const pid of launchedChildPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Child may already have exited.
      }
    }

    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
    }
    if (sessionDir) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("launches a named child, waits through resumed turns, then retains its completed session", async () => {
    const { createVigilTestHarness } = await import("../helpers/vigil-test-harness");

    const firstMarker = `VIGIL_READY_${crypto.randomUUID()}`;
    const secondMarker = `VIGIL_FOLLOW_${crypto.randomUUID()}`;
    const launchName = `Live child ${crypto.randomUUID()}`;
    const renamedName = `Renamed during work ${crypto.randomUUID()}`;
    const harness = await createVigilTestHarness({ cwd: tempCwd });
    const testModel = getVigilTestModel();

    const launchResult = await harness.execute({
      action: "launch",
      name: launchName,
      message: `Reply with exactly: ${firstMarker}`,
      model: testModel,
      cwd: tempCwd,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;
    expect(launched.id).toMatch(/^vigil-/);
    expect(launched.name).toBe(launchName);
    expect(launched.state).toBe("running");

    const launchRecord = harness.capturedEntries[0]?.data as VigilLaunchRecord;
    expect(launchRecord.sessionDir).toBe(sessionDir);
    expect(launchRecord.name).toBe(launchName);
    launchedChildPids.push(launchRecord.pid);

    const firstWaitUpdates: Array<{ details?: unknown }> = [];
    const firstWaitResult = await harness.execute(
      {
        action: "wait",
        timeoutMs: getAcceptanceTimeoutMs(),
        initialDelayMs: 250,
        maxDelayMs: 5_000,
        progress: "status",
      },
      undefined,
      (update) => firstWaitUpdates.push(update),
    );
    expect((firstWaitResult as { isError?: boolean }).isError).toBeFalsy();
    expect(firstWaitUpdates.length).toBeGreaterThanOrEqual(1);
    const initialProgress = firstWaitUpdates[0]?.details as {
      items?: Array<{ id: string; state: string; steps: number; messages: number }>;
    };
    expect(initialProgress?.items?.some((item) => item.id === launched.id)).toBe(true);
    expect(initialProgress?.items?.find((item) => item.id === launched.id)).toEqual(
      expect.objectContaining({ state: expect.stringMatching(/running|waiting/), steps: expect.any(Number), messages: expect.any(Number) }),
    );
    const firstWait = firstWaitResult.details as VigilWaitResult;
    expect(firstWait.outcome).toBe("settled");
    const firstWaiting = firstWait.outcome === "settled" ? firstWait.settled.find((snapshot) => snapshot.id === launched.id) : undefined;
    expect(firstWaiting?.state).toBe("waiting");
    expect(firstWaiting?.latestResponse).toContain(firstMarker);

    const launchPid = launchRecord.pid;
    const wasAliveBeforeSend = isProcessAlive(launchPid);

    const sendResult = await harness.execute({
      action: "send",
      id: launched.id,
      message: `Include both ${firstMarker} and ${secondMarker} in your reply.`,
      model: testModel,
    });

    expect((sendResult as { isError?: boolean }).isError).toBeFalsy();
    const sent = sendResult.details as VigilSnapshot;
    expect(sent.state).toBe("running");
    expect(sent.id).toBe(launched.id);
    expect(sent.sessionId).toBe(launched.sessionId);
    if (wasAliveBeforeSend) {
      expect(isProcessAlive(launchPid)).toBe(false);
    }

    const turnRecord = harness.capturedEntries.find((entry) => entry.customType === "vigil-turn")?.data as
      | VigilTurnRecord
      | undefined;
    expect(turnRecord?.pid).toBeTruthy();
    if (turnRecord?.pid) {
      launchedChildPids.push(turnRecord.pid);
    }

    const secondWaitResult = await harness.execute({
      action: "wait",
      timeoutMs: getAcceptanceTimeoutMs(),
      initialDelayMs: 250,
      maxDelayMs: 5_000,
    });
    expect((secondWaitResult as { isError?: boolean }).isError).toBeFalsy();
    const secondWait = secondWaitResult.details as VigilWaitResult;
    expect(secondWait.outcome).toBe("settled");
    const finalSnapshot = secondWait.outcome === "settled" ? secondWait.settled.find((snapshot) => snapshot.id === launched.id) : undefined;

    expect(finalSnapshot?.state).toBe("waiting");
    expect(finalSnapshot?.latestResponse).toContain(firstMarker);
    expect(finalSnapshot?.latestResponse).toContain(secondMarker);

    const childSessionPath = await findChildSessionPath(launched.sessionId, tempCwd, sessionDir);
    expect(childSessionPath).toBeTruthy();
    expect(childSessionPath!.startsWith(sessionDir)).toBe(true);

    const childSessionText = readFileSync(childSessionPath!, "utf8");
    expect(childSessionText).toContain(firstMarker);
    expect(childSessionText).toContain(secondMarker);

    const persistedText = readLatestAssistantTextFromFile(childSessionPath!);
    expect(persistedText).toContain(firstMarker);
    expect(persistedText).toContain(secondMarker);

    const listResult = await harness.execute({ action: "list" });
    expect((listResult as { isError?: boolean }).isError).toBeFalsy();
    const listed = listResult.details as VigilListResult;
    expect(listed.vigils.some((item) => item.id === launched.id && item.name === launchName)).toBe(true);
    expect(listed.vigils[0]).not.toHaveProperty("latestResponse");

    const childSessionManager = SessionManager.open(childSessionPath!, sessionDir, tempCwd);
    childSessionManager.appendSessionInfo(renamedName);
    expect(childSessionManager.getSessionName()).toBe(renamedName);

    const completePid = turnRecord?.pid ?? launchRecord.pid;
    const wasAliveBeforeComplete = isProcessAlive(completePid);

    const completeResult = await harness.execute({
      action: "complete",
      id: launched.id,
    });
    expect((completeResult as { isError?: boolean }).isError).toBeFalsy();
    const completed = completeResult.details as VigilSnapshot;
    expect(completed.state).toBe("completed");
    expect(completed.name).toBe(`[completed] ${renamedName}`);

    expect(readFileSync(childSessionPath!, "utf8")).toContain(firstMarker);
    expect(readFileSync(childSessionPath!, "utf8")).toContain(secondMarker);

    const reopenedChild = SessionManager.open(childSessionPath!, sessionDir, tempCwd);
    expect(reopenedChild.getSessionName()).toBe(`[completed] ${renamedName}`);

    const polledCompleted = await harness.execute({ action: "poll", id: launched.id });
    expect((polledCompleted.details as VigilSnapshot).state).toBe("completed");

    const sendAfterComplete = await harness.execute({
      action: "send",
      id: launched.id,
      message: "Should fail",
    });
    expect((sendAfterComplete as { isError?: boolean }).isError).toBe(true);

    const defaultList = await harness.execute({ action: "list" });
    expect((defaultList.details as VigilListResult).vigils.some((item) => item.id === launched.id)).toBe(false);

    const allList = await harness.execute({ action: "list", includeCompleted: true });
    const completedItem = (allList.details as VigilListResult).vigils.find((item) => item.id === launched.id);
    expect(completedItem?.state).toBe("completed");
    expect(completedItem?.name).toBe(`[completed] ${renamedName}`);

    if (wasAliveBeforeComplete) {
      expect(isProcessAlive(completePid)).toBe(false);
    }
  }, getAcceptanceTimeoutMs() + 120_000);
});
