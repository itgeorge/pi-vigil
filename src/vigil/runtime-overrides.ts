import type { ChildSessionNamer, ChildSessionReader, ProcessRunner } from "./ports.ts";

export interface VigilRuntimeOverrides {
  processRunner?: ProcessRunner;
  childSessionReader?: ChildSessionReader;
  childSessionNamer?: ChildSessionNamer;
  sessionDir?: string;
}

let runtimeOverrides: VigilRuntimeOverrides = {};

export function setVigilRuntimeOverrides(overrides: VigilRuntimeOverrides): void {
  runtimeOverrides = overrides;
}

export function resetVigilRuntimeOverrides(): void {
  runtimeOverrides = {};
}

export function getVigilRuntimeOverrides(): VigilRuntimeOverrides {
  return runtimeOverrides;
}
