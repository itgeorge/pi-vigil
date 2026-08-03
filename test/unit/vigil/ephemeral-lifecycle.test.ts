import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getLifecycleFromSessionManager } from "../../../src/vigil/node-runtime";
import { reconstructVigilLifecycleFromEntries } from "../../../src/vigil/lifecycle";
import type { VigilLaunchRecord, VigilSettleRecord } from "../../../src/vigil/types";

function appendLaunch(sessionManager: SessionManager, record: VigilLaunchRecord): void {
  sessionManager.appendCustomEntry("vigil-launch", record);
}

function appendSettle(sessionManager: SessionManager, record: VigilSettleRecord): void {
  sessionManager.appendCustomEntry("vigil-settle", record);
}

describe("ephemeral lifecycle reconstruction", () => {
  it("retains ephemeral launch metadata and the first valid settle record", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-ephemeral-a",
      sessionId: "vigil-ephemeral-a",
      name: "Quick task",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
      ephemeral: true,
    });
    appendSettle(sessionManager, {
      id: "vigil-ephemeral-a",
      sessionId: "vigil-ephemeral-a",
      latestResponse: "Final answer",
      settledAt: "2026-08-01T10:05:00.000Z",
      stopReason: "stop",
    });
    appendSettle(sessionManager, {
      id: "vigil-ephemeral-a",
      sessionId: "vigil-ephemeral-a",
      latestResponse: "Duplicate settle",
      settledAt: "2026-08-01T10:06:00.000Z",
    });

    const lifecycle = getLifecycleFromSessionManager(sessionManager, "vigil-ephemeral-a");
    expect(lifecycle?.runtimeRecord).toMatchObject({ ephemeral: true });
    expect(lifecycle?.settleRecord?.latestResponse).toBe("Final answer");
    expect(lifecycle?.lastUpdatedAt).toBe("2026-08-01T10:05:00.000Z");
  });

  it("ignores malformed settle entries and unrelated ids", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-ephemeral-valid",
      sessionId: "vigil-ephemeral-valid",
      name: "Valid",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
      ephemeral: true,
    });
    sessionManager.appendCustomEntry("vigil-settle", { id: "broken" });
    sessionManager.appendCustomEntry("vigil-settle", {
      id: "vigil-other",
      sessionId: "vigil-other",
      latestResponse: "wrong",
      settledAt: "2026-08-01T10:01:00.000Z",
    });

    const lifecycle = reconstructVigilLifecycleFromEntries(sessionManager.getEntries()).get(
      "vigil-ephemeral-valid",
    );
    expect(lifecycle?.settleRecord).toBeNull();
  });

  it("leaves persisted launch records unchanged when ephemeral is absent", () => {
    const sessionManager = SessionManager.inMemory("/parent/project");
    appendLaunch(sessionManager, {
      id: "vigil-persisted",
      sessionId: "vigil-persisted",
      name: "Persisted",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });

    const lifecycle = getLifecycleFromSessionManager(sessionManager, "vigil-persisted");
    expect(lifecycle?.runtimeRecord).not.toHaveProperty("ephemeral");
    expect(lifecycle?.settleRecord).toBeNull();
  });
});
