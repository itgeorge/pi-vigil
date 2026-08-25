import { describe, expect, it } from "vitest";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

describe("vigil extension nesting policy session_start", () => {
  it("registers the vigil-no-subagents flag as a boolean with default false", async () => {
    const harness = await createVigilTestHarness({ skipSessionStart: true });

    expect(harness.registeredFlags).toEqual(
      expect.arrayContaining([
        {
          name: "vigil-no-subagents",
          options: {
            description:
              "Deny Vigil nested launch in this session (stamped into vigil-policy on session_start)",
            type: "boolean",
            default: false,
          },
        },
      ]),
    );
  });

  it("appends a deny vigil-policy entry on session_start when the flag is set and no valid policy exists", async () => {
    const harness = await createVigilTestHarness({ skipSessionStart: true, noSubagentsFlag: true });

    await harness.emitExtensionEvent("session_start");

    expect(harness.capturedEntries).toContainEqual({
      customType: "vigil-policy",
      data: { allowSubagents: false },
    });
    expect(
      harness.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "vigil-policy"),
    ).toHaveLength(1);
  });

  it("does not append vigil-policy on session_start when a valid policy entry already exists", async () => {
    const harness = await createVigilTestHarness({ skipSessionStart: true, noSubagentsFlag: true });
    harness.sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: true });

    await harness.emitExtensionEvent("session_start");

    expect(harness.capturedEntries.filter((entry) => entry.customType === "vigil-policy")).toHaveLength(0);
    expect(
      harness.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "vigil-policy"),
    ).toHaveLength(1);
  });

  it("does not append vigil-policy on session_start when only malformed policy entries exist", async () => {
    const harness = await createVigilTestHarness({ skipSessionStart: true, noSubagentsFlag: true });
    harness.sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: "no" });
    harness.sessionManager.appendCustomEntry("vigil-policy", null);

    await harness.emitExtensionEvent("session_start");

    expect(harness.capturedEntries).toContainEqual({
      customType: "vigil-policy",
      data: { allowSubagents: false },
    });
  });
});
