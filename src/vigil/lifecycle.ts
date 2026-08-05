import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  VigilCompletionRecord,
  VigilFailRecord,
  VigilLaunchRecord,
  VigilListItem,
  VigilRuntimeRecord,
  VigilSettleRecord,
  VigilState,
  VigilTurnRecord,
} from "./types";

export interface VigilLifecycleState {
  id: string;
  sessionId: string;
  cwd: string;
  launchName: string;
  runtimeRecord: VigilRuntimeRecord;
  settleRecord: VigilSettleRecord | null;
  completionRecord: VigilCompletionRecord | null;
  failRecord: VigilFailRecord | null;
  lastUpdatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidRuntimeRecord(data: unknown): data is VigilRuntimeRecord {
  if (!isRecord(data)) {
    return false;
  }

  return (
    isNonEmptyString(data.id) &&
    isNonEmptyString(data.sessionId) &&
    typeof data.pid === "number" &&
    isNonEmptyString(data.cwd) &&
    (typeof data.launchedAt === "string" || typeof data.sentAt === "string")
  );
}

function isValidLaunchRecord(data: unknown): data is VigilLaunchRecord {
  return isValidRuntimeRecord(data) && isNonEmptyString((data as VigilLaunchRecord).name) && typeof (data as VigilLaunchRecord).launchedAt === "string";
}

function isValidTurnRecord(data: unknown): data is VigilTurnRecord {
  return isValidRuntimeRecord(data) && typeof (data as VigilTurnRecord).sentAt === "string";
}

function isValidCompletionRecord(data: unknown): data is VigilCompletionRecord {
  if (!isRecord(data)) {
    return false;
  }

  return (
    isNonEmptyString(data.id) &&
    isNonEmptyString(data.sessionId) &&
    isNonEmptyString(data.name) &&
    isNonEmptyString(data.cwd) &&
    isNonEmptyString(data.completedAt)
  );
}

function isValidFailRecord(data: unknown): data is VigilFailRecord {
  if (!isRecord(data)) {
    return false;
  }

  const source = data.source;
  return (
    isNonEmptyString(data.id) &&
    isNonEmptyString(data.sessionId) &&
    isNonEmptyString(data.failedAt) &&
    isNonEmptyString(data.error) &&
    (source === "bootstrap" || source === "ephemeral-settle" || source === "turn") &&
    (data.stderrExcerpt === undefined || typeof data.stderrExcerpt === "string")
  );
}

function isValidSettleRecord(data: unknown): data is VigilSettleRecord {
  if (!isRecord(data)) {
    return false;
  }

  return (
    isNonEmptyString(data.id) &&
    isNonEmptyString(data.sessionId) &&
    (data.latestResponse === null || typeof data.latestResponse === "string") &&
    isNonEmptyString(data.settledAt)
  );
}

function matchesCanonicalIdentity(
  existing: VigilLifecycleState,
  data: { sessionId: string; cwd: string },
): boolean {
  return existing.sessionId === data.sessionId && existing.cwd === data.cwd;
}

export function isEphemeralLifecycle(state: VigilLifecycleState): boolean {
  const record = state.runtimeRecord;
  return "launchedAt" in record && record.ephemeral === true;
}

export function reconstructVigilLifecycleFromEntries(
  entries: SessionEntry[],
): Map<string, VigilLifecycleState> {
  const byId = new Map<string, VigilLifecycleState>();

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    if (entry.customType === "vigil-launch") {
      const data = entry.data;
      if (!isValidLaunchRecord(data)) {
        continue;
      }

      if (byId.has(data.id)) {
        continue;
      }

      byId.set(data.id, {
        id: data.id,
        sessionId: data.sessionId,
        cwd: data.cwd,
        launchName: data.name.trim(),
        runtimeRecord: data,
        settleRecord: null,
        completionRecord: null,
        failRecord: null,
        lastUpdatedAt: data.launchedAt,
      });
      continue;
    }

    if (entry.customType === "vigil-turn") {
      const data = entry.data;
      if (!isValidTurnRecord(data)) {
        continue;
      }

      const existing = byId.get(data.id);
      if (!existing || existing.completionRecord || existing.failRecord || isEphemeralLifecycle(existing)) {
        continue;
      }

      if (!matchesCanonicalIdentity(existing, data)) {
        continue;
      }

      existing.runtimeRecord = data;
      existing.lastUpdatedAt = data.sentAt;
      continue;
    }

    if (entry.customType === "vigil-settle") {
      const data = entry.data;
      if (!isValidSettleRecord(data)) {
        continue;
      }

      const existing = byId.get(data.id);
      if (!existing || existing.settleRecord || existing.completionRecord || existing.failRecord) {
        continue;
      }

      if (!matchesCanonicalIdentity(existing, { sessionId: data.sessionId, cwd: existing.cwd })) {
        continue;
      }

      existing.settleRecord = data;
      existing.lastUpdatedAt = data.settledAt;
      continue;
    }

    if (entry.customType === "vigil-complete") {
      const data = entry.data;
      if (!isValidCompletionRecord(data)) {
        continue;
      }

      const existing = byId.get(data.id);
      if (!existing || existing.completionRecord || existing.failRecord) {
        continue;
      }

      if (!matchesCanonicalIdentity(existing, data)) {
        continue;
      }

      existing.completionRecord = data;
      existing.lastUpdatedAt = data.completedAt;
      continue;
    }

    if (entry.customType === "vigil-fail") {
      const data = entry.data;
      if (!isValidFailRecord(data)) {
        continue;
      }

      const existing = byId.get(data.id);
      if (!existing || existing.failRecord || existing.completionRecord) {
        continue;
      }

      if (!matchesCanonicalIdentity(existing, { sessionId: data.sessionId, cwd: existing.cwd })) {
        continue;
      }

      existing.failRecord = data;
      existing.lastUpdatedAt = data.failedAt;
    }
  }

