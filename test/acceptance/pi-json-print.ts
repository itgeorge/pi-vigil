import { spawn } from "node:child_process";

export interface PiJsonPrintResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  sawAgentSettled: boolean;
}

export interface PiJsonPrintOptions {
  args: string[];
  timeoutMs?: number;
  successMarker?: string;
  piExecutable?: string;
}

export function runPiJsonPrintCommand(options: PiJsonPrintOptions): Promise<PiJsonPrintResult> {
  const {
    args,
    timeoutMs = 180_000,
    successMarker,
    piExecutable = "pi",
  } = options;

  return new Promise((resolve) => {
    const child = spawn(piExecutable, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let sawAgentSettled = false;
    let settled = false;

    const finish = (result: Omit<PiJsonPrintResult, "stdout" | "stderr" | "sawAgentSettled">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        sawAgentSettled,
        ...result,
      });
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('"type":"agent_settled"')) {
        sawAgentSettled = true;
      }
      if (successMarker && stdout.includes(successMarker) && sawAgentSettled) {
        child.kill("SIGTERM");
        finish({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: false,
        });
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      stderr += error.message;
      finish({
        exitCode: 1,
        signal: null,
        timedOut: false,
      });
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode,
        signal,
        timedOut: false,
      });
    });
  });
}

export function formatPiCommandFailure(label: string, result: PiJsonPrintResult, model?: string): string {
  return [
    `${label} failed.`,
    model ? `Model: ${model}` : undefined,
    result.timedOut ? `Timed out after waiting for Pi JSON print mode.` : undefined,
    result.sawAgentSettled
      ? "Observed agent_settled in stdout."
      : "Did not observe agent_settled in stdout.",
    result.exitCode !== null ? `exitCode: ${result.exitCode}` : undefined,
    result.signal ? `signal: ${result.signal}` : undefined,
    result.stderr.trim() ? `stderr: ${result.stderr.trim()}` : undefined,
    result.stdout.trim() ? `stdout tail: ${tailLines(result.stdout, 8)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function tailLines(text: string, count: number): string {
  const lines = text.trim().split("\n");
  return lines.slice(-count).join("\n");
}
