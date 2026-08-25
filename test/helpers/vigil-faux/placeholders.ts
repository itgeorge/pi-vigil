import type { Context, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

const LAUNCH_PLACEHOLDER_PATTERN = /^\$launch\[(\d+)\]\.id$/;
const LAUNCH_ID_TEXT_PATTERN = /^id:\s*(.+)$/m;

export class VigilFauxPlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VigilFauxPlaceholderError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function substituteValue(value: unknown, launchIds: string[]): unknown {
  if (typeof value === "string") {
    const match = value.match(LAUNCH_PLACEHOLDER_PATTERN);
    if (!match) {
      return value;
    }

    const index = Number(match[1]);
    const launchId = launchIds[index];
    if (launchId === undefined) {
      throw new VigilFauxPlaceholderError(`Unresolved launch placeholder: ${value}`);
    }

    return launchId;
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, launchIds));
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = substituteValue(child, launchIds);
    }
    return result;
  }

  return value;
}

export function substituteLaunchPlaceholders(value: unknown, launchIds: string[]): unknown {
  return substituteValue(value, launchIds);
}

function extractIdFromToolResultText(content: ToolResultMessage["content"]): string | undefined {
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;

  for (const block of blocks) {
    if (block.type !== "text") {
      continue;
    }

    const match = block.text.match(LAUNCH_ID_TEXT_PATTERN);
    if (match) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractIdFromToolResult(message: ToolResultMessage): string | undefined {
  if (isRecord(message.details) && typeof message.details.id === "string") {
    return message.details.id;
  }

  return extractIdFromToolResultText(message.content);
}

function findVigilLaunchToolCall(messages: Message[], toolCallId: string): ToolCall | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.content) {
      if (part.type !== "toolCall" || part.id !== toolCallId || part.name !== "vigil") {
        continue;
      }

      if (isRecord(part.arguments) && part.arguments.action === "launch") {
        return part;
      }
    }
  }

  return undefined;
}

export function extractLaunchIdsFromContext(context: Context): string[] {
  const launchIds: string[] = [];

  for (const message of context.messages) {
    if (message.role !== "toolResult" || message.toolName !== "vigil" || message.isError) {
      continue;
    }

    if (!findVigilLaunchToolCall(context.messages, message.toolCallId)) {
      continue;
    }

    const launchId = extractIdFromToolResult(message);
    if (launchId !== undefined) {
      launchIds.push(launchId);
    }
  }

  return launchIds;
}
