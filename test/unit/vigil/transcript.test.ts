import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readChildTranscriptFromFile } from "../../../src/vigil/node-runtime";
import {
  buildMatchExcerpt,
  DEFAULT_SEARCH_MAX_RESULTS,
  formatReadText,
  formatSearchText,
  MAX_ENTRY_DETAIL_CHARS,
  MAX_READ_CONTEXT,
  MAX_SEARCH_EXCERPT_CHARS,
  MAX_SEARCH_MAX_RESULTS,
  parseChildSessionTranscript,
  projectTranscriptEntry,
  readTranscriptWindow,
  resolveReadPolicy,
  resolveSearchPolicy,
  searchTranscriptEntries,
  serializeToolArgumentsMatchCorpus,
  truncateVisible,
} from "../../../src/vigil/transcript";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

function assistantMessage(
  id: string,
  parentId: string | null,
  text: string,
  extra?: Partial<SessionEntry & { type: "message" }>,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T12:00:02.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
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
    ...extra,
  } as SessionEntry;
}

describe("transcript policy validation", () => {
  it("requires a nonblank search query", () => {
    expect(resolveSearchPolicy({ query: "  " })).toEqual({ error: "search requires query" });
  });

  it("defaults search bounds and includeCompleted", () => {
    expect(resolveSearchPolicy({ query: "failure" })).toEqual({
      query: "failure",
      includeCompleted: false,
      maxResults: DEFAULT_SEARCH_MAX_RESULTS,
    });
  });

  it("rejects out-of-range search maxResults before file access", () => {
    expect(resolveSearchPolicy({ query: "x", maxResults: 51 })).toEqual({
      error: `maxResults must be a positive safe integer no greater than ${MAX_SEARCH_MAX_RESULTS}`,
    });
  });

  it("requires read id and entryId", () => {
    expect(resolveReadPolicy({})).toEqual({ error: "read requires id" });
    expect(resolveReadPolicy({ id: "vigil-a" })).toEqual({ error: "read requires entryId" });
  });

  it("defaults read context and rejects oversized windows", () => {
    expect(resolveReadPolicy({ id: "vigil-a", entryId: "entry-1" })).toEqual({
      id: "vigil-a",
      entryId: "entry-1",
      before: 1,
      after: 1,
      includeCompleted: false,
    });
    expect(resolveReadPolicy({ id: "vigil-a", entryId: "entry-1", before: 10, after: 10 })).toEqual({
      id: "vigil-a",
      entryId: "entry-1",
      before: 10,
      after: 10,
      includeCompleted: false,
    });
    expect(resolveReadPolicy({ id: "vigil-a", entryId: "entry-1", before: 11 })).toEqual({
      error: `before must be a nonnegative safe integer no greater than ${MAX_READ_CONTEXT}`,
    });
  });
});

