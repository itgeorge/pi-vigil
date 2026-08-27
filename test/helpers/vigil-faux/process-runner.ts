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
const FAUX_MODEL_ID = "vigil-faux/scripted";

function normalizeFauxSpawnModel(model?: string): string | undefined {
  if (!model?.trim()) {
    return undefined;
  }

  const trimmed = model.trim();
  if (trimmed === FAUX_MODEL_ID || trimmed.startsWith(`${FAUX_MODEL_ID}:`)) {
    return FAUX_MODEL_ID;
  }

  return trimmed;
}

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

  // Prepend extension args so we never insert tokens between a trailing bare
  // boolean flag (e.g. --vigil-no-subagents) and the positional prompt. Doing
  // so previously masked a production argv bug where Pi swallowed the prompt.
  if (options.loadLocalVigil) {
    const vigilPath = options.localVigilExtensionPath ?? getLocalVigilExtensionPath();
    return ["-ne", "-e", vigilPath, "-e", fauxPath, ...head, message];
  }

  return ["--extension", fauxPath, ...head, message];
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
      const normalizedInput = {
        ...input,
        model: normalizeFauxSpawnModel(input.model),
      };

      return spawnDetachedPiChild(piExecutable, normalizedInput, {
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
  const childArgs = buildPiChildArgs({
    ...input,
    model: normalizeFauxSpawnModel(input.model),
  });
  const spawnArgs = buildPiSpawnArgs(spawnCommand, childArgs);
  return insertVigilFauxExtensionArgs(spawnArgs, options);
}
