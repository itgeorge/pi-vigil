import { afterEach, describe, expect, it } from "vitest";
import { resetVigilRuntimeOverrides, setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides";
import { createFakeEphemeralChildObserver } from "../../../src/vigil/ephemeral-observer";
import { createZeroDescendantInspector } from "../../../src/vigil/descendant-inspector";
import { formatMutationSnapshotText, type VigilSnapshot } from "../../../src/vigil/types";
import { createDeterministicTestTheme } from "../../helpers/test-theme";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

describe("vigil extension adapter ephemeral", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  const testTheme = createDeterministicTestTheme();

  function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, "");
  }

  it("rejects ephemeral on non-launch actions", async () => {
    const harness = await createVigilTestHarness();
    const result = await harness.execute({ action: "poll", id: "vigil-a", ephemeral: true });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "ephemeral is only valid for launch",
    });
  });

  it("launch with ephemeral returns compact receipt and starts fake observer", async () => {
    const observer = createFakeEphemeralChildObserver();
    setVigilRuntimeOverrides({
      descendantInspector: createZeroDescendantInspector(),
      ephemeralChildObserver: observer,
      processRunner: {
        spawnDetached: async () => {
          throw new Error("persisted spawn must not run");
        },
        isAlive: () => false,
        terminateAndWait: async () => undefined,
      },
    });

    const harness = await createVigilTestHarness();
    const result = await harness.execute({
      action: "launch",
      name: "Ephemeral task",
      message: "Reply OK",
      model: "openai-codex/gpt-5.5",
      ephemeral: true,
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const snapshot = result.details as VigilSnapshot;
    expect(snapshot.ephemeral).toBe(true);
    expect(result.content[0]).toEqual({
      type: "text",
      text: formatMutationSnapshotText(snapshot),
    });
    expect((result.content[0] as { text?: string }).text).not.toContain("latestResponse:");
    expect(observer.started).toHaveLength(1);

    const rendered = stripAnsi(
      harness.tool
        .renderCall!(
          { action: "launch", name: "Ephemeral task", ephemeral: true },
          testTheme,
          { lastComponent: undefined, args: { action: "launch", name: "Ephemeral task", ephemeral: true } } as never,
        )
        .render(120)
        .join("\n"),
    );
    expect(rendered).toContain("ephemeral");
  });
});
