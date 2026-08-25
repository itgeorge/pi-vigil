import { truncateLine } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { reconstructVigilLifecycleFromEntries } from "./lifecycle";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./node-runtime";
import {
  appendThemedExpandableDetailBlock,
  formatExpandHint,
  formatLaunchMessageDetailBlock,
} from "./render-detail";
import { escapeTerminalControls } from "./transcript";

export const MAX_CALL_FIELD_CHARS = 120;
export const VIGIL_SHORT_ID_HEX_LENGTH = 7;

export interface VigilCallArgs {
  action?: "launch" | "poll" | "send" | "list" | "complete" | "wait" | "search" | "read" | "models";
  name?: string;
  message?: string;
  model?: string;
  cwd?: string;
  id?: string;
  query?: string;
  entryId?: string;
  before?: number;
  after?: number;
  maxResults?: number;
  skipToId?: string;
  includeCompleted?: boolean;
  timeoutMs?: number;
  allowIncompleteSubagents?: boolean;
  allowSubagents?: boolean;
  ephemeral?: boolean;
}

export interface VigilLifecycleDisplayEntry {
  name: string;
  model?: string;
}

export type VigilLifecycleLookup = ReadonlyMap<string, VigilLifecycleDisplayEntry>;

/** @deprecated Use VigilLifecycleLookup */
export type VigilDisplayNameLookup = VigilLifecycleLookup;

export function sanitizeCallField(value: string): string {
  const lineBroken = value.replace(/\n/g, " ");
  const escaped = escapeTerminalControls(lineBroken, false);
  const collapsed = escaped.replace(/ +/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  return truncateLine(collapsed, MAX_CALL_FIELD_CHARS).text;
}

export function formatVigilShortId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed.startsWith("vigil-")) {
    return sanitizeCallField(trimmed) || trimmed;
  }

  const suffix = escapeTerminalControls(trimmed.slice("vigil-".length).replace(/-/g, ""), false);
  if (!suffix) {
    return "vigil-?";
  }

  return `vigil-${suffix.slice(0, VIGIL_SHORT_ID_HEX_LENGTH)}`;
}

export function buildVigilLifecycleDisplayIndex(entries: SessionEntry[]): VigilLifecycleLookup {
  const lifecycle = reconstructVigilLifecycleFromEntries(entries);
  const index = new Map<string, VigilLifecycleDisplayEntry>();

  for (const state of lifecycle.values()) {
    index.set(state.id, {
      name: state.completionRecord?.name ?? state.launchName,
      model: state.runtimeRecord.model,
    });
  }

  return index;
}

export function buildVigilDisplayNameIndex(entries: SessionEntry[]): VigilLifecycleLookup {
  return buildVigilLifecycleDisplayIndex(entries);
}

export function createVigilDisplayNameCache(): {
  refreshFromEntries: (entries: SessionEntry[]) => void;
  refreshFromBranch: (getBranch: () => SessionEntry[]) => void;
  lookup: () => VigilLifecycleLookup;
} {
  let index: VigilLifecycleLookup = new Map();

  return {
    refreshFromEntries(entries) {
      index = buildVigilLifecycleDisplayIndex(entries);
    },
    refreshFromBranch(getBranch) {
      index = buildVigilLifecycleDisplayIndex(getBranch());
    },
    lookup: () => index,
  };
}

function resolveLifecycleEntry(
  id: string | undefined,
  lookup: VigilLifecycleLookup | ((id: string) => VigilLifecycleDisplayEntry | undefined),
): VigilLifecycleDisplayEntry | undefined {
  if (!id?.trim()) {
    return undefined;
  }

  if (typeof lookup === "function") {
    return lookup(id);
  }

  return lookup.get(id);
}

function resolveDisplayName(
  id: string | undefined,
  lookup: VigilLifecycleLookup | ((id: string) => VigilLifecycleDisplayEntry | undefined),
): string | undefined {
  return resolveLifecycleEntry(id, lookup)?.name;
}

