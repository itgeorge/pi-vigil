import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChildSessionDescendantInspector } from "./descendant-inspector";
import type { VigilLifecycleState } from "./lifecycle";
import type { ChildSessionTranscript } from "./transcript";
import type { VigilSessionActivity } from "./session-text";
import type { EphemeralChildObserver } from "./ephemeral-observer";
import type { PersistedBootstrapObserver } from "./persisted-bootstrap-observer";
import type {
  VigilCompletionRecord,
  VigilFailRecord,
  VigilLaunchRecord,
  VigilSettleRecord,
  VigilTurnRecord,
} from "./types";

export interface SpawnChildInput {
  sessionId: string;
  message: string;
  cwd: string;
  model?: string;
  sessionDir?: string;
  name?: string;
  noSubagents?: boolean;
}

export interface TerminateAndWaitOptions {
  timeoutMs?: number;
}

export interface ProcessRunner {
  spawnDetached(input: SpawnChildInput): Promise<{ pid: number }>;
  isAlive(pid: number): boolean;
  terminateAndWait(pid: number, options?: TerminateAndWaitOptions): Promise<void>;
}

export type { VigilSessionActivity } from "./session-text";

export interface ChildSessionState {
  latestResponse: string | null;
  turnComplete: boolean;
  lastConversationTimestamp: string | null;
  activity: VigilSessionActivity;
}

export interface ChildSessionReader {
  readChildSessionState(input: {
    sessionId: string;
    cwd: string;
    sessionDir?: string;
  }): Promise<ChildSessionState>;
}

export interface ChildSessionTranscriptReader {
  readChildTranscript(input: {
    sessionId: string;
    cwd: string;
    sessionDir?: string;
  }): Promise<ChildSessionTranscript | { error: string }>;
}

export interface WaitScheduler {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<"elapsed" | "cancelled">;
}

export interface ChildSessionNamer {
  markCompleted(input: {
    sessionId: string;
    cwd: string;
    sessionDir?: string;
  }): Promise<{ completedName: string } | { error: string }>;
}

export interface ParentLedger {
  appendLaunch(record: VigilLaunchRecord): void;
  appendTurn(record: VigilTurnRecord): void;
  appendSettle(record: VigilSettleRecord): void;
  appendComplete(record: VigilCompletionRecord): void;
  appendFail(record: VigilFailRecord): void;
  getLifecycle(vigilId: string): VigilLifecycleState | null;
  listLifecycleStates(includeCompleted: boolean): VigilLifecycleState[];
}

export interface VigilServiceDeps {
  processRunner: ProcessRunner;
  childSessionReader: ChildSessionReader;
  childSessionTranscriptReader: ChildSessionTranscriptReader;
  childSessionNamer: ChildSessionNamer;
  parentLedger: ParentLedger;
  descendantInspector: ChildSessionDescendantInspector;
  ephemeralChildObserver?: EphemeralChildObserver;
  persistedBootstrapObserver?: PersistedBootstrapObserver;
  bootstrapFailFastTimeoutMs?: number;
  createId?: () => string;
  sessionDir?: string;
  reapTimeoutMs?: number;
  waitScheduler?: WaitScheduler;
  currentParentSessionId?: string;
  getSessionEntries?: () => SessionEntry[];
  getNoSubagentsFlag?: () => boolean;
}
