import type { Context } from "@earendil-works/pi-ai";

export class VigilFauxPlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VigilFauxPlaceholderError";
  }
}

export function extractLaunchIdsFromContext(_context: Context): string[] {
  return [];
}

export function substituteLaunchPlaceholders(value: unknown, _launchIds: string[]): unknown {
  return value;
}