describe("transcript projection and literal search", () => {
  it("matches case-insensitively without using regex evaluation", () => {
    const transcript = parseChildSessionTranscript([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "npm TEST failed: expected 3" }],
          timestamp: 1,
        },
      },
    ]);

    const matches = searchTranscriptEntries(
      transcript,
      "test failed",
      { id: "vigil-a", sessionId: "vigil-a", name: "Task", state: "waiting" },
      20,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.entryId).toBe("user-1");
    expect(matches[0]?.match.toLowerCase()).toContain("test failed");
  });

  it("searches tool-call names/arguments and tool results but excludes thinking", () => {
    const entry: SessionEntry = {
      type: "message",
      id: "assistant-tool",
      parentId: "user-1",
      timestamp: "2026-08-01T12:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THINKING_MARKER" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
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
    expect(projected?.searchableText).toContain("bash");
    expect(projected?.searchableText).toContain("npm test");
    expect(projected?.searchableText).not.toContain("SECRET_THINKING_MARKER");

    const thinkingOnly = searchTranscriptEntries(
      parseChildSessionTranscript([entry]),
      "SECRET_THINKING_MARKER",
      { id: "vigil-a", sessionId: "vigil-a", name: "Task", state: "running" },
      20,
    );
    expect(thinkingOnly).toHaveLength(0);
  });

  it("returns one result per matching entry and truncates globally", () => {
    const transcript = parseChildSessionTranscript([
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "needle needle needle" }],
          timestamp: 1,
        },
      },
      assistantMessage("assistant-1", "user-1", "needle here"),
      assistantMessage("assistant-2", "user-1", "no match"),
    ]);

    const matches = searchTranscriptEntries(
      transcript,
      "needle",
      { id: "vigil-a", sessionId: "vigil-a", name: "Task", state: "waiting" },
      1,
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.entryId).toBe("user-1");
  });

  it("builds bounded excerpts around the first match", () => {
    const longPrefix = "a".repeat(600);
    const excerpt = buildMatchExcerpt(`${longPrefix}TARGET${"b".repeat(600)}`, "target", MAX_SEARCH_EXCERPT_CHARS);
    expect(excerpt.length).toBeLessThanOrEqual(MAX_SEARCH_EXCERPT_CHARS);
    expect(excerpt.toLowerCase()).toContain("target");
    expect(excerpt.startsWith("…") || excerpt.endsWith("…")).toBe(true);
  });

  it("serializes tool arguments with deterministic key ordering for match corpus", () => {
    expect(serializeToolArgumentsMatchCorpus({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("truncates rendered entry detail", () => {
    const detail = truncateVisible("x".repeat(MAX_ENTRY_DETAIL_CHARS + 100), MAX_ENTRY_DETAIL_CHARS);
    expect(detail.length).toBeLessThanOrEqual(MAX_ENTRY_DETAIL_CHARS);
    expect(detail.endsWith("…")).toBe(true);
  });
});

describe("readTranscriptWindow", () => {
  it("uses JSONL append order, not conversational branch order", () => {
    const fixturePath = path.join(fixturesDir, "child-session-branch-append-order.jsonl");
    const transcript = readChildTranscriptFromFile(fixturePath);
    expect("error" in transcript).toBe(false);
    if ("error" in transcript) {
      return;
    }

    const window = readTranscriptWindow(transcript, "branch-b", 1, 0);
    expect("error" in window).toBe(false);
    if ("error" in window) {
      return;
    }

    expect(window.map((entry) => entry.entryId)).toEqual(["branch-a", "branch-b"]);
  });

  it("returns unknown entry errors", () => {
    const transcript = parseChildSessionTranscript([]);
    expect(readTranscriptWindow(transcript, "missing", 1, 1)).toEqual({
      error: "Unknown child session entry: missing",
    });
  });
});

describe("diagnostic text formatting", () => {
  it("formats self-sufficient search and read text", () => {
    const searchText = formatSearchText({
      matches: [
        {
          id: "vigil-abc-def0-1234-5678-abcd-ef0123456789",
          sessionId: "vigil-abc-def0-1234-5678-abcd-ef0123456789",
          name: "Slice 5 implementation",
          state: "waiting",
          entryId: "1a2b3c4d",
          parentId: "0f1e2d3c",
          entryType: "message",
          role: "assistant",
          timestamp: "2026-08-02T00:12:00.000Z",
          match: "npm test failed: expected 3",
        },
      ],
    });
    expect(searchText).toContain("matches: 1");
    expect(searchText).toContain("Slice 5 implementation");
    expect(searchText).toContain("entry 1a2b3c4d");

    const readText = formatReadText({
      id: "vigil-abc-def0-1234-5678-abcd-ef0123456789",
      sessionId: "vigil-abc-def0-1234-5678-abcd-ef0123456789",
      name: "Slice 5 implementation",
      state: "waiting",
      anchorEntryId: "1a2b3c4d",
      anchorParentId: "0f1e2d3c",
      requestedBefore: 1,
      requestedAfter: 2,
      effectiveBefore: 1,
      effectiveAfter: 2,
      order: "jsonl-append-order",
      entries: [
        {
          entryId: "0f1e2d3c",
          parentId: null,
          entryType: "message",
          role: "user",
          timestamp: "2026-08-02T00:11:59.000Z",
          detail: "prompt",
          isAnchor: false,
        },
        {
          entryId: "1a2b3c4d",
          parentId: "0f1e2d3c",
          entryType: "message",
          role: "assistant",
          timestamp: "2026-08-02T00:12:00.000Z",
          detail: "npm test failed: expected 3",
          isAnchor: true,
        },
      ],
    });
    expect(readText).toContain("JSONL append order");
    expect(readText).toContain("(anchor)");
  });
});

describe("fixture-backed transcript reader", () => {
  it("parses persisted child session fixtures via Pi parser", () => {
    const fixturePath = path.join(fixturesDir, "child-session-with-assistant.jsonl");
    const raw = readFileSync(fixturePath, "utf8");
    expect(raw).toContain('"role":"assistant"');
    const transcript = readChildTranscriptFromFile(fixturePath);
    expect("error" in transcript).toBe(false);
    if ("error" in transcript) {
      return;
    }
    expect(transcript.entries.some((entry) => entry.searchableText.includes("Hello from the child session"))).toBe(
      true,
    );
  });
});
