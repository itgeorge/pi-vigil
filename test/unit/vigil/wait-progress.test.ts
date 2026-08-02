import { describe, expect, it } from "vitest";
import {
  boundWaitProgressItems,
  fingerprintWaitProgress,
  formatWaitProgressText,
  MAX_WAIT_PROGRESS_ITEMS,
} from "../../../src/vigil/wait-progress";

describe("wait progress formatting", () => {
  it("formats a concise header and child line with relative last activity", () => {
    const progress = {
      waitedMs: 15_000,
      nextPollInMs: 4_000,
      items: [
        {
          id: "vigil-abcd",
          name: "Slice 4 implementation",
          state: "running" as const,
          steps: 12,
          messages: 7,
          lastActivity: "tool result: bash",
          lastActivityTimestamp: "2026-08-01T12:00:12.000Z",
        },
      ],
      omittedItemCount: 0,
    };

    const text = formatWaitProgressText(progress, Date.parse("2026-08-01T12:00:15.000Z"));
    expect(text).toContain("elapsed 15s · next poll ≤4s");
    expect(text).toContain("Slice 4 implementation [vigil-abcd] — running");
    expect(text).toContain("steps: 12 · messages: 7");
    expect(text).toContain("last: tool result: bash (3s ago)");
  });

  it("truncates unusually long names and activity metadata to a single safe line", () => {
    const longName = `${"N".repeat(200)}\nhidden`;
    const longActivity = `${"A".repeat(200)}\nhidden`;
    const progress = {
      waitedMs: 0,
      nextPollInMs: 500,
      items: [
        {
          id: "vigil-long",
          name: longName,
          state: "running" as const,
          steps: 1,
          messages: 1,
          lastActivity: longActivity,
          lastActivityTimestamp: null,
        },
      ],
      omittedItemCount: 0,
    };

    const line = formatWaitProgressText(progress, Date.now());
    expect(line).not.toContain("\nhidden");
    expect(line).toContain("[truncated]");
  });

  it("bounds the number of child lines and reports omitted count", () => {
    const items = Array.from({ length: MAX_WAIT_PROGRESS_ITEMS + 3 }, (_, index) => ({
      id: `vigil-${index}`,
      name: `Task ${index}`,
      state: "running" as const,
      steps: index,
      messages: index,
      lastActivity: null,
      lastActivityTimestamp: null,
    }));
    const bounded = boundWaitProgressItems(items);
    expect(bounded.items).toHaveLength(MAX_WAIT_PROGRESS_ITEMS);
    expect(bounded.omittedItemCount).toBe(3);

    const text = formatWaitProgressText(
      { waitedMs: 0, nextPollInMs: 100, items: bounded.items, omittedItemCount: bounded.omittedItemCount },
      Date.now(),
    );
    expect(text).toContain("… and 3 more children omitted");
  });
});

describe("wait progress fingerprint", () => {
  it("changes when persisted activity facts change", () => {
    const base = [{ id: "vigil-a", state: "running" as const, steps: 1, messages: 1, lastActivity: "user message", lastActivityTimestamp: "t1" }];
    const changedSteps = [{ ...base[0], steps: 2 }];
    expect(fingerprintWaitProgress(base)).not.toBe(fingerprintWaitProgress(changedSteps));
  });
});
