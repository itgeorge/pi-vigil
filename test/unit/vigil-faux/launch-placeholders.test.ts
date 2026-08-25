import type { AssistantMessage, Context, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { formatMutationSnapshotText, type VigilSnapshot } from "../../../src/vigil/types.js";
import {
  VigilFauxPlaceholderError,
  createScriptMatcher,
  extractLaunchIdsFromContext,
  parseVigilFauxScript,
  substituteLaunchPlaceholders,
} from "../../helpers/vigil-faux/index.js";

const LAUNCH_ID_0 = "vigil-11111111-1111-1111-1111-111111111111";
const LAUNCH_ID_1 = "vigil-22222222-2222-2222-2222-222222222222";

function contextWithUserText(text: string): Context {
  return {
    messages: [{ role: "user", content: text, timestamp: 1 }],
  };
}

function launchSnapshot(id: string, name: string): VigilSnapshot {
  return {
    id,
    sessionId: id,
    name,
    cwd: "/tmp/work",
    state: "running",
    latestResponse: null,
  };
}

function vigilLaunchToolResult(toolCallId: string, snapshot: VigilSnapshot): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "vigil",
    content: [{ type: "text", text: formatMutationSnapshotText(snapshot) }],
    details: snapshot,
    isError: false,
    timestamp: 2,
  };
}

function assistantLaunchToolCall(toolCallId: string, name: string): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: "vigil",
        arguments: { action: "launch", name, message: `Launch ${name}` },
      },
    ],
    api: "vigil-faux-api",
    provider: "vigil-faux",
    model: "scripted",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function contextWithTwoSuccessfulLaunches(marker: string): Context {
  const fast = launchSnapshot(LAUNCH_ID_0, "Orch Fast");
  const slow = launchSnapshot(LAUNCH_ID_1, "Orch Slow");

  return {
    messages: [
      { role: "user", content: marker, timestamp: 1 },
      assistantLaunchToolCall("call-fast", "Orch Fast"),
      vigilLaunchToolResult("call-fast", fast),
      assistantLaunchToolCall("call-slow", "Orch Slow"),
      vigilLaunchToolResult("call-slow", slow),
      { role: "user", content: marker, timestamp: 6 },
    ],
  };
}

function getToolCall(message: AssistantMessage): ToolCall | undefined {
  return message.content.find((part) => part.type === "toolCall");
}

describe("substituteLaunchPlaceholders", () => {
  it("substitutes exact $launch[0].id with the first launch id", () => {
    const result = substituteLaunchPlaceholders({ id: "$launch[0].id" }, [LAUNCH_ID_0, LAUNCH_ID_1]);

    expect(result).toEqual({ id: LAUNCH_ID_0 });
  });

  it("substitutes exact $launch[1].id with the second launch id", () => {
    const result = substituteLaunchPlaceholders({ id: "$launch[1].id" }, [LAUNCH_ID_0, LAUNCH_ID_1]);

    expect(result).toEqual({ id: LAUNCH_ID_1 });
  });

  it("throws a controlled error when the launch index is unresolved", () => {
    expect(() => substituteLaunchPlaceholders({ id: "$launch[2].id" }, [LAUNCH_ID_0])).toThrow(
      VigilFauxPlaceholderError,
    );
  });

  it("leaves non-placeholder strings unchanged", () => {
    const input = { id: LAUNCH_ID_0, note: "prefix $launch[0].id suffix" };
    const result = substituteLaunchPlaceholders(input, [LAUNCH_ID_0, LAUNCH_ID_1]);

    expect(result).toEqual(input);
  });
});

describe("extractLaunchIdsFromContext", () => {
  it("captures successful vigil launch ids in first-seen order", () => {
    const marker = "orch-marker-capture";
    const ids = extractLaunchIdsFromContext(contextWithTwoSuccessfulLaunches(marker));

    expect(ids).toEqual([LAUNCH_ID_0, LAUNCH_ID_1]);
  });
});

describe("createScriptMatcher launch placeholders", () => {
  it("substitutes $launch[0].id in toolCall arguments from context", () => {
    const marker = "orch-marker-complete-0";
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: marker },
          then: {
            type: "toolCall",
            name: "vigil",
            arguments: { action: "complete", id: "$launch[0].id" },
          },
        },
      ],
    });
    const matcher = createScriptMatcher(script);

    const result = matcher.match(contextWithTwoSuccessfulLaunches(marker));
    const toolCall = getToolCall(result);

    expect(toolCall?.arguments).toEqual({ action: "complete", id: LAUNCH_ID_0 });
  });

  it("substitutes $launch[1].id in toolCall arguments from context", () => {
    const marker = "orch-marker-complete-1";
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: marker },
          then: {
            type: "toolCall",
            name: "vigil",
            arguments: { action: "complete", id: "$launch[1].id" },
          },
        },
      ],
    });
    const matcher = createScriptMatcher(script);

    const result = matcher.match(contextWithTwoSuccessfulLaunches(marker));
    const toolCall = getToolCall(result);

    expect(toolCall?.arguments).toEqual({ action: "complete", id: LAUNCH_ID_1 });
  });

  it("throws a controlled error when a placeholder index is unresolved in context", () => {
    const marker = "orch-marker-unresolved";
    const script = parseVigilFauxScript({
      version: 1,
      steps: [
        {
          when: { userTextIncludes: marker },
          then: {
            type: "toolCall",
            name: "vigil",
            arguments: { action: "complete", id: "$launch[1].id" },
          },
        },
      ],
    });
    const matcher = createScriptMatcher(script);
    const context: Context = {
      messages: [
        { role: "user", content: marker, timestamp: 1 },
        assistantLaunchToolCall("call-fast", "Orch Fast"),
        vigilLaunchToolResult("call-fast", launchSnapshot(LAUNCH_ID_0, "Orch Fast")),
        { role: "user", content: marker, timestamp: 4 },
      ],
    };

    expect(() => matcher.match(context)).toThrow(VigilFauxPlaceholderError);
  });
});
