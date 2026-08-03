import { readFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
  type SessionManager as SessionManagerType,
} from "@earendil-works/pi-coding-agent";
import {
  createNodeChildSessionDescendantInspector,
  createZeroDescendantInspector,
  formatIncompleteSubagentCompleteError,
  type VigilDirectSubagentInspection,
} from "./descendant-inspector";
import {
  createNodeEphemeralChildObserver,
  createNoopEphemeralChildObserver,
  type EphemeralChildObserver,
} from "./ephemeral-observer";
import {
  lifecycleStateToListItem,
  reconstructVigilLifecycleFromEntries,
  sortLifecycleStatesMostRecentFirst,
  deriveDiagnosticChildIdentity,
  isEphemeralLifecycle,
  type VigilLifecycleState,
} from "./lifecycle";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ChildSessionTranscriptReader,
  ChildSessionState,
  ParentLedger,
  ProcessRunner,
  SpawnChildInput,
  TerminateAndWaitOptions,
  VigilServiceDeps,
  VigilSessionActivity,
  WaitScheduler,
} from "./ports";
import { extractLatestAssistantState, deriveVigilState, getTurnStartedAt, extractSessionActivity } from "./session-text";
import {
  parseChildSessionTranscript,
  readTranscriptWindow,
  resolveReadPolicy,
  resolveSearchPolicy,
  searchTranscriptEntries,
  type ChildSessionTranscript,
  type VigilReadResult,
  type VigilSearchResult,
} from "./transcript";
import {
  boundWaitProgressItems,
  computeNextPollInMs,
  DEFAULT_WAIT_PROGRESS_INTERVAL_MS,
  fingerprintWaitProgress,
  MAX_WAIT_PROGRESS_INTERVAL_MS,
  type VigilWaitProgress,
  type VigilWaitProgressItem,
} from "./wait-progress";
import {
  createVigilId,
  normalizeVigilName,
  type ListInput,
  type ReadInput,
  type SearchInput,
  resolveListPolicy,
  type VigilReadOrError,
  type VigilSearchOrError,
  type CompleteInput,
  type LaunchInput,
  type SendInput,
  type VigilCompletionRecord,
  type VigilLaunchRecord,
  type VigilListItem,
  type VigilListOrError,
  type VigilResult,
  type VigilRuntimeRecord,
  type VigilSettleRecord,
  type VigilSnapshot,
  type VigilTurnRecord,
  type VigilWaitOrError,
  type VigilWaitPolicy,
  type VigilWaitResult,
  type WaitInput,
  formatEphemeralObservationUnavailableError,
  formatEphemeralSendRejectedError,
  formatEphemeralTranscriptUnavailableError,
} from "./types";

const DEFAULT_REAP_TIMEOUT_MS = 5000;
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
export const DEFAULT_WAIT_PROGRESS_MODE = "status" as const;
export {
  DEFAULT_WAIT_PROGRESS_INTERVAL_MS,
  MAX_WAIT_PROGRESS_INTERVAL_MS,
  MAX_WAIT_PROGRESS_ITEMS,
} from "./wait-progress";
export type { VigilWaitProgress, VigilWaitProgressItem } from "./wait-progress";
export const DEFAULT_WAIT_INITIAL_DELAY_MS = 500;
export const DEFAULT_WAIT_MAX_DELAY_MS = 5_000;
export const MAX_WAIT_TIMEOUT_MS = 300_000;
export const MAX_WAIT_DELAY_MS = 30_000;
const REAP_POLL_INTERVAL_MS = 50;

const EMPTY_EPHEMERAL_ACTIVITY: VigilSessionActivity = {
  steps: 0,
  messages: 0,
  lastActivity: null,
  lastActivityTimestamp: null,
  recentMessages: [],
};

let sharedEphemeralChildObserver: EphemeralChildObserver | undefined;

export function getSharedEphemeralChildObserver(
  processRunner: ProcessRunner,
  reapTimeoutMs?: number,
): EphemeralChildObserver {
  if (!sharedEphemeralChildObserver) {
    sharedEphemeralChildObserver = createNodeEphemeralChildObserver({ processRunner, reapTimeoutMs });
  }
  return sharedEphemeralChildObserver;
}

export function resetSharedEphemeralChildObserverForTests(): void {
  sharedEphemeralChildObserver = undefined;
}

export async function shutdownSharedEphemeralChildObserver(
  options?: TerminateAndWaitOptions,
): Promise<void> {
  await sharedEphemeralChildObserver?.shutdown(options);
  sharedEphemeralChildObserver = undefined;
}

export { buildPiEphemeralChildArgs } from "./ephemeral-observer";

type WaitCohortScan = {
  lifecycle: VigilLifecycleState;
  snapshot: VigilSnapshot;
  activity: VigilSessionActivity;
  directSubagents?: VigilDirectSubagentInspection;
};

type CurrentSessionLifecycleAction = "poll" | "send" | "complete" | "wait";

function formatCurrentSessionLifecycleError(action: CurrentSessionLifecycleAction): string {
  return `Cannot ${action} the current Vigil session.`;
}

export class VigilService {
  private readonly deps: VigilServiceDeps & { ephemeralChildObserver: EphemeralChildObserver };

  constructor(deps: VigilServiceDeps) {
    this.deps = {
      ...deps,
      ephemeralChildObserver: deps.ephemeralChildObserver ?? createNoopEphemeralChildObserver(),
    };
  }

