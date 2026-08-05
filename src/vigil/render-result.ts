import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { VigilCallArgs } from "./render-call";
import {
  appendThemedExpandableDetailBlock,
  formatExpandHint,
  formatExpandableMutationDetailBlock,
} from "./render-detail";
import { escapeTerminalControls } from "./transcript";
import { formatMutationSnapshotText, type VigilSnapshot } from "./types";

const MUTATION_ACTIONS = new Set(["launch", "send", "complete"]);

export interface VigilResultRenderContext {
  lastComponent?: Component;
  expanded?: boolean;
  isPartial?: boolean;
  isError?: boolean;
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

    const detailBlock = formatExpandableMutationDetailBlock(args.action, args, details);
    if (renderContext.expanded && detailBlock) {
      rendered += appendThemedExpandableDetailBlock(detailBlock, theme);
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
