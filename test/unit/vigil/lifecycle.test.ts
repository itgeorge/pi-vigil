import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  getLifecycleFromSessionManager,
  listLifecycleStatesFromSessionManager,
} from "../../../src/vigil/node-runtime";
import { reconstructVigilLifecycleFromEntries } from "../../../src/vigil/lifecycle";
import type { VigilCompletionRecord, VigilLaunchRecord, VigilTurnRecord } from "../../../src/vigil/types";

function appendLaunch(sessionManager: SessionManager, record: VigilLaunchRecord): void {
  sessionManager.appendCustomEntry("vigil-launch", record);
}

function appendTurn(sessionManager: SessionManager, record: VigilTurnRecord): void {
  sessionManager.appendCustomEntry("vigil-turn", record);
}

function appendComplete(sessionManager: SessionManager, record: VigilCompletionRecord): void {
  sessionManager.appendCustomEntry("vigil-complete", record);
}

describe("vigil lifecycle reconstruction", () => {
  it("retains the latest runtime record across multiple turns for one id", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-a",
      sessionId: "vigil-a",
      name: "Alpha",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });
    appendTurn(sessionManager, {
      id: "vigil-a",
      sessionId: "vigil-a",
      pid: 200,
      cwd: "/parent/project",
      sentAt: "2026-08-01T11:00:00.000Z",
    });

    const lifecycle = getLifecycleFromSessionManager(sessionManager, "vigil-a");
    expect(lifecycle?.runtimeRecord.pid).toBe(200);
    expect(lifecycle?.launchName).toBe("Alpha");
    expect(lifecycle?.lastUpdatedAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("marks an id completed when a later vigil-complete record is present", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-a",
      sessionId: "vigil-a",
      name: "Alpha",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });
    appendComplete(sessionManager, {
      id: "vigil-a",
      sessionId: "vigil-a",
      name: "[completed] Alpha",
      cwd: "/parent/project",
      completedAt: "2026-08-01T12:00:00.000Z",
    });

    const lifecycle = getLifecycleFromSessionManager(sessionManager, "vigil-a");
    expect(lifecycle?.completionRecord?.name).toBe("[completed] Alpha");
    expect(lifecycle?.lastUpdatedAt).toBe("2026-08-01T12:00:00.000Z");
  });

  it("ignores malformed and unrelated custom entries", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    sessionManager.appendCustomEntry("vigil-launch", { id: "broken" });
    sessionManager.appendCustomEntry("other-extension", { id: "vigil-noise" });
    appendLaunch(sessionManager, {
      id: "vigil-valid",
      sessionId: "vigil-valid",
      name: "Valid",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });

    const lifecycle = reconstructVigilLifecycleFromEntries(sessionManager.getEntries());
    expect([...lifecycle.keys()]).toEqual(["vigil-valid"]);
  });

  it("orders lifecycle states most recently updated first", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-old",
      sessionId: "vigil-old",
      name: "Old",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });
    appendLaunch(sessionManager, {
      id: "vigil-new",
      sessionId: "vigil-new",
      name: "New",
      pid: 101,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T12:00:00.000Z",
    });

    const active = listLifecycleStatesFromSessionManager(sessionManager, false);
    expect(active.map((state) => state.id)).toEqual(["vigil-new", "vigil-old"]);
  });

  it("excludes completed children from default lifecycle listing", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-active",
      sessionId: "vigil-active",
      name: "Active",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });
    appendLaunch(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "Done",
      pid: 101,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T09:00:00.000Z",
    });
    appendComplete(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "[completed] Done",
      cwd: "/parent/project",
      completedAt: "2026-08-01T11:00:00.000Z",
    });

    expect(listLifecycleStatesFromSessionManager(sessionManager, false).map((state) => state.id)).toEqual([
      "vigil-active",
    ]);
    expect(listLifecycleStatesFromSessionManager(sessionManager, true).map((state) => state.id)).toEqual([
      "vigil-done",
      "vigil-active",
    ]);
  });

  it("keeps the first valid completion immutable when later duplicate or mismatched records appear", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    const originalLaunch: VigilLaunchRecord = {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "Done",
      pid: 101,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T09:00:00.000Z",
    };
    const originalTurn: VigilTurnRecord = {
      id: "vigil-done",
      sessionId: "vigil-done",
      pid: 202,
      cwd: "/parent/project",
      sentAt: "2026-08-01T10:30:00.000Z",
    };
    const originalCompletion: VigilCompletionRecord = {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "[completed] Done",
      cwd: "/parent/project",
      completedAt: "2026-08-01T11:00:00.000Z",
    };

    appendLaunch(sessionManager, originalLaunch);
    appendTurn(sessionManager, originalTurn);
    appendComplete(sessionManager, originalCompletion);

    appendLaunch(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-done-relaunch",
      name: "Reactivated",
      pid: 999,
      cwd: "/other/project",
      launchedAt: "2026-08-02T12:00:00.000Z",
    });
    appendTurn(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-done",
      pid: 303,
      cwd: "/parent/project",
      sentAt: "2026-08-02T12:30:00.000Z",
    });
    appendTurn(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-other-session",
      pid: 404,
      cwd: "/other/project",
      sentAt: "2026-08-02T13:00:00.000Z",
    });
    appendComplete(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-done",
      name: "[completed] Overwritten",
      cwd: "/parent/project",
      completedAt: "2026-08-02T14:00:00.000Z",
    });
    appendComplete(sessionManager, {
      id: "vigil-done",
      sessionId: "vigil-other-session",
      name: "[completed] Wrong identity",
      cwd: "/other/project",
      completedAt: "2026-08-02T15:00:00.000Z",
    });

    const lifecycle = getLifecycleFromSessionManager(sessionManager, "vigil-done");
    expect(lifecycle).toEqual({
      id: "vigil-done",
      sessionId: "vigil-done",
      cwd: "/parent/project",
      launchName: "Done",
      runtimeRecord: originalTurn,
      settleRecord: null,
      completionRecord: originalCompletion,
      lastUpdatedAt: "2026-08-01T11:00:00.000Z",
    });

    expect(listLifecycleStatesFromSessionManager(sessionManager, false).map((state) => state.id)).toEqual([]);
    expect(listLifecycleStatesFromSessionManager(sessionManager, true)).toEqual([lifecycle]);
  });
});
