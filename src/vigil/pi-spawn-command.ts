import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const DEFAULT_PI_EXECUTABLE = "pi";

export interface PiSpawnCommand {
  command: string;
  argsPrefix: string[];
}

export function derivePiCliEntrypointFromPackageIndex(indexPath: string): string {
  return join(dirname(indexPath), "cli.js");
}

function locatePiCodingAgentIndexPath(): string {
  if (typeof import.meta.resolve === "function") {
    return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  }

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "index.js",
    );
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  throw new Error(
    "Could not resolve @earendil-works/pi-coding-agent CLI entrypoint: import.meta.resolve is unavailable and the package was not found in node_modules",
  );
}

export function defaultResolvePiCliEntrypoint(): string {
  return derivePiCliEntrypointFromPackageIndex(locatePiCodingAgentIndexPath());
}

export function resolvePiSpawnCommand(options?: {
  piExecutable?: string;
  platform?: NodeJS.Platform;
  resolvePiCliEntrypoint?: () => string;
}): PiSpawnCommand {
  const platform = options?.platform ?? process.platform;
  const piExecutable = options?.piExecutable ?? DEFAULT_PI_EXECUTABLE;

  if (platform !== "win32") {
    return { command: piExecutable, argsPrefix: [] };
  }

  if (piExecutable !== DEFAULT_PI_EXECUTABLE) {
    return { command: piExecutable, argsPrefix: [] };
  }

  const resolveCli = options?.resolvePiCliEntrypoint ?? defaultResolvePiCliEntrypoint;
  return {
    command: process.execPath,
    argsPrefix: [resolveCli()],
  };
}

export function buildPiSpawnArgs(command: PiSpawnCommand, piArgs: string[]): string[] {
  return [...command.argsPrefix, ...piArgs];
}
