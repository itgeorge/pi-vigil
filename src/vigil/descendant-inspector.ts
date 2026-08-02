import {
  parseSessionEntries,
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import {
  reconstructVigilLifecycleFromEntries,
  sortLifecycleStatesMostRecentFirst,
  type VigilLifecycleState,
} from "./lifecycle";
import type { ChildSessionReader, ProcessRunner } from "./ports";
import { deriveVigilState, getTurnStartedAt } from "./session-text";
import { truncateLine } from "@earendil-works/pi-coding-agent";
import { escapeTerminalControls } from "./transcript";
import type { VigilState } from "./types";

export const MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS = 20;

export interface VigilDirectSubagentItem {
  id: string;
  sessionId: string;
  name: string;
  state: VigilState | "unknown";
}

export interface VigilDirectSubagentSummary {
  inspection: "available";
  total: number;
  incomplete: number;
  running: number;
  waiting: number;
  completed: number;
  unknown: number;
  items: VigilDirectSubagentItem[];
  omittedCount: number;
}

export interface VigilDirectSubagentSummaryUnavailable {
  inspection: "unavailable";
  error: string;
}

export type VigilDirectSubagentInspection =
  | VigilDirectSubagentSummary
  | VigilDirectSubagentSummaryUnavailable;

export interface ChildSessionDescendantInspector {
  inspectDirectSubagents(input: {
    sessionId: string;
    cwd: string;
    sessionDir?: string;
  }): Promise<VigilDirectSubagentInspection>;
}

export interface VigilDirectSubagentFingerprint {
  inspection: "available" | "unavailable";
  incomplete?: number;
  running?: number;
  waiting?: number;
  completed?: number;
  unknown?: number;
}

const MAX_SUBAGENT_DISPLAY_FIELD_CHARS = 120;

function sanitizeSubagentField(value: string): string {
  const normalized = escapeTerminalControls(value.replace(/\s+/g, " ").trim(), false);
  if (!normalized) {
    return "";
  }
  return truncateLine(normalized, MAX_SUBAGENT_DISPLAY_FIELD_CHARS).text;
}

export function formatDirectSubagentItemLine(item: VigilDirectSubagentItem): string {
  const name = sanitizeSubagentField(item.name) || item.id;
  const id = sanitizeSubagentField(item.id) || item.id;
  return `  - ${name} [${id}] — ${item.state}`;
}

export function formatDirectSubagentsSummaryText(summary: VigilDirectSubagentInspection): string[] {
  if (summary.inspection === "unavailable") {
    return ["  direct subagents: inspection unavailable"];
  }

  if (summary.total === 0) {
    return ["  direct subagents: none"];
  }

  const lines: string[] = [];
  if (summary.incomplete > 0) {
    const parts: string[] = [`${summary.incomplete} incomplete`];
    const stateParts: string[] = [];
    if (summary.running > 0) {
      stateParts.push(`${summary.running} running`);
    }
    if (summary.waiting > 0) {
      stateParts.push(`${summary.waiting} waiting`);
    }
    if (summary.unknown > 0) {
      stateParts.push(`${summary.unknown} unknown`);
    }
    if (summary.completed > 0) {
      stateParts.push(`${summary.completed} completed`);
    }
    lines.push(`  direct subagents: ${parts.join(" ")} (${stateParts.join(", ")})`);
  } else {
    lines.push(`  direct subagents: ${summary.completed} completed`);
  }

  for (const item of summary.items) {
    lines.push(formatDirectSubagentItemLine(item));
  }
  if (summary.omittedCount > 0) {
    lines.push(`  … and ${summary.omittedCount} more direct subagent${summary.omittedCount === 1 ? "" : "s"} omitted`);
  }
  return lines;
}

export function toDirectSubagentFingerprint(
  summary: VigilDirectSubagentInspection | undefined,
): VigilDirectSubagentFingerprint | undefined {
  if (!summary) {
    return undefined;
  }
  if (summary.inspection === "unavailable") {
    return { inspection: "unavailable" };
  }
  return {
    inspection: "available",
    incomplete: summary.incomplete,
    running: summary.running,
    waiting: summary.waiting,
    completed: summary.completed,
    unknown: summary.unknown,
  };
}

export function formatIncompleteSubagentCompleteError(vigilId: string, summary: VigilDirectSubagentSummary): string {
  const parts: string[] = [];
  if (summary.running > 0) {
    parts.push(`${summary.running} running`);
  }
  if (summary.waiting > 0) {
    parts.push(`${summary.waiting} waiting`);
  }
  if (summary.unknown > 0) {
    parts.push(`${summary.unknown} unknown`);
  }
  return `Cannot complete Vigil child ${vigilId}: ${summary.incomplete} incomplete direct subagents (${parts.join(", ")}). Prompt the child to finish them, or pass allowIncompleteSubagents: true.`;
}

async function deriveDirectSubagentState(
  lifecycle: VigilLifecycleState,
  reader: ChildSessionReader,
  runner: ProcessRunner,
): Promise<VigilState | "unknown"> {
  if (lifecycle.completionRecord) {
    return "completed";
  }

  const record = lifecycle.runtimeRecord;
  try {
    const childState = await reader.readChildSessionState({
      sessionId: record.sessionId,
      cwd: record.cwd,
      sessionDir: record.sessionDir,
    });
    const alive = runner.isAlive(record.pid);
    return deriveVigilState({
      alive,
      turnComplete: childState.turnComplete,
      lastConversationTimestamp: childState.lastConversationTimestamp,
      turnStartedAt: getTurnStartedAt(record),
    });
  } catch {
    return "unknown";
  }
}

function lifecycleToDisplayName(lifecycle: VigilLifecycleState): string {
  return lifecycle.completionRecord?.name ?? lifecycle.launchName;
}

export async function inspectDirectSubagentsFromEntries(
  entries: SessionEntry[],
  reader: ChildSessionReader,
  runner: ProcessRunner,
): Promise<VigilDirectSubagentSummary> {
  const lifecycleEntries = entries.filter((entry) => (entry as { type: string }).type !== "session");
  const lifecycle = reconstructVigilLifecycleFromEntries(lifecycleEntries);
  const states = sortLifecycleStatesMostRecentFirst(lifecycle.values());

  const items: VigilDirectSubagentItem[] = [];
  let running = 0;
  let waiting = 0;
  let completed = 0;
  let unknown = 0;

  for (const state of states) {
    const derived = await deriveDirectSubagentState(state, reader, runner);
    if (derived === "running") {
      running += 1;
    } else if (derived === "waiting") {
      waiting += 1;
    } else if (derived === "completed") {
      completed += 1;
    } else {
      unknown += 1;
    }

    items.push({
      id: state.id,
      sessionId: state.sessionId,
      name: lifecycleToDisplayName(state),
      state: derived,
    });
  }

  const incomplete = running + waiting + unknown;
  const total = items.length;
  const displayItems = items.slice(0, MAX_DIRECT_SUBAGENT_DISPLAY_ITEMS);
  const omittedCount = Math.max(0, total - displayItems.length);

  return {
    inspection: "available",
    total,
    incomplete,
    running,
    waiting,
    completed,
    unknown,
    items: displayItems,
    omittedCount,
  };
}

async function resolveChildSessionPath(
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

export function createZeroDescendantInspector(): ChildSessionDescendantInspector {
  const empty: VigilDirectSubagentSummary = {
    inspection: "available",
    total: 0,
    incomplete: 0,
    running: 0,
    waiting: 0,
    completed: 0,
    unknown: 0,
    items: [],
    omittedCount: 0,
  };
  return {
    async inspectDirectSubagents() {
      return empty;
    },
  };
}

export function createInMemoryDescendantInspector(options: {
  summaries: Map<string, VigilDirectSubagentInspection>;
}): ChildSessionDescendantInspector {
  return {
    async inspectDirectSubagents({ sessionId }) {
      return options.summaries.get(sessionId) ?? {
        inspection: "unavailable",
        error: "Child session ledger unavailable",
      };
    },
  };
}

export function createNodeChildSessionDescendantInspector(options: {
  childSessionReader: ChildSessionReader;
  processRunner: ProcessRunner;
}): ChildSessionDescendantInspector {
  return {
    async inspectDirectSubagents({ sessionId, cwd, sessionDir }) {
      try {
        const sessionPath = await resolveChildSessionPath(sessionId, cwd, sessionDir);
        if (!sessionPath) {
          return {
            inspection: "unavailable",
            error: "Child session ledger unavailable for direct subagent inspection",
          };
        }

        const content = readFileSync(sessionPath, "utf8");
        const fileEntries = parseSessionEntries(content);
        const entries = fileEntries.filter((entry) => (entry as { type: string }).type !== "session") as SessionEntry[];
        return inspectDirectSubagentsFromEntries(entries, options.childSessionReader, options.processRunner);
      } catch {
        return {
          inspection: "unavailable",
          error: "Child session ledger unavailable for direct subagent inspection",
        };
      }
    },
  };
}
