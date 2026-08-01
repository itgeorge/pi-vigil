import type { ChildSessionNamer, ChildSessionReader, ProcessRunner, WaitScheduler } from "./ports.ts";

export interface VigilRuntimeOverrides {
  processRunner?: ProcessRunner;
  childSessionReader?: ChildSessionReader;
  childSessionNamer?: ChildSessionNamer;
  waitScheduler?: WaitScheduler;
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
