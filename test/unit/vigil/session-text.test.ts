import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readLatestAssistantTextFromFile } from "../../../src/vigil/node-runtime";
import { extractLatestAssistantText } from "../../../src/vigil/session-text";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

describe("child session text extraction", () => {
  it("reads the latest complete assistant text from Pi v3 session fixtures", () => {
    const fixturePath = path.join(fixturesDir, "../../fixtures/child-session-with-assistant.jsonl");
    const entries = parseSessionEntries(readFileSync(fixturePath, "utf8")).filter(
      (entry) => entry.type !== "session",
    ) as SessionEntry[];

    expect(extractLatestAssistantText(entries)).toBe("Hello from the child session.");
    expect(readLatestAssistantTextFromFile(fixturePath)).toBe("Hello from the child session.");
  });

  it("returns null when no assistant message exists", () => {
    const fixturePath = path.join(fixturesDir, "../../fixtures/child-session-without-assistant.jsonl");
    const raw = readFileSync(fixturePath, "utf8");
    expect(raw).toContain('"role":"user"');
    expect(readLatestAssistantTextFromFile(fixturePath)).toBeNull();
  });
});
