import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayField } from "./transcript";

export interface AssistantTurnState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
}

export interface VigilMessagePreview {
  label: string;
  excerpt: string;
}

export interface VigilSessionActivity {
  steps: number;
  messages: number;
  lastActivity: string | null;
  lastActivityTimestamp: string | null;
  recentMessages: VigilMessagePreview[];
}

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
  activity: VigilSessionActivity;
}

export const MAX_RECENT_MESSAGE_PREVIEWS = 3;
export const MAX_MESSAGE_PREVIEW_CHARS = 50;

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

const EMPTY_SESSION_ACTIVITY: VigilSessionActivity = {
  steps: 0,
  messages: 0,
  lastActivity: null,
  lastActivityTimestamp: null,
  recentMessages: [],
};

function extractVisibleTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  let text = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const typed = part as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      text += typed.text;
    }
  }
  return text;
}

function describeAssistantToolUse(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const names: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const typed = part as { type?: string; name?: string };
    if (typed.type === "toolCall" && typeof typed.name === "string" && typed.name.trim()) {
      names.push(typed.name.trim());
    }
  }

  if (names.length === 0) {
    return null;
  }
  return names.length === 1 ? `tool use: ${names[0]}` : `tool use: ${names.join(", ")}`;
}

function labelForMessageRole(role: string): string {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tool result";
    case "bashExecution":
      return "bash execution";
    case "custom":
      return "custom";
    case "branchSummary":
      return "branch summary";
    case "compactionSummary":
      return "compaction summary";
    default:
      return role.trim() || "message";
  }
}

function buildMessagePreviewExcerpt(entry: SessionEntry & { type: "message" }): string {
  const role = entry.message?.role;
  if (typeof role !== "string" || !role) {
    return "";
  }

  if (role === "user" || role === "custom") {
    return extractVisibleTextParts(entry.message.content);
  }

  if (role === "assistant") {
    const text = extractVisibleTextParts(entry.message.content).trim();
    if (text) {
      return text;
    }
    return describeAssistantToolUse(entry.message.content) ?? "";
  }

  if (role === "toolResult") {
    return extractVisibleTextParts(entry.message.content);
  }

  if (role === "bashExecution") {
    const command = entry.message.command?.trim() ?? "";
    const output = entry.message.output?.trim() ?? "";
    return command || output;
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    return entry.message.summary?.trim() ?? "";
  }

  return extractVisibleTextParts((entry.message as { content?: unknown }).content);
}

function formatMessagePreviewExcerpt(raw: string): string {
  return sanitizeDisplayField(raw, MAX_MESSAGE_PREVIEW_CHARS);
}

export function extractRecentMessagePreviews(entries: SessionEntry[]): VigilMessagePreview[] {
  const messageEntries = entries.filter(
    (entry): entry is SessionEntry & { type: "message" } => entry.type === "message",
  );
  const selected = messageEntries.slice(-MAX_RECENT_MESSAGE_PREVIEWS);

  return selected.map((entry) => {
    const role = entry.message?.role;
    const label = typeof role === "string" && role ? labelForMessageRole(role) : "message";
    const excerpt = formatMessagePreviewExcerpt(buildMessagePreviewExcerpt(entry));
    return { label, excerpt };
  });
}

function describePersistedEntryActivity(entry: SessionEntry): string {
  if (entry.type === "message") {
    if (entry.message.role === "user") {
      return "user message";
    }
    if (entry.message.role === "toolResult") {
      const toolName = entry.message.toolName?.trim();
      return toolName ? `tool result: ${toolName}` : "tool result";
    }
    if (entry.message.role === "assistant") {
      for (const content of entry.message.content) {
        if (content.type === "toolCall") {
          const toolName = content.name?.trim();
          return toolName ? `assistant tool use: ${toolName}` : "assistant tool use";
        }
      }
      return "assistant response";
    }
    return "message";
  }

  if (entry.type === "model_change") {
    return "model change";
  }

  if (entry.type === "thinking_level_change") {
    return "thinking level change";
  }

  if (entry.type === "compaction") {
    return "compaction";
  }

  if (entry.type === "branch_summary") {
    return "branch summary";
  }

  if (entry.type === "custom") {
    return "custom entry";
  }

  if (entry.type === "custom_message") {
    return "custom message";
  }

  if (entry.type === "label") {
    return "label";
  }

  if (entry.type === "session_info") {
    return "session info";
  }

  return "session entry";
}

export function extractSessionActivity(entries: SessionEntry[]): VigilSessionActivity {
  if (entries.length === 0) {
    return EMPTY_SESSION_ACTIVITY;
  }

  let steps = 0;
  let messages = 0;

  for (const entry of entries) {
    steps += 1;
    if (entry.type === "message") {
      messages += 1;
    }
  }

  const newestEntry = entries[entries.length - 1];
  const lastActivity = newestEntry ? describePersistedEntryActivity(newestEntry) : null;
  const lastActivityTimestamp = newestEntry?.timestamp ?? null;

  return {
    steps,
    messages,
    lastActivity,
    lastActivityTimestamp,
    recentMessages: extractRecentMessagePreviews(entries),
  };
}

function extractAssistantText(message: SessionEntry & { type: "message" }): string | null {
  if (message.message.role !== "assistant") {
    return null;
  }

  if (message.message.stopReason === "aborted" && message.message.content.length === 0) {
    return null;
  }

  let text = "";
  for (const content of message.message.content) {
    if (content.type === "text") {
      text += content.text;
    }
  }

  return text.trim() || null;
}

function isTerminalAssistantMessage(entry: SessionEntry & { type: "message" }): boolean {
  if (entry.message.role !== "assistant") {
    return false;
  }

  return entry.message.stopReason !== undefined && TERMINAL_STOP_REASONS.has(entry.message.stopReason);
}

export function extractLatestAssistantState(entries: SessionEntry[]): AssistantTurnState {
  let latestResponse: string | null = null;
  let lastConversationTimestamp: string | null = null;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") {
      continue;
    }

    if (lastConversationTimestamp === null) {
      lastConversationTimestamp = entry.timestamp;
    }

    const text = extractAssistantText(entry);
    if (text !== null) {
      latestResponse = text;
      break;
    }
  }

  let turnComplete = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") {
      continue;
    }

    const role = entry.message.role;
    if (role === "user" || role === "toolResult") {
      turnComplete = false;
      break;
    }

    if (role === "assistant") {
      turnComplete = isTerminalAssistantMessage(entry);
      break;
    }
  }

  return {
    latestResponse,
    turnComplete,
    lastConversationTimestamp,
  };
}

export function extractLatestAssistantText(entries: SessionEntry[]): string | null {
  return extractLatestAssistantState(entries).latestResponse;
}

export function getTurnStartedAt(record: { launchedAt?: string; sentAt?: string }): string {
  return record.sentAt ?? record.launchedAt ?? "";
}

export function deriveVigilState(input: {
  alive: boolean;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
  turnStartedAt: string;
}): "running" | "waiting" {
  if (!input.alive) {
    return "waiting";
  }

  if (!input.turnComplete) {
    return "running";
  }

  if (
    input.lastConversationTimestamp !== null &&
    input.turnStartedAt !== "" &&
    input.lastConversationTimestamp < input.turnStartedAt
  ) {
    return "running";
  }

  return "waiting";
}
