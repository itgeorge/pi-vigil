import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  VigilFauxScriptError,
  createScriptMatcher,
  parseVigilFauxScript,
} from "../../helpers/vigil-faux/index.js";

function contextWithUserText(text: string): Context {
  return {
    messages: [{ role: "user", content: text, timestamp: 1 }],
  };
}

function getTextContent(message: AssistantMessage): string | undefined {
  const block = message.content.find((part) => part.type === "text");
  return block?.type === "text" ? block.text : undefined;
}

function getToolCall(message: AssistantMessage): ToolCall | undefined {
  return message.content.find((part) => part.type === "toolCall");
}

describe("parseVigilFauxScript", () => {
  it("throws a controlled error for an unsupported version", () => {
    expect(() => parseVigilFauxScript({ version: 2, steps: [] })).toThrow(VigilFauxScriptError);
  });

  it("throws a controlled error when steps is missing", () => {
    expect(() => parseVigilFauxScript({ version: 1 })).toThrow(VigilFauxScriptError);
  });
});

describe("createScriptMatcher", () => {
  it("returns the default fallback when no step matches", () => {
    const script = parseVigilFauxScript({ version: 1, steps: [] });
    const matcher = createScriptMatcher(script);

    const result = matcher.match(contextWithUserText("unmatched prompt"));

    expect(getTextContent(result)).toBe(VIGIL_FAUX_DEFAULT_FALLBACK_TEXT);
    expect(result.stopReason).toBe("stop");
  });

  it("returns a text step when userTextIncludes matches the latest user message", () => {
    const script = parseVigilFauxScript({
      version: 1,
      steps: [{ when: { userTextIncludes: "marker-abc" }, then: { type: "text", text: "scripted reply" } }],
    });
    const matcher = createScriptMatcher(script);

    const result = matcher.match(contextWithUserText("please handle marker-abc now"));

    expect(getTextContent(result)).toBe("scripted reply");
    expect(result.stopReason).toBe("stop");
  });

  it("returns a toolCall step with the configured name and arguments", () => {
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: "launch child" },
          then: {
            type: "toolCall",
            name: "vigil",
            arguments: { action: "launch", name: "Faux child", message: "Do work" },
          },
        },
      ],
    });
    const matcher = createScriptMatcher(script);

    const result = matcher.match(contextWithUserText("please launch child for me"));

    const toolCall = getToolCall(result);
    expect(toolCall?.name).toBe("vigil");
    expect(toolCall?.arguments).toEqual({
      action: "launch",
      name: "Faux child",
      message: "Do work",
    });
    expect(result.stopReason).toBe("toolUse");
  });

  it("consumes one-shot steps so a second match falls back", () => {
    const script = parseVigilFauxScript({
      version: 1,
      steps: [{ when: { userTextIncludes: "once-only" }, then: { type: "text", text: "first hit" } }],
    });
    const matcher = createScriptMatcher(script);
    const context = contextWithUserText("trigger once-only marker");

    expect(getTextContent(matcher.match(context))).toBe("first hit");
    expect(getTextContent(matcher.match(context))).toBe(VIGIL_FAUX_DEFAULT_FALLBACK_TEXT);
  });

  it("advances to the next step after a consumed one-shot step matches again", () => {
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        { when: { userTextIncludes: "queue" }, then: { type: "text", text: "step one" } },
        { when: { userTextIncludes: "queue" }, then: { type: "text", text: "step two" } },
      ],
    });
    const matcher = createScriptMatcher(script);
    const context = contextWithUserText("run the queue");

    expect(getTextContent(matcher.match(context))).toBe("step one");
    expect(getTextContent(matcher.match(context))).toBe("step two");
  });

  it("matches reusable steps on every call", () => {
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: "repeat-me" },
          then: { type: "text", text: "repeatable" },
          reusable: true,
        },
      ],
    });
    const matcher = createScriptMatcher(script);
    const context = contextWithUserText("please repeat-me again");

    expect(getTextContent(matcher.match(context))).toBe("repeatable");
    expect(getTextContent(matcher.match(context))).toBe("repeatable");
  });

  it("delays before emitting a matched step when delayMs is set on the step", () => {
    const delayMs = 80;
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: "delay-marker" },
          then: { type: "text", text: "delayed reply" },
          delayMs,
        },
      ],
    });
    const matcher = createScriptMatcher(script);
    const start = performance.now();

    const result = matcher.match(contextWithUserText("please delay-marker now"));
    const elapsed = performance.now() - start;

    expect(getTextContent(result)).toBe("delayed reply");
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 15);
  });
});
