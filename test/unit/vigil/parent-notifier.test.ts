import { describe, expect, it } from "vitest";
import {
  createExtensionParentNotifier,
  formatVigilNotifyMessage,
  formatVigilNotifyPrefix,
  MAX_VIGIL_NOTIFY_CONTENT_CHARS,
} from "../../../src/vigil/parent-notifier";

describe("parent notifier formatting", () => {
  it("formats success settle content with bounded excerpt", () => {
    const message = formatVigilNotifyMessage({
      id: "vigil-abc",
      name: "Quick task",
      state: "waiting",
      latestResponse: "All done.",
    });

    expect(message.content).toBe("[vigil:Quick task vigil-abc] settled\nAll done.");
    expect(message.details).toEqual({
      id: "vigil-abc",
      name: "Quick task",
      state: "waiting",
      latestResponse: "All done.",
    });
  });

  it("formats failed settle content with error excerpt", () => {
    const message = formatVigilNotifyMessage({
      id: "vigil-fail",
      name: "Broken",
      state: "failed",
      latestResponse: null,
      error: "ephemeral child exited (code 1)",
    });

    expect(message.content).toBe(
      "[vigil:Broken vigil-fail] failed\nephemeral child exited (code 1)",
    );
    expect(message.details.state).toBe("failed");
    expect(message.details.error).toBe("ephemeral child exited (code 1)");
  });

  it("keeps total content within MAX_VIGIL_NOTIFY_CONTENT_CHARS", () => {
    const longResponse = "x".repeat(800);
    const message = formatVigilNotifyMessage({
      id: "vigil-long",
      name: "Long",
      state: "waiting",
      latestResponse: longResponse,
    });

    expect(message.content.length).toBeLessThanOrEqual(MAX_VIGIL_NOTIFY_CONTENT_CHARS);
    expect(message.content.startsWith(formatVigilNotifyPrefix({ name: "Long", id: "vigil-long", state: "waiting" }))).toBe(
      true,
    );
    expect(message.content.endsWith("…")).toBe(true);
  });
});

describe("extension parent notifier adapter", () => {
  it("calls sendMessage with vigil-notify steer delivery", () => {
    const calls: Array<{ message: unknown; options: unknown }> = [];
    const notifier = createExtensionParentNotifier(async (message, options) => {
      calls.push({ message, options });
    });

    notifier.notifySettled({
      id: "vigil-1",
      name: "Child",
      state: "waiting",
      latestResponse: "OK",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toEqual({
      customType: "vigil-notify",
      content: "[vigil:Child vigil-1] settled\nOK",
      display: true,
      details: {
        id: "vigil-1",
        name: "Child",
        state: "waiting",
        latestResponse: "OK",
      },
    });
    expect(calls[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
  });
});
