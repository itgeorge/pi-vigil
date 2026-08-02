import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChildSessionTranscriptReader } from "../../src/vigil/ports";
import type { ChildSessionTranscript } from "../../src/vigil/transcript";
import { parseChildSessionTranscript } from "../../src/vigil/transcript";

export function createInMemoryTranscriptReader(
  transcripts: Record<string, ChildSessionTranscript | { error: string }>,
): ChildSessionTranscriptReader {
  return {
    async readChildTranscript({ sessionId }) {
      return transcripts[sessionId] ?? { error: `Child session not found: ${sessionId}` };
    },
  };
}

export function transcriptFromEntries(entries: SessionEntry[]): ChildSessionTranscript {
  return parseChildSessionTranscript(entries);
}
