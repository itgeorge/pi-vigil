import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { VigilCallArgs } from "./render-call";
import { MAX_ENTRY_DETAIL_CHARS, sanitizeDisplayMultiline } from "./transcript";
import type { VigilSnapshot } from "./types";

export function formatExpandHint(theme: Theme): string {
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

export function hasLaunchMessage(args: VigilCallArgs): boolean {
  return typeof args.message === "string" && args.message.length > 0;
}

export function formatLaunchMessageDetailBlock(args: VigilCallArgs): string | undefined {
  if (!hasLaunchMessage(args)) {
    return undefined;
  }

  return `launch message:\n${sanitizeDisplayMultiline(args.message!, MAX_ENTRY_DETAIL_CHARS)}`;
}

export function formatExpandableMutationDetailBlock(
  action: VigilCallArgs["action"],
  args: VigilCallArgs,
  details: VigilSnapshot | undefined,
): string | undefined {
  if (action === "launch") {
    return formatLaunchMessageDetailBlock(args);
  }
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

export function appendThemedExpandableDetailBlock(detailBlock: string, theme: Theme): string {
  const [label, ...bodyLines] = detailBlock.split("\n");
  let rendered = `\n\n${theme.fg("dim", label ?? "")}`;
  if (bodyLines.length > 0) {
    rendered += `\n${theme.fg("text", bodyLines.join("\n"))}`;
  }
  return rendered;
}
