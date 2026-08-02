import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { VigilCallArgs } from "./render-call";
import { MAX_ENTRY_DETAIL_CHARS, escapeTerminalControls, sanitizeDisplayMultiline } from "./transcript";
import { formatMutationSnapshotText, type VigilSnapshot } from "./types";

const MUTATION_ACTIONS = new Set(["launch", "send", "complete"]);

export interface VigilResultRenderContext {
  lastComponent?: Component;
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
}

function formatExpandHint(theme: Theme): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    const key = keyText("app.tools.expand");
    if (key) {
      return theme.fg("dim", key) + theme.fg("muted", " to expand");
    }
    return theme.fg("muted", "to expand");
  }
}

function isVigilSnapshot(details: unknown): details is VigilSnapshot {
  return (
    typeof details === "object" &&
    details !== null &&
    typeof (details as VigilSnapshot).id === "string" &&
    typeof (details as VigilSnapshot).name === "string" &&
    typeof (details as VigilSnapshot).state === "string"
  );
}

function getResultText(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
}

function sanitizeRendererFallbackText(text: string): string {
  return escapeTerminalControls(text, true);
}

function getSafeFallbackResultText(result: AgentToolResult<unknown>): string {
  return sanitizeRendererFallbackText(getResultText(result));
}

function resolveTextComponent(lastComponent?: Component): Text {
  if (lastComponent && typeof (lastComponent as { setText?: unknown }).setText === "function") {
    return lastComponent as Text;
  }
  return new Text("", 0, 0);
}

function hasExpandableDetail(
  action: VigilCallArgs["action"],
  args: VigilCallArgs,
  details: VigilSnapshot | undefined,
): boolean {
  if (action === "send") {
    return typeof args.message === "string" && args.message.length > 0;
  }
  if (action === "complete") {
    return typeof details?.latestResponse === "string" && details.latestResponse.length > 0;
  }
  return false;
}

function formatExpandableDetailBlock(
  action: VigilCallArgs["action"],
  args: VigilCallArgs,
  details: VigilSnapshot | undefined,
): string | undefined {
  if (action === "send" && typeof args.message === "string" && args.message.length > 0) {
    return `sent message:\n${sanitizeDisplayMultiline(args.message, MAX_ENTRY_DETAIL_CHARS)}`;
  }
  if (
    action === "complete" &&
    typeof details?.latestResponse === "string" &&
    details.latestResponse.length > 0
  ) {
    return `latest response:\n${sanitizeDisplayMultiline(details.latestResponse, MAX_ENTRY_DETAIL_CHARS)}`;
  }
  return undefined;
}

export function renderVigilResultText(
  result: AgentToolResult<unknown>,
  args: VigilCallArgs,
  theme: Theme,
  renderContext: VigilResultRenderContext = {},
): Text {
  const text = resolveTextComponent(renderContext.lastComponent);

  try {
    if (renderContext.isPartial || renderContext.isError || !args.action || !MUTATION_ACTIONS.has(args.action)) {
      text.setText(getSafeFallbackResultText(result));
      return text;
    }

    const details = isVigilSnapshot(result.details) ? result.details : undefined;
    const compactText = details ? formatMutationSnapshotText(details) : getSafeFallbackResultText(result);
    let rendered = theme.fg("toolOutput", compactText);

    const detailBlock = formatExpandableDetailBlock(args.action, args, details);
    if (renderContext.expanded && detailBlock) {
      const [label, ...bodyLines] = detailBlock.split("\n");
      rendered += `\n\n${theme.fg("dim", label ?? "")}`;
      if (bodyLines.length > 0) {
        rendered += `\n${theme.fg("text", bodyLines.join("\n"))}`;
      }
    } else if (!renderContext.expanded && detailBlock) {
      rendered += `\n${formatExpandHint(theme)}`;
    }

    text.setText(rendered);
    return text;
  } catch {
    text.setText(getSafeFallbackResultText(result));
    return text;
  }
}
