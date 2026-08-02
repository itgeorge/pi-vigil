import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface AssistantTurnState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
}

export interface VigilSessionActivity {
  steps: number;
  messages: number;
  lastActivity: string | null;
  lastActivityTimestamp: string | null;
}

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
  activity: VigilSessionActivity;
}

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

const EMPTY_SESSION_ACTIVITY: VigilSessionActivity = {
  steps: 0,
  messages: 0,
  lastActivity: null,
  lastActivityTimestamp: null,
};

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
