import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  buildVigilDisplayNameIndex,
  formatVigilCallSummary,
  formatVigilShortId,
  renderVigilCallText,
  sanitizeCallField,
} from "../../../src/vigil/render-call";
import type { VigilCallArgs } from "../../../src/vigil/render-call";
import { createDeterministicTestTheme } from "../../helpers/test-theme";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

const testTheme = createDeterministicTestTheme();

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const SAMPLE_UUID = "vigil-bd02f54e-1234-5678-abcd-ef0123456789";

function lookupFrom(entries: ReturnType<SessionManager["getBranch"]>) {
  return buildVigilDisplayNameIndex(entries);
}

function plainSummary(args: VigilCallArgs, entries: ReturnType<SessionManager["getBranch"]> = []) {
  return formatVigilCallSummary(args, lookupFrom(entries));
}

function renderPlainText(args: VigilCallArgs, entries: ReturnType<SessionManager["getBranch"]> = []) {
  const component = renderVigilCallText(args, testTheme, lookupFrom(entries));
  return stripAnsi(component.render(120).join("\n").trim());
}

function renderHarnessCall(
  harness: Awaited<ReturnType<typeof createVigilTestHarness>>,
  args: VigilCallArgs,
) {
  const component = harness.tool.renderCall!(args, testTheme, {
    lastComponent: undefined,
    args,
  } as never);
  return stripAnsi(component.render(120).join("\n").trim());
}

describe("formatVigilShortId", () => {
  it("preserves the vigil- prefix and first seven UUID hex characters", () => {
    expect(formatVigilShortId(SAMPLE_UUID)).toBe("vigil-bd02f54");
  });

  it("leaves already-short ids unchanged when the suffix fits", () => {
    expect(formatVigilShortId("vigil-abcd")).toBe("vigil-abcd");
  });
});

