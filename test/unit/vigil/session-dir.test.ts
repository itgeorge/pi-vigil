import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getVigilSessionDir } from "../../../src/vigil/config";
import { buildPiChildArgs } from "../../../src/vigil/node-runtime";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import type { SpawnChildInput } from "../../../src/vigil/ports";
import type { VigilLaunchRecord } from "../../../src/vigil/types";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

describe("vigil session directory configuration", () => {
  const previousSessionDir = process.env.PI_VIGIL_SESSION_DIR;

  afterEach(() => {
    resetVigilRuntimeOverrides();
    if (previousSessionDir === undefined) {
      delete process.env.PI_VIGIL_SESSION_DIR;
    } else {
      process.env.PI_VIGIL_SESSION_DIR = previousSessionDir;
    }
  });

  it("reads PI_VIGIL_SESSION_DIR at execution time for launch records and child args", async () => {
    process.env.PI_VIGIL_SESSION_DIR = "/tmp/vigil-session-dir-at-runtime";
    expect(getVigilSessionDir()).toBe("/tmp/vigil-session-dir-at-runtime");

    const spawnInputs: SpawnChildInput[] = [];
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });

    setVigilRuntimeOverrides({
      processRunner: {
        spawnDetached: async (input) => {
          spawnInputs.push(input);
          return { pid: 9090 };
        },
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
    });

    const result = await harness.execute({
      action: "launch",
      message: "Inspect the repository",
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(spawnInputs).toHaveLength(1);
    expect(spawnInputs[0]?.sessionDir).toBe("/tmp/vigil-session-dir-at-runtime");
    expect(buildPiChildArgs(spawnInputs[0]!)).toContain("--session-dir");

    const record = harness.capturedEntries[0]?.data as VigilLaunchRecord;
    expect(record.sessionDir).toBe("/tmp/vigil-session-dir-at-runtime");
  });
});

describe("vigil child session lookup by configured session dir", () => {
  it("finds fixture sessions when the configured session directory matches", async () => {
    const fixturesDir = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(fixturesDir, "../../fixtures/child-session-with-assistant.jsonl");
    const sessionDir = path.dirname(fixturePath);
    const sessionId = "vigil-fixture-session-001";

    const { findChildSessionPath, readLatestAssistantTextFromFile } = await import("../../../src/vigil/node-runtime");

    await expect(findChildSessionPath(sessionId, "/tmp/vigil-fixture-cwd", sessionDir)).resolves.toBe(fixturePath);
    expect(readLatestAssistantTextFromFile(fixturePath)).toBe("Hello from the child session.");
  });
});
