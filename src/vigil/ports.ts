import type { VigilLaunchRecord } from "./types";

export interface SpawnChildInput {
  sessionId: string;
  message: string;
  cwd: string;
  model?: string;
  sessionDir?: string;
}

export interface ProcessRunner {
  spawnDetached(input: SpawnChildInput): Promise<{ pid: number }>;
  isAlive(pid: number): boolean;
}

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
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
  findLaunch(vigilId: string): VigilLaunchRecord | null;
}

export interface VigilServiceDeps {
  processRunner: ProcessRunner;
  childSessionReader: ChildSessionReader;
  parentLedger: ParentLedger;
  createId?: () => string;
  sessionDir?: string;
}
