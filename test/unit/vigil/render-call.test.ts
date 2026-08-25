import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  buildVigilDisplayNameIndex,
  formatVigilCallExpandedArgs,
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

function renderPlainText(
  args: VigilCallArgs,
  entries: ReturnType<SessionManager["getBranch"]> = [],
  renderContext: { expanded?: boolean; lastComponent?: unknown } = {},
) {
  const component = renderVigilCallText(args, testTheme, lookupFrom(entries), renderContext as never);
  return stripAnsi(component.render(120).join("\n").trim());
}

function renderHarnessCall(
  harness: Awaited<ReturnType<typeof createVigilTestHarness>>,
  args: VigilCallArgs,
  renderContext: { expanded?: boolean; lastComponent?: unknown } = {},
) {
  const component = harness.tool.renderCall!(args, testTheme, {
    lastComponent: renderContext.lastComponent,
    expanded: renderContext.expanded ?? false,
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

  it("renders launch without model indicator when model was omitted", () => {
    expect(
      plainSummary({
        action: "launch",
        name: "Slice 4.5 implementation",
        message: "hidden prompt",
      }),
    ).toBe("launch · Slice 4.5 implementation");
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
    expect(
      plainSummary({ action: "complete", id: SAMPLE_UUID, allowIncompleteSubagents: true }, entries),
    ).toBe("complete · Slice 4.5 implementation [vigil-bd02f54] · allow incomplete subagents");
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

  it("renders send message excerpt and model when supplied explicitly", () => {
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

  it("renders send with the child lifecycle model when continuation model is omitted", () => {
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
          model: "cursor/composer-2.5-fast:high",
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
        },
        entries,
      ),
    ).toBe(
      'send · Slice 4.5 implementation [vigil-bd02f54] — "Address reviewer feedback" · model cursor/composer-2.5-fast:high',
    );
  });

  it("differentiates active-only list from includeCompleted", () => {
    expect(plainSummary({ action: "list" })).toBe("list · active");
    expect(plainSummary({ action: "list", includeCompleted: true })).toBe("list · including completed");
  });

  it("renders models with optional filter and maxResults", () => {
    expect(plainSummary({ action: "models" })).toBe("models");
    expect(plainSummary({ action: "models", query: "composer", maxResults: 10 })).toBe(
      "models · filter composer · max 10",
    );
  });

  it("renders wait timeout using documented defaults", () => {
    expect(plainSummary({ action: "wait" })).toBe("wait · up to 60s");
    expect(
      plainSummary({
        action: "wait",
        timeoutMs: 120_000,
      }),
    ).toBe("wait · up to 120s");
  });

  it("includes the targeted vigil id in wait summaries only when id is supplied", () => {
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
          name: "Target task",
          pid: 100,
          cwd: "/parent/project",
          launchedAt: "2026-08-01T10:00:00.000Z",
        },
      },
    ];
    expect(plainSummary({ action: "wait", id: SAMPLE_UUID }, entries)).toBe(
      "wait · Target task [vigil-bd02f54] · up to 60s",
    );
    expect(plainSummary({ action: "wait" }, entries)).toBe("wait · up to 60s");
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

describe("formatVigilCallExpandedArgs", () => {
  it("pretty-prints the full argument object", () => {
    expect(
      formatVigilCallExpandedArgs({
        action: "launch",
        name: "Task",
        message: "Full prompt",
      }),
    ).toBe(
      [
        "{",
        '  "action": "launch",',
        '  "name": "Task",',
        '  "message": "Full prompt"',
        "}",
      ].join("\n"),
    );
  });

  it("sanitizes terminal controls while preserving indent newlines and valid JSON", () => {
    const args: VigilCallArgs = {
      action: "search",
      query: "before\u0081C1\u2028LS\u2029PS\u001b[31mRED\te\r\nf\u0007bell",
      id: "vigil-\u0001child",
    };

    const expanded = formatVigilCallExpandedArgs(args);
    expect(expanded).toMatch(/^\{\n  "action": "search",\n/);
    expect(expanded.endsWith("\n}")).toBe(true);
    expect(expanded).not.toMatch(/\u001b|\u0007|\u0081|\u2028|\u2029|\t|\r/);
    expect(expanded).toContain("\\u0081");
    expect(expanded).toContain("\\u2028");
    expect(expanded).toContain("\\u2029");
    expect(expanded).toContain("\\u001b");
    expect(expanded).toContain("\\t");
    expect(expanded).toContain("\\r");
    expect(expanded).toContain("\\u0007");
    expect(expanded).toContain('"id": "vigil-\\u0001child"');
    expect(() => JSON.parse(expanded)).not.toThrow();
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
      { lastComponent: first },
    );
    expect(second).toBe(first);

    const rendered = renderPlainText({ action: "launch", name: "Task", message: "go" });
    expect(rendered).toContain("vigil");
    expect(rendered).toContain("launch · Task");
    expect(rendered).not.toContain("model Pi default");
  });

  it("returns a safe fallback header for incomplete arguments", () => {
    const rendered = renderPlainText({ action: "launch" } as VigilCallArgs);
    expect(rendered).toContain("vigil");
    expect(rendered).toContain("launch");
  });

  it("appends full arguments when expanded without changing the collapsed line", () => {
    const args: VigilCallArgs = {
      action: "launch",
      name: "Slice 4.5 implementation",
      message: "Implement the reviewer feedback in full.",
      model: "cursor/composer-2.5-fast",
    };

    const collapsed = renderPlainText(args);
    expect(collapsed).toContain(
      "vigil launch · Slice 4.5 implementation · model cursor/composer-2.5-fast",
    );
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("Implement the reviewer feedback");

    const expanded = renderPlainText(args, [], { expanded: true });
    expect(expanded).toContain(
      "vigil launch · Slice 4.5 implementation · model cursor/composer-2.5-fast",
    );
    expect(expanded).toContain("launch message:");
    expect(expanded).toContain("Implement the reviewer feedback in full.");
    expect(expanded).toContain('"message": "Implement the reviewer feedback in full."');
    expect(expanded).toContain('"model": "cursor/composer-2.5-fast"');
  });

  it("shows a launch prompt preview on expanded renderCall without echoing it in the collapsed row", () => {
    const args: VigilCallArgs = {
      action: "launch",
      name: "Research API",
      message: "Hidden launch prompt",
    };

    const collapsed = renderPlainText(args);
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("Hidden launch prompt");

    const expanded = renderPlainText(args, [], { expanded: true });
    expect(expanded).toContain("launch message:");
    expect(expanded).toContain("Hidden launch prompt");
  });

  it("reuses a Text lastComponent but falls back when setText is unavailable", () => {
    const textComponent = new Text("", 0, 0);
    const reused = renderVigilCallText(
      { action: "list" },
      testTheme,
      new Map(),
      { lastComponent: textComponent },
    );
    expect(reused).toBe(textComponent);

    const foreignComponent = { render: () => ["foreign"] };
    const fallback = renderVigilCallText(
      { action: "list", includeCompleted: true },
      testTheme,
      new Map(),
      { lastComponent: foreignComponent as never },
    );
    expect(fallback).toBeInstanceOf(Text);
    expect(fallback).not.toBe(foreignComponent);
    expect(stripAnsi(fallback.render(120).join("\n"))).toContain("including completed");
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

  it("shows full tool arguments through renderCall when expanded", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const args: VigilCallArgs = {
      action: "launch",
      name: "Hidden launch name",
      message: "Full launch prompt body",
      model: "cursor/composer-2.5-fast",
    };

    const collapsed = renderHarnessCall(harness, args, { expanded: false });
    expect(collapsed).not.toContain("Full launch prompt body");

    const expanded = renderHarnessCall(harness, args, { expanded: true });
    expect(expanded).toContain("launch message:");
    expect(expanded).toContain("Full launch prompt body");
    expect(expanded).toContain('"message": "Full launch prompt body"');
    expect(expanded).toContain('"action": "launch"');
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
  it("renders search with bounded quoted query and scope", () => {
    expect(
      plainSummary({
        action: "search",
        query: "failure\nline",
        includeCompleted: true,
      }),
    ).toBe('search · "failure line" · including completed');

    const entries = [
      {
        type: "custom" as const,
        id: "launch",
        parentId: null,
        timestamp: "t",
        customType: "vigil-launch",
        data: {
          id: "vigil-search-child",
          sessionId: "vigil-search-child",
          name: "Diagnostics child",
          pid: 1,
          cwd: "/t",
          launchedAt: "t",
        },
      },
    ];
    expect(
      plainSummary({ action: "search", query: "needle", id: "vigil-search-child" }, entries),
    ).toContain("Diagnostics child");
  });

  it("renders read with child identity and shortened entry id", () => {
    const entries = [
      {
        type: "custom" as const,
        id: "launch",
        parentId: null,
        timestamp: "t",
        customType: "vigil-launch",
        data: {
          id: SAMPLE_UUID,
          sessionId: SAMPLE_UUID,
          name: "Diagnostics read",
          pid: 1,
          cwd: "/t",
          launchedAt: "t",
        },
      },
    ];

    expect(
      plainSummary(
        {
          action: "read",
          id: SAMPLE_UUID,
          entryId: "entry-0123456789abcdef",
          before: 2,
          after: 3,
        },
        entries,
      ),
    ).toContain("Diagnostics read");
    expect(
      plainSummary(
        {
          action: "read",
          id: SAMPLE_UUID,
          entryId: "entry-0123456789abcdef",
          before: 2,
          after: 3,
        },
        entries,
      ),
    ).toContain("context 2/3");
  });

  it("falls back safely for unknown search/read parameters", () => {
    expect(plainSummary({ action: "search" })).toContain('search · ""');
    expect(plainSummary({ action: "read" })).toContain("entry entry");
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
    expect([...index.entries()]).toEqual([
      ["vigil-valid", { name: "Valid", model: undefined }],
    ]);
  });
});

describe("sanitizeCallField", () => {
  it("collapses whitespace and truncates with a marker", () => {
    expect(sanitizeCallField("  hello\nworld  ")).toBe("hello world");
    expect(sanitizeCallField("x".repeat(200))).toContain("[truncated]");
  });

  it("escapes terminal controls in compact call fields", () => {
    expect(sanitizeCallField("query\u001b[31mRED\u0007")).not.toMatch(/\u001b|\u0007/);
    expect(sanitizeCallField("query\u001b[31mRED\u0007")).toContain("\\u0007");
    expect(sanitizeCallField("a\tb\rc")).toBe("a\\tb\\rc");
  });
});

describe("terminal control rendering for search/read", () => {
  it("neutralizes controls in compact search and read summaries", () => {
    const searchSummary = plainSummary({
      action: "search",
      query: "fail\u0007\u001b[31mRED\ttab",
      id: "vigil-\u0001evil",
    });
    expect(searchSummary).not.toMatch(/\u0007|\u001b|\t/);
    expect(searchSummary).toContain("\\u0007");
    expect(searchSummary).toContain("\\t");

    const readSummary = plainSummary({
      action: "read",
      id: "vigil-\u0002child",
      entryId: "entry\u0003\ttab",
    });
    expect(readSummary).not.toMatch(/\u0002|\u0003|\t/);
    expect(readSummary).toContain("\\t");
  });

  it("keeps expanded argument rendering safe via JSON escaping", () => {
    const args: VigilCallArgs = {
      action: "search",
      query: "fail\u0007\ttab",
      id: "vigil-\u0001child",
    };

    const expanded = formatVigilCallExpandedArgs(args);
    expect(expanded).toContain('"query": "fail\\u0007\\ttab"');
    expect(expanded).toContain('"id": "vigil-\\u0001child"');
    expect(() => JSON.parse(expanded)).not.toThrow();

    const rendered = renderPlainText(args, [], { expanded: true });
    expect(rendered).not.toMatch(/\u0007|\t/);
    expect(rendered).toContain('"query": "fail\\u0007\\ttab"');
  });
});