  async launch(input: LaunchInput): Promise<VigilResult> {
    const normalizedName = normalizeVigilName(input.name);
    if (!normalizedName) {
      return { error: "launch requires name" };
    }

    if (!input.message.trim()) {
      return { error: "launch requires message" };
    }

    const id = this.deps.createId?.() ?? createVigilId();
    const sessionId = id;
    const cwd = input.cwd ?? input.parentCwd;
    const turnStartedAt = new Date().toISOString();

    let pid: number;

    if (input.ephemeral) {
      const parentSessionId = this.deps.currentParentSessionId ?? sessionId;
      let activate: () => void;
      try {
        ({ pid, activate } = await this.deps.ephemeralChildObserver.start({
          vigilId: id,
          parentSessionId,
          message: input.message,
          cwd,
          model: input.model,
          name: normalizedName,
          onSettled: (result) => {
            const current = this.deps.parentLedger.getLifecycle(id);
            if (!current || current.settleRecord || current.completionRecord) {
              return;
            }
            if (parentSessionId !== this.deps.currentParentSessionId) {
              return;
            }
            const settleRecord: VigilSettleRecord = {
              id,
              sessionId,
              latestResponse: result.latestResponse,
              settledAt: result.settledAt,
              ...(result.stopReason ? { stopReason: result.stopReason } : {}),
              ...(result.error ? { error: result.error } : {}),
            };
            this.deps.parentLedger.appendSettle(settleRecord);
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to launch ephemeral Pi child: ${message}` };
      }

      const record: VigilLaunchRecord = {
        id,
        sessionId,
        name: normalizedName,
        pid,
        cwd,
        model: input.model,
        launchedAt: turnStartedAt,
        ephemeral: true,
      };

      this.deps.parentLedger.appendLaunch(record);
      activate();

      return {
        id,
        sessionId,
        name: normalizedName,
        cwd,
        state: "running",
        latestResponse: null,
        ephemeral: true,
      };
    }

    try {
      ({ pid } = await this.deps.processRunner.spawnDetached({
        sessionId,
        message: input.message,
        cwd,
        model: input.model,
        sessionDir: this.deps.sessionDir,
        name: normalizedName,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to launch Pi child: ${message}` };
    }

    const record: VigilLaunchRecord = {
      id,
      sessionId,
      name: normalizedName,
      pid,
      cwd,
      model: input.model,
      sessionDir: this.deps.sessionDir,
      launchedAt: turnStartedAt,
    };

    this.deps.parentLedger.appendLaunch(record);

    return {
      id,
      sessionId,
      name: normalizedName,
      cwd,
      state: "running",
      latestResponse: null,
    };
  }

  async poll(vigilId: string): Promise<VigilResult> {
    const lifecycle = this.getLifecycleState(vigilId);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${vigilId}` };
    }

    const currentSessionRejection = this.rejectIfCurrentSessionTarget(lifecycle, "poll");
    if (currentSessionRejection) {
      return currentSessionRejection;
    }

    if (lifecycle.completionRecord) {
      return this.buildCompletedSnapshot(lifecycle);
    }

    if (isEphemeralLifecycle(lifecycle)) {
      const ephemeralSnapshot = this.resolveEphemeralActiveSnapshot(lifecycle);
      if ("error" in ephemeralSnapshot) {
        return ephemeralSnapshot;
      }
      return ephemeralSnapshot;
    }

    return this.buildActiveSnapshot(lifecycle);
  }

  async send(input: SendInput): Promise<VigilResult> {
    if (!input.message.trim()) {
      return { error: "send requires message" };
    }

    const lifecycle = this.getLifecycleState(input.vigilId);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${input.vigilId}` };
    }

    const currentSessionRejection = this.rejectIfCurrentSessionTarget(lifecycle, "send");
    if (currentSessionRejection) {
      return currentSessionRejection;
    }

    if (lifecycle.completionRecord) {
      return { error: `Vigil child is completed: ${input.vigilId}` };
    }

    if (isEphemeralLifecycle(lifecycle)) {
      return { error: formatEphemeralSendRejectedError(input.vigilId) };
    }

    const record = lifecycle.runtimeRecord;
    const snapshot = await this.buildActiveSnapshot(lifecycle);

    if (snapshot.state === "running") {
      return { error: `Vigil child is still running: ${input.vigilId}` };
    }

    if (this.deps.processRunner.isAlive(record.pid)) {
      try {
        await this.deps.processRunner.terminateAndWait(record.pid, {
          timeoutMs: this.deps.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to reap settled Pi child before send: ${message}` };
      }
    }

    let pid: number;
    const turnStartedAt = new Date().toISOString();
    try {
      ({ pid } = await this.deps.processRunner.spawnDetached({
        sessionId: record.sessionId,
        message: input.message,
        cwd: record.cwd,
        model: input.model,
        sessionDir: record.sessionDir ?? this.deps.sessionDir,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `Failed to launch Pi child: ${message}` };
    }

    const turnRecord: VigilTurnRecord = {
      id: record.id,
      sessionId: record.sessionId,
      pid,
      cwd: record.cwd,
      model: input.model,
      sessionDir: record.sessionDir ?? this.deps.sessionDir,
      sentAt: turnStartedAt,
    };

    this.deps.parentLedger.appendTurn(turnRecord);

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: lifecycle.launchName,
      cwd: record.cwd,
      state: "running",
      latestResponse: snapshot.latestResponse,
    };
  }

  async list(input: ListInput = {}): Promise<VigilListOrError> {
    const policy = resolveListPolicy(input);
    if ("error" in policy) {
      return policy;
    }

    const states = this.deps.parentLedger.listLifecycleStates(policy.includeCompleted);

    let startIndex = 0;
    if (policy.skipToId !== undefined) {
      const skipIndex = states.findIndex((state) => state.id === policy.skipToId);
      if (skipIndex === -1) {
        const lifecycle = this.getLifecycleState(policy.skipToId);
        if (!lifecycle) {
          return { error: `Unknown vigil id: ${policy.skipToId}` };
        }
        if (lifecycle.completionRecord && !policy.includeCompleted) {
          return {
            error: `Completed vigil child excluded: ${policy.skipToId} (pass includeCompleted: true)`,
          };
        }
        return { error: `Unknown vigil id: ${policy.skipToId}` };
      }
      startIndex = skipIndex;
    }

    const pageStates = states.slice(startIndex, startIndex + policy.maxResults);
    const items = await this.buildListItemsFromStates(pageStates);
    const remainingEligible = states.length - startIndex;
    const omittedCount = remainingEligible - pageStates.length;
    const nextSkipToId =
      omittedCount > 0 ? states[startIndex + pageStates.length]?.id : undefined;

    return {
      vigils: items,
      omittedCount,
      ...(nextSkipToId !== undefined ? { nextSkipToId } : {}),
    };
  }

  async search(input: SearchInput): Promise<VigilSearchOrError> {
    const policy = resolveSearchPolicy(input);
    if ("error" in policy) {
      return policy;
    }

    const candidates = this.resolveDiagnosticCandidates(policy.id, policy.includeCompleted);
    if ("error" in candidates) {
      return candidates;
    }

    const matches: VigilSearchResult["matches"] = [];
    for (const lifecycle of candidates) {
      const remaining = policy.maxResults - matches.length;
      if (remaining <= 0) {
        break;
      }

      if (isEphemeralLifecycle(lifecycle)) {
        if (policy.id) {
          return { error: formatEphemeralTranscriptUnavailableError(lifecycle.id) };
        }
        continue;
      }

      const transcriptResult = await this.loadChildTranscript(lifecycle);
      if ("error" in transcriptResult) {
        return { error: `Child session transcript unavailable for vigil: ${lifecycle.id}` };
      }

      const diagnostic = deriveDiagnosticChildIdentity(lifecycle);

      matches.push(
        ...searchTranscriptEntries(
          transcriptResult,
          policy.query,
          {
            id: diagnostic.id,
            sessionId: diagnostic.sessionId,
            name: diagnostic.name,
            state: diagnostic.state,
          },
          remaining,
        ),
      );
    }

    return { matches };
  }

  async read(input: ReadInput): Promise<VigilReadOrError> {
    const policy = resolveReadPolicy(input);
    if ("error" in policy) {
      return policy;
    }

    const lifecycle = this.getLifecycleState(policy.id);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${policy.id}` };
    }

    if (lifecycle.completionRecord && !policy.includeCompleted) {
      return {
        error: `Completed vigil child excluded: ${policy.id} (pass includeCompleted: true)`,
      };
    }

    if (isEphemeralLifecycle(lifecycle)) {
      return { error: formatEphemeralTranscriptUnavailableError(lifecycle.id) };
    }

    const transcriptResult = await this.loadChildTranscript(lifecycle);
    if ("error" in transcriptResult) {
      return { error: `Child session transcript unavailable for vigil: ${policy.id}` };
    }

    const anchorIndex = transcriptResult.entries.findIndex((entry) => entry.entryId === policy.entryId);
    if (anchorIndex < 0) {
      return { error: `Unknown child session entry: ${policy.entryId}` };
    }

    const window = readTranscriptWindow(transcriptResult, policy.entryId, policy.before, policy.after);
    if ("error" in window) {
      return window;
    }

    const start = Math.max(0, anchorIndex - policy.before);
    const end = Math.min(transcriptResult.entries.length - 1, anchorIndex + policy.after);
    const diagnostic = deriveDiagnosticChildIdentity(lifecycle);
    const anchor = transcriptResult.entries[anchorIndex]!;

    const result: VigilReadResult = {
      id: policy.id,
      sessionId: diagnostic.sessionId,
      name: diagnostic.name,
      state: diagnostic.state,
      anchorEntryId: policy.entryId,
      anchorParentId: anchor.parentId,
      requestedBefore: policy.before,
      requestedAfter: policy.after,
      effectiveBefore: anchorIndex - start,
      effectiveAfter: end - anchorIndex,
      order: "jsonl-append-order",
      entries: window,
    };

    return result;
  }

  async wait(
    input: WaitInput,
    signal?: AbortSignal,
    onProgress?: (progress: VigilWaitProgress) => void,
  ): Promise<VigilWaitOrError> {
    const policy = resolveWaitPolicy(input);
    if ("error" in policy) {
      return policy;
    }

    const scheduler = this.deps.waitScheduler ?? createNodeWaitScheduler();
    const startedAt = scheduler.now();
    const cohortIds = this.resolveWaitCohortIds(policy);
    if ("error" in cohortIds) {
      return cohortIds;
    }
    if (cohortIds.length === 0) {
      return { outcome: "empty", waitedMs: 0 };
    }

    const currentSessionRejection = this.rejectWaitCohortIfCurrentSession(cohortIds);
    if (currentSessionRejection) {
      return currentSessionRejection;
    }

    let delayMs = policy.initialDelayMs;
    let lastFingerprint: string | null = null;
    let lastProgressAt = startedAt;
    let afterCompletedSleep = false;

    const emitProgressIfNeeded = (
      scan: WaitCohortScan[],
      options?: { force?: boolean },
    ) => {
      if (policy.progress !== "status" || !onProgress) {
        return;
      }

      const waitedMs = this.waitedMs(startedAt, scheduler);
      const remainingMs = policy.timeoutMs - waitedMs;
      const allStillRunning = scan.every(({ snapshot }) => snapshot.state === "running");
      const willPollAgain = allStillRunning && remainingMs > 0 && !signal?.aborted;
      const nextPollInMs = computeNextPollInMs({
        delayMs,
        maxDelayMs: policy.maxDelayMs,
        remainingMs,
        afterCompletedSleep,
        willPollAgain,
      });
      const progressItems = scan.map(({ snapshot, activity, directSubagents }) =>
        this.toWaitProgressItem(snapshot, activity, directSubagents),
      );
      const fingerprint = fingerprintWaitProgress(progressItems);
      const heartbeatDue = waitedMs > 0 && scheduler.now() - lastProgressAt >= policy.progressIntervalMs;
      if (!options?.force && fingerprint === lastFingerprint && !heartbeatDue) {
        return;
      }

      lastFingerprint = fingerprint;
      lastProgressAt = scheduler.now();
      const bounded = boundWaitProgressItems(progressItems);
      try {
        onProgress({
          waitedMs,
          nextPollInMs,
          items: bounded.items,
          omittedItemCount: bounded.omittedItemCount,
        });
      } catch {
        // Progress updates are transport ephemera; consumer failures must not affect wait.
      }
    };

    let scan = await this.scanWaitCohort(cohortIds);
    if ("error" in scan) {
      return scan;
    }
    emitProgressIfNeeded(scan, { force: true });
    if (signal?.aborted) {
      return this.cancelledWaitResult(startedAt, scheduler, scan);
    }
    if (scan.some(({ snapshot }) => snapshot.state !== "running")) {
      return this.settledWaitResult(startedAt, scheduler, scan);
    }

    while (true) {
      const remainingMs = policy.timeoutMs - this.waitedMs(startedAt, scheduler);
      if (remainingMs <= 0) {
        return this.timeoutWaitResult(startedAt, scheduler, scan);
      }

      if (signal?.aborted) {
        return this.cancelledWaitResult(startedAt, scheduler, scan);
      }

      const sleepResult = await scheduler.sleep(Math.min(delayMs, remainingMs), signal);
      if (sleepResult === "cancelled" || signal?.aborted) {
        return this.cancelledWaitResult(startedAt, scheduler, scan);
      }

      afterCompletedSleep = true;
      scan = await this.scanWaitCohort(cohortIds);
      if ("error" in scan) {
        return scan;
      }
      emitProgressIfNeeded(scan);
      if (scan.some(({ snapshot }) => snapshot.state !== "running")) {
        return this.settledWaitResult(startedAt, scheduler, scan);
      }
      if (this.waitedMs(startedAt, scheduler) >= policy.timeoutMs) {
        return this.timeoutWaitResult(startedAt, scheduler, scan);
      }

      delayMs = Math.min(delayMs * 2, policy.maxDelayMs);
    }
  }

  async complete(input: CompleteInput): Promise<VigilResult> {
    const lifecycle = this.getLifecycleState(input.vigilId);
    if (!lifecycle) {
      return { error: `Unknown vigil id: ${input.vigilId}` };
    }

    const currentSessionRejection = this.rejectIfCurrentSessionTarget(lifecycle, "complete");
    if (currentSessionRejection) {
      return currentSessionRejection;
    }

    if (lifecycle.completionRecord) {
      return this.buildCompletedSnapshot(lifecycle);
    }

    const record = lifecycle.runtimeRecord;
    let activeSnapshot: VigilSnapshot;

    if (isEphemeralLifecycle(lifecycle)) {
      const ephemeralSnapshot = this.resolveEphemeralActiveSnapshot(lifecycle);
      if ("error" in ephemeralSnapshot) {
        return ephemeralSnapshot;
      }
      activeSnapshot = ephemeralSnapshot;
    } else {
      activeSnapshot = await this.buildActiveSnapshot(lifecycle);
    }

    if (activeSnapshot.state === "running") {
      return { error: `Vigil child is still running: ${input.vigilId}` };
    }

    if (!isEphemeralLifecycle(lifecycle)) {
      const descendantInspection = await this.inspectDirectSubagentsForLifecycle(lifecycle);
      if (descendantInspection.inspection === "unavailable") {
        return { error: descendantInspection.error };
      }

      if (descendantInspection.incomplete > 0 && !input.allowIncompleteSubagents) {
        return { error: formatIncompleteSubagentCompleteError(input.vigilId, descendantInspection) };
      }
    }

    if (this.deps.processRunner.isAlive(record.pid)) {
      try {
        await this.deps.processRunner.terminateAndWait(record.pid, {
          timeoutMs: this.deps.reapTimeoutMs ?? DEFAULT_REAP_TIMEOUT_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to reap settled Pi child before complete: ${message}` };
      }
    }

    let completedName: string;
    if (isEphemeralLifecycle(lifecycle)) {
      completedName = `[completed] ${lifecycle.launchName}`;
    } else {
      const renameResult = await this.deps.childSessionNamer.markCompleted({
        sessionId: record.sessionId,
        cwd: record.cwd,
        sessionDir: record.sessionDir ?? this.deps.sessionDir,
      });

      if ("error" in renameResult) {
        return { error: renameResult.error };
      }
      completedName = renameResult.completedName;
    }

    const completedAt = new Date().toISOString();
    const completionRecord: VigilCompletionRecord = {
      id: record.id,
      sessionId: record.sessionId,
      name: completedName,
      cwd: record.cwd,
      ...(record.sessionDir ?? this.deps.sessionDir
        ? { sessionDir: record.sessionDir ?? this.deps.sessionDir }
        : {}),
      completedAt,
    };

    this.deps.parentLedger.appendComplete(completionRecord);

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: completedName,
      cwd: record.cwd,
      state: "completed",
      latestResponse: activeSnapshot.latestResponse,
      completedAt,
      ...(isEphemeralLifecycle(lifecycle) ? { ephemeral: true as const } : {}),
    };
  }

  private resolveDiagnosticCandidates(
    explicitId: string | undefined,
    includeCompleted: boolean,
  ): VigilLifecycleState[] | { error: string } {
    if (explicitId) {
      const lifecycle = this.getLifecycleState(explicitId);
      if (!lifecycle) {
        return { error: `Unknown vigil id: ${explicitId}` };
      }
      if (lifecycle.completionRecord && !includeCompleted) {
        return {
          error: `Completed vigil child excluded: ${explicitId} (pass includeCompleted: true)`,
        };
      }
      return [lifecycle];
    }

    return this.deps.parentLedger.listLifecycleStates(includeCompleted);
  }

  private async loadChildTranscript(
    lifecycle: VigilLifecycleState,
  ): Promise<ChildSessionTranscript | { error: string }> {
    const record = lifecycle.runtimeRecord;
    try {
      const result = await this.deps.childSessionTranscriptReader.readChildTranscript({
        sessionId: record.sessionId,
        cwd: record.cwd,
        sessionDir: record.sessionDir ?? this.deps.sessionDir,
      });
      if ("error" in result) {
        return result;
      }
      return result;
    } catch {
      return { error: `Child session transcript unavailable for vigil: ${lifecycle.id}` };
    }
  }

  private async inspectDirectSubagentsForLifecycle(
    lifecycle: VigilLifecycleState,
  ): Promise<VigilDirectSubagentInspection> {
    const record = lifecycle.runtimeRecord;
    return this.deps.descendantInspector.inspectDirectSubagents({
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir ?? this.deps.sessionDir,
    });
  }

  private async scanWaitCohort(
    cohortIds: string[],
  ): Promise<WaitCohortScan[] | { error: string }> {
    const scans: Array<WaitCohortScan | { error: string }> = await Promise.all(
      cohortIds.map(async (vigilId) => {
        const lifecycle = this.getLifecycleState(vigilId);
        if (!lifecycle) {
          return { error: `Watched vigil record no longer resolves: ${vigilId}` };
        }

        if (isEphemeralLifecycle(lifecycle)) {
          const snapshot = lifecycle.completionRecord
            ? await this.buildCompletedSnapshot(lifecycle)
            : this.resolveEphemeralActiveSnapshot(lifecycle);
          if ("error" in snapshot) {
            return snapshot;
          }
          return {
            lifecycle,
            snapshot,
            activity: EMPTY_EPHEMERAL_ACTIVITY,
          };
        }

        const record = lifecycle.runtimeRecord;
        const childState = await this.deps.childSessionReader.readChildSessionState({
          sessionId: record.sessionId,
          cwd: record.cwd,
          sessionDir: record.sessionDir ?? this.deps.sessionDir,
        });
        const snapshot = lifecycle.completionRecord
          ? await this.buildCompletedSnapshot(lifecycle, childState)
          : await this.buildActiveSnapshot(lifecycle, childState);
        const directSubagents = await this.inspectDirectSubagentsForLifecycle(lifecycle);
        return { lifecycle, snapshot, activity: childState.activity, directSubagents };
      }),
    );

    const failure = scans.find((scan): scan is { error: string } => "error" in scan);
    if (failure) {
      return failure;
    }
    return scans as WaitCohortScan[];
  }

  private toWaitProgressItem(
    snapshot: VigilSnapshot,
    activity: VigilSessionActivity,
    directSubagents?: VigilDirectSubagentInspection,
  ): VigilWaitProgressItem {
    const progressActivity = snapshot.ephemeral ? EMPTY_EPHEMERAL_ACTIVITY : activity;
    return {
      id: snapshot.id,
      name: snapshot.name,
      state: snapshot.state,
      steps: progressActivity.steps,
      messages: progressActivity.messages,
      lastActivity: progressActivity.lastActivity,
      lastActivityTimestamp: progressActivity.lastActivityTimestamp,
      recentMessages: progressActivity.recentMessages,
      ...(directSubagents ? { directSubagents } : {}),
    };
  }

  private settledWaitResult(
    startedAt: number,
    scheduler: WaitScheduler,
    scan: WaitCohortScan[],
  ): VigilWaitResult {
    return {
      outcome: "settled",
      waitedMs: this.waitedMs(startedAt, scheduler),
      settled: scan
        .filter(({ snapshot }) => snapshot.state !== "running")
        .map(({ snapshot, directSubagents }) => ({
          ...snapshot,
          directSubagents,
        })),
    };
  }

  private timeoutWaitResult(
    startedAt: number,
    scheduler: WaitScheduler,
    scan: WaitCohortScan[],
  ): VigilWaitResult {
    return {
      outcome: "timeout",
      waitedMs: this.waitedMs(startedAt, scheduler),
      pending: this.waitPendingItems(scan),
    };
  }

  private cancelledWaitResult(
    startedAt: number,
    scheduler: WaitScheduler,
    scan: WaitCohortScan[],
  ): VigilWaitResult {
    return {
      outcome: "cancelled",
      waitedMs: this.waitedMs(startedAt, scheduler),
      pending: this.waitPendingItems(scan),
    };
  }

  private waitPendingItems(scan: WaitCohortScan[]): VigilListItem[] {
    return scan.map(({ snapshot, directSubagents }) => ({
      id: snapshot.id,
      sessionId: snapshot.sessionId,
      name: snapshot.name,
      cwd: snapshot.cwd,
      state: snapshot.state,
      directSubagents,
      ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
    }));
  }

  private waitedMs(startedAt: number, scheduler: WaitScheduler): number {
    return Math.max(0, scheduler.now() - startedAt);
  }

  private resolveWaitCohortIds(policy: VigilWaitPolicy): string[] | { error: string } {
    if (policy.id) {
      const lifecycle = this.getLifecycleState(policy.id);
      if (!lifecycle) {
        return { error: `Unknown vigil id: ${policy.id}` };
      }
      return [policy.id];
    }

    return this.deps.parentLedger.listLifecycleStates(false).map((lifecycle) => lifecycle.id);
  }

  private getLifecycleState(vigilId: string): VigilLifecycleState | null {
    return this.deps.parentLedger.getLifecycle(vigilId);
  }

  private rejectIfCurrentSessionTarget(
    lifecycle: VigilLifecycleState,
    action: CurrentSessionLifecycleAction,
  ): { error: string } | null {
    const currentSessionId = this.deps.currentParentSessionId;
    if (currentSessionId && lifecycle.sessionId === currentSessionId) {
      return { error: formatCurrentSessionLifecycleError(action) };
    }
    return null;
  }

  private rejectWaitCohortIfCurrentSession(cohortIds: string[]): { error: string } | null {
    for (const vigilId of cohortIds) {
      const lifecycle = this.getLifecycleState(vigilId);
      if (!lifecycle) {
        continue;
      }
      const rejection = this.rejectIfCurrentSessionTarget(lifecycle, "wait");
      if (rejection) {
        return rejection;
      }
    }
    return null;
  }

  private async buildListItemsFromStates(states: VigilLifecycleState[]): Promise<VigilListItem[]> {
    const items: VigilListItem[] = [];

    for (const lifecycle of states) {
      const directSubagents = isEphemeralLifecycle(lifecycle)
        ? undefined
        : await this.inspectDirectSubagentsForLifecycle(lifecycle);
      if (lifecycle.completionRecord) {
        items.push({
          ...lifecycleStateToListItem(lifecycle, "completed"),
          ...(directSubagents ? { directSubagents } : {}),
        });
        continue;
      }

      let activeState: "running" | "waiting";
      if (isEphemeralLifecycle(lifecycle)) {
        const ephemeralSnapshot = this.resolveEphemeralActiveSnapshot(lifecycle);
        if ("error" in ephemeralSnapshot) {
          activeState = "running";
        } else {
          activeState = ephemeralSnapshot.state === "running" ? "running" : "waiting";
        }
      } else {
        const activeSnapshot = await this.buildActiveSnapshot(lifecycle);
        activeState = activeSnapshot.state === "running" ? "running" : "waiting";
      }

      items.push({
        ...lifecycleStateToListItem(lifecycle, activeState),
        ...(directSubagents ? { directSubagents } : {}),
      });
    }

    return items;
  }

  private resolveEphemeralActiveSnapshot(
    lifecycle: VigilLifecycleState,
  ): VigilSnapshot | { error: string } {
    const record = lifecycle.runtimeRecord;

    if (lifecycle.settleRecord) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        name: lifecycle.launchName,
        cwd: record.cwd,
        state: "waiting",
        latestResponse: lifecycle.settleRecord.latestResponse,
        ephemeral: true,
      };
    }

    const live = this.deps.ephemeralChildObserver.getLiveState(lifecycle.id);
    if (live) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        name: lifecycle.launchName,
        cwd: record.cwd,
        state: live.state,
        latestResponse: live.latestResponse,
        ephemeral: true,
      };
    }

    return { error: formatEphemeralObservationUnavailableError(lifecycle.id) };
  }

  private async buildActiveSnapshot(
    lifecycle: VigilLifecycleState,
    childState?: ChildSessionState,
  ): Promise<VigilSnapshot> {
    if (isEphemeralLifecycle(lifecycle)) {
      const ephemeralSnapshot = this.resolveEphemeralActiveSnapshot(lifecycle);
      if ("error" in ephemeralSnapshot) {
        return {
          id: lifecycle.id,
          sessionId: lifecycle.sessionId,
          name: lifecycle.launchName,
          cwd: lifecycle.cwd,
          state: "running",
          latestResponse: null,
          ephemeral: true,
        };
      }
      return ephemeralSnapshot;
    }

    const record = lifecycle.runtimeRecord;
    const sessionState =
      childState ??
      (await this.deps.childSessionReader.readChildSessionState({
        sessionId: record.sessionId,
        cwd: record.cwd,
        sessionDir: record.sessionDir,
      }));
    const { latestResponse, turnComplete, lastConversationTimestamp } = sessionState;

    const alive = this.deps.processRunner.isAlive(record.pid);
    const state = deriveVigilState({
      alive,
      turnComplete,
      lastConversationTimestamp,
      turnStartedAt: getTurnStartedAt(record),
    });

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: lifecycle.launchName,
      cwd: record.cwd,
      state,
      latestResponse,
    };
  }

  private async buildCompletedSnapshot(
    lifecycle: VigilLifecycleState,
    childState?: ChildSessionState,
  ): Promise<VigilSnapshot> {
    const completion = lifecycle.completionRecord!;
    const record = lifecycle.runtimeRecord;

    if (isEphemeralLifecycle(lifecycle)) {
      return {
        id: record.id,
        sessionId: record.sessionId,
        name: completion.name,
        cwd: record.cwd,
        state: "completed",
        latestResponse: lifecycle.settleRecord?.latestResponse ?? null,
        completedAt: completion.completedAt,
        ephemeral: true,
      };
    }

    const sessionState =
      childState ??
      (await this.deps.childSessionReader.readChildSessionState({
        sessionId: record.sessionId,
        cwd: record.cwd,
        sessionDir: record.sessionDir,
      }));
    const { latestResponse } = sessionState;

    return {
      id: record.id,
      sessionId: record.sessionId,
      name: completion.name,
      cwd: record.cwd,
      state: "completed",
      latestResponse,
      completedAt: completion.completedAt,
    };
  }
}

function validateWaitOptionalId(value: string): string | { error: string } {
  if (value !== value.trim()) {
    return { error: "wait id must not contain leading or trailing whitespace" };
  }
  if (!value) {
    return { error: "wait id must be nonblank when supplied" };
  }
  return value;
}

export function resolveWaitPolicy(input: WaitInput): VigilWaitPolicy | { error: string } {
  const validatedId =
    input.id === undefined ? undefined : validateWaitOptionalId(input.id);
  if (validatedId && typeof validatedId === "object" && "error" in validatedId) {
    return validatedId;
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const initialDelayMs = input.initialDelayMs ?? DEFAULT_WAIT_INITIAL_DELAY_MS;
  const maxDelayMs = input.maxDelayMs ?? DEFAULT_WAIT_MAX_DELAY_MS;
  const progress = input.progress ?? DEFAULT_WAIT_PROGRESS_MODE;
  const progressIntervalMs = input.progressIntervalMs ?? DEFAULT_WAIT_PROGRESS_INTERVAL_MS;

  if (progress !== "status" && progress !== "none") {
    return { error: 'progress must be "status" or "none"' };
  }

  for (const [name, value, maximum] of [
    ["timeoutMs", timeoutMs, MAX_WAIT_TIMEOUT_MS],
    ["initialDelayMs", initialDelayMs, MAX_WAIT_DELAY_MS],
    ["maxDelayMs", maxDelayMs, MAX_WAIT_DELAY_MS],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      return { error: `${name} must be a positive safe integer no greater than ${maximum}` };
    }
  }
  if (maxDelayMs < initialDelayMs) {
    return { error: "maxDelayMs must be greater than or equal to initialDelayMs" };
  }

  if (
    progress === "status" &&
    (!Number.isSafeInteger(progressIntervalMs) ||
      progressIntervalMs <= 0 ||
      progressIntervalMs > MAX_WAIT_PROGRESS_INTERVAL_MS)
  ) {
    return {
      error: `progressIntervalMs must be a positive safe integer no greater than ${MAX_WAIT_PROGRESS_INTERVAL_MS}`,
    };
  }

  return {
    ...(typeof validatedId === "string" ? { id: validatedId } : {}),
    timeoutMs,
    initialDelayMs,
    maxDelayMs,
    progress,
    progressIntervalMs,
  };
}

export function createNodeWaitScheduler(): WaitScheduler {
  return {
    now: () => Date.now(),
    sleep(ms, signal) {
      if (signal?.aborted) {
        return Promise.resolve("cancelled");
      }

      return new Promise((resolve) => {
        let done = false;
        const finish = (result: "elapsed" | "cancelled") => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => finish("cancelled");
        const timer = setTimeout(() => finish("elapsed"), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export function buildPiChildArgs(input: SpawnChildInput): string[] {
  const args = ["--mode", "json", "-p", "--session-id", input.sessionId];
  if (input.name) {
    args.push("--name", input.name);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.sessionDir) {
    args.push("--session-dir", input.sessionDir);
  }
  args.push(input.message);
  return args;
}

export function spawnDetachedPiChild(
  piExecutable: string,
  input: SpawnChildInput,
): Promise<{ pid: number }> {
  return new Promise((resolve, reject) => {
    const args = buildPiChildArgs(input);
    const child = spawn(piExecutable, args, {
      cwd: input.cwd,
      detached: true,
      stdio: "ignore",
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.once("spawn", () => {
      child.on("error", () => {
        // Detached children may fail after unref; never crash the parent Pi process.
      });
      child.unref();

      if (!child.pid) {
        reject(new Error("Failed to spawn detached Pi child process"));
        return;
      }

      resolve({ pid: child.pid });
    });
  });
}

export function attachDetachedChildErrorHandler(child: ChildProcess): void {
  child.on("error", () => {
    // Prevent unhandled 'error' events on detached children after unref().
  });
}

export async function terminateTrackedProcess(
  isAlive: (pid: number) => boolean,
  pid: number,
  options?: TerminateAndWaitOptions,
): Promise<void> {
  if (!isAlive(pid)) {
    return;
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, REAP_POLL_INTERVAL_MS));
  }

  throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
}

export function createNodeProcessRunner(options?: { piExecutable?: string }): ProcessRunner {
  const piExecutable = options?.piExecutable ?? "pi";

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    spawnDetached(input) {
      return spawnDetachedPiChild(piExecutable, input);
    },
    isAlive,
    terminateAndWait(pid, terminateOptions) {
      return terminateTrackedProcess(isAlive, pid, terminateOptions);
    },
  };
}

export async function findChildSessionPath(
  sessionId: string,
  cwd: string,
  sessionDir?: string,
): Promise<string | null> {
  const sessions = sessionDir
    ? await SessionManager.listAll(sessionDir)
    : await SessionManager.list(cwd);
  const match = sessions.find((session) => session.id === sessionId);
  return match?.path ?? null;
}

const EMPTY_CHILD_SESSION_STATE: ChildSessionState = {
  latestResponse: null,
  turnComplete: false,
  lastConversationTimestamp: null,
  activity: {
    steps: 0,
    messages: 0,
    lastActivity: null,
    lastActivityTimestamp: null,
    recentMessages: [],
  },
};

export function readChildSessionStateFromFile(sessionFile: string): ChildSessionState {
  const content = readFileSync(sessionFile, "utf8");
  const fileEntries = parseSessionEntries(content);
  const entries = fileEntries.filter((entry) => entry.type !== "session") as SessionEntry[];
  const assistantState = extractLatestAssistantState(entries);
  return {
    ...assistantState,
    activity: extractSessionActivity(entries),
  };
}

export function readChildTranscriptFromFile(
  sessionFile: string,
): ChildSessionTranscript | { error: string } {
  try {
    const content = readFileSync(sessionFile, "utf8");
    const fileEntries = parseSessionEntries(content);
    const entries = fileEntries.filter((entry) => entry.type !== "session") as SessionEntry[];
    return parseChildSessionTranscript(entries);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Failed to read child session transcript: ${message}` };
  }
}

export function readLatestAssistantTextFromFile(sessionFile: string): string | null {
  return readChildSessionStateFromFile(sessionFile).latestResponse;
}

export function createEmptyChildSessionTranscriptReader(): ChildSessionTranscriptReader {
  return {
    async readChildTranscript() {
      return { entries: [] };
    },
  };
}

export function createNodeChildSessionTranscriptReader(): ChildSessionTranscriptReader {
  return {
    async readChildTranscript({ sessionId, cwd, sessionDir }) {
      try {
        const sessionPath = await findChildSessionPath(sessionId, cwd, sessionDir);
        if (!sessionPath) {
          return { error: `Child session not found: ${sessionId}` };
        }
        return readChildTranscriptFromFile(sessionPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `Failed to read child session transcript: ${message}` };
      }
    },
  };
}

export function createNodeChildSessionReader(): ChildSessionReader {
  return {
    async readChildSessionState({ sessionId, cwd, sessionDir }) {
      const sessionPath = await findChildSessionPath(sessionId, cwd, sessionDir);
      if (!sessionPath) {
        return EMPTY_CHILD_SESSION_STATE;
      }
      return readChildSessionStateFromFile(sessionPath);
    },
  };
}

export function createNodeChildSessionNamer(): ChildSessionNamer {
  return {
    async markCompleted({ sessionId, cwd, sessionDir }) {
      const sessionPath = await findChildSessionPath(sessionId, cwd, sessionDir);
      if (!sessionPath) {
        return { error: `Child session not found: ${sessionId}` };
      }

      const sessionManager = SessionManager.open(sessionPath, sessionDir, cwd);
      const currentName = sessionManager.getSessionName();
      const completedName = currentName ? `[completed] ${currentName}` : "[completed]";
      sessionManager.appendSessionInfo(completedName);
      return { completedName };
    },
  };
}

export function getLifecycleFromSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  vigilId: string,
): VigilLifecycleState | null {
  const lifecycle = reconstructVigilLifecycleFromEntries(sessionManager.getEntries());
  return lifecycle.get(vigilId) ?? null;
}

export function listLifecycleStatesFromSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  includeCompleted: boolean,
): VigilLifecycleState[] {
  const lifecycle = reconstructVigilLifecycleFromEntries(sessionManager.getEntries());
  const sorted = sortLifecycleStatesMostRecentFirst(lifecycle.values());

  if (includeCompleted) {
    return sorted;
  }

  return sorted.filter((state) => !state.completionRecord);
}

export function findLatestTurnInSessionManager(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  vigilId: string,
): VigilRuntimeRecord | null {
  return getLifecycleFromSessionManager(sessionManager, vigilId)?.runtimeRecord ?? null;
}

export function createSessionParentLedger(
  sessionManager: Pick<SessionManagerType, "getEntries">,
  appendEntry: (customType: string, data: unknown) => void,
): ParentLedger {
  return {
    appendLaunch(record) {
      appendEntry("vigil-launch", record);
    },
    appendTurn(record) {
      appendEntry("vigil-turn", record);
    },
    appendSettle(record) {
      appendEntry("vigil-settle", record);
    },
    appendComplete(record) {
      appendEntry("vigil-complete", record);
    },
    getLifecycle(vigilId) {
      return getLifecycleFromSessionManager(sessionManager, vigilId);
    },
    listLifecycleStates(includeCompleted) {
      return listLifecycleStatesFromSessionManager(sessionManager, includeCompleted);
    },
  };
}

export function createVigilServiceForContext(options: {
  parentCwd: string;
  sessionManager: Pick<SessionManagerType, "getEntries" | "getSessionId">;
  appendEntry: (customType: string, data: unknown) => void;
  sessionDir?: string;
  processRunner?: ProcessRunner;
  childSessionReader?: ChildSessionReader;
  childSessionTranscriptReader?: ChildSessionTranscriptReader;
  childSessionNamer?: ChildSessionNamer;
  descendantInspector?: import("./descendant-inspector").ChildSessionDescendantInspector;
  ephemeralChildObserver?: EphemeralChildObserver;
  reapTimeoutMs?: number;
  waitScheduler?: WaitScheduler;
}): VigilService {
  const processRunner = options.processRunner ?? createNodeProcessRunner();
  const childSessionReader = options.childSessionReader ?? createNodeChildSessionReader();
  const ephemeralChildObserver =
    options.ephemeralChildObserver ?? getSharedEphemeralChildObserver(processRunner, options.reapTimeoutMs);
  return new VigilService({
    processRunner,
    childSessionReader,
    childSessionTranscriptReader:
      options.childSessionTranscriptReader ?? createNodeChildSessionTranscriptReader(),
    childSessionNamer: options.childSessionNamer ?? createNodeChildSessionNamer(),
    descendantInspector:
      options.descendantInspector ??
      createNodeChildSessionDescendantInspector({ childSessionReader, processRunner }),
    parentLedger: createSessionParentLedger(options.sessionManager, options.appendEntry),
    ephemeralChildObserver,
    sessionDir: options.sessionDir,
    reapTimeoutMs: options.reapTimeoutMs,
    waitScheduler: options.waitScheduler,
    currentParentSessionId: options.sessionManager.getSessionId(),
  });
}
