export const DEFAULT_BOOTSTRAP_FAIL_FAST_TIMEOUT_MS = 2500;
export const DEFAULT_BOOTSTRAP_WATCHDOG_TIMEOUT_MS = 60_000;
export const MAX_STDERR_EXCERPT_CHARS = 8 * 1024;

const PI_STDERR_ERROR_PREFIX = "Error:";

export interface ClassifyPersistedBootstrapFailureInput {
  alive: boolean;
  sessionExists: boolean;
  turnStartedAt?: string | null;
  lastConversationTimestamp?: string | null;
  stderr?: string;
}

export function parsePiStderrFailure(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PI_STDERR_ERROR_PREFIX)) {
      continue;
    }

    const message = trimmed.slice(PI_STDERR_ERROR_PREFIX.length).trim();
    return message || trimmed;
  }

  return null;
}

export function boundStderrExcerpt(stderr: string, maxChars: number): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}…`;
}

export function classifyPersistedBootstrapFailure(
  input: ClassifyPersistedBootstrapFailureInput,
): string | null {
  if (input.sessionExists) {
    return null;
  }

  if (input.alive) {
    return null;
  }

  const parsed = input.stderr ? parsePiStderrFailure(input.stderr) : null;
  if (parsed) {
    return parsed;
  }

  return "Pi child exited before session was created";
}

export function formatVigilChildFailedError(vigilId: string, error: string): string {
  return `Vigil child failed: ${vigilId} — ${error}`;
}
