import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
}

export function extractLatestAssistantState(entries: SessionEntry[]): ChildSessionState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message") {
      continue;
    }

    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }

    if (message.stopReason === "aborted" && message.content.length === 0) {
      continue;
    }

    let text = "";
    for (const content of message.content) {
      if (content.type === "text") {
        text += content.text;
      }
    }

    const turnComplete = message.stopReason !== undefined && message.stopReason !== "pending";

    return {
      latestResponse: text.trim() || null,
      turnComplete,
    };
  }

  return {
    latestResponse: null,
    turnComplete: false,
  };
}

export function extractLatestAssistantText(entries: SessionEntry[]): string | null {
  return extractLatestAssistantState(entries).latestResponse;
}
