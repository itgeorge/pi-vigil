import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetVigilRuntimeOverrides } from "../../src/vigil/runtime-overrides";
import { findChildSessionPath, readLatestAssistantTextFromFile } from "../../src/vigil/node-runtime";
import type { VigilLaunchRecord, VigilSnapshot, VigilTurnRecord } from "../../src/vigil/types";
import {
  getAcceptancePollIntervalMs,
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

  it("launches a child, sends a follow-up turn, and polls until both markers appear", async () => {
    const { createVigilTestHarness } = await import("../helpers/vigil-test-harness");

    const firstMarker = `VIGIL_READY_${crypto.randomUUID()}`;
    const secondMarker = `VIGIL_FOLLOW_${crypto.randomUUID()}`;
    const harness = await createVigilTestHarness({ cwd: tempCwd });
    const testModel = getVigilTestModel();

    const launchResult = await harness.execute({
      action: "launch",
      message: `Reply with exactly: ${firstMarker}`,
      model: testModel,
      cwd: tempCwd,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;
    expect(launched.id).toMatch(/^vigil-/);
    expect(launched.state).toBe("running");

    const launchRecord = harness.capturedEntries[0]?.data as VigilLaunchRecord;
    expect(launchRecord.sessionDir).toBe(sessionDir);
    launchedChildPids.push(launchRecord.pid);

    const deadline = Date.now() + getAcceptanceTimeoutMs();
    let firstWaiting: VigilSnapshot | undefined;

    while (Date.now() < deadline) {
      const pollResult = await harness.execute({
        action: "poll",
        id: launched.id,
      });

      expect((pollResult as { isError?: boolean }).isError).toBeFalsy();
      firstWaiting = pollResult.details as VigilSnapshot;

      if (firstWaiting.state === "waiting") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, getAcceptancePollIntervalMs()));
    }

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

    let finalSnapshot: VigilSnapshot | undefined;
    const secondDeadline = Date.now() + getAcceptanceTimeoutMs();
    while (Date.now() < secondDeadline) {
      const pollResult = await harness.execute({
        action: "poll",
        id: launched.id,
      });

      expect((pollResult as { isError?: boolean }).isError).toBeFalsy();
      finalSnapshot = pollResult.details as VigilSnapshot;

      if (finalSnapshot.state === "waiting") {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, getAcceptancePollIntervalMs()));
    }

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
  }, getAcceptanceTimeoutMs() + 60_000);
});
