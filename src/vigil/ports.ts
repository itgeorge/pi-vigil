import type { VigilLaunchRecord, VigilRuntimeRecord, VigilTurnRecord } from "./types";

export interface SpawnChildInput {
  sessionId: string;
  message: string;
  cwd: string;
  model?: string;
  sessionDir?: string;
}

export interface TerminateAndWaitOptions {
  timeoutMs?: number;
}

export interface ProcessRunner {
  spawnDetached(input: SpawnChildInput): Promise<{ pid: number }>;
  isAlive(pid: number): boolean;
  terminateAndWait(pid: number, options?: TerminateAndWaitOptions): Promise<void>;
}

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
}

export interface ChildSessionReader {
  readChildSessionState(input: {
    sessionId: string;
    cwd: string;
    sessionDir?: string;
  }): Promise<ChildSessionState>;
}

export interface ParentLedger {
  appendLaunch(record: VigilLaunchRecord): void;
  appendTurn(record: VigilTurnRecord): void;
  findLatestTurn(vigilId: string): VigilRuntimeRecord | null;
}

export interface VigilServiceDeps {
  processRunner: ProcessRunner;
  childSessionReader: ChildSessionReader;
  parentLedger: ParentLedger;
  createId?: () => string;
  sessionDir?: string;
  reapTimeoutMs?: number;
}