describe("formatVigilCallSummary", () => {
  it("renders launch with name and an explicitly supplied model", () => {
    expect(
      plainSummary({
        action: "launch",
        name: "Slice 4.5 implementation",
        message: "hidden prompt",
        model: "cursor/composer-2.5-fast",
      }),
    ).toBe("launch · Slice 4.5 implementation · model cursor/composer-2.5-fast");
  });

  it("renders launch with model Pi default when model was omitted", () => {
    expect(
      plainSummary({
        action: "launch",
        name: "Slice 4.5 implementation",
        message: "hidden prompt",
      }),
    ).toBe("launch · Slice 4.5 implementation · model Pi default");
  });

  it("renders poll, send, and complete with lifecycle display name plus short id", () => {
    const entries = [
      {
        type: "custom" as const,
        id: "entry-1",
        parentId: null,
        timestamp: "2026-08-01T10:00:00.000Z",
        customType: "vigil-launch",
        data: {
          id: SAMPLE_UUID,
          sessionId: SAMPLE_UUID,
          name: "Slice 4.5 implementation",
          pid: 100,
          cwd: "/parent/project",
          launchedAt: "2026-08-01T10:00:00.000Z",
        },
      },
    ];

    expect(plainSummary({ action: "poll", id: SAMPLE_UUID }, entries)).toBe(
      "poll · Slice 4.5 implementation [vigil-bd02f54]",
    );
    expect(
      plainSummary(
        { action: "send", id: SAMPLE_UUID, message: "Address reviewer feedback" },
        entries,
      ),
    ).toBe('send · Slice 4.5 implementation [vigil-bd02f54] — "Address reviewer feedback"');
    expect(plainSummary({ action: "complete", id: SAMPLE_UUID }, entries)).toBe(
      "complete · Slice 4.5 implementation [vigil-bd02f54]",
    );
  });

  it("uses the completed display name after completion is recorded", () => {
    const entries = [
      {
        type: "custom" as const,
        id: "entry-1",
        parentId: null,
        timestamp: "2026-08-01T10:00:00.000Z",
        customType: "vigil-launch",
        data: {
          id: SAMPLE_UUID,
          sessionId: SAMPLE_UUID,
          name: "Slice 4.5 implementation",
          pid: 100,
          cwd: "/parent/project",
          launchedAt: "2026-08-01T10:00:00.000Z",
        },
      },
      {
        type: "custom" as const,
        id: "entry-2",
        parentId: "entry-1",
        timestamp: "2026-08-01T12:00:00.000Z",
        customType: "vigil-complete",
        data: {
          id: SAMPLE_UUID,
          sessionId: SAMPLE_UUID,
          name: "[completed] Slice 4.5 implementation",
          cwd: "/parent/project",
          completedAt: "2026-08-01T12:00:00.000Z",
        },
      },
    ];

    expect(plainSummary({ action: "poll", id: SAMPLE_UUID }, entries)).toBe(
      "poll · [completed] Slice 4.5 implementation [vigil-bd02f54]",
    );
  });

  it("renders send message excerpt and model only when supplied", () => {
    const entries = [
      {
        type: "custom" as const,
        id: "entry-1",
        parentId: null,
        timestamp: "2026-08-01T10:00:00.000Z",
        customType: "vigil-launch",
        data: {
          id: SAMPLE_UUID,
          sessionId: SAMPLE_UUID,
          name: "Slice 4.5 implementation",
          pid: 100,
          cwd: "/parent/project",
          launchedAt: "2026-08-01T10:00:00.000Z",
        },
      },
    ];

    expect(
      plainSummary(
        {
          action: "send",
          id: SAMPLE_UUID,
          message: "Address reviewer feedback",
          model: "cursor/composer-2.5-fast",
        },
        entries,
      ),
    ).toBe(
      'send · Slice 4.5 implementation [vigil-bd02f54] — "Address reviewer feedback" · model cursor/composer-2.5-fast',
    );
  });

  it("differentiates active-only list from includeCompleted", () => {
    expect(plainSummary({ action: "list" })).toBe("list · active");
    expect(plainSummary({ action: "list", includeCompleted: true })).toBe("list · including completed");
  });

  it("renders wait timeout and progress mode using documented defaults", () => {
    expect(plainSummary({ action: "wait" })).toBe("wait · up to 60s · progress status");
    expect(
      plainSummary({
        action: "wait",
        timeoutMs: 120_000,
        progress: "none",
      }),
    ).toBe("wait · up to 120s · progress none");
  });

  it("falls back safely for unknown or malformed ids without throwing", () => {
    expect(plainSummary({ action: "poll", id: "vigil-missing" })).toBe("poll · [vigil-missing]");
    expect(plainSummary({ action: "poll", id: "not-a-vigil-id" })).toBe("poll · [not-a-vigil-id]");
    expect(() => plainSummary({ action: "poll", id: "" })).not.toThrow();
  });

  it("keeps long or newline-containing values on one bounded line", () => {
    const longName = `${"N".repeat(200)}\nhidden name`;
    const longMessage = `${"M".repeat(200)}\nhidden message`;
    const summary = plainSummary({
      action: "launch",
      name: longName,
      message: "prompt",
      model: `${"X".repeat(200)}\nhidden model`,
    });
    expect(summary).not.toContain("\n");
    expect(summary).toContain("[truncated]");
    expect(summary).toContain("launch ·");

    const sendSummary = plainSummary({
      action: "send",
      id: `${"I".repeat(200)}\nhidden`,
      message: longMessage,
    });
    expect(sendSummary).not.toContain("\nhidden");
    expect(sendSummary).toContain("[truncated]");
  });
});

