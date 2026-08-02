import { truncateLine } from "@earendil-works/pi-coding-agent";
import type { VigilState } from "./types";

export const DEFAULT_WAIT_PROGRESS_INTERVAL_MS = 30_000;
export const MAX_WAIT_PROGRESS_INTERVAL_MS = 60_000;
export const MAX_WAIT_PROGRESS_ITEMS = 20;
const MAX_PROGRESS_FIELD_CHARS = 120;

export interface VigilWaitProgressItem {
  id: string;
  name: string;
  state: VigilState;
  steps: number;
  messages: number;
  lastActivity: string | null;
  lastActivityTimestamp: string | null;
}

export interface VigilWaitProgress {
  waitedMs: number;
  nextPollInMs: number;
  items: VigilWaitProgressItem[];
  omittedItemCount: number;
}

export interface VigilWaitProgressFingerprintItem {
  id: string;
  state: VigilState;
  steps: number;
  messages: number;
  lastActivity: string | null;
  lastActivityTimestamp: string | null;
}

function sanitizeSingleLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return truncateLine(normalized, MAX_PROGRESS_FIELD_CHARS).text;
}

export function formatRelativeAge(referenceMs: number, timestamp: string | null): string | null {
  if (!timestamp) {
    return null;
  }
  const activityMs = Date.parse(timestamp);
  if (Number.isNaN(activityMs)) {
    return null;
  }
  const ageMs = Math.max(0, referenceMs - activityMs);
  if (ageMs < 1_000) {
    return "just now";
  }
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function formatWaitProgressItemLine(
  item: VigilWaitProgressItem,
  referenceMs: number,
): string {
  const name = sanitizeSingleLine(item.name) || item.id;
  const lastPart = item.lastActivity
    ? `last: ${sanitizeSingleLine(item.lastActivity)}${(() => {
        const age = formatRelativeAge(referenceMs, item.lastActivityTimestamp);
        return age ? ` (${age})` : "";
      })()}`
    : "last: none";
  return `${name} [${item.id}] — ${item.state} · steps: ${item.steps} · messages: ${item.messages} · ${lastPart}`;
}

export function formatWaitProgressText(progress: VigilWaitProgress, referenceMs: number): string {
  const elapsedSeconds = Math.floor(progress.waitedMs / 1_000);
  const nextPollSeconds = Math.ceil(progress.nextPollInMs / 1_000);
  const header = `elapsed ${elapsedSeconds}s · next poll ≤${nextPollSeconds}s`;
  const lines = progress.items.map((item) => formatWaitProgressItemLine(item, referenceMs));
  if (progress.omittedItemCount > 0) {
    lines.push(`… and ${progress.omittedItemCount} more child${progress.omittedItemCount === 1 ? "" : "ren"} omitted`);
  }
  return [header, ...lines].join("\n");
}

export function fingerprintWaitProgress(items: VigilWaitProgressFingerprintItem[]): string {
  return items
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (item) =>
        `${item.id}|${item.state}|${item.steps}|${item.messages}|${item.lastActivity ?? ""}|${item.lastActivityTimestamp ?? ""}`,
    )
    .join("\n");
}

export function boundWaitProgressItems(
  items: VigilWaitProgressItem[],
  maxItems = MAX_WAIT_PROGRESS_ITEMS,
): { items: VigilWaitProgressItem[]; omittedItemCount: number } {
  if (items.length <= maxItems) {
    return { items, omittedItemCount: 0 };
  }
  return {
    items: items.slice(0, maxItems),
    omittedItemCount: items.length - maxItems,
  };
}
