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
import {
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  type VigilFauxScript,
  type VigilFauxStepThen,
} from "./script.js";

export interface VigilFauxScriptMatcher {
  match(context: Context): AssistantMessage;
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

function buildStepResponse(then: VigilFauxStepThen): AssistantMessage {
  switch (then.type) {
    case "text":
      return fauxAssistantMessage(then.text, { stopReason: "stop" });
    case "toolCall":
      return fauxAssistantMessage(fauxToolCall(then.name, then.arguments), {
        stopReason: "toolUse",
      });
    case "textAndToolCall": {
      const content = [];
      if (then.text !== undefined) {
        content.push(fauxText(then.text));
      }
      content.push(fauxToolCall(then.name, then.arguments));
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

        return buildStepResponse(step.then);
      }

      return buildFallbackResponse(fallbackText);
    },
  };
}
