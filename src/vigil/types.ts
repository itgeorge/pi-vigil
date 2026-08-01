export type VigilState = "running" | "waiting";

export interface VigilSnapshot {
  id: string;
  sessionId: string;
  cwd: string;
  state: VigilState;
  latestResponse: string | null;
}

export interface VigilLaunchRecord {
  id: string;
  sessionId: string;
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

export type VigilRuntimeRecord = VigilLaunchRecord | VigilTurnRecord;

export interface LaunchInput {
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

export interface VigilError {
  error: string;
}

export type VigilResult = VigilSnapshot | VigilError;

export function isVigilError(result: VigilResult): result is VigilError {
  return "error" in result;
}

export function createVigilId(): string {
  return `vigil-${crypto.randomUUID()}`;
}

export function formatSnapshotText(snapshot: VigilSnapshot): string {
  const lines = [
    `id: ${snapshot.id}`,
    `sessionId: ${snapshot.sessionId}`,
    `cwd: ${snapshot.cwd}`,
    `state: ${snapshot.state}`,
    `latestResponse: ${snapshot.latestResponse ?? "null"}`,
  ];
  return lines.join("\n");
}
