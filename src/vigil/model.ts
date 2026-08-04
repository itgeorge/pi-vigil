const MODEL_THINKING_LEVEL_SUFFIXES = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function hasThinkingLevelSuffix(model: string): boolean {
  const lastColonIndex = model.lastIndexOf(":");
  if (lastColonIndex === -1) {
    return false;
  }

  return MODEL_THINKING_LEVEL_SUFFIXES.has(model.slice(lastColonIndex + 1));
}

export function appendThinkingLevelToModel(
  model: string | undefined,
  thinkingLevel: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!thinkingLevel || hasThinkingLevelSuffix(trimmed)) {
    return trimmed;
  }

  return `${trimmed}:${thinkingLevel}`;
}
