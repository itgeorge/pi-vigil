import type { VigilDirectSubagentInspection } from "./descendant-inspector";
import { formatDirectSubagentsSummaryText } from "./descendant-inspector";
import {
  MAX_DISPLAY_ID_CHARS,
  MAX_DISPLAY_METADATA_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  sanitizeReceiptField,
} from "./transcript";

export type VigilState = "running" | "waiting" | "completed" | "failed";

export interface VigilSnapshot {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  state: VigilState;
  latestResponse: string | null;
  completedAt?: string;
  directSubagents?: VigilDirectSubagentInspection;
  ephemeral?: true;
}

export interface VigilLaunchRecord {
  id: string;
  sessionId: string;
  name: string;
  pid: number;
  cwd: string;
  model?: string;
  sessionDir?: string;
  launchedAt: string;
  ephemeral?: true;
  allowSubagents?: false;
}

export interface VigilSettleRecord {
  id: string;
  sessionId: string;
  latestResponse: string | null;
  settledAt: string;
  stopReason?: string;
  error?: string;
}

export interface VigilTurnRecord {
  id: string;
  sessionId: string;
  pid: number;
  cwd: string;
  model?: string;
  sessionDir?: string;
  sentAt: string;
}

export interface VigilCompletionRecord {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  sessionDir?: string;
  completedAt: string;
}

export interface VigilFailRecord {
  id: string;
  sessionId: string;
  failedAt: string;
  error: string;
  source: "bootstrap" | "ephemeral-settle" | "turn";
  stderrExcerpt?: string;
}

export type VigilRuntimeRecord = VigilLaunchRecord | VigilTurnRecord;

export interface VigilListItem {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  state: VigilState;
  completedAt?: string;
  directSubagents?: VigilDirectSubagentInspection;
  ephemeral?: true;
}

export const DEFAULT_LIST_MAX_RESULTS = 20;
export const MAX_LIST_MAX_RESULTS = 50;

export interface ListInput {
  includeCompleted?: boolean;
  maxResults?: number;
  skipToId?: string;
}

export interface ListPolicy {
  includeCompleted: boolean;
  maxResults: number;
  skipToId?: string;
}

export interface VigilListResult {
  vigils: VigilListItem[];
  omittedCount: number;
  nextSkipToId?: string;
}

export function resolveListPolicy(input: ListInput = {}): ListPolicy | { error: string } {
  const maxResults = input.maxResults ?? DEFAULT_LIST_MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0 || maxResults > MAX_LIST_MAX_RESULTS) {
    return {
      error: `maxResults must be a positive safe integer no greater than ${MAX_LIST_MAX_RESULTS}`,
    };
  }

  let skipToId: string | undefined;
  if (input.skipToId !== undefined) {
    if (input.skipToId !== input.skipToId.trim()) {
      return { error: "skipToId must not contain leading or trailing whitespace" };
    }
    if (!input.skipToId) {
      return { error: "skipToId must be nonblank when supplied" };
    }
    skipToId = input.skipToId;
  }

  return {
    includeCompleted: input.includeCompleted ?? false,
    maxResults,
    ...(skipToId !== undefined ? { skipToId } : {}),
  };
}

export interface WaitInput {
  id?: string;
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  progress?: "status" | "none";
  progressIntervalMs?: number;
}

export interface VigilWaitPolicy {
  id?: string;
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  progress: "status" | "none";
  progressIntervalMs: number;
}

export type VigilWaitResult =
  | { outcome: "settled"; waitedMs: number; settled: VigilSnapshot[] }
  | { outcome: "timeout"; waitedMs: number; pending: VigilListItem[] }
  | { outcome: "empty"; waitedMs: 0 }
  | { outcome: "cancelled"; waitedMs: number; pending: VigilListItem[] };

export interface LaunchInput {
  name: string;
  message: string;
  cwd?: string;
  model?: string;
  parentCwd: string;
  ephemeral?: boolean;
  allowSubagents?: boolean;
}

export interface SendInput {
  vigilId: string;
  message: string;
  model?: string;
  parentCwd: string;
}

export interface CompleteInput {
  vigilId: string;
  parentCwd: string;
  allowIncompleteSubagents?: boolean;
}

export interface SearchInput {
  query: string;
  id?: string;
  includeCompleted?: boolean;
  maxResults?: number;
}

export interface ReadInput {
  id: string;
  entryId: string;
  before?: number;
  after?: number;
  includeCompleted?: boolean;
}

export type {
  VigilReadContextEntry,
  VigilReadResult,
  VigilSearchMatch,
  VigilSearchResult,
} from "./transcript";

export { formatReadText, formatSearchText } from "./transcript";

export interface VigilError {
  error: string;
}

export type VigilResult = VigilSnapshot | VigilError;
export type VigilListOrError = VigilListResult | VigilError;
export type VigilWaitOrError = VigilWaitResult | VigilError;

