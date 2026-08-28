import { afterEach, describe, expect, it } from "vitest";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import { createFakePersistedBootstrapObserver } from "../../../src/vigil/persisted-bootstrap-observer";
import { createDeterministicTestTheme } from "../../helpers/test-theme";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

describe("vigil extension adapter dontNotify", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  const testTheme = createDeterministicTestTheme();

  function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, "");
  }

  it("rejects dontNotify on non-launch/send actions", async () => {
    const harness = await createVigilTestHarness();

    const pollResult = await harness.execute({ action: "poll", id: "vigil-a", dontNotify: true });
    expect((pollResult as { isError?: boolean }).isError).toBe(true);
    expect(pollResult.content[0]).toEqual({
      type: "text",
      text: "dontNotify is only valid for launch and send",
    });
  });

  it("accepts dontNotify on launch and stamps the ledger", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const bootstrapObserver = createFakePersistedBootstrapObserver();

    setVigilRuntimeOverrides({
      descendantInspector: createZeroDescendantInspector(),
      persistedBootstrapObserver: bootstrapObserver,
      processRunner: {
        spawnDetached: async () => ({ pid: 5151 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      bootstrapFailFastTimeoutMs: 100,
    });

    const result = await harness.execute({
      action: "launch",
      name: "Silent child",
      message: "Work",
      model: "openai-codex/gpt-5.5",
      dontNotify: true,
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(harness.capturedEntries[0]?.data).toEqual(
      expect.objectContaining({
        dontNotify: true,
      }),
    );

    const rendered = stripAnsi(
      harness.tool
        .renderCall!(
          { action: "launch", name: "Silent child", dontNotify: true },
          testTheme,
          {
            lastComponent: undefined,
            args: { action: "launch", name: "Silent child", dontNotify: true },
          } as never,
        )
        .render(120)
        .join("\n"),
    );
    expect(rendered).toContain("no notify");
  });

  it("accepts dontNotify on send and stamps the turn record", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const bootstrapObserver = createFakePersistedBootstrapObserver();

    setVigilRuntimeOverrides({
      descendantInspector: createZeroDescendantInspector(),
      persistedBootstrapObserver: bootstrapObserver,
      processRunner: {
        spawnDetached: async () => ({ pid: 5151 }),
        isAlive: () => true,
        terminateAndWait: async () => undefined,
      },
      bootstrapFailFastTimeoutMs: 100,
      childSessionReader: {
        readChildSessionState: async () => ({
          latestResponse: "First answer.",
          turnComplete: true,
          lastConversationTimestamp: "2099-01-01T00:00:00.000Z",
          activity: { steps: 0, messages: 0, lastActivity: null, lastActivityTimestamp: null, recentMessages: [] },
        }),
      },
    });

    const launchResult = await harness.execute({
      action: "launch",
      name: "Continue work",
      message: "Start work",
      model: "openai-codex/gpt-5.5",
    });
    const launched = launchResult.details as { id: string };

    const sendResult = await harness.execute({
      action: "send",
      id: launched.id,
      message: "Continue the work",
      model: "openai-codex/gpt-5.5",
      dontNotify: true,
    });

    expect((sendResult as { isError?: boolean }).isError).toBeFalsy();
    const turnEntry = harness.capturedEntries.find((entry) => entry.customType === "vigil-turn");
    expect(turnEntry?.data).toEqual(
      expect.objectContaining({
        dontNotify: true,
      }),
    );
  });
});
