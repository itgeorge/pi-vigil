import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPiChildArgs,
  createNodeProcessRunner,
  spawnDetachedPiChild,
} from "../../../src/vigil/node-runtime.js";
import type { ProcessRunner, SpawnChildInput } from "../../../src/vigil/ports.js";
import { buildPiSpawnArgs, resolvePiSpawnCommand } from "../../../src/vigil/pi-spawn-command.js";
import type { VigilFauxScript } from "./script.js";

const FAUX_SCRIPT_FILENAME = "vigil-faux-script.json";

export function writeVigilFauxScript(dir: string, script: VigilFauxScript): string {
  const scriptPath = resolve(dir, FAUX_SCRIPT_FILENAME);
  writeFileSync(scriptPath, `${JSON.stringify(script, null, 2)}\n`, "utf8");
  return scriptPath;
}

export function getVigilFauxExtensionPath(): string {
  const extensionPath = fileURLToPath(new URL("./extension.ts", import.meta.url));
  accessSync(extensionPath);
  return extensionPath;
}

export function getLocalVigilExtensionPath(): string {
  const extensionPath = fileURLToPath(new URL("../../../src/index.ts", import.meta.url));
  accessSync(extensionPath);
  return extensionPath;
}

export type InsertVigilFauxExtensionArgsOptions = {
  loadLocalVigil?: boolean;
  fauxExtensionPath?: string;
  localVigilExtensionPath?: string;
};

export function insertVigilFauxExtensionArgs(
  args: string[],
  options: InsertVigilFauxExtensionArgsOptions = {},
): string[] {
  if (args.length === 0) {
    throw new Error("Cannot insert faux extension args into an empty argv list");
  }

  const fauxPath = options.fauxExtensionPath ?? getVigilFauxExtensionPath();
  const message = args[args.length - 1]!;
  const head = args.slice(0, -1);

  if (options.loadLocalVigil) {
    const vigilPath = options.localVigilExtensionPath ?? getLocalVigilExtensionPath();
    return [...head, "-ne", "-e", vigilPath, "-e", fauxPath, message];
  }

  return [...head, "--extension", fauxPath, message];
}

export type CreateVigilFauxProcessRunnerOptions = {
  base?: ProcessRunner;
  loadLocalVigil?: boolean;
  piExecutable?: string;
  platform?: NodeJS.Platform;
  resolvePiCliEntrypoint?: () => string;
  spawnChild?: (
    command: string,
    args: string[],
    spawnOptions: SpawnOptions,
  ) => ChildProcess;
};

export function createVigilFauxProcessRunner(
  options: CreateVigilFauxProcessRunnerOptions = {},
): ProcessRunner {
  const base = options.base ?? createNodeProcessRunner({ piExecutable: options.piExecutable });
  const piExecutable = options.piExecutable ?? "pi";
  const insertExtensionArgs: InsertVigilFauxExtensionArgsOptions = {
    loadLocalVigil: options.loadLocalVigil,
  };

  return {
    spawnDetached(input: SpawnChildInput) {
      return spawnDetachedPiChild(piExecutable, input, {
        platform: options.platform,
        resolvePiCliEntrypoint: options.resolvePiCliEntrypoint,
        spawnChild: (command, args, spawnOptions) => {
          const withExtension = insertVigilFauxExtensionArgs(args, insertExtensionArgs);
          const spawnFn = options.spawnChild ?? spawn;
          return spawnFn(command, withExtension, spawnOptions);
        },
      });
    },
    isAlive(pid) {
      return base.isAlive(pid);
    },
    terminateAndWait(pid, terminateOptions) {
      return base.terminateAndWait(pid, terminateOptions);
    },
  };
}

/** @internal Exported for unit tests that assert arg splicing without spawning. */
export function buildVigilFauxPiChildArgs(
  input: SpawnChildInput,
  options: InsertVigilFauxExtensionArgsOptions = {},
): string[] {
  const spawnCommand = resolvePiSpawnCommand();
  const childArgs = buildPiChildArgs(input);
  const spawnArgs = buildPiSpawnArgs(spawnCommand, childArgs);
  return insertVigilFauxExtensionArgs(spawnArgs, options);
}
