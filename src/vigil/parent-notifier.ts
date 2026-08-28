import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Total LLM-visible content cap for vigil-notify messages (prefix + excerpt). */
export const MAX_VIGIL_NOTIFY_CONTENT_CHARS = 500;

export interface ParentNotifierSettleInput {
  id: string;
  name: string;
  state: "waiting" | "failed";
  latestResponse: string | null;
  error?: string;
}

export interface ParentNotifier {
  notifySettled(input: ParentNotifierSettleInput): void;
}

export interface VigilNotifyMessage {
  content: string;
  details: {
    id: string;
    name: string;
    state: "waiting" | "failed";
    latestResponse: string | null;
    error?: string;
  };
}

function boundExcerpt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (maxChars <= 1) {
    return "…";
  }
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

export function formatVigilNotifyPrefix(input: Pick<ParentNotifierSettleInput, "name" | "id" | "state">): string {
  const verb = input.state === "failed" ? "failed" : "settled";
  return `[vigil:${input.name} ${input.id}] ${verb}`;
}

export function formatVigilNotifyMessage(input: ParentNotifierSettleInput): VigilNotifyMessage {
  const prefix = formatVigilNotifyPrefix(input);
  const bodySource =
    input.state === "failed"
      ? input.error?.trim() || input.latestResponse?.trim() || "child failed"
      : input.latestResponse?.trim() || "";
  const maxBodyChars = Math.max(0, MAX_VIGIL_NOTIFY_CONTENT_CHARS - prefix.length - (bodySource ? 1 : 0));
  const body = bodySource ? boundExcerpt(bodySource, maxBodyChars) : "";
  let content = body ? `${prefix}\n${body}` : prefix;
  if (content.length > MAX_VIGIL_NOTIFY_CONTENT_CHARS) {
    content = boundExcerpt(content, MAX_VIGIL_NOTIFY_CONTENT_CHARS);
  }

  return {
    content,
    details: {
      id: input.id,
      name: input.name,
      state: input.state,
      latestResponse: input.latestResponse,
      ...(input.error ? { error: input.error } : {}),
    },
  };
}

export function createExtensionParentNotifier(sendMessage: ExtensionAPI["sendMessage"]): ParentNotifier {
  return {
    notifySettled(input) {
      const { content, details } = formatVigilNotifyMessage(input);
      void sendMessage(
        {
          customType: "vigil-notify",
          content,
          display: true,
          details,
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    },
  };
}

export function createNoopParentNotifier(): ParentNotifier {
  return {
    notifySettled() {
      // Tests and contexts without a parent Pi session.
    },
  };
}

export function createRecordingParentNotifier(): ParentNotifier & {
  calls: ParentNotifierSettleInput[];
} {
  const calls: ParentNotifierSettleInput[] = [];
  return {
    calls,
    notifySettled(input) {
      calls.push({ ...input });
    },
  };
}

export function createShutdownAwareParentNotifier(inner: ParentNotifier): ParentNotifier & {
  shutdown(): void;
} {
  let shutdownRequested = false;
  return {
    notifySettled(input) {
      if (shutdownRequested) {
        return;
      }
      inner.notifySettled(input);
    },
    shutdown() {
      shutdownRequested = true;
    },
  };
}
