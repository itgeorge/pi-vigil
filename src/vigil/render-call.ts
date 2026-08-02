import { truncateLine } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { reconstructVigilLifecycleFromEntries } from "./lifecycle";
import {
  DEFAULT_WAIT_PROGRESS_MODE,
  DEFAULT_WAIT_TIMEOUT_MS,
} from "./node-runtime";

export const MAX_CALL_FIELD_CHARS = 120;
export const VIGIL_SHORT_ID_HEX_LENGTH = 7;

export interface VigilCallArgs {
  action?: "launch" | "poll" | "send" | "list" | "complete" | "wait";
  name?: string;
  message?: string;
  model?: string;
  cwd?: string;
  id?: string;
  includeCompleted?: boolean;
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  progress?: "status" | "none";
  progressIntervalMs?: number;
}

export type VigilDisplayNameLookup = ReadonlyMap<string, string>;

export function sanitizeCallField(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return truncateLine(normalized, MAX_CALL_FIELD_CHARS).text;
}

export function formatVigilShortId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed.startsWith("vigil-")) {
    return sanitizeCallField(trimmed) || trimmed;
  }

  const suffix = trimmed.slice("vigil-".length);
  const compact = suffix.replace(/-/g, "");
  if (!compact) {
    return "vigil-?";
  }

  return `vigil-${compact.slice(0, VIGIL_SHORT_ID_HEX_LENGTH)}`;
}

export function buildVigilDisplayNameIndex(entries: SessionEntry[]): VigilDisplayNameLookup {
  const lifecycle = reconstructVigilLifecycleFromEntries(entries);
  const index = new Map<string, string>();

  for (const state of lifecycle.values()) {
    const name = state.completionRecord?.name ?? state.launchName;
    index.set(state.id, name);
  }

  return index;
}

export function createVigilDisplayNameCache(): {
  refreshFromEntries: (entries: SessionEntry[]) => void;
  refreshFromBranch: (getBranch: () => SessionEntry[]) => void;
  lookup: () => VigilDisplayNameLookup;
} {
  let index: VigilDisplayNameLookup = new Map();

  return {
    refreshFromEntries(entries) {
      index = buildVigilDisplayNameIndex(entries);
    },
    refreshFromBranch(getBranch) {
      index = buildVigilDisplayNameIndex(getBranch());
    },
    lookup: () => index,
  };
}

function resolveDisplayName(
  id: string | undefined,
  lookup: VigilDisplayNameLookup | ((id: string) => string | undefined),
): string | undefined {
  if (!id) {
    return undefined;
  }

  if (typeof lookup === "function") {
    return lookup(id);
  }

  return lookup.get(id);
}

function formatWaitTimeoutLabel(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return `up to ${seconds}s`;
}

function formatQuotedExcerpt(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }

  const sanitized = sanitizeCallField(message);
  if (!sanitized) {
    return undefined;
  }

  const escaped = sanitized.replace(/"/g, "'");
  return `"${escaped}"`;
}

function formatIdIdentity(
  id: string | undefined,
  lookup: VigilDisplayNameLookup | ((id: string) => string | undefined),
): string {
  if (!id?.trim()) {
    return "";
  }

  const shortId = formatVigilShortId(id);
  const name = resolveDisplayName(id, lookup);
  if (name) {
    const safeName = sanitizeCallField(name) || shortId;
    return `${safeName} [${shortId}]`;
  }

  return `[${shortId}]`;
}

function formatModelIndicator(model: string | undefined, fallback?: string): string {
  const value = model?.trim() ? sanitizeCallField(model) || model.trim() : fallback;
  if (!value) {
    return "";
  }
  return `model ${value}`;
}

