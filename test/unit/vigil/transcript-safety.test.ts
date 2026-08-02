import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildMatchExcerpt,
  escapeTerminalControls,
  formatReadText,
  formatSearchText,
  formatToolArgumentsDisplay,
  MAX_ENTRY_DETAIL_CHARS,
  MAX_SEARCH_EXCERPT_CHARS,
  MAX_TOOL_ARGUMENTS_DISPLAY_CHARS,
  parseChildSessionTranscript,
  projectTranscriptEntry,
  resolveReadPolicy,
  resolveSearchPolicy,
  sanitizeDisplayField,
  sanitizeDisplayMultiline,
  searchTranscriptEntries,
  serializeToolArgumentsMatchCorpus,
} from "../../../src/vigil/transcript";

describe("safe display projections", () => {
  it("escapes C0/C1 control sequences and ANSI/OSC escapes visibly in display fields", () => {
    const injected = "before\u001b[31mRED\u001b[0m\u0007after\u001b]0;Title\u0007";
    expect(sanitizeDisplayField(injected, 200)).not.toMatch(/\u001b|\u0007/);
    expect(sanitizeDisplayField(injected, 200)).toContain("\\u0007");
    expect(sanitizeDisplayMultiline("line1\nline2\u000b", 200)).toBe("line1\nline2\\u000b");
  });

  it("escapes tabs and carriage returns while preserving only LF in multiline read detail", () => {
    expect(escapeTerminalControls("a\tb", true)).toBe("a\\tb");
    expect(escapeTerminalControls("a\rb", true)).toBe("a\\rb");
    expect(escapeTerminalControls("line1\nline2", true)).toBe("line1\nline2");
    expect(escapeTerminalControls("\u007fDEL", false)).toContain("\\u007f");
  });

  it("caps oversized display fields", () => {
    const long = "x".repeat(500);
    expect(sanitizeDisplayField(long, 50).length).toBeLessThanOrEqual(50);
    expect(sanitizeDisplayMultiline(`${long}\n${long}`, 100).length).toBeLessThanOrEqual(100);
  });

  it("serializes tool arguments as full valid JSON for matching and separately truncates display excerpts", () => {
    expect(serializeToolArgumentsMatchCorpus({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(serializeToolArgumentsMatchCorpus({ cmd: 'say "hi"\nline2' })).toBe('{"cmd":"say \\"hi\\"\\nline2"}');
    expect(serializeToolArgumentsMatchCorpus({ nested: { z: true, a: "x" } })).toBe('{"nested":{"a":"x","z":true}}');

    const oversizedArgs = { payload: `${"p".repeat(2_500)}DEEP_MARKER` };
    const matchCorpus = serializeToolArgumentsMatchCorpus(oversizedArgs);
    expect(matchCorpus).toContain("DEEP_MARKER");
    expect(matchCorpus.length).toBeGreaterThan(2_000);

    const display = formatToolArgumentsDisplay(oversizedArgs);
    expect(display.length).toBeLessThanOrEqual(MAX_TOOL_ARGUMENTS_DISPLAY_CHARS);
    expect(display).not.toContain("DEEP_MARKER");
    expect(() => JSON.parse(display)).toThrow();
  });

  it("finds markers beyond 2,000 characters in tool arguments while keeping emitted output bounded", () => {
    const padding = "z".repeat(2_100);
    const entry: SessionEntry = {
      type: "message",
      id: "deep-tool-call",
      parentId: null,
      timestamp: "2026-08-01T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-deep",
            name: "bash",
            arguments: { command: `${padding}FAR_MARKER` },
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1722513602000,
      },
    };

    const projected = projectTranscriptEntry(entry);
    expect(projected?.searchableText).toContain("FAR_MARKER");
    expect(projected?.detailText.length ?? 0).toBeLessThanOrEqual(MAX_ENTRY_DETAIL_CHARS);

    const matches = searchTranscriptEntries(
      parseChildSessionTranscript([entry]),
      "far_marker",
      { id: "vigil-a", sessionId: "vigil-a", name: "Task", state: "running" },
      5,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.match.length ?? 0).toBeLessThanOrEqual(MAX_SEARCH_EXCERPT_CHARS);
    expect(matches[0]?.match.toLowerCase()).toContain("far_marker");

    const searchText = formatSearchText({ matches });
    expect(searchText.length).toBeLessThan(10_000);
    expect(searchText).not.toMatch(/\u001b|\u0007|\t/);
  });

  it("formatSearchText and formatReadText use safe bounded projections without literal controls", () => {
    const controlName = "Task\u001b[2J";
    const controlMatch = "fail\u0007ure\ttab\rcr";
    const searchText = formatSearchText({
      matches: [
        {
          id: "vigil-abc-def0-1234-5678-abcd-ef0123456789",
          sessionId: "vigil-abc-def0-1234-5678-abcd-ef0123456789",
          name: controlName,
          state: "running",
          entryId: "entry\u0001id",
          parentId: "parent\u0002id",
          entryType: "message",
          role: "assistant",
          timestamp: "2026-08-02T00:12:00.000Z",
          match: controlMatch,
        },
      ],
    });
    expect(searchText).not.toMatch(/\u001b|\u0001|\u0002|\u0007|\t|\r/);
    expect(searchText).toContain("\\u0007");
    expect(searchText).toContain("\\t");
    expect(searchText).toContain("matches: 1");

    const readText = formatReadText({
      id: "vigil-read-id",
      sessionId: "vigil-read-id",
      name: controlName,
      state: "running",
      anchorEntryId: "anchor-id",
      anchorParentId: null,
      requestedBefore: 0,
      requestedAfter: 0,
      effectiveBefore: 0,
      effectiveAfter: 0,
      order: "jsonl-append-order",
      entries: [
        {
          entryId: "anchor-id",
          parentId: null,
          entryType: "message",
          role: "assistant",
          timestamp: "2026-08-02T00:12:00.000Z",
          detail: "line-one\nline-two\u0007\ttab\rcr",
          isAnchor: true,
        },
      ],
    });
    expect(readText).toContain("line-one\nline-two");
    expect(readText).not.toMatch(/\u0007|\u001b|\t|\r/);
    expect(readText).toContain("\\u0007");
    expect(readText).toContain("\\t");
  });

  it("retains raw searchable text for matching while projecting safe match excerpts", () => {
    const entry: SessionEntry = {
      type: "message",
      id: "raw-entry",
      parentId: null,
      timestamp: "2026-08-01T12:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "RAW\u0007MARKER visible" }],
        timestamp: 1,
      },
    };
    const projected = projectTranscriptEntry(entry);
    expect(projected?.searchableText).toContain("\u0007");

    const matches = searchTranscriptEntries(
      parseChildSessionTranscript([entry]),
      "marker",
      { id: "vigil-a", sessionId: "vigil-a", name: "Task", state: "running" },
      5,
    );
    expect(matches[0]?.match).not.toContain("\u0007");
    expect(matches[0]?.match.toLowerCase()).toContain("marker");
  });
});

describe("exact id validation", () => {
  it("rejects id and entryId with leading or trailing whitespace", () => {
    expect(resolveReadPolicy({ id: " vigil-a", entryId: "entry-1" })).toEqual({
      error: "read id must not contain leading or trailing whitespace",
    });
    expect(resolveReadPolicy({ id: "vigil-a", entryId: "entry-1 " })).toEqual({
      error: "read entryId must not contain leading or trailing whitespace",
    });
    expect(resolveSearchPolicy({ query: "x", id: " vigil-a" })).toEqual({
      error: "search id must not contain leading or trailing whitespace",
    });
  });

  it("preserves raw unchanged ids after validation", () => {
    const read = resolveReadPolicy({ id: "vigil-a", entryId: "entry-1" });
    expect("error" in read).toBe(false);
    if (!("error" in read)) {
      expect(read.id).toBe("vigil-a");
      expect(read.entryId).toBe("entry-1");
    }

    const search = resolveSearchPolicy({ query: "  needle  ", id: "vigil-a" });
    expect("error" in search).toBe(false);
    if (!("error" in search)) {
      expect(search.query).toBe("needle");
      expect(search.id).toBe("vigil-a");
    }
  });
});

describe("malformed session entry metadata", () => {
  it("skips entries with invalid base metadata", () => {
    const valid = projectTranscriptEntry({
      type: "message",
      id: "valid",
      parentId: null,
      timestamp: "2026-08-01T12:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "ok" }], timestamp: 1 },
    });
    expect(valid?.entryId).toBe("valid");

    expect(
      projectTranscriptEntry({
        type: "message",
        id: "  ",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "bad id" }], timestamp: 1 },
      } as SessionEntry),
    ).toBeNull();

    expect(
      projectTranscriptEntry({
        type: "message",
        id: "bad-parent",
        parentId: 42 as unknown as string,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "bad parent" }], timestamp: 1 },
      } as SessionEntry),
    ).toBeNull();

    expect(
      projectTranscriptEntry({
        type: "message",
        id: "bad-ts",
        parentId: null,
        timestamp: "  ",
        message: { role: "user", content: [{ type: "text", text: "bad ts" }], timestamp: 1 },
      } as SessionEntry),
    ).toBeNull();
  });
});

