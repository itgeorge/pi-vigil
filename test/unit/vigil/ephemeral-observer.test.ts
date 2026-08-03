import { describe, expect, it } from "vitest";
import {
  MAX_EPHEMERAL_JSON_LINE_BYTES,
  MAX_EPHEMERAL_LATEST_RESPONSE_CHARS,
  EphemeralJsonLineBuffer,
  applyEphemeralJsonEvent,
  buildPiEphemeralChildArgs,
  createFakeEphemeralChildObserver,
  createInitialEphemeralObserverState,
  deriveEphemeralLiveState,
  parseEphemeralJsonLine,
} from "../../../src/vigil/ephemeral-observer";

describe("ephemeral JSON output parser", () => {
  it("parses split JSON lines and settles on agent_settled with bounded final response", () => {
    let state = createInitialEphemeralObserverState();
    const chunks = [
      "{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello",
      " world\"}],\"stopReason\":\"stop\"}}\n",
      "{\"type\":\"agent_settled\"}\n",
    ];

    const buffer = new EphemeralJsonLineBuffer();
    for (const chunk of chunks) {
      for (const line of buffer.feed(chunk)) {
        const event = parseEphemeralJsonLine(line);
        expect(event).not.toBeNull();
        state = applyEphemeralJsonEvent(state, event!);
      }
    }

    expect(state.settled).toBe(true);
    expect(state.latestResponse).toBe("Hello world");
    expect(deriveEphemeralLiveState(state)).toEqual({
      state: "waiting",
      latestResponse: "Hello world",
    });
  });

  it("handles CRLF input, malformed lines, and oversized lines without crashing", () => {
    const buffer = new EphemeralJsonLineBuffer();
    const oversized = "x".repeat(MAX_EPHEMERAL_JSON_LINE_BYTES + 1);
    const lines = buffer.feed(`not-json\r\n${oversized}\r\n{"type":"agent_settled"}\r\n`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("not-json");
    expect(buffer.getOversizedLineCount()).toBe(1);
    expect(parseEphemeralJsonLine("not-json")).toBeNull();

    let state = createInitialEphemeralObserverState();
    state = applyEphemeralJsonEvent(state, parseEphemeralJsonLine(lines[1]!)!);
    expect(state.settled).toBe(true);
    expect(state.error).toContain("without terminal assistant response");
  });

  it("caps retained final responses at the diagnostic limit", () => {
    const longText = "Z".repeat(MAX_EPHEMERAL_LATEST_RESPONSE_CHARS + 50);
    let state = createInitialEphemeralObserverState();
    state = applyEphemeralJsonEvent(state, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: longText }],
        stopReason: "stop",
      },
    });
    state = applyEphemeralJsonEvent(state, { type: "agent_settled" });

    expect(state.latestResponse).toHaveLength(MAX_EPHEMERAL_LATEST_RESPONSE_CHARS + 1);
    expect(state.latestResponse?.endsWith("…")).toBe(true);
  });

  it("builds ephemeral pi args with --no-session and without session-id", () => {
    expect(
      buildPiEphemeralChildArgs({
        message: "Do work",
        name: "Quick task",
        model: "openai-codex/gpt-5.5",
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--name",
      "Quick task",
      "--model",
      "openai-codex/gpt-5.5",
      "Do work",
    ]);
  });
});

describe("fake ephemeral child observer", () => {
  it("settles asynchronously and skips onSettled after shutdown", async () => {
    const observer = createFakeEphemeralChildObserver();
    const settled: string[] = [];

    const { pid } = await observer.start({
      vigilId: "vigil-ephemeral-test",
      parentSessionId: "parent-session",
      message: "Reply",
      cwd: "/parent/project",
      name: "Quick",
      onSettled: (result) => {
        settled.push(result.latestResponse ?? "null");
      },
    });

    expect(pid).toBe(9000);
    observer.pushStdout(
      "vigil-ephemeral-test",
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"stopReason":"stop"}}\n{"type":"agent_settled"}\n',
    );

    expect(settled).toEqual(["Done"]);
    expect(observer.getLiveState("vigil-ephemeral-test")).toBeNull();

    await observer.start({
      vigilId: "vigil-ephemeral-2",
      parentSessionId: "parent-session",
      message: "Again",
      cwd: "/parent/project",
      onSettled: () => settled.push("after-shutdown"),
    });

    await observer.shutdown();
    observer.pushStdout(
      "vigil-ephemeral-2",
      '{"type":"agent_settled"}\n',
    );
    expect(observer.shutdownCalls).toBe(1);
    expect(settled).toEqual(["Done"]);
  });
});
