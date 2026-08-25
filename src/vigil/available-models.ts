import type { Api, Model } from "@earendil-works/pi-ai";

export const DEFAULT_MODELS_MAX_RESULTS = 50;
export const MAX_MODELS_MAX_RESULTS = 100;

export interface VigilAvailableModelItem {
  reference: string;
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  images: boolean;
}

export interface VigilAvailableModelsResult {
  models: VigilAvailableModelItem[];
  omittedCount: number;
  registryError?: string;
}

export interface ModelsInput {
  query?: string;
  maxResults?: number;
}

export interface ModelsPolicy {
  query?: string;
  maxResults: number;
}

export interface AvailableModelsSource {
  getAvailable(): Model<Api>[];
  getError(): string | undefined;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
  }
  return count.toString();
}

export function resolveModelsPolicy(input: ModelsInput = {}): ModelsPolicy | { error: string } {
  const maxResults = input.maxResults ?? DEFAULT_MODELS_MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults <= 0 || maxResults > MAX_MODELS_MAX_RESULTS) {
    return {
      error: `maxResults must be a positive safe integer no greater than ${MAX_MODELS_MAX_RESULTS}`,
    };
  }

  let query: string | undefined;
  if (input.query !== undefined) {
    const trimmed = input.query.trim();
    if (!trimmed) {
      return { error: "models query must be nonblank when supplied" };
    }
    query = trimmed;
  }

  return {
    ...(query !== undefined ? { query } : {}),
    maxResults,
  };
}

export function modelToAvailableItem(model: Model<Api>): VigilAvailableModelItem {
  return {
    reference: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    images: model.input.includes("image"),
  };
}

export function filterAvailableModels(
  models: Model<Api>[],
  query?: string,
): Model<Api>[] {
  if (!query) {
    return models;
  }

  const needle = query.toLowerCase();
  return models.filter((model) => {
    const haystack = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
    return haystack.includes(needle);
  });
}

export function listAvailableModels(
  source: AvailableModelsSource,
  input: ModelsInput = {},
): VigilAvailableModelsResult | { error: string } {
  const policy = resolveModelsPolicy(input);
  if ("error" in policy) {
    return policy;
  }

  const registryError = source.getError()?.trim();
  const sorted = [...source.getAvailable()].sort((left, right) => {
    const providerCmp = left.provider.localeCompare(right.provider);
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.id.localeCompare(right.id);
  });

  const filtered = filterAvailableModels(sorted, policy.query);
  const models = filtered.slice(0, policy.maxResults).map(modelToAvailableItem);
  const omittedCount = Math.max(0, filtered.length - models.length);

  return {
    models,
    omittedCount,
    ...(registryError ? { registryError } : {}),
  };
}

export function formatAvailableModelsText(result: VigilAvailableModelsResult): string {
  const lines: string[] = [];

  if (result.registryError) {
    lines.push(`registryWarning: ${result.registryError}`);
  }

  if (result.models.length === 0) {
    lines.push("models: (none)");
    if (result.registryError) {
      lines.push("hint: configure provider auth or models.json, then retry");
    } else {
      lines.push("hint: no authenticated models are available in this Pi session");
    }
    return lines.join("\n");
  }

  lines.push(`count: ${result.models.length}`);
  if (result.omittedCount > 0) {
    lines.push(`omittedCount: ${result.omittedCount}`);
  }
  lines.push("");
  lines.push("reference · provider · id · context · max-out · thinking · images");

  for (const model of result.models) {
    lines.push(
      [
        model.reference,
        model.provider,
        model.id,
        formatTokenCount(model.contextWindow),
        formatTokenCount(model.maxTokens),
        model.reasoning ? "yes" : "no",
        model.images ? "yes" : "no",
      ].join(" · "),
    );
  }

  lines.push("");
  lines.push("Use reference values in launch (required) and send (optional) model (optional :thinking suffix, e.g. cursor/composer-2.5-fast:high).");

  return lines.join("\n");
}
