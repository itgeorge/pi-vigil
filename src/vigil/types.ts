export type VigilState = "running" | "waiting" | "completed";

export interface VigilSnapshot {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  state: VigilState;
  latestResponse: string | null;
  completedAt?: string;
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

export type VigilRuntimeRecord = VigilLaunchRecord | VigilTurnRecord;

export interface VigilListItem {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  state: VigilState;
  completedAt?: string;
}

export interface VigilListResult {
  vigils: VigilListItem[];
}

export interface WaitInput {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface VigilWaitPolicy {
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
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
}

export interface VigilError {
  error: string;
}

export type VigilResult = VigilSnapshot | VigilError;
export type VigilListOrError = VigilListResult | VigilError;
export type VigilWaitOrError = VigilWaitResult | VigilError;

export function isVigilError(result: unknown): result is VigilError {
  return typeof result === "object" && result !== null && "error" in result;
}

export function createVigilId(): string {
  return `vigil-${crypto.randomUUID()}`;
}

export function normalizeVigilName(name: string): string | null {
  const normalized = name.trim();
  return normalized.length > 0 ? normalized : null;
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
  return lines.join("\n");
}

export function formatWaitText(result: VigilWaitResult): string {
  if (result.outcome === "empty") {
    return "outcome: empty\nwaitedMs: 0";
  }

  const items = result.outcome === "settled" ? result.settled : result.pending;
  return [`outcome: ${result.outcome}`, `waitedMs: ${result.waitedMs}`, `count: ${items.length}`].join("\n");
}

export function formatListText(result: VigilListResult): string {
  if (result.vigils.length === 0) {
    return "vigils: (none)";
  }

  return result.vigils
    .map((item) => {
      const parts = [
        `id: ${item.id}`,
        `name: ${item.name}`,
        `state: ${item.state}`,
        `cwd: ${item.cwd}`,
      ];
      if (item.completedAt) {
        parts.push(`completedAt: ${item.completedAt}`);
      }
      return parts.join(", ");
    })
    .join("\n");
}