describe("searchable and excluded transcript surfaces", () => {
  it("searches every promised persisted text surface", () => {
    const entries = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "USER_SURFACE" }], timestamp: 1 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-08-01T12:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ASSIST_SURFACE" }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1722513602000,
        },
      },
      {
        type: "message",
        id: "tool-call",
        parentId: "assistant-1",
        timestamp: "2026-08-01T12:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "TOOLARG_SURFACE" } }],
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: 1722513603000,
        },
      },
      {
        type: "message",
        id: "tool-result",
        parentId: "tool-call",
        timestamp: "2026-08-01T12:00:04.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "TOOLRESULT_SURFACE" }],
          isError: false,
          timestamp: 1722513604000,
        },
      },
      {
        type: "message",
        id: "bash-exec",
        parentId: "tool-result",
        timestamp: "2026-08-01T12:00:05.000Z",
        message: {
          role: "bashExecution",
          command: "BASHCMD_SURFACE",
          output: "BASHOUT_SURFACE",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1722513605000,
        },
      } as SessionEntry,
      {
        type: "message",
        id: "custom-msg",
        parentId: "bash-exec",
        timestamp: "2026-08-01T12:00:06.000Z",
        message: {
          role: "custom",
          customType: "test",
          display: false,
          content: [{ type: "text", text: "CUSTOMMSG_SURFACE" }],
          timestamp: 1722513606000,
        },
      } as SessionEntry,
      {
        type: "custom_message",
        id: "custom-message-entry",
        parentId: "custom-msg",
        timestamp: "2026-08-01T12:00:07.000Z",
        customType: "test",
        display: true,
        content: [{ type: "text", text: "CUSTOM_MESSAGE_ENTRY_SURFACE" }],
      } as SessionEntry,
      {
        type: "compaction",
        id: "compaction-entry",
        parentId: "custom-message-entry",
        timestamp: "2026-08-01T12:00:08.000Z",
        summary: "COMPACTION_SURFACE",
        firstKeptEntryId: "user-1",
        tokensBefore: 100,
      },
      {
        type: "branch_summary",
        id: "branch-entry",
        parentId: "compaction-entry",
        timestamp: "2026-08-01T12:00:09.000Z",
        summary: "BRANCH_SURFACE",
        fromId: "user-1",
      },
      {
        type: "model_change",
        id: "model-entry",
        parentId: "branch-entry",
        timestamp: "2026-08-01T12:00:10.000Z",
        provider: "openai-codex",
        modelId: "MODEL_SURFACE",
      },
      {
        type: "thinking_level_change",
        id: "thinking-entry",
        parentId: "model-entry",
        timestamp: "2026-08-01T12:00:11.000Z",
        thinkingLevel: "THINKING_SURFACE",
      },
      {
        type: "label",
        id: "label-entry",
        parentId: "thinking-entry",
        timestamp: "2026-08-01T12:00:12.000Z",
        targetId: "user-1",
        label: "LABEL_SURFACE",
      },
    ];

    const transcript = parseChildSessionTranscript(entries as SessionEntry[]);
    const child = { id: "vigil-a", sessionId: "vigil-a", name: "Task", state: "running" as const };

    for (const marker of [
      "USER_SURFACE",
      "ASSIST_SURFACE",
      "TOOLARG_SURFACE",
      "TOOLRESULT_SURFACE",
      "BASHCMD_SURFACE",
      "BASHOUT_SURFACE",
      "CUSTOMMSG_SURFACE",
      "CUSTOM_MESSAGE_ENTRY_SURFACE",
      "COMPACTION_SURFACE",
      "BRANCH_SURFACE",
      "MODEL_SURFACE",
      "THINKING_SURFACE",
      "LABEL_SURFACE",
    ]) {
      const matches = searchTranscriptEntries(transcript, marker, child, 50);
      expect(matches.some((match) => match.match.includes(marker) || match.match.toLowerCase().includes(marker.toLowerCase())), marker).toBe(
        true,
      );
    }
  });

  it("excludes thinking blocks, opaque custom data, and image payloads", () => {
    const thinkingEntry: SessionEntry = {
      type: "message",
      id: "thinking-only",
      parentId: null,
      timestamp: "2026-08-01T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THINKING" },
          { type: "text", text: "visible only" },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.5",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 1722513602000,
      },
    };

    const projected = projectTranscriptEntry(thinkingEntry);
    expect(projected?.searchableText ?? "").not.toContain("SECRET_THINKING");
    expect(projected?.searchableText).toContain("visible only");

    expect(
      searchTranscriptEntries(parseChildSessionTranscript([thinkingEntry]), "SECRET_THINKING", {
        id: "vigil-a",
        sessionId: "vigil-a",
        name: "Task",
        state: "running",
      }, 5),
    ).toHaveLength(0);

    expect(projectTranscriptEntry({ type: "custom", id: "opaque", parentId: null, timestamp: "t", customType: "x", data: { secret: "OPAQUE_CUSTOM" } } as SessionEntry)).toBeNull();
  });

  it("buildMatchExcerpt respects max visible characters", () => {
    const excerpt = buildMatchExcerpt(`${"a".repeat(800)}TARGET${"b".repeat(800)}`, "target", MAX_SEARCH_EXCERPT_CHARS);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_SEARCH_EXCERPT_CHARS);
  });

  it("projects bounded entry detail without leaking raw oversized content in display fields", () => {
    const entry: SessionEntry = {
      type: "message",
      id: "big-detail",
      parentId: null,
      timestamp: "2026-08-01T12:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "z".repeat(MAX_ENTRY_DETAIL_CHARS + 500) }],
        timestamp: 1,
      },
    };
    const projected = projectTranscriptEntry(entry);
    expect(projected?.searchableText.length).toBeGreaterThan(MAX_ENTRY_DETAIL_CHARS);
    expect(projected?.detailText.length).toBeLessThanOrEqual(MAX_ENTRY_DETAIL_CHARS);
  });
});