export type VigilSearchOrError = import("./transcript").VigilSearchResult | VigilError;
export type VigilReadOrError = import("./transcript").VigilReadResult | VigilError;

export function isVigilError(result: unknown): result is VigilError {
  return typeof result === "object" && result !== null && "error" in result;
}

export function formatEphemeralObservationUnavailableError(vigilId: string): string {
  return `Ephemeral Vigil child observation unavailable for ${vigilId}: parent restarted before settlement`;
}

export function formatEphemeralSendRejectedError(vigilId: string): string {
  return `Ephemeral Vigil child is single-turn and cannot be resumed: ${vigilId}`;
}

export function formatEphemeralTranscriptUnavailableError(vigilId: string): string {
  return `Ephemeral Vigil child has no retained transcript: ${vigilId}`;
}

export function createVigilId(): string {
  return `vigil-${crypto.randomUUID()}`;
}

export function normalizeVigilName(name: string): string | null {
  const normalized = name.trim();
  return normalized.length > 0 ? normalized : null;
}

export function formatMutationSnapshotText(snapshot: VigilSnapshot): string {
  const lines = [
    `id: ${sanitizeReceiptField(snapshot.id, MAX_DISPLAY_ID_CHARS)}`,
    `name: ${sanitizeReceiptField(snapshot.name, MAX_DISPLAY_NAME_CHARS)}`,
    `state: ${sanitizeReceiptField(snapshot.state, MAX_DISPLAY_METADATA_CHARS)}`,
  ];
  if (snapshot.completedAt) {
    lines.push(`completedAt: ${sanitizeReceiptField(snapshot.completedAt, MAX_DISPLAY_METADATA_CHARS)}`);
  }
  return lines.join("\n");
}

export function formatSnapshotText(snapshot: VigilSnapshot): string {
  const lines = [
    `id: ${snapshot.id}`,
    `sessionId: ${snapshot.sessionId}`,
    `name: ${snapshot.name}`,
    `cwd: ${snapshot.cwd}`,
    `state: ${snapshot.state}`,
    `latestResponse: ${snapshot.latestResponse ?? "null"}`,
  ];
  if (snapshot.completedAt) {
    lines.push(`completedAt: ${snapshot.completedAt}`);
  }
  if (snapshot.directSubagents) {
    lines.push(...formatDirectSubagentsSummaryText(snapshot.directSubagents));
  }
  return lines.join("\n");
}

function formatWaitPendingItemText(item: VigilListItem): string {
  const parts = [`id: ${item.id}`, `name: ${item.name}`, `state: ${item.state}`];
  if (item.completedAt) {
    parts.push(`completedAt: ${item.completedAt}`);
  }
  const lines = [parts.join(", ")];
  if (item.directSubagents) {
    lines.push(...formatDirectSubagentsSummaryText(item.directSubagents));
  }
  return lines.join("\n");
}

export function formatWaitText(result: VigilWaitResult): string {
  if (result.outcome === "empty") {
    return "outcome: empty\nwaitedMs: 0";
  }

  const header = [`outcome: ${result.outcome}`, `waitedMs: ${result.waitedMs}`];
  if (result.outcome === "settled") {
    header.push(`count: ${result.settled.length}`);
    if (result.settled.length === 0) {
      return header.join("\n");
    }
    return [...header, "", ...result.settled.map(formatSnapshotText)].join("\n");
  }

  header.push(`count: ${result.pending.length}`);
  if (result.pending.length === 0) {
    return header.join("\n");
  }
  return [...header, "", ...result.pending.map(formatWaitPendingItemText)].join("\n");
}

export function formatListText(result: VigilListResult): string {
  if (result.vigils.length === 0) {
    return "vigils: (none)";
  }

  const body = result.vigils
    .map((item) => {
      const parts = [
        `id: ${item.id}`,
        `name: ${item.name}`,
        `state: ${item.state}`,
        `cwd: ${item.cwd}`,
      ];
      if (item.ephemeral) {
        parts.push("ephemeral");
      }
      if (item.completedAt) {
        parts.push(`completedAt: ${item.completedAt}`);
      }
      const lines = [parts.join(", ")];
      if (item.directSubagents) {
        lines.push(...formatDirectSubagentsSummaryText(item.directSubagents));
      }
      return lines.join("\n");
    })
    .join("\n\n");

  if (result.omittedCount > 0 && result.nextSkipToId) {
    const safeNextSkipToId = sanitizeReceiptField(result.nextSkipToId, MAX_DISPLAY_ID_CHARS);
    return `${body}\n\n${result.omittedCount} more children omitted. Use maxResults to expand this page or skipToId to retrieve older children. next skipToId: ${safeNextSkipToId}`;
  }

  return body;
}