  return byId;
}

export function sortLifecycleStatesMostRecentFirst(
  states: Iterable<VigilLifecycleState>,
): VigilLifecycleState[] {
  return [...states].sort((left, right) => {
    if (left.lastUpdatedAt === right.lastUpdatedAt) {
      return left.id.localeCompare(right.id);
    }
    return left.lastUpdatedAt < right.lastUpdatedAt ? 1 : -1;
  });
}

/**
 * Lifecycle-only identity for search/read diagnostics.
 * For non-completed children, `state: "running"` means lifecycle-active (eligible
 * for the default active corpus), not live poll running/waiting semantics.
 */
export function deriveDiagnosticChildIdentity(state: VigilLifecycleState): {
  id: string;
  sessionId: string;
  name: string;
  state: VigilState;
} {
  if (state.completionRecord) {
    return {
      id: state.id,
      sessionId: state.sessionId,
      name: state.completionRecord.name,
      state: "completed",
    };
  }

  if (state.failRecord) {
    return {
      id: state.id,
      sessionId: state.sessionId,
      name: state.launchName,
      state: "failed",
    };
  }

  return {
    id: state.id,
    sessionId: state.sessionId,
    name: state.launchName,
    state: "running",
  };
}

export function lifecycleStateToListItem(
  state: VigilLifecycleState,
  activeState: "running" | "waiting" | "completed" | "failed",
): VigilListItem {
  const ephemeral = isEphemeralLifecycle(state) ? ({ ephemeral: true as const }) : {};

  if (state.completionRecord) {
    return {
      id: state.id,
      sessionId: state.sessionId,
      name: state.completionRecord.name,
      cwd: state.cwd,
      state: "completed",
      completedAt: state.completionRecord.completedAt,
      ...ephemeral,
    };
  }

  if (state.failRecord) {
    return {
      id: state.id,
      sessionId: state.sessionId,
      name: state.launchName,
      cwd: state.cwd,
      state: "failed",
      ...ephemeral,
    };
  }

  return {
    id: state.id,
    sessionId: state.sessionId,
    name: state.launchName,
    cwd: state.cwd,
    state: activeState,
    ...ephemeral,
  };
}
