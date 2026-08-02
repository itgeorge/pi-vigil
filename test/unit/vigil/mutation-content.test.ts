import { describe, expect, it } from "vitest";
import { formatMutationSnapshotText, formatSnapshotText, type VigilSnapshot } from "../../../src/vigil/types";

const LONG_RESPONSE = `RESPONSE_${"x".repeat(10_000)}`;

function baseSnapshot(overrides: Partial<VigilSnapshot> = {}): VigilSnapshot {
  return {
    id: "vigil-bd02f54e-1234-5678-abcd-ef0123456789",
    sessionId: "vigil-bd02f54e-1234-5678-abcd-ef0123456789",
    name: "Research API",
    cwd: "/child/worktree",
    state: "running",
    latestResponse: null,
    ...overrides,
  };
}

describe("formatMutationSnapshotText", () => {
  it("includes only id, name, and state for launch/send running snapshots", () => {
    const snapshot = baseSnapshot();
    const text = formatMutationSnapshotText(snapshot);

    expect(text).toBe(
      [
        "id: vigil-bd02f54e-1234-5678-abcd-ef0123456789",
        "name: Research API",
        "state: running",
      ].join("\n"),
    );
    expect(text).not.toContain("sessionId:");
    expect(text).not.toContain("cwd:");
    expect(text).not.toContain("latestResponse:");
  });

  it("includes completedAt for complete snapshots and omits it for launch/send", () => {
    const completed = baseSnapshot({
      state: "completed",
      completedAt: "2026-08-01T12:00:00.000Z",
      latestResponse: "Done.",
      name: "[completed] Research API",
    });

    expect(formatMutationSnapshotText(completed)).toBe(
      [
        "id: vigil-bd02f54e-1234-5678-abcd-ef0123456789",
        "name: [completed] Research API",
        "state: completed",
        "completedAt: 2026-08-01T12:00:00.000Z",
      ].join("\n"),
    );
    expect(formatMutationSnapshotText(baseSnapshot({ state: "waiting" }))).not.toContain("completedAt:");
  });

  it("omits latestResponse even when it is extremely long", () => {
    const snapshot = baseSnapshot({
      state: "waiting",
      latestResponse: LONG_RESPONSE,
    });

    const text = formatMutationSnapshotText(snapshot);
    expect(text).not.toContain("latestResponse:");
    expect(text).not.toContain(LONG_RESPONSE.slice(0, 100));
  });

  it("leaves poll/wait observation formatting unchanged via formatSnapshotText", () => {
    const snapshot = baseSnapshot({
      state: "waiting",
      latestResponse: "Hello from the child session.",
    });

    const observation = formatSnapshotText(snapshot);
    expect(observation).toContain("sessionId:");
    expect(observation).toContain("cwd:");
    expect(observation).toContain("latestResponse: Hello from the child session.");
  });
});
