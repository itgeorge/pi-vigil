import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  formatNestedLaunchDisabledError,
  NESTED_LAUNCH_DISABLED_ERROR,
  resolveNestedLaunchAllowed,
} from "../../../src/vigil/nesting-policy";

describe("nesting policy resolution", () => {
  it("allows nested launch when there are no policy entries and no flag", () => {
    expect(resolveNestedLaunchAllowed({ entries: [], noSubagentsFlag: false })).toBe(true);
    expect(resolveNestedLaunchAllowed({ entries: [] })).toBe(true);
  });

  it("denies nested launch when a valid deny policy entry exists", () => {
    const sessionManager = SessionManager.inMemory("/child/session");
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: false });

    expect(resolveNestedLaunchAllowed({ entries: sessionManager.getEntries() })).toBe(false);
  });

  it("denies nested launch when only the no-subagents flag is set", () => {
    expect(resolveNestedLaunchAllowed({ entries: [], noSubagentsFlag: true })).toBe(false);
  });

  it("allows nested launch when policy entries are malformed", () => {
    const sessionManager = SessionManager.inMemory("/child/session");
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: "no" });
    sessionManager.appendCustomEntry("vigil-policy", null);
    sessionManager.appendCustomEntry("other-type", { allowSubagents: false });

    expect(resolveNestedLaunchAllowed({ entries: sessionManager.getEntries() })).toBe(true);
  });

  it("denies nested launch when the first valid policy entry is deny even if a later entry allows", () => {
    const sessionManager = SessionManager.inMemory("/child/session");
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: false });
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: true });

    expect(resolveNestedLaunchAllowed({ entries: sessionManager.getEntries() })).toBe(false);
  });

  it("allows nested launch when the first valid policy entry is allow even if a later entry denies", () => {
    const sessionManager = SessionManager.inMemory("/child/session");
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: true });
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: false });

    expect(resolveNestedLaunchAllowed({ entries: sessionManager.getEntries() })).toBe(true);
  });

  it("allows nested launch when a valid allow policy entry beats the no-subagents flag", () => {
    const sessionManager = SessionManager.inMemory("/child/session");
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: true });

    expect(
      resolveNestedLaunchAllowed({ entries: sessionManager.getEntries(), noSubagentsFlag: true }),
    ).toBe(true);
  });

  it("denies nested launch when malformed entries precede a valid deny policy entry", () => {
    const sessionManager = SessionManager.inMemory("/child/session");
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: "no" });
    sessionManager.appendCustomEntry("vigil-policy", null);
    sessionManager.appendCustomEntry("vigil-policy", { allowSubagents: false });

    expect(resolveNestedLaunchAllowed({ entries: sessionManager.getEntries() })).toBe(false);
  });

  it("formats the locked nested launch disabled error", () => {
    expect(formatNestedLaunchDisabledError()).toBe(NESTED_LAUNCH_DISABLED_ERROR);
    expect(NESTED_LAUNCH_DISABLED_ERROR).toBe(
      "Vigil nested launch is disabled for this session. Launch with allowSubagents: true from the parent if nesting is intended.",
    );
  });
});