function resolveSendModel(
  args: VigilCallArgs,
  lookup: VigilLifecycleLookup | ((id: string) => VigilLifecycleDisplayEntry | undefined),
): string | undefined {
  const explicit = args.model?.trim();
  if (explicit) {
    return explicit;
  }

  return resolveLifecycleEntry(args.id, lookup)?.model;
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
  lookup: VigilLifecycleLookup | ((id: string) => VigilLifecycleDisplayEntry | undefined),
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

export function formatVigilCallExpandedArgs(args: VigilCallArgs): string {
  try {
    const pretty = JSON.stringify(args, null, 2);
    return escapeTerminalControls(pretty, true);
  } catch {
    return "{}";
  }
}

function resolveTextComponent(lastComponent?: Component): Text {
  if (
    lastComponent &&
    typeof (lastComponent as { setText?: unknown }).setText === "function"
  ) {
    return lastComponent as Text;
  }
  return new Text("", 0, 0);
}

export function formatVigilCallSummary(
  args: VigilCallArgs,
  lookup: VigilLifecycleLookup | ((id: string) => VigilLifecycleDisplayEntry | undefined) = new Map(),
): string {
  const action = args.action ?? "vigil";
  const segments: string[] = [action];

  switch (action) {
    case "launch": {
      const name = sanitizeCallField(args.name ?? "") || "launch";
      segments.push(name);
      if (args.ephemeral) {
        segments.push("ephemeral");
      }
      if (args.allowSubagents) {
        segments.push("allow subagents");
      }
      segments.push(formatModelIndicator(args.model));
      break;
    }
    case "poll":
    case "complete": {
      segments.push(formatIdIdentity(args.id, lookup));
      if (action === "complete" && args.allowIncompleteSubagents) {
        segments.push("allow incomplete subagents");
      }
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
      const model = formatModelIndicator(resolveSendModel(args, lookup));
      if (model) {
        summary += ` · ${model}`;
      }
      return summary;
    }
    case "list": {
      segments.push(args.includeCompleted ? "including completed" : "active");
      if (
        typeof args.maxResults === "number" &&
        Number.isFinite(args.maxResults) &&
        Number.isSafeInteger(args.maxResults)
      ) {
        segments.push(`max ${args.maxResults}`);
      }
      if (args.skipToId?.trim()) {
        segments.push(`from ${formatVigilShortId(args.skipToId)}`);
      }
      break;
    }
    case "models": {
      if (args.query?.trim()) {
        segments.push(`filter ${sanitizeCallField(args.query)}`);
      }
      if (
        typeof args.maxResults === "number" &&
        Number.isFinite(args.maxResults) &&
        Number.isSafeInteger(args.maxResults)
      ) {
        segments.push(`max ${args.maxResults}`);
      }
      break;
    }
    case "wait": {
      if (args.id?.trim()) {
        segments.push(formatIdIdentity(args.id, lookup));
      }
      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : DEFAULT_WAIT_TIMEOUT_MS;
      segments.push(formatWaitTimeoutLabel(timeoutMs));
      break;
    }
    case "search": {
      const excerpt = formatQuotedExcerpt(args.query) ?? '""';
      segments.push(excerpt);
      if (args.id?.trim()) {
        segments.push(formatIdIdentity(args.id, lookup));
      } else {
        segments.push(args.includeCompleted ? "including completed" : "active");
      }
      break;
    }
    case "read": {
      segments.push(formatIdIdentity(args.id, lookup));
      const entryId = args.entryId?.trim() ? sanitizeCallField(args.entryId) || "entry" : "entry";
      const before =
        typeof args.before === "number" && Number.isFinite(args.before) ? args.before : 1;
      const after =
        typeof args.after === "number" && Number.isFinite(args.after) ? args.after : 1;
      segments.push(`entry ${entryId}`);
      segments.push(`context ${before}/${after}`);
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

export interface VigilCallRenderContext {
  lastComponent?: Component;
  expanded?: boolean;
}

export function renderVigilCallText(
  args: VigilCallArgs,
  theme: Theme,
  lookup: VigilLifecycleLookup | ((id: string) => VigilLifecycleDisplayEntry | undefined) = new Map(),
  renderContext: VigilCallRenderContext = {},
): Text {
  const text = resolveTextComponent(renderContext.lastComponent);

  try {
    const summary = formatVigilCallSummary(args, lookup);
    const parts: string[] = [theme.fg("toolTitle", theme.bold("vigil"))];

    if (summary.startsWith("launch")) {
      const name = sanitizeCallField(args.name ?? "") || "launch";
      const model = args.model?.trim() ? formatModelIndicator(args.model) : "";
      parts.push(theme.fg("muted", " launch · "));
      parts.push(theme.fg("text", name));
      if (args.ephemeral) {
        parts.push(theme.fg("dim", " · ephemeral"));
      }
      if (args.allowSubagents) {
        parts.push(theme.fg("dim", " · allow subagents"));
      }
      if (model) {
        parts.push(theme.fg("dim", ` · ${model}`));
      }
    } else if (summary.startsWith("send")) {
      parts.push(theme.fg("muted", " send · "));
      parts.push(theme.fg("text", formatIdIdentity(args.id, lookup)));
      const excerpt = formatQuotedExcerpt(args.message);
      if (excerpt) {
        parts.push(theme.fg("dim", ` — ${excerpt}`));
      }
      const model = formatModelIndicator(resolveSendModel(args, lookup));
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
      if (action === "complete" && args.allowIncompleteSubagents) {
        parts.push(theme.fg("dim", " · allow incomplete subagents"));
      }
    } else if (summary.startsWith("list")) {
      const listSegments = [args.includeCompleted ? "including completed" : "active"];
      if (
        typeof args.maxResults === "number" &&
        Number.isFinite(args.maxResults) &&
        Number.isSafeInteger(args.maxResults)
      ) {
        listSegments.push(`max ${args.maxResults}`);
      }
      if (args.skipToId?.trim()) {
        listSegments.push(`from ${formatVigilShortId(args.skipToId)}`);
      }
      parts.push(theme.fg("muted", ` list · ${listSegments.join(" · ")}`));
    } else if (summary.startsWith("wait")) {
      const timeoutMs =
        typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
          ? args.timeoutMs
          : DEFAULT_WAIT_TIMEOUT_MS;
      parts.push(theme.fg("muted", " wait"));
      if (args.id?.trim()) {
        parts.push(theme.fg("muted", " · "));
        parts.push(theme.fg("text", formatIdIdentity(args.id, lookup)));
      }
      parts.push(theme.fg("muted", ` · ${formatWaitTimeoutLabel(timeoutMs)}`));
    } else if (summary.startsWith("search")) {
      const excerpt = formatQuotedExcerpt(args.query) ?? '""';
      parts.push(theme.fg("muted", " search · "));
      parts.push(theme.fg("text", excerpt));
      if (args.id?.trim()) {
        parts.push(theme.fg("dim", ` · ${formatIdIdentity(args.id, lookup)}`));
      } else {
        parts.push(
          theme.fg(
            "dim",
            args.includeCompleted ? " · including completed" : " · active",
          ),
        );
      }
    } else if (summary.startsWith("read")) {
      parts.push(theme.fg("muted", " read · "));
      parts.push(theme.fg("text", formatIdIdentity(args.id, lookup)));
      const entryId = args.entryId?.trim() ? sanitizeCallField(args.entryId) || "entry" : "entry";
      const before =
        typeof args.before === "number" && Number.isFinite(args.before) ? args.before : 1;
      const after =
        typeof args.after === "number" && Number.isFinite(args.after) ? args.after : 1;
      parts.push(theme.fg("dim", ` · entry ${entryId} · context ${before}/${after}`));
    } else {
      appendThemedSegment(parts, theme, "muted", ` ${summary}`);
    }

    let rendered = parts.join("");
    const launchDetail = formatLaunchMessageDetailBlock(args);

    if (launchDetail) {
      if (renderContext.expanded) {
        rendered += appendThemedExpandableDetailBlock(launchDetail, theme);
        rendered += `\n\n${formatVigilCallExpandedArgs(args)}`;
      } else {
        rendered += `\n${formatExpandHint(theme)}`;
      }
    } else if (renderContext.expanded) {
      rendered += `\n\n${formatVigilCallExpandedArgs(args)}`;
    }
    text.setText(rendered);
    return text;
  } catch {
    let fallback = "vigil";
    if (theme?.fg && theme?.bold) {
      fallback = theme.fg("toolTitle", theme.bold("vigil"));
    }
    if (renderContext.expanded) {
      fallback += `\n\n${formatVigilCallExpandedArgs(args)}`;
    }
    text.setText(fallback);
    return text;
  }
}
