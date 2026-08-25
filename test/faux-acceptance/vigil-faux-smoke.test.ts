import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createVigilTestHarness } from "../helpers/vigil-test-harness";
import {
  createVigilFauxProcessRunner,
  getVigilFauxModelId,
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  writeVigilFauxScript,
} from "../helpers/vigil-faux";
import {
  resetVigilRuntimeOverrides,
  setVigilRuntimeOverrides,
} from "../../src/vigil/runtime-overrides";
import type { VigilLaunchRecord, VigilSnapshot, VigilWaitResult } from "../../src/vigil/types";

function terminatePid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Child may already have exited.
  }
}

describe("vigil faux acceptance smoke", () => {
  let tempCwd = "";
  let sessionDir = "";
  let scriptDir = "";
  const launchedChildPids: number[] = [];
  const previousFauxScript = process.env.PI_VIGIL_FAUX_SCRIPT;
  const previousSessionDir = process.env.PI_VIGIL_SESSION_DIR;

  afterEach(() => {
    resetVigilRuntimeOverrides();

    for (const pid of launchedChildPids.splice(0)) {
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

    if (previousFauxScript !== undefined) {
      process.env.PI_VIGIL_FAUX_SCRIPT = previousFauxScript;
    } else {
      delete process.env.PI_VIGIL_FAUX_SCRIPT;
    }

    if (previousSessionDir !== undefined) {
      process.env.PI_VIGIL_SESSION_DIR = previousSessionDir;
    } else {
      delete process.env.PI_VIGIL_SESSION_DIR;
    }
  });

  afterAll(() => {
    resetVigilRuntimeOverrides();
  });

  async function setupFauxHarness(script: Parameters<typeof writeVigilFauxScript>[1]) {
    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-script-"));

    const scriptPath = writeVigilFauxScript(scriptDir, script);
    process.env.PI_VIGIL_FAUX_SCRIPT = scriptPath;
    process.env.PI_VIGIL_SESSION_DIR = sessionDir;

    setVigilRuntimeOverrides({
      processRunner: createVigilFauxProcessRunner({ loadLocalVigil: true }),
      sessionDir,
    });

    return createVigilTestHarness({ cwd: tempCwd });
  }

  it("returns scripted marker text when the user message matches", async () => {
    const marker = `VIGIL_FAUX_${crypto.randomUUID()}`;
    const harness = await setupFauxHarness({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: marker },
          then: { type: "text", text: marker },
        },
      ],
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Faux marker child",
      message: `Include this marker in your reply: ${marker}`,
      model: getVigilFauxModelId(),
      cwd: tempCwd,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;
    expect(launched.state).toBe("running");

    const launchRecord = harness.capturedEntries.find((entry) => entry.customType === "vigil-launch")
      ?.data as VigilLaunchRecord;
    expect(launchRecord?.pid).toBeTruthy();
    launchedChildPids.push(launchRecord.pid);

    const waitResult = await harness.execute({
      action: "wait",
      id: launched.id,
      timeoutMs: 30_000,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      model: "openai-codex/gpt-5.5",
    });

    expect((waitResult as { isError?: boolean }).isError).toBeFalsy();
    const waitDetails = waitResult.details as VigilWaitResult;
    expect(waitDetails.outcome).toBe("settled");
    if (waitDetails.outcome === "settled") {
      const snapshot = waitDetails.settled.find((item) => item.id === launched.id);
      expect(snapshot?.state).toBe("waiting");
      expect(snapshot?.latestResponse).toContain(marker);
    }
  });

  it("returns fallback text when the user message does not match any script step", async () => {
    const harness = await setupFauxHarness({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: "WILL_NEVER_MATCH" },
          then: { type: "text", text: "unexpected scripted reply" },
        },
      ],
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Faux fallback child",
      message: "This prompt does not match the scripted step.",
      model: getVigilFauxModelId(),
      cwd: tempCwd,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;

    const launchRecord = harness.capturedEntries.find((entry) => entry.customType === "vigil-launch")
      ?.data as VigilLaunchRecord;
    expect(launchRecord?.pid).toBeTruthy();
    launchedChildPids.push(launchRecord.pid);

    const waitResult = await harness.execute({
      action: "wait",
      id: launched.id,
      timeoutMs: 30_000,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      model: "openai-codex/gpt-5.5",
    });

    expect((waitResult as { isError?: boolean }).isError).toBeFalsy();
    const waitDetails = waitResult.details as VigilWaitResult;
    expect(waitDetails.outcome).toBe("settled");
    if (waitDetails.outcome === "settled") {
      const snapshot = waitDetails.settled.find((item) => item.id === launched.id);
      expect(snapshot?.state).toBe("waiting");
      expect(snapshot?.latestResponse).toContain(VIGIL_FAUX_DEFAULT_FALLBACK_TEXT);
    }
  });
});
