import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { formatVigilNotifyPrefix } from "../../src/vigil/parent-notifier";
import {
  getVigilFauxModelId,
  readVigilLedgerFromSessionFile,
  readVigilNotifyEntriesFromSessionFile,
  spawnVigilFauxParentPi,
  writeVigilFauxScript,
  type VigilFauxScript,
} from "../helpers/vigil-faux";

function terminatePid(pid: number): void {
  if (pid <= 0) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already have exited.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildPersistedNotifyScript(markers: {
  parentMark: string;
  childMark: string;
  dontNotify?: boolean;
}): VigilFauxScript {
  const fauxModel = getVigilFauxModelId();

  return {
    version: 1,
    steps: [
      {
        when: { userTextIncludes: markers.parentMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: {
            action: "launch",
            name: "Notify Persisted",
            message: `Settle with marker ${markers.childMark}`,
            model: fauxModel,
            ...(markers.dontNotify ? { dontNotify: true } : {}),
          },
        },
      },
      {
        when: { userTextIncludes: markers.parentMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "wait", id: "$launch[0].id", timeoutMs: 120_000 },
        },
      },
      {
        when: { userTextIncludes: markers.parentMark },
        delayMs: 2_500,
        then: { type: "text", text: "notify persisted done" },
      },
      {
        when: { userTextIncludes: markers.childMark },
        delayMs: 400,
        then: { type: "text", text: `child-ok ${markers.childMark}` },
      },
    ],
  };
}

function buildBusyNotifyScript(markers: {
  parentMark: string;
  childMark: string;
  blockingMark: string;
}): VigilFauxScript {
  const fauxModel = getVigilFauxModelId();

  return {
    version: 1,
    steps: [
      {
        when: { userTextIncludes: markers.parentMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: {
            action: "launch",
            name: "Notify Busy",
            message: `Settle during blocking bash with marker ${markers.childMark}`,
            model: fauxModel,
          },
        },
      },
      {
        when: { userTextIncludes: markers.parentMark },
        then: {
          type: "toolCall",
          name: "bash",
          arguments: {
            command: `sleep 3; printf '%s' '${markers.blockingMark}'`,
            timeout: 10_000,
          },
        },
      },
      {
        when: { userTextIncludes: markers.parentMark },
        then: { type: "text", text: "busy notify done" },
      },
      {
        when: { userTextIncludes: markers.childMark },
        then: { type: "text", text: `child-ok ${markers.childMark}` },
      },
    ],
  };
}

function buildEphemeralNotifyScript(markers: {
  parentMark: string;
  childMark: string;
}): VigilFauxScript {
  const fauxModel = getVigilFauxModelId();

  return {
    version: 1,
    steps: [
      {
        when: { userTextIncludes: markers.parentMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: {
            action: "launch",
            name: "Notify Ephemeral",
            message: `Ephemeral settle with marker ${markers.childMark}`,
            model: fauxModel,
            ephemeral: true,
          },
        },
      },
      {
        when: { userTextIncludes: markers.parentMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "wait", id: "$launch[0].id", timeoutMs: 120_000 },
        },
      },
      {
        when: { userTextIncludes: markers.parentMark },
        delayMs: 2_500,
        then: { type: "text", text: "notify ephemeral done" },
      },
      {
        when: { userTextIncludes: markers.childMark },
        delayMs: 400,
        then: { type: "text", text: `ephemeral-ok ${markers.childMark}` },
      },
    ],
  };
}

