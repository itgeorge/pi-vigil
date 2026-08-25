import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { NESTED_LAUNCH_DISABLED_ERROR } from "../../src/vigil/nesting-policy";
import {
  resetVigilRuntimeOverrides,
  setVigilRuntimeOverrides,
} from "../../src/vigil/runtime-overrides";
import type {
  VigilLaunchRecord,
  VigilListResult,
  VigilSearchResult,
  VigilSnapshot,
  VigilWaitResult,
} from "../../src/vigil/types";
import { createVigilTestHarness } from "../helpers/vigil-test-harness";
import {
  createVigilFauxProcessRunner,
  getVigilFauxModelId,
  writeVigilFauxScript,
  type VigilFauxScript,
} from "../helpers/vigil-faux";

function terminatePid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Child may already have exited.
  }
}

describe("vigil faux acceptance nesting policy", () => {
  let tempCwd = "";
  let sessionDir = "";
  let scriptDir = "";
  const launchedChildPids: number[] = [];
  const previousFauxScript = process.env.PI_VIGIL_FAUX_SCRIPT;
  const previousSessionDir = process.env.PI_VIGIL_SESSION_DIR;
  const previousBootstrapRunner = process.env.PI_VIGIL_FAUX_BOOTSTRAP_RUNNER;

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

    if (previousBootstrapRunner !== undefined) {
      process.env.PI_VIGIL_FAUX_BOOTSTRAP_RUNNER = previousBootstrapRunner;
    } else {
      delete process.env.PI_VIGIL_FAUX_BOOTSTRAP_RUNNER;
    }
  });

  afterAll(() => {
    resetVigilRuntimeOverrides();
  });

  async function setupFauxHarness(script: VigilFauxScript) {
    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-nesting-cwd-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-nesting-sessions-"));
    scriptDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-faux-nesting-script-"));

    const scriptPath = writeVigilFauxScript(scriptDir, script);
    process.env.PI_VIGIL_FAUX_SCRIPT = scriptPath;
    process.env.PI_VIGIL_SESSION_DIR = sessionDir;
    process.env.PI_VIGIL_FAUX_BOOTSTRAP_RUNNER = "1";

    setVigilRuntimeOverrides({
      processRunner: createVigilFauxProcessRunner({ loadLocalVigil: true }),
      sessionDir,
    });

    return createVigilTestHarness({ cwd: tempCwd });
  }

  async function waitForChildSettled(harness: Awaited<ReturnType<typeof setupFauxHarness>>, id: string) {
    const waitResult = await harness.execute({
      action: "wait",
      id,
      timeoutMs: 30_000,
      initialDelayMs: 100,
      maxDelayMs: 1_000,
    });

    expect((waitResult as { isError?: boolean }).isError).toBeFalsy();
    const waitDetails = waitResult.details as VigilWaitResult;
    expect(waitDetails.outcome).toBe("settled");
    return waitDetails;
  }

  it("rejects nested launch by default and keeps direct subagents empty on the parent list", async () => {
    const denyMarker = `VIGIL_FAUX_DENY_${crypto.randomUUID()}`;
    const harness = await setupFauxHarness({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: denyMarker },
          then: {
            type: "toolCall",
            name: "vigil",
            arguments: {
              action: "launch",
              name: "Blocked grandchild",
              message: "This nested launch should be denied.",
              model: getVigilFauxModelId(),
            },
          },
        },
        {
          when: { userTextIncludes: denyMarker },
          then: { type: "text", text: "nested launch attempt finished" },
        },
      ],
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Default-deny nesting child",
      message: `Attempt nested launch with marker ${denyMarker}`,
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

    const waitDetails = await waitForChildSettled(harness, launched.id);
    if (waitDetails.outcome === "settled") {
      const snapshot = waitDetails.settled.find((item) => item.id === launched.id);
      expect(snapshot?.state).toBe("waiting");
      expect(snapshot?.latestResponse).toContain("nested launch attempt finished");
    }

    const searchResult = await harness.execute({
      action: "search",
      id: launched.id,
      query: NESTED_LAUNCH_DISABLED_ERROR,
      model: "openai-codex/gpt-5.5",
    });
    expect((searchResult as { isError?: boolean }).isError).toBeFalsy();
    const searchDetails = searchResult.details as VigilSearchResult;
    expect(searchDetails.matches.length).toBeGreaterThan(0);
    expect((searchResult.content[0] as { text?: string }).text).toContain(NESTED_LAUNCH_DISABLED_ERROR);

    const listResult = await harness.execute({ action: "list" });
    expect((listResult as { isError?: boolean }).isError).toBeFalsy();
    const listed = listResult.details as VigilListResult;
    const listedChild = listed.vigils.find((item) => item.id === launched.id);
    expect(listedChild?.directSubagents).toEqual(
      expect.objectContaining({ inspection: "available", total: 0, incomplete: 0 }),
    );
  });

  it("allows nested launch when allowSubagents is true and exposes the grandchild on parent list", async () => {
    const childMarker = `VIGIL_FAUX_ALLOW_${crypto.randomUUID()}`;
    const grandchildMarker = `VIGIL_FAUX_GRAND_${crypto.randomUUID()}`;
    const grandchildName = "Allowed grandchild";
    const harness = await setupFauxHarness({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: childMarker },
          then: {
            type: "toolCall",
            name: "vigil",
            arguments: {
              action: "launch",
              name: grandchildName,
              message: `Settle the grandchild with marker ${grandchildMarker}`,
              model: getVigilFauxModelId(),
            },
          },
        },
        {
          when: { userTextIncludes: childMarker },
          then: { type: "text", text: "nested launch accepted" },
        },
        {
          when: { userTextIncludes: grandchildMarker },
          then: { type: "text", text: grandchildMarker },
        },
      ],
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Allow-nesting child",
      message: `Launch a nested child with marker ${childMarker}`,
      model: getVigilFauxModelId(),
      cwd: tempCwd,
      allowSubagents: true,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;
    expect(launched.state).toBe("running");

    const launchRecord = harness.capturedEntries.find((entry) => entry.customType === "vigil-launch")
      ?.data as VigilLaunchRecord;
    expect(launchRecord?.pid).toBeTruthy();
    expect(launchRecord.allowSubagents).toBeUndefined();
    launchedChildPids.push(launchRecord.pid);

    const waitDetails = await waitForChildSettled(harness, launched.id);
    if (waitDetails.outcome === "settled") {
      const snapshot = waitDetails.settled.find((item) => item.id === launched.id);
      expect(snapshot?.state).toBe("waiting");
      expect(snapshot?.latestResponse).toContain("nested launch accepted");
    }

    const listResult = await harness.execute({ action: "list" });
    expect((listResult as { isError?: boolean }).isError).toBeFalsy();
    const listed = listResult.details as VigilListResult;
    const listedChild = listed.vigils.find((item) => item.id === launched.id);
    expect(listedChild?.directSubagents).toEqual(
      expect.objectContaining({
        inspection: "available",
        total: 1,
        incomplete: 1,
      }),
    );
    if (listedChild?.directSubagents?.inspection === "available") {
      expect(listedChild.directSubagents.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: grandchildName,
          }),
        ]),
      );
    }
    expect((listResult.content[0] as { text?: string }).text).toContain(grandchildName);
  });
});
