import type { ChildSessionDescendantInspector } from "./descendant-inspector.ts";
import type {
  ChildSessionNamer,
  ChildSessionReader,
  ChildSessionTranscriptReader,
  ProcessRunner,
  WaitScheduler,
} from "./ports.ts";

export interface VigilRuntimeOverrides {
  processRunner?: ProcessRunner;
  childSessionReader?: ChildSessionReader;
  childSessionTranscriptReader?: ChildSessionTranscriptReader;
  childSessionNamer?: ChildSessionNamer;
  descendantInspector?: ChildSessionDescendantInspector;
  waitScheduler?: WaitScheduler;
  sessionDir?: string;
}

let runtimeOverrides: VigilRuntimeOverrides = {};

export function setVigilRuntimeOverrides(overrides: VigilRuntimeOverrides): void {
  runtimeOverrides = { ...runtimeOverrides, ...overrides };
}

export function resetVigilRuntimeOverrides(): void {
  runtimeOverrides = {};
}

export function getVigilRuntimeOverrides(): VigilRuntimeOverrides {
  return runtimeOverrides;
}