describe("vigil faux acceptance parent settle notify", () => {
  let tempCwd = "";
  let sessionDir = "";
  let scriptDir = "";
  const trackedPids: number[] = [];

  afterEach(() => {
    for (const pid of trackedPids.splice(0)) {
      terminatePid(pid);
    }

    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
      tempCwd = "";
    }
    if (sessionDir) {
      rmSync(sessionDir, { recursive: true, force: true });
      sessionDir = "";
    }
    if (scriptDir) {
      rmSync(scriptDir, { recursive: true, force: true });
      scriptDir = "";
    }
  });

  it("defers persisted settle notify until a blocking bash tool result is recorded", async () => {
    const parentMark = `VIGIL_NOTIFY_BUSY_${crypto.randomUUID()}`;
    const childMark = `VIGIL_NOTIFY_BUSY_CHILD_${crypto.randomUUID()}`;
    const blockingMark = `VIGIL_NOTIFY_BLOCKING_${crypto.randomUUID()}`;
    const parentSessionId = `vigil-notify-busy-parent-${crypto.randomUUID()}`;

    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-busy-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-busy-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-busy-script-"));

    const scriptPath = writeVigilFauxScript(
      scriptDir,
      buildBusyNotifyScript({ parentMark, childMark, blockingMark }),
    );

    const parentResult = await spawnVigilFauxParentPi({
      sessionId: parentSessionId,
      cwd: tempCwd,
      sessionDir,
      scriptPath,
      name: "Faux busy notify parent",
      prompt: `Run busy notify smoke with marker ${parentMark}`,
      timeoutMs: 30_000,
    });

    if (parentResult.pid > 0) {
      trackedPids.push(parentResult.pid);
    }

    expect(parentResult.timedOut, "parent Pi process timed out").toBe(false);
    expect(parentResult.exitCode, "parent Pi process exit code").toBe(0);
    expect(parentResult.sessionPath, "parent session JSONL path").toBeTruthy();

    const ledger = readVigilLedgerFromSessionFile(parentResult.sessionPath!);
    expect(ledger.launches).toHaveLength(1);
    const launch = ledger.launches[0]!;
    if (launch.pid) {
      trackedPids.push(launch.pid);
    }

    const entries = parseSessionEntries(readFileSync(parentResult.sessionPath!, "utf8")).filter(
      (entry) => entry.type !== "session",
    );
    const blockingBashResultIndex = entries.findIndex(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "bash" &&
        entry.message.content.some(
          (block) => block.type === "text" && block.text.includes(blockingMark),
        ),
    );
    const notificationIndex = entries.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === "vigil-notify",
    );

    expect(blockingBashResultIndex).toBeGreaterThanOrEqual(0);
    expect(notificationIndex).toBeGreaterThan(blockingBashResultIndex);

    const notifications = readVigilNotifyEntriesFromSessionFile(parentResult.sessionPath!);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.details).toEqual(
      expect.objectContaining({ id: launch.id, name: "Notify Busy" }),
    );
  });

  it("records vigil-notify custom_message in the parent session when default notify is on (persisted)", async () => {
    const parentMark = `VIGIL_NOTIFY_ON_${crypto.randomUUID()}`;
    const childMark = `VIGIL_NOTIFY_CHILD_${crypto.randomUUID()}`;
    const parentSessionId = `vigil-notify-parent-${crypto.randomUUID()}`;

    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-script-"));

    const scriptPath = writeVigilFauxScript(
      scriptDir,
      buildPersistedNotifyScript({ parentMark, childMark }),
    );

    const parentResult = await spawnVigilFauxParentPi({
      sessionId: parentSessionId,
      cwd: tempCwd,
      sessionDir,
      scriptPath,
      name: "Faux notify parent",
      prompt: `Run persisted notify smoke with marker ${parentMark}`,
      timeoutMs: 55_000,
    });

    if (parentResult.pid > 0) {
      trackedPids.push(parentResult.pid);
    }

    expect(parentResult.timedOut, "parent Pi process timed out").toBe(false);
    expect(parentResult.exitCode, "parent Pi process exit code").toBe(0);
    expect(parentResult.sessionPath, "parent session JSONL path").toBeTruthy();

    const ledger = readVigilLedgerFromSessionFile(parentResult.sessionPath!);
    expect(ledger.launches).toHaveLength(1);
    const launch = ledger.launches[0]!;
    if (launch.pid) {
      trackedPids.push(launch.pid);
    }

    const notifications = readVigilNotifyEntriesFromSessionFile(parentResult.sessionPath!);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.customType).toBe("vigil-notify");
    expect(notifications[0]?.content).toContain(
      formatVigilNotifyPrefix({ name: "Notify Persisted", id: launch.id, state: "waiting" }),
    );
    expect(notifications[0]?.content).toContain(childMark);
    expect(notifications[0]?.details).toEqual(
      expect.objectContaining({
        id: launch.id,
        name: "Notify Persisted",
        state: "waiting",
      }),
    );

    for (const pid of trackedPids) {
      expect(isProcessAlive(pid), `expected child/parent pid ${pid} to be terminated`).toBe(false);
    }
  });

  it("does not record vigil-notify when launch opts out with dontNotify: true", async () => {
    const parentMark = `VIGIL_NOTIFY_OFF_${crypto.randomUUID()}`;
    const childMark = `VIGIL_NOTIFY_OFF_CHILD_${crypto.randomUUID()}`;
    const parentSessionId = `vigil-notify-off-parent-${crypto.randomUUID()}`;

    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-off-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-off-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-off-script-"));

    const scriptPath = writeVigilFauxScript(
      scriptDir,
      buildPersistedNotifyScript({ parentMark, childMark, dontNotify: true }),
    );

    const parentResult = await spawnVigilFauxParentPi({
      sessionId: parentSessionId,
      cwd: tempCwd,
      sessionDir,
      scriptPath,
      name: "Faux notify opt-out parent",
      prompt: `Run notify opt-out smoke with marker ${parentMark}`,
      timeoutMs: 55_000,
    });

    if (parentResult.pid > 0) {
      trackedPids.push(parentResult.pid);
    }

    expect(parentResult.timedOut, "parent Pi process timed out").toBe(false);
    expect(parentResult.exitCode, "parent Pi process exit code").toBe(0);
    expect(parentResult.sessionPath, "parent session JSONL path").toBeTruthy();

    const ledger = readVigilLedgerFromSessionFile(parentResult.sessionPath!);
    expect(ledger.launches).toHaveLength(1);
    const launch = ledger.launches[0]!;
    if (launch.pid) {
      trackedPids.push(launch.pid);
    }

    const notifications = readVigilNotifyEntriesFromSessionFile(parentResult.sessionPath!);
    expect(notifications).toHaveLength(0);

    for (const pid of trackedPids) {
      expect(isProcessAlive(pid), `expected child/parent pid ${pid} to be terminated`).toBe(false);
    }
  });

  it("records vigil-notify for ephemeral children when default notify is on", async () => {
    const parentMark = `VIGIL_NOTIFY_EPH_${crypto.randomUUID()}`;
    const childMark = `VIGIL_NOTIFY_EPH_CHILD_${crypto.randomUUID()}`;
    const parentSessionId = `vigil-notify-eph-parent-${crypto.randomUUID()}`;

    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-eph-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-eph-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-notify-eph-script-"));

    const scriptPath = writeVigilFauxScript(
      scriptDir,
      buildEphemeralNotifyScript({ parentMark, childMark }),
    );

    const parentResult = await spawnVigilFauxParentPi({
      sessionId: parentSessionId,
      cwd: tempCwd,
      sessionDir,
      scriptPath,
      name: "Faux ephemeral notify parent",
      prompt: `Run ephemeral notify smoke with marker ${parentMark}`,
      timeoutMs: 55_000,
    });

    if (parentResult.pid > 0) {
      trackedPids.push(parentResult.pid);
    }

    expect(parentResult.timedOut, "parent Pi process timed out").toBe(false);
    expect(parentResult.exitCode, "parent Pi process exit code").toBe(0);
    expect(parentResult.sessionPath, "parent session JSONL path").toBeTruthy();

    const ledger = readVigilLedgerFromSessionFile(parentResult.sessionPath!);
    expect(ledger.launches).toHaveLength(1);
    const launch = ledger.launches[0]!;
    expect(launch.ephemeral).toBe(true);
    if (launch.pid) {
      trackedPids.push(launch.pid);
    }

    const notifications = readVigilNotifyEntriesFromSessionFile(parentResult.sessionPath!);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.customType).toBe("vigil-notify");
    expect(notifications[0]?.content).toContain(`[vigil:Notify Ephemeral ${launch.id}]`);
    expect(notifications[0]?.details).toEqual(
      expect.objectContaining({
        id: launch.id,
        name: "Notify Ephemeral",
        state: expect.stringMatching(/^(waiting|failed)$/),
      }),
    );

    for (const pid of trackedPids) {
      expect(isProcessAlive(pid), `expected child/parent pid ${pid} to be terminated`).toBe(false);
    }
  });
});
