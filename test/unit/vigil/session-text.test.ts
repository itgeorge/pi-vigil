import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readChildSessionStateFromFile, readLatestAssistantTextFromFile } from "../../../src/vigil/node-runtime";
import {
  deriveVigilState,
  extractLatestAssistantState,
  extractLatestAssistantText,
  extractRecentMessagePreviews,
  extractSessionActivity,
} from "../../../src/vigil/session-text";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

function loadFixture(name: string): SessionEntry[] {
  const fixturePath = path.join(fixturesDir, name);
  return parseSessionEntries(readFileSync(fixturePath, "utf8")).filter(
    (entry) => entry.type !== "session",
  ) as SessionEntry[];
}

function assistantMessage(
  id: string,
  parentId: string | null,
  text: string,
  stopReason?: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-01T12:00:00.000Z",
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
      stopReason: stopReason as never,
      timestamp: 1722513602000,
    },
  };
}

describe("child session text extraction", () => {
  it("reads the latest complete assistant text from Pi v3 session fixtures", () => {
    const entries = loadFixture("child-session-with-assistant.jsonl");

    expect(extractLatestAssistantText(entries)).toBe("Hello from the child session.");
    expect(extractLatestAssistantState(entries)).toEqual({
      latestResponse: "Hello from the child session.",
      turnComplete: true,
      lastConversationTimestamp: "2026-08-01T12:00:02.000Z",
    });
    expect(readLatestAssistantTextFromFile(path.join(fixturesDir, "child-session-with-assistant.jsonl"))).toBe(
      "Hello from the child session.",
    );
    expect(readChildSessionStateFromFile(path.join(fixturesDir, "child-session-with-assistant.jsonl")).turnComplete).toBe(
      true,
    );
  });

  it("returns null when no assistant message exists", () => {
    const fixturePath = path.join(fixturesDir, "child-session-without-assistant.jsonl");
    const raw = readFileSync(fixturePath, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(readChildSessionStateFromFile(fixturePath)).toEqual({
      latestResponse: null,
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:01.000Z",
      activity: {
        steps: 1,
        messages: 1,
        lastActivity: "user message",
        lastActivityTimestamp: "2026-08-01T12:00:01.000Z",
        recentMessages: [{ label: "user", excerpt: "Do something" }],
      },
    });
  });

  it("keeps the prior assistant text but marks the turn incomplete when a newer user message exists", () => {
    const entries = loadFixture("child-session-prior-response-new-user.jsonl");

    expect(extractLatestAssistantState(entries)).toEqual({
      latestResponse: "First answer.",
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:03.000Z",
    });
  });

  it("treats assistant toolUse followed by a tool result as incomplete", () => {
    const entries = loadFixture("child-session-tool-use-incomplete.jsonl");

    expect(extractLatestAssistantState(entries)).toEqual({
      latestResponse: null,
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:03.000Z",
    });
  });

  it.each(["stop", "length", "error", "aborted"])(
    "treats a final assistant with stopReason %s as complete",
    (stopReason) => {
      const entries = [assistantMessage("assistant-001", "user-001", `Done via ${stopReason}.`, stopReason)];

      expect(extractLatestAssistantState(entries)).toEqual({
        latestResponse: `Done via ${stopReason}.`,
        turnComplete: true,
        lastConversationTimestamp: "2026-08-01T12:00:00.000Z",
      });
    },
  );

  it("treats assistant toolUse, pending, and missing stop reasons as incomplete", () => {
    expect(extractLatestAssistantState([assistantMessage("a1", null, "tooling", "toolUse")])).toEqual({
      latestResponse: "tooling",
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:00.000Z",
    });
    expect(extractLatestAssistantState([assistantMessage("a2", null, "pending", "pending")])).toEqual({
      latestResponse: "pending",
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:00.000Z",
    });
    const missingStopReason = assistantMessage("a3", null, "missing", "stop");
    if (missingStopReason.type === "message" && missingStopReason.message.role === "assistant") {
      missingStopReason.message.stopReason = undefined as never;
    }
    expect(extractLatestAssistantState([missingStopReason])).toEqual({
      latestResponse: "missing",
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:00.000Z",
    });
  });

  it("ignores non-conversation entries when determining turn completion", () => {
    const entries = loadFixture("child-session-user-after-model-change.jsonl");

    expect(extractLatestAssistantState(entries)).toEqual({
      latestResponse: "First answer.",
      turnComplete: false,
      lastConversationTimestamp: "2026-08-01T12:00:03.000Z",
    });
  });
});

describe("extractSessionActivity", () => {
  it("counts persisted steps excluding the session header and message entries separately", () => {
    const entries = loadFixture("child-session-with-assistant.jsonl");
    expect(extractSessionActivity(entries)).toEqual({
      steps: 2,
      messages: 2,
      lastActivity: "assistant response",
      lastActivityTimestamp: "2026-08-01T12:00:02.000Z",
      recentMessages: [
        { label: "user", excerpt: "Say hello" },
        { label: "assistant", excerpt: "Hello from the child session." },
      ],
    });
  });

  it("describes assistant tool use and tool results from persisted entries", () => {
    const entries = loadFixture("child-session-tool-use-incomplete.jsonl");
    expect(extractSessionActivity(entries)).toEqual({
      steps: 3,
      messages: 3,
      lastActivity: "tool result: read",
      lastActivityTimestamp: "2026-08-01T12:00:03.000Z",
      recentMessages: [
        { label: "user", excerpt: "Use a tool" },
        { label: "assistant", excerpt: "tool use: read" },
        { label: "tool result", excerpt: "file contents" },
      ],
    });
  });

  it("describes model change and user message cases without inventing live reasoning", () => {
    const entries = loadFixture("child-session-user-after-model-change.jsonl");
    expect(extractSessionActivity(entries)).toEqual({
      steps: 4,
      messages: 3,
      lastActivity: "user message",
      lastActivityTimestamp: "2026-08-01T12:00:03.000Z",
      recentMessages: [
        { label: "user", excerpt: "First turn" },
        { label: "assistant", excerpt: "First answer." },
        { label: "user", excerpt: "Second turn" },
      ],
    });
  });

  it("returns zero counts and null activity for an empty entry list", () => {
    expect(extractSessionActivity([])).toEqual({
      steps: 0,
      messages: 0,
      lastActivity: null,
      lastActivityTimestamp: null,
      recentMessages: [],
    });
  });

  it("describes the newest persisted entry even when it is not a message or model change", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "user-001",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 1722513601000,
        },
      },
      {
        type: "compaction",
        id: "compact-001",
        parentId: "user-001",
        timestamp: "2026-08-01T12:00:04.000Z",
        summary: "summarized context",
        firstKeptEntryId: "user-001",
        tokensBefore: 100,
      },
    ];

    expect(extractSessionActivity(entries)).toEqual({
      steps: 2,
      messages: 1,
      lastActivity: "compaction",
      lastActivityTimestamp: "2026-08-01T12:00:04.000Z",
      recentMessages: [{ label: "user", excerpt: "Hello" }],
    });
  });

  it("uses a safe generic label for custom entries without exposing custom data", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "user-001",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 1722513601000,
        },
      },
      {
        type: "custom",
        id: "custom-001",
        parentId: "user-001",
        timestamp: "2026-08-01T12:00:05.000Z",
        customType: "untrusted-extension",
        data: { secret: "do-not-leak" },
      },
    ];

    const activity = extractSessionActivity(entries);
    expect(activity.lastActivity).toBe("custom entry");
    expect(activity.lastActivityTimestamp).toBe("2026-08-01T12:00:05.000Z");
    expect(JSON.stringify(activity)).not.toContain("untrusted-extension");
    expect(JSON.stringify(activity)).not.toContain("do-not-leak");
  });
});

