import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
}

const TERMINAL_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

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

export function extractLatestAssistantState(entries: SessionEntry[]): ChildSessionState {
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