export function formatVigilCallSummary(
  args: VigilCallArgs,
  lookup: VigilDisplayNameLookup | ((id: string) => string | undefined) = new Map(),
): string {
  const action = args.action ?? "vigil";
  const segments: string[] = [action];

  switch (action) {
    case "launch": {
      const name = sanitizeCallField(args.name ?? "") || "launch";
      segments.push(name);
      segments.push(formatModelIndicator(args.model, "Pi default"));
      break;
    }
    case "poll":
    case "complete": {
      segments.push(formatIdIdentity(args.id, lookup));
      break;
    }
    case "send": {
      const identity = formatIdIdentity(args.id, lookup);
      if (identity) {
        segments.push(identity);
      }
      let summary = segments.join(" · ");
      const excerpt = formatQuotedExcerpt(args.message);
      if (excerpt) {
        summary += ` — ${excerpt}`;
      }
      const model = formatModelIndicator(args.model);
      if (model) {
        summary += ` · ${model}`;
      }
      return summary;
    }
    case "list": {
      segments.push(args.includeCompleted ? "including completed" : "active");
      break;
    }
    case "wait": {
      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : DEFAULT_WAIT_TIMEOUT_MS;
      const progress =
        args.progress === "none" || args.progress === "status"
          ? args.progress
          : DEFAULT_WAIT_PROGRESS_MODE;
      segments.push(formatWaitTimeoutLabel(timeoutMs));
      segments.push(`progress ${progress}`);
      break;
    }
    default:
      break;
  }

  return segments.filter((segment) => segment.length > 0).join(" · ");
}

function appendThemedSegment(
  parts: string[],
  theme: Theme,
  color: "muted" | "dim" | "accent" | "text",
  text: string,
): void {
  if (!text) {
    return;
  }
  parts.push(theme.fg(color, text));
}

export function renderVigilCallText(
  args: VigilCallArgs,
  theme: Theme,
  lookup: VigilDisplayNameLookup | ((id: string) => string | undefined) = new Map(),
  lastComponent?: Component,
): Text {
  const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);

  try {
    const summary = formatVigilCallSummary(args, lookup);
    const parts: string[] = [theme.fg("toolTitle", theme.bold("vigil"))];

    if (summary.startsWith("launch")) {
      const name = sanitizeCallField(args.name ?? "") || "launch";
      const model = args.model?.trim()
        ? formatModelIndicator(args.model)
        : formatModelIndicator(undefined, "Pi default");
      parts.push(theme.fg("muted", " launch · "));
      parts.push(theme.fg("text", name));
      parts.push(theme.fg("dim", ` · ${model}`));
    } else if (summary.startsWith("send")) {
      parts.push(theme.fg("muted", " send · "));
      parts.push(theme.fg("text", formatIdIdentity(args.id, lookup)));
      const excerpt = formatQuotedExcerpt(args.message);
      if (excerpt) {
        parts.push(theme.fg("dim", ` — ${excerpt}`));
      }
      const model = formatModelIndicator(args.model);
      if (model) {
        parts.push(theme.fg("dim", ` · ${model}`));
      }
    } else if (
      summary.startsWith("poll") ||
      summary.startsWith("complete")
    ) {
      const action = args.action ?? "poll";
      parts.push(theme.fg("muted", ` ${action} · `));
      const identity = formatIdIdentity(args.id, lookup);
      const bracketIndex = identity.indexOf(" [");
      if (bracketIndex >= 0) {
        parts.push(theme.fg("text", identity.slice(0, bracketIndex)));
        parts.push(theme.fg("accent", identity.slice(bracketIndex)));
      } else {
        parts.push(theme.fg("accent", identity));
      }
    } else if (summary.startsWith("list")) {
      parts.push(
        theme.fg(
          "muted",
          args.includeCompleted ? " list · including completed" : " list · active",
        ),
      );
    } else if (summary.startsWith("wait")) {
      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : DEFAULT_WAIT_TIMEOUT_MS;
      const progress =
        args.progress === "none" || args.progress === "status"
          ? args.progress
          : DEFAULT_WAIT_PROGRESS_MODE;
      parts.push(
        theme.fg(
          "muted",
          ` wait · ${formatWaitTimeoutLabel(timeoutMs)} · progress ${progress}`,
        ),
      );
    } else {
      appendThemedSegment(parts, theme, "muted", ` ${summary}`);
    }

    text.setText(parts.join(""));
    return text;
  } catch {
    if (theme?.fg && theme?.bold) {
      text.setText(theme.fg("toolTitle", theme.bold("vigil")));
    } else {
      text.setText("vigil");
    }
    return text;
  }
}
