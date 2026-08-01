import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetVigilRuntimeOverrides } from "../../src/vigil/runtime-overrides";
import { findChildSessionPath, readLatestAssistantTextFromFile } from "../../src/vigil/node-runtime";
import type { VigilSnapshot } from "../../src/vigil/types";
import { createVigilTestHarness } from "../helpers/vigil-test-harness";
import {
  getAcceptancePollIntervalMs,
  getAcceptanceTimeoutMs,
  getVigilTestModel,
  requireLiveAcceptanceEnv,
  verifyPiAuthentication,
} from "./live-prereq";

describe("live vigil acceptance", () => {
  let tempCwd = "";
  let sessionDir = "";

  beforeAll(() => {
    requireLiveAcceptanceEnv();
    verifyPiAuthentication();
    tempCwd = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-live-"));
    sessionDir = mkdtempSync(path.join(os.tmpdir(), "pi-vigil-live-sessions-"));
    process.env.PI_VIGIL_SESSION_DIR = sessionDir;
  });

  afterAll(() => {
    resetVigilRuntimeOverrides();
    delete process.env.PI_VIGIL_SESSION_DIR;
    if (tempCwd) {
      rmSync(tempCwd, { recursive: true, force: true });
    }
    if (sessionDir) {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("launches a real child session and polls until waiting with the expected marker", async () => {
    const marker = `VIGIL_READY_${crypto.randomUUID()}`;
    const harness = await createVigilTestHarness({ cwd: tempCwd });

    const launchResult = await harness.execute({
      action: "launch",
      message: `Reply with exactly: ${marker}`,
      model: getVigilTestModel(),
      cwd: tempCwd,
    });

    expect((launchResult as { isError?: boolean }).isError).toBeFalsy();
    const launched = launchResult.details as VigilSnapshot;
    expect(launched.id).toMatch(/^vigil-/);
    expect(launched.state).toBe("running");

    const deadline = Date.now() + getAcceptanceTimeoutMs();
    let finalSnapshot: VigilSnapshot | undefined;

    while (Date.now() < deadline) {
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
    expect(finalSnapshot?.latestResponse).toContain(marker);

    const childSessionPath = await findChildSessionPath(launched.sessionId, tempCwd, sessionDir);
    expect(childSessionPath).toBeTruthy();
    const persistedText = readLatestAssistantTextFromFile(childSessionPath!);
    expect(persistedText).toContain(marker);
  }, getAcceptanceTimeoutMs() + 30_000);
});