describe("extractRecentMessagePreviews", () => {
  function userMessage(id: string, text: string, parentId: string | null = null): SessionEntry {
    return {
      type: "message",
      id,
      parentId,
      timestamp: "2026-08-01T12:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: 1,
      },
    };
  }

  function assistantTextMessage(id: string, text: string, parentId: string | null = null): SessionEntry {
    return assistantMessage(id, parentId, text, "stop");
  }

  it("returns an empty list when there are no persisted message entries", () => {
    expect(extractRecentMessagePreviews([])).toEqual([]);
  });

  it("returns one preview for a single message", () => {
    expect(extractRecentMessagePreviews([userMessage("u1", "Apply the final renderer correction")])).toEqual([
      { label: "user", excerpt: "Apply the final renderer correction" },
    ]);
  });

  it("returns two previews in append order for two messages", () => {
    const entries = [
      userMessage("u1", "first"),
      assistantTextMessage("a1", "second", "u1"),
    ];
    expect(extractRecentMessagePreviews(entries)).toEqual([
      { label: "user", excerpt: "first" },
      { label: "assistant", excerpt: "second" },
    ]);
  });

  it("returns the last three message previews oldest to newest when more than three exist", () => {
    const entries = [
      userMessage("u1", "m1"),
      assistantTextMessage("a1", "m2", "u1"),
      userMessage("u2", "m3", "a1"),
      assistantTextMessage("a2", "m4", "u2"),
    ];
    expect(extractRecentMessagePreviews(entries)).toEqual([
      { label: "assistant", excerpt: "m2" },
      { label: "user", excerpt: "m3" },
      { label: "assistant", excerpt: "m4" },
    ]);
  });

  it("truncates excerpts at 50 visible characters and appends an ellipsis only when truncated", () => {
    const exact = "x".repeat(50);
    const over = `${exact}y`;
    expect(extractRecentMessagePreviews([userMessage("u1", exact)])).toEqual([
      { label: "user", excerpt: exact },
    ]);
    expect(extractRecentMessagePreviews([userMessage("u1", over)])[0]?.excerpt).toBe(`${"x".repeat(49)}…`);
  });

  it("neutralizes multiline content, controls, and ANSI sequences in previews", () => {
    const injected = "line1\nline2\u0007\u001b[31mred\u001b[0m";
    const preview = extractRecentMessagePreviews([userMessage("u1", injected)])[0];
    expect(preview?.excerpt).not.toMatch(/\u001b|\u0007/);
    expect(preview?.excerpt).not.toContain("\n");
    expect(preview?.excerpt).toContain("\\u0007");
  });

  it("labels tool results and assistant tool-call-only messages honestly", () => {
    const entries = loadFixture("child-session-tool-use-incomplete.jsonl");
    expect(extractRecentMessagePreviews(entries)).toEqual([
      { label: "user", excerpt: "Use a tool" },
      { label: "assistant", excerpt: "tool use: read" },
      { label: "tool result", excerpt: "file contents" },
    ]);
  });

  it("excludes assistant thinking and image payloads from preview excerpts", () => {
    const entry = {
      type: "message",
      id: "assistant-thinking",
      parentId: null,
      timestamp: "2026-08-01T12:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "SECRET_THINKING" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
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
    } as SessionEntry;

    const preview = extractRecentMessagePreviews([entry])[0];
    expect(preview).toEqual({ label: "assistant", excerpt: "visible only" });
    expect(JSON.stringify(preview)).not.toContain("SECRET_THINKING");
    expect(JSON.stringify(preview)).not.toContain("aGVsbG8=");
  });

  it("labels bashExecution and custom message roles factually", () => {
    const entries = [
      {
        type: "message",
        id: "bash-1",
        parentId: null,
        timestamp: "2026-08-01T12:00:01.000Z",
        message: {
          role: "bashExecution",
          command: "npm test",
          output: "172 tests passed",
          exitCode: 0,
          cancelled: false,
          truncated: false,
          timestamp: 1,
        },
      },
      {
        type: "message",
        id: "custom-1",
        parentId: "bash-1",
        timestamp: "2026-08-01T12:00:02.000Z",
        message: {
          role: "custom",
          customType: "test",
          display: false,
          content: [{ type: "text", text: "extension note" }],
          timestamp: 2,
        },
      },
    ] as SessionEntry[];

    expect(extractRecentMessagePreviews(entries)).toEqual([
      { label: "bash execution", excerpt: "npm test" },
      { label: "custom", excerpt: "extension note" },
    ]);
  });
});

describe("deriveVigilState", () => {
  it("returns running for a spawned turn before the child session catches up", () => {
    expect(
      deriveVigilState({
        alive: true,
        turnComplete: true,
        lastConversationTimestamp: "2026-08-01T12:00:02.000Z",
        turnStartedAt: "2026-08-01T12:00:05.000Z",
      }),
    ).toBe("running");
  });

  it("returns waiting for a settled alive child whose session matches the tracked turn", () => {
    expect(
      deriveVigilState({
        alive: true,
        turnComplete: true,
        lastConversationTimestamp: "2026-08-01T12:00:05.000Z",
        turnStartedAt: "2026-08-01T12:00:02.000Z",
      }),
    ).toBe("waiting");
  });
});
