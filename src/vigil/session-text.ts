import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function extractLatestAssistantText(entries: SessionEntry[]): string | null {
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

    const trimmed = text.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}
