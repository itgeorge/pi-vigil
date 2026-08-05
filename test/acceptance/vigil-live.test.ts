import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resetVigilRuntimeOverrides } from "../../src/vigil/runtime-overrides";
import { findChildSessionPath, readLatestAssistantTextFromFile } from "../../src/vigil/node-runtime";
import {
  DEFAULT_LIST_MAX_RESULTS,
  type VigilLaunchRecord,
  type VigilListResult,
  type VigilReadResult,
  type VigilSearchResult,
  type VigilSnapshot,
  type VigilTurnRecord,
  type VigilWaitResult,
} from "../../src/vigil/types";
import {
  getAcceptanceTimeoutMs,
  getVigilTestModel,
  requireLiveAcceptanceEnv,
  verifyPiAuthentication,
} from "./live-prereq";

const SYNTHETIC_PAGINATION_PID_BASE = 9_000_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function appendSyntheticPaginationLaunches(
  sessionManager: { appendCustomEntry: (customType: string, data: unknown) => void },
  options: { cwd: string; sessionDir: string; count: number; runId: string },
): VigilLaunchRecord[] {
  const records: VigilLaunchRecord[] = Array.from({ length: options.count }, (_, index) => {
    const ordinal = index + 1;
    const id = `vigil-pag-${options.runId}-${String(ordinal).padStart(3, "0")}`;
    return {
      id,
      sessionId: id,
      name: `Synthetic pagination task ${ordinal}`,
      pid: SYNTHETIC_PAGINATION_PID_BASE + ordinal,
      cwd: options.cwd,
      sessionDir: options.sessionDir,
      launchedAt: new Date(Date.UTC(2026, 7, 2, 12, index)).toISOString(),
    };
  });

  for (const record of records) {
    sessionManager.appendCustomEntry("vigil-launch", record);
  }

  return records;
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
    const launchText = launchResult.content[0]?.type === "text" ? launchResult.content[0].text : "";
    expect(launchText).toContain(`id: ${launched.id}`);
    expect(launchText).not.toContain("sessionId:");
    expect(launchText).not.toContain("latestResponse:");

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

    const targetedWaitingResult = await harness.execute({
      action: "wait",
      id: launched.id,
      timeoutMs: getAcceptanceTimeoutMs(),
      initialDelayMs: 250,
      maxDelayMs: 5_000,
    });
    expect((targetedWaitingResult as { isError?: boolean }).isError).toBeFalsy();
    const targetedWaiting = targetedWaitingResult.details as VigilWaitResult;
    expect(targetedWaiting.outcome).toBe("settled");
    expect(targetedWaiting.outcome === "settled" && targetedWaiting.waitedMs).toBeLessThanOrEqual(250);
    if (targetedWaiting.outcome === "settled") {
      expect(targetedWaiting.settled).toHaveLength(1);
      expect(targetedWaiting.settled[0]?.id).toBe(launched.id);
      expect(targetedWaiting.settled[0]?.state).toBe("waiting");
      expect(targetedWaiting.settled[0]?.latestResponse).toContain(firstMarker);
    }
    const targetedWaitingText =
      targetedWaitingResult.content[0]?.type === "text" ? targetedWaitingResult.content[0].text : "";
    expect(targetedWaitingText).toContain(firstMarker);

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
    const sendText = sendResult.content[0]?.type === "text" ? sendResult.content[0].text : "";
    expect(sendText).not.toContain(secondMarker);
    expect(sendText).not.toContain("latestResponse:");
    expect(sendText).not.toContain("sessionId:");
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

    const activeSearch = await harness.execute({
      action: "search",
      query: secondMarker,
      id: launched.id,
    });
    expect((activeSearch as { isError?: boolean }).isError).toBeFalsy();
    const searchDetails = activeSearch.details as VigilSearchResult;
    expect(searchDetails.matches.length).toBeGreaterThan(0);
    const diagnosticMatch = searchDetails.matches.find((match) => match.id === launched.id);
    expect(diagnosticMatch?.entryId).toBeTruthy();
    expect((activeSearch.content[0] as { text?: string }).text).toContain(secondMarker);

    const readActive = await harness.execute({
      action: "read",
      id: diagnosticMatch!.id,
      entryId: diagnosticMatch!.entryId,
      before: 1,
      after: 1,
    });
    expect((readActive as { isError?: boolean }).isError).toBeFalsy();
    const readDetails = readActive.details as VigilReadResult;
    expect(readDetails.anchorEntryId).toBe(diagnosticMatch!.entryId);
    expect(readDetails.order).toBe("jsonl-append-order");
    expect((readActive.content[0] as { text?: string }).text).toContain(secondMarker);

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

    const targetedCompletedResult = await harness.execute({ action: "wait", id: launched.id });
    expect((targetedCompletedResult as { isError?: boolean }).isError).toBeFalsy();
    const targetedCompleted = targetedCompletedResult.details as VigilWaitResult;
    expect(targetedCompleted.outcome).toBe("settled");
    expect(targetedCompleted.outcome === "settled" && targetedCompleted.waitedMs).toBeLessThanOrEqual(250);
    if (targetedCompleted.outcome === "settled") {
      expect(targetedCompleted.settled).toHaveLength(1);
      expect(targetedCompleted.settled[0]?.id).toBe(launched.id);
      expect(targetedCompleted.settled[0]?.state).toBe("completed");
      expect(targetedCompleted.settled[0]?.latestResponse).toContain(secondMarker);
    }
    const targetedCompletedText =
      targetedCompletedResult.content[0]?.type === "text" ? targetedCompletedResult.content[0].text : "";
    expect(targetedCompletedText).toContain(secondMarker);

    const sendAfterComplete = await harness.execute({
      action: "send",
      id: launched.id,
      message: "Should fail",
    });
    expect((sendAfterComplete as { isError?: boolean }).isError).toBe(true);

    const excludedSearch = await harness.execute({
      action: "search",
      query: secondMarker,
      id: launched.id,
    });
    expect((excludedSearch as { isError?: boolean }).isError).toBe(true);

    const retainedSearch = await harness.execute({
      action: "search",
      query: secondMarker,
      id: launched.id,
      includeCompleted: true,
    });
    expect((retainedSearch as { isError?: boolean }).isError).toBeFalsy();
    expect((retainedSearch.details as VigilSearchResult).matches.some((match) => match.id === launched.id)).toBe(
      true,
    );

    expect(
      await harness.execute({
        action: "read",
        id: launched.id,
        entryId: diagnosticMatch!.entryId,
      }),
    ).toMatchObject({ isError: true });

    const readCompleted = await harness.execute({
      action: "read",
      id: launched.id,
      entryId: diagnosticMatch!.entryId,
      includeCompleted: true,
    });
    expect((readCompleted as { isError?: boolean }).isError).toBeFalsy();
    expect((readCompleted.content[0] as { text?: string }).text).toContain(secondMarker);

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

  it("shows shallow direct-subagent summaries and guarded completion without mutating synthetic descendants", async () => {
    const { createVigilTestHarness } = await import("../helpers/vigil-test-harness");

    const marker = `VIGIL_SUBAGENT_${crypto.randomUUID()}`;
    const launchName = `Nested parent ${crypto.randomUUID()}`;
    const syntheticSubId = `vigil-${crypto.randomUUID()}`;
    const harness = await createVigilTestHarness({ cwd: tempCwd });
    const testModel = getVigilTestModel();

    const launchResult = await harness.execute({
      action: "launch",
      name: launchName,
      message: `Reply with exactly: ${marker}`,
      model: testModel,
      cwd: tempCwd,
    });
    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;

    const launchRecord = harness.capturedEntries[0]?.data as VigilLaunchRecord;
    launchedChildPids.push(launchRecord.pid);

    const waitResult = await harness.execute({
      action: "wait",
      timeoutMs: getAcceptanceTimeoutMs(),
      initialDelayMs: 250,
      maxDelayMs: 5_000,
    });
    expect((waitResult as { isError?: boolean }).isError).toBeFalsy();
    const waitDetails = waitResult.details as VigilWaitResult;
    expect(waitDetails.outcome).toBe("settled");

    const childSessionPath = await findChildSessionPath(launched.sessionId, tempCwd, sessionDir);
    expect(childSessionPath).toBeTruthy();

    const childSessionManager = SessionManager.open(childSessionPath!, sessionDir, tempCwd);
    childSessionManager.appendCustomEntry("vigil-launch", {
      id: syntheticSubId,
      sessionId: syntheticSubId,
      name: "Synthetic nested task",
      pid: 999_999,
      cwd: tempCwd,
      sessionDir,
      launchedAt: new Date().toISOString(),
    } satisfies VigilLaunchRecord);

    const listResult = await harness.execute({ action: "list" });
    expect((listResult as { isError?: boolean }).isError).toBeFalsy();
    const listed = listResult.details as VigilListResult;
    const listedChild = listed.vigils.find((item) => item.id === launched.id);
    expect(listedChild?.directSubagents).toEqual(
      expect.objectContaining({ inspection: "available", incomplete: 1, unknown: 1, waiting: 0 }),
    );
    expect((listResult.content[0] as { text?: string }).text).toContain("Synthetic nested task");

    const waitWithSubs = await harness.execute({
      action: "wait",
      timeoutMs: 1_000,
      progress: "status",
    });
    expect((waitWithSubs as { isError?: boolean }).isError).toBeFalsy();
    expect((waitWithSubs.content[0] as { text?: string }).text).toContain("direct subagents");
    const waitWithSubsDetails = waitWithSubs.details as VigilWaitResult;
    expect(waitWithSubsDetails.outcome).toBe("settled");
    if (waitWithSubsDetails.outcome === "settled") {
      expect(waitWithSubsDetails.settled.find((snapshot) => snapshot.id === launched.id)?.directSubagents).toEqual(
        expect.objectContaining({ inspection: "available", incomplete: 1, unknown: 1, waiting: 0 }),
      );
    }

    const rejectedComplete = await harness.execute({ action: "complete", id: launched.id });
    expect((rejectedComplete as { isError?: boolean }).isError).toBe(true);
    expect((rejectedComplete.content[0] as { text?: string }).text).toContain("allowIncompleteSubagents");
    expect(harness.capturedEntries.some((entry) => entry.customType === "vigil-complete")).toBe(false);

    const childTextBeforeComplete = readFileSync(childSessionPath!, "utf8");

    const allowedComplete = await harness.execute({
      action: "complete",
      id: launched.id,
      allowIncompleteSubagents: true,
    });
    expect((allowedComplete as { isError?: boolean }).isError).toBeFalsy();
    expect((allowedComplete.details as VigilSnapshot).state).toBe("completed");

    const childTextAfterComplete = readFileSync(childSessionPath!, "utf8");
    expect(childTextAfterComplete).toContain("Synthetic nested task");
    expect(childTextAfterComplete).toContain(syntheticSubId);
    // Parent completion appends its own session-info rename; its synthetic direct-child ledger remains unchanged.
    expect(childTextAfterComplete).not.toBe(childTextBeforeComplete);
    expect(childTextAfterComplete.split(syntheticSubId).length).toBe(
      childTextBeforeComplete.split(syntheticSubId).length,
    );
  }, getAcceptanceTimeoutMs() + 120_000);

  it("launches an ephemeral child, settles through wait/poll, and leaves no child session", async () => {
    const { createVigilTestHarness } = await import("../helpers/vigil-test-harness");

    const marker = `VIGIL_EPHEMERAL_${crypto.randomUUID()}`;
    const launchName = `Ephemeral child ${crypto.randomUUID()}`;
    const harness = await createVigilTestHarness({ cwd: tempCwd });
    const testModel = getVigilTestModel();

    const launchResult = await harness.execute({
      action: "launch",
      name: launchName,
      message: `Reply with exactly: ${marker}`,
      model: testModel,
      cwd: tempCwd,
      ephemeral: true,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;
    expect(launched.ephemeral).toBe(true);
    expect(launched.state).toBe("running");

    const launchRecord = harness.capturedEntries.find((entry) => entry.customType === "vigil-launch")?.data as
      | VigilLaunchRecord
      | undefined;
    expect(launchRecord?.ephemeral).toBe(true);
    if (launchRecord?.pid) {
      launchedChildPids.push(launchRecord.pid);
    }

    const waitResult = await harness.execute({
      action: "wait",
      id: launched.id,
      timeoutMs: getAcceptanceTimeoutMs(),
      initialDelayMs: 250,
      maxDelayMs: 5_000,
    });
    expect((waitResult as { isError?: boolean }).isError).toBeFalsy();
    const waitDetails = waitResult.details as VigilWaitResult;
    expect(waitDetails.outcome).toBe("settled");
    if (waitDetails.outcome === "settled") {
      expect(waitDetails.settled[0]?.latestResponse).toContain(marker);
    }

    expect(harness.capturedEntries.some((entry) => entry.customType === "vigil-settle")).toBe(true);
    expect(await findChildSessionPath(launched.sessionId, tempCwd, sessionDir)).toBeNull();

    const sendRejected = await harness.execute({ action: "send", id: launched.id, message: "again" });
    expect((sendRejected as { isError?: boolean }).isError).toBe(true);
    const searchRejected = await harness.execute({ action: "search", query: marker, id: launched.id });
    expect((searchRejected as { isError?: boolean }).isError).toBe(true);
    const readRejected = await harness.execute({ action: "read", id: launched.id, entryId: "entry-1" });
    expect((readRejected as { isError?: boolean }).isError).toBe(true);

    const completeResult = await harness.execute({ action: "complete", id: launched.id });
    expect((completeResult as { isError?: boolean }).isError).toBeFalsy();
    expect((completeResult.details as VigilSnapshot).state).toBe("completed");
    expect((completeResult.details as VigilSnapshot).name).toBe(`[completed] ${launchName}`);
  }, getAcceptanceTimeoutMs() + 120_000);

  it("launch with invalid model returns tool error within bootstrap window", async () => {
    const { createVigilTestHarness } = await import("../helpers/vigil-test-harness");

    const harness = await createVigilTestHarness({ cwd: tempCwd });
    const launchResult = await harness.execute({
      action: "launch",
      name: "Invalid model child",
      message: "hello",
      model: "totally-invalid-model/foo",
      cwd: tempCwd,
    });

    expect((launchResult as { isError?: boolean }).isError).toBe(true);
    const text = launchResult.content[0]?.type === "text" ? launchResult.content[0].text : "";
    expect(text).toMatch(/not found|Vigil child failed/i);
    expect(harness.capturedEntries.some((entry) => entry.customType === "vigil-launch")).toBe(true);
    expect(harness.capturedEntries.some((entry) => entry.customType === "vigil-fail")).toBe(true);
  }, 30_000);

  it("paginates list results with synthetic lifecycle records without launching real children", async () => {
    const { createVigilTestHarness } = await import("../helpers/vigil-test-harness");

    const runId = crypto.randomUUID();
    const harness = await createVigilTestHarness({ cwd: tempCwd });
    const syntheticRecords = appendSyntheticPaginationLaunches(harness.sessionManager, {
      cwd: tempCwd,
      sessionDir,
      count: 25,
      runId,
    });

    const firstPageResult = await harness.execute({ action: "list" });
    expect((firstPageResult as { isError?: boolean }).isError).toBeFalsy();
    const firstPage = firstPageResult.details as VigilListResult;
    expect(firstPage.vigils).toHaveLength(DEFAULT_LIST_MAX_RESULTS);
    expect(firstPage.omittedCount).toBe(5);
    expect(firstPage.nextSkipToId).toBe(syntheticRecords[4]?.id);
    expect(firstPage.vigils.map((item) => item.id)).toEqual(
      syntheticRecords
        .slice()
        .reverse()
        .slice(0, DEFAULT_LIST_MAX_RESULTS)
        .map((record) => record.id),
    );
    for (const item of firstPage.vigils) {
      expect(item).toEqual(
        expect.objectContaining({
          id: expect.stringMatching(/^vigil-pag-/),
          sessionId: expect.any(String),
          name: expect.stringMatching(/^Synthetic pagination task /),
          cwd: tempCwd,
          state: "waiting",
        }),
      );
      expect(item).not.toHaveProperty("latestResponse");
      expect(item.directSubagents).toEqual(
        expect.objectContaining({
          inspection: "unavailable",
          error: "Child session ledger unavailable for direct subagent inspection",
        }),
      );
    }

    const firstPageText = firstPageResult.content[0]?.type === "text" ? firstPageResult.content[0].text : "";
    expect(firstPageText).toContain("5 more children omitted.");
    expect(firstPageText).toContain(
      "Use maxResults to expand this page or skipToId to retrieve older children.",
    );
    expect(firstPageText).toContain(`next skipToId: ${syntheticRecords[4]?.id}`);

    const secondPageResult = await harness.execute({ action: "list", skipToId: firstPage.nextSkipToId });
    expect((secondPageResult as { isError?: boolean }).isError).toBeFalsy();
    const secondPage = secondPageResult.details as VigilListResult;
    expect(secondPage.vigils.map((item) => item.id)).toEqual(
      syntheticRecords
        .slice(0, 5)
        .reverse()
        .map((record) => record.id),
    );
    expect(secondPage.omittedCount).toBe(0);
    expect(secondPage.nextSkipToId).toBeUndefined();

    const firstIds = new Set(firstPage.vigils.map((item) => item.id));
    for (const item of secondPage.vigils) {
      expect(firstIds.has(item.id)).toBe(false);
    }

    const secondPageText = secondPageResult.content[0]?.type === "text" ? secondPageResult.content[0].text : "";
    expect(secondPageText).not.toContain("more children omitted");
    expect(secondPageText).toContain("Synthetic pagination task 1");
  }, 30_000);
});
