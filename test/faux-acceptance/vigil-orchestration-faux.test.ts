import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getVigilFauxModelId,
  readVigilLedgerFromSessionFile,
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

function buildOrchestrationScript(markers: {
  orchMark: string;
  fastMark: string;
  slowMark: string;
}): VigilFauxScript {
  const fauxModel = getVigilFauxModelId();

  return {
    version: 1,
    steps: [
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: {
            action: "launch",
            name: "Orch Fast",
            message: `Fast child settle with marker ${markers.fastMark}`,
            model: fauxModel,
            dontNotify: true,
          },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: {
            action: "launch",
            name: "Orch Slow",
            message: `Slow child settle with marker ${markers.slowMark}`,
            model: fauxModel,
            dontNotify: true,
          },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "wait", id: "$launch[0].id", timeoutMs: 120_000 },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "wait", id: "$launch[1].id", timeoutMs: 120_000 },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "complete", id: "$launch[0].id" },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "complete", id: "$launch[1].id" },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: {
          type: "toolCall",
          name: "vigil",
          arguments: { action: "list", includeCompleted: true },
        },
      },
      {
        when: { userTextIncludes: markers.orchMark },
        then: { type: "text", text: "orchestration smoke done" },
      },
      {
        when: { userTextIncludes: markers.fastMark },
        delayMs: 400,
        then: { type: "text", text: `fast-ok ${markers.fastMark}` },
      },
      {
        when: { userTextIncludes: markers.slowMark },
        delayMs: 2_000,
        then: { type: "text", text: `slow-ok ${markers.slowMark}` },
      },
    ],
  };
}

describe("vigil faux acceptance orchestration smoke", () => {
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

  it("orchestrates staggered faux children via a real Pi parent and records launch/complete ledger entries", async () => {
    const orchMark = `VIGIL_ORCH_${crypto.randomUUID()}`;
    const fastMark = `VIGIL_ORCH_FAST_${crypto.randomUUID()}`;
    const slowMark = `VIGIL_ORCH_SLOW_${crypto.randomUUID()}`;
    const parentSessionId = `vigil-orch-parent-${crypto.randomUUID()}`;

    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-orch-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-orch-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-orch-script-"));

    const scriptPath = writeVigilFauxScript(scriptDir, buildOrchestrationScript({
      orchMark,
      fastMark,
      slowMark,
    }));

    const parentResult = await spawnVigilFauxParentPi({
      sessionId: parentSessionId,
      cwd: tempCwd,
      sessionDir,
      scriptPath,
      name: "Faux orchestration parent",
      prompt: `Run orchestration smoke with marker ${orchMark}`,
      timeoutMs: 55_000,
    });

    if (parentResult.pid > 0) {
      trackedPids.push(parentResult.pid);
    }

    expect(parentResult.timedOut, "parent Pi process timed out").toBe(false);
    expect(parentResult.exitCode, "parent Pi process exit code").toBe(0);
    expect(parentResult.sessionPath, "parent session JSONL path").toBeTruthy();

    const ledger = readVigilLedgerFromSessionFile(parentResult.sessionPath!);
    const fastLaunch = ledger.launches.find((record) => record.name === "Orch Fast");
    const slowLaunch = ledger.launches.find((record) => record.name === "Orch Slow");

    expect(ledger.launches).toHaveLength(2);
    expect(fastLaunch).toBeDefined();
    expect(slowLaunch).toBeDefined();

    if (fastLaunch?.pid) {
      trackedPids.push(fastLaunch.pid);
    }
    if (slowLaunch?.pid) {
      trackedPids.push(slowLaunch.pid);
    }

    expect(ledger.completions).toHaveLength(2);
    expect(ledger.completions.map((record) => record.id)).toEqual(
      expect.arrayContaining([fastLaunch!.id, slowLaunch!.id]),
    );

    for (const pid of trackedPids) {
      expect(isProcessAlive(pid), `expected child/parent pid ${pid} to be terminated`).toBe(false);
    }
  });
});