describe("renderVigilCallText", () => {
  it("styles the vigil title and reuses the last Text component", () => {
    const first = renderVigilCallText(
      { action: "launch", name: "Task", message: "go" },
      testTheme,
      new Map(),
    );
    expect(first).toBeInstanceOf(Text);

    const second = renderVigilCallText(
      { action: "launch", name: "Task", message: "go", model: "openai/gpt" },
      testTheme,
      new Map(),
      first,
    );
    expect(second).toBe(first);

    const rendered = renderPlainText({ action: "launch", name: "Task", message: "go" });
    expect(rendered).toContain("vigil");
    expect(rendered).toContain("launch · Task · model Pi default");
  });

  it("returns a safe fallback header for incomplete arguments", () => {
    const rendered = renderPlainText({ action: "launch" } as VigilCallArgs);
    expect(rendered).toContain("vigil");
    expect(rendered).toContain("launch");
  });
});

describe("vigil renderCall integration", () => {
  it("hydrates the display-name cache from resumed session entries on session_start", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    harness.sessionManager.appendCustomEntry("vigil-launch", {
      id: SAMPLE_UUID,
      sessionId: SAMPLE_UUID,
      name: "Resumed child",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });

    await harness.emitExtensionEvent("session_start");

    const rendered = renderHarnessCall(harness, { action: "poll", id: SAMPLE_UUID });
    expect(rendered).toContain("Resumed child");
    expect(rendered).toContain("[vigil-bd02f54]");
  });

  it("rebuilds the cache from the active branch on session_tree", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const rootId = harness.sessionManager.appendCustomEntry("marker", { marker: true });
    const branchAEntryId = harness.sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-branch-a",
      sessionId: "vigil-branch-a",
      name: "Branch A child",
      pid: 100,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T10:00:00.000Z",
    });

    harness.sessionManager.branch(rootId);
    harness.sessionManager.appendCustomEntry("vigil-launch", {
      id: "vigil-branch-b",
      sessionId: "vigil-branch-b",
      name: "Branch B child",
      pid: 200,
      cwd: "/parent/project",
      launchedAt: "2026-08-01T11:00:00.000Z",
    });

    await harness.emitExtensionEvent("session_tree");

    const branchB = renderHarnessCall(harness, { action: "poll", id: "vigil-branch-b" });
    expect(branchB).toContain("Branch B child");
    expect(branchB).not.toContain("Branch A child");

    harness.sessionManager.branch(branchAEntryId);
    await harness.emitExtensionEvent("session_tree");

    const branchA = renderHarnessCall(harness, { action: "poll", id: "vigil-branch-a" });
    expect(branchA).toContain("Branch A child");
    expect(branchA).not.toContain("Branch B child");
  });

  it("does not append ledger entries or execute tool services when rendering", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const appendCount = harness.capturedEntries.length;

    expect(harness.tool.renderCall).toBeDefined();
    harness.tool.renderCall!(
      { action: "poll", id: "vigil-missing" },
      testTheme,
      { lastComponent: undefined, args: { action: "poll", id: "vigil-missing" } } as never,
    );

    expect(harness.capturedEntries).toHaveLength(appendCount);
  });
});

describe("buildVigilDisplayNameIndex", () => {
  it("ignores malformed lifecycle records without corrupting valid names", () => {
    const entries = [
      {
        type: "custom" as const,
        id: "bad",
        parentId: null,
        timestamp: "t",
        customType: "vigil-launch",
        data: { id: "broken" },
      },
      {
        type: "custom" as const,
        id: "good",
        parentId: null,
        timestamp: "t",
        customType: "vigil-launch",
        data: {
          id: "vigil-valid",
          sessionId: "vigil-valid",
          name: "Valid",
          pid: 1,
          cwd: "/t",
          launchedAt: "t",
        },
      },
    ];

    const index = buildVigilDisplayNameIndex(entries);
    expect([...index.entries()]).toEqual([["vigil-valid", "Valid"]]);
  });
});

describe("sanitizeCallField", () => {
  it("collapses whitespace and truncates with a marker", () => {
    expect(sanitizeCallField("  hello\nworld  ")).toBe("hello world");
    expect(sanitizeCallField("x".repeat(200))).toContain("[truncated]");
  });
});
