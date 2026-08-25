import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const NESTED_LAUNCH_DISABLED_ERROR =
  "Vigil nested launch is disabled for this session. Launch with allowSubagents: true from the parent if nesting is intended.";

export function formatNestedLaunchDisabledError(): string {
  return NESTED_LAUNCH_DISABLED_ERROR;
}

export interface ResolveNestedLaunchAllowedInput {
  entries: SessionEntry[];
  noSubagentsFlag?: boolean;
}

function parseVigilPolicyAllowSubagents(entry: SessionEntry): boolean | null {
  if (entry.type !== "custom" || entry.customType !== "vigil-policy") {
    return null;
  }

  const data = entry.data;
  if (data === null || typeof data !== "object") {
    return null;
  }

  const allowSubagents = (data as { allowSubagents?: unknown }).allowSubagents;
  if (typeof allowSubagents !== "boolean") {
    return null;
  }

  return allowSubagents;
}

export function resolveNestedLaunchAllowed(input: ResolveNestedLaunchAllowedInput): boolean {
  for (const entry of input.entries) {
    const allowSubagents = parseVigilPolicyAllowSubagents(entry);
    if (allowSubagents !== null) {
      return allowSubagents;
    }
  }

  if (input.noSubagentsFlag === true) {
    return false;
  }

  return true;
}
