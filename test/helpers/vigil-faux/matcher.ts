import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
} from "@earendil-works/pi-ai";
import { extractLaunchIdsFromContext, substituteLaunchPlaceholders } from "./placeholders.js";
import {
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  type VigilFauxScript,
  type VigilFauxStepThen,
} from "./script.js";

export interface VigilFauxScriptMatcher {
  match(context: Context): AssistantMessage;
}

function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }

  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

function userContentToText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function getLatestUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") {
      return userContentToText(message.content);
    }
  }

  return "";
}

function buildStepResponse(then: VigilFauxStepThen, launchIds: string[]): AssistantMessage {
  switch (then.type) {
    case "text":
      return fauxAssistantMessage(then.text, { stopReason: "stop" });
    case "toolCall": {
      const arguments_ = substituteLaunchPlaceholders(then.arguments, launchIds) as Record<string, unknown>;
      return fauxAssistantMessage(fauxToolCall(then.name, arguments_), {
        stopReason: "toolUse",
      });
    }
    case "textAndToolCall": {
      const arguments_ = substituteLaunchPlaceholders(then.arguments, launchIds) as Record<string, unknown>;
      const content = [];
      if (then.text !== undefined) {
        content.push(fauxText(then.text));
      }
      content.push(fauxToolCall(then.name, arguments_));
      return fauxAssistantMessage(content, { stopReason: "toolUse" });
    }
  }
}

function buildFallbackResponse(fallbackText: string): AssistantMessage {
  return fauxAssistantMessage(fallbackText, { stopReason: "stop" });
}

export function createScriptMatcher(script: VigilFauxScript): VigilFauxScriptMatcher {
  const consumedStepIndices = new Set<number>();
  const fallbackText = script.fallbackText ?? VIGIL_FAUX_DEFAULT_FALLBACK_TEXT;

  return {
    match(context: Context): AssistantMessage {
      const userText = getLatestUserText(context.messages);
      const launchIds = extractLaunchIdsFromContext(context);

      for (let index = 0; index < script.steps.length; index++) {
        const step = script.steps[index];
        const reusable = step.reusable === true;

        if (!reusable && consumedStepIndices.has(index)) {
          continue;
        }

        if (!userText.includes(step.when.userTextIncludes)) {
          continue;
        }

        if (!reusable) {
          consumedStepIndices.add(index);
        }

        if (step.delayMs !== undefined && step.delayMs > 0) {
          sleepSync(step.delayMs);
        }

        return buildStepResponse(step.then, launchIds);
      }

      return buildFallbackResponse(fallbackText);
    },
  };
}
