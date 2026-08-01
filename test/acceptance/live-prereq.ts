export const DEFAULT_VIGIL_TEST_MODEL = "openai-codex/gpt-5.5";

export function getVigilTestModel(): string {
  return process.env.PI_VIGIL_TEST_MODEL?.trim() || DEFAULT_VIGIL_TEST_MODEL;
}

export function requireLiveAcceptanceEnv(): void {
  if (process.env.PI_VIGIL_LIVE !== "1") {
    throw new Error(
      [
        "Live acceptance tests require opt-in.",
        "Set PI_VIGIL_LIVE=1 and ensure Pi authentication is configured, then run:",
        "  npm run test:acceptance",
      ].join("\n"),
    );
  }
}

export function getPreflightTimeoutMs(): number {
  const value = Number(process.env.PI_VIGIL_PREFLIGHT_TIMEOUT_MS ?? "180000");
  return Number.isFinite(value) && value > 0 ? value : 180_000;
}

export async function verifyPiAuthentication(model = getVigilTestModel()): Promise<void> {
  const { formatPiCommandFailure, runPiJsonPrintCommand } = await import("./pi-json-print.js");

  const result = await runPiJsonPrintCommand({
    args: ["--mode", "json", "-p", "--no-tools", "--model", model, "Reply with exactly: VIGIL_AUTH_OK"],
    timeoutMs: getPreflightTimeoutMs(),
    successMarker: "VIGIL_AUTH_OK",
  });

  if (!result.stdout.includes("VIGIL_AUTH_OK")) {
    throw new Error(
      formatPiCommandFailure("Pi authentication preflight did not return the expected marker", result, model),
    );
  }

  if (!result.sawAgentSettled) {
    throw new Error(formatPiCommandFailure("Pi authentication preflight did not settle", result, model));
  }

  if (result.timedOut) {
    throw new Error(formatPiCommandFailure("Pi authentication preflight timed out", result, model));
  }
}

export function getAcceptancePollIntervalMs(): number {
  const value = Number(process.env.PI_VIGIL_ACCEPTANCE_POLL_MS ?? "1000");
  return Number.isFinite(value) && value > 0 ? value : 1000;
}

export function getAcceptanceTimeoutMs(): number {
  const value = Number(process.env.PI_VIGIL_ACCEPTANCE_TIMEOUT_MS ?? "180000");
  return Number.isFinite(value) && value > 0 ? value : 180_000;
}
