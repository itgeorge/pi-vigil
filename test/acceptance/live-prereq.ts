import { spawnSync } from "node:child_process";

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

export function verifyPiAuthentication(model = getVigilTestModel()): void {
  const result = spawnSync(
    "pi",
    ["--mode", "json", "-p", "--model", model, "Reply with exactly: VIGIL_AUTH_OK"],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: process.env,
    },
  );

  if (result.error) {
    throw new Error(`Pi authentication preflight failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      [
        "Pi authentication preflight failed.",
        "Ensure the `pi` CLI is installed and authenticated for the configured model.",
        `Model: ${model}`,
        stderr ? `stderr: ${stderr}` : undefined,
        stdout ? `stdout: ${stdout}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes("VIGIL_AUTH_OK")) {
    throw new Error(
      [
        "Pi authentication preflight did not return the expected marker.",
        `Model: ${model}`,
        `Output: ${combined.trim()}`,
      ].join("\n"),
    );
  }
}

export function getAcceptancePollIntervalMs(): number {
  const value = Number(process.env.PI_VIGIL_ACCEPTANCE_POLL_MS ?? "1000");
  return Number.isFinite(value) && value > 0 ? value : 1000;
}

export function getAcceptanceTimeoutMs(): number {
  const value = Number(process.env.PI_VIGIL_ACCEPTANCE_TIMEOUT_MS ?? "120000");
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}
