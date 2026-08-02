import { describe, expect, it } from "vitest";
import {
  boundWaitProgressItems,
  computeNextPollInMs,
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
          recentMessages: [],
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

  it("truncates unusually long names, ids, and activity metadata to a single safe line", () => {
    const longName = `${"N".repeat(200)}\nhidden`;
    const longId = `${"I".repeat(200)}\nhidden-id`;
    const longActivity = `${"A".repeat(200)}\nhidden`;
    const progress = {
      waitedMs: 0,
      nextPollInMs: 500,
      items: [
        {
          id: longId,
          name: longName,
          state: "running" as const,
          steps: 1,
          messages: 1,
          lastActivity: longActivity,
          lastActivityTimestamp: null,
          recentMessages: [],
        },
      ],
      omittedItemCount: 0,
    };

    const line = formatWaitProgressText(progress, Date.now());
    expect(line).not.toContain("\nhidden");
    expect(line).not.toContain("\nhidden-id");
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
      recentMessages: [],
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

  it("renders recent message previews under each child line when present", () => {
    const progress = {
      waitedMs: 5_000,
      nextPollInMs: 2_000,
      items: [
        {
          id: "vigil-abcd",
          name: "Slice 4 implementation",
          state: "running" as const,
          steps: 12,
          messages: 7,
          lastActivity: "tool result: bash",
          lastActivityTimestamp: "2026-08-01T12:00:12.000Z",
          recentMessages: [
            { label: "assistant", excerpt: "I'm adding transcript bounds and tests" },
            { label: "tool result", excerpt: "172 tests passed" },
            { label: "user", excerpt: "Apply the final renderer correction" },
          ],
        },
      ],
      omittedItemCount: 0,
    };

    const text = formatWaitProgressText(progress, Date.parse("2026-08-01T12:00:15.000Z"));
    expect(text).toContain("Slice 4 implementation [vigil-abcd] — running");
    expect(text).toContain("  recent:");
    expect(text).toContain('    assistant: "I\'m adding transcript bounds and tests"');
    expect(text).toContain('    tool result: "172 tests passed"');
    expect(text).toContain('    user: "Apply the final renderer correction"');
  });

  it("omits the recent section when a child has no message previews", () => {
    const progress = {
      waitedMs: 0,
      nextPollInMs: 500,
      items: [
        {
          id: "vigil-empty",
          name: "Empty child",
          state: "running" as const,
          steps: 0,
          messages: 0,
          lastActivity: null,
          lastActivityTimestamp: null,
          recentMessages: [],
        },
      ],
      omittedItemCount: 0,
    };

    const text = formatWaitProgressText(progress, Date.now());
    expect(text).not.toContain("recent:");
  });
});

describe("computeNextPollInMs", () => {
  it("uses the initial delay before the first sleep", () => {
    expect(
      computeNextPollInMs({
        delayMs: 500,
        maxDelayMs: 5_000,
        remainingMs: 10_000,
        afterCompletedSleep: false,
        willPollAgain: true,
      }),
    ).toBe(500);
  });

  it("uses the doubled capped delay after a completed sleep", () => {
    expect(
      computeNextPollInMs({
        delayMs: 500,
        maxDelayMs: 700,
        remainingMs: 1_300,
        afterCompletedSleep: true,
        willPollAgain: true,
      }),
    ).toBe(700);
  });

  it("truncates the forthcoming delay to remaining timeout budget", () => {
    expect(
      computeNextPollInMs({
        delayMs: 200,
        maxDelayMs: 200,
        remainingMs: 50,
        afterCompletedSleep: true,
        willPollAgain: true,
      }),
    ).toBe(50);
  });

  it("returns zero when no subsequent poll will occur", () => {
    expect(
      computeNextPollInMs({
        delayMs: 500,
        maxDelayMs: 5_000,
        remainingMs: 10_000,
        afterCompletedSleep: true,
        willPollAgain: false,
      }),
    ).toBe(0);
  });
});

describe("wait progress fingerprint", () => {
  const baseItem = {
    id: "vigil-a",
    state: "running" as const,
    steps: 1,
    messages: 1,
    lastActivity: "user message",
    lastActivityTimestamp: "t1",
    recentMessages: [] as { label: string; excerpt: string }[],
  };

  it("changes when persisted activity facts change", () => {
    const base = [baseItem];
    const changedSteps = [{ ...baseItem, steps: 2 }];
    expect(fingerprintWaitProgress(base)).not.toBe(fingerprintWaitProgress(changedSteps));
  });

  it("changes when recent message previews change", () => {
    const base = [baseItem];
    const changedRecent = [
      {
        ...baseItem,
        recentMessages: [{ label: "user", excerpt: "new message" }],
      },
    ];
    expect(fingerprintWaitProgress(base)).not.toBe(fingerprintWaitProgress(changedRecent));
  });
});
