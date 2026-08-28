import type { ChildSessionDescendantInspector } from "./descendant-inspector.ts";
import type { EphemeralChildObserver } from "./ephemeral-observer.ts";
import type { ParentNotifier } from "./parent-notifier.ts";
import type { PersistedBootstrapObserver } from "./persisted-bootstrap-observer.ts";
import type { PersistedSettleWatcher } from "./persisted-settle-watcher.ts";
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
  ephemeralChildObserver?: EphemeralChildObserver;
  persistedBootstrapObserver?: PersistedBootstrapObserver;
  persistedSettleWatcher?: PersistedSettleWatcher;
  parentNotifier?: ParentNotifier;
  bootstrapFailFastTimeoutMs?: number;
  waitScheduler?: WaitScheduler;
  sessionDir?: string;
}

const RUNTIME_OVERRIDES_GLOBAL_KEY = Symbol.for("pi-vigil.runtime-overrides");

type GlobalWithVigilRuntimeOverrides = typeof globalThis & {
  [RUNTIME_OVERRIDES_GLOBAL_KEY]?: VigilRuntimeOverrides;
};

function getRuntimeOverridesStore(): VigilRuntimeOverrides {
  const globalStore = globalThis as GlobalWithVigilRuntimeOverrides;
  if (!globalStore[RUNTIME_OVERRIDES_GLOBAL_KEY]) {
    globalStore[RUNTIME_OVERRIDES_GLOBAL_KEY] = {};
  }
  return globalStore[RUNTIME_OVERRIDES_GLOBAL_KEY]!;
}

export function setVigilRuntimeOverrides(overrides: VigilRuntimeOverrides): void {
  Object.assign(getRuntimeOverridesStore(), overrides);
}

export function resetVigilRuntimeOverrides(): void {
  const globalStore = globalThis as GlobalWithVigilRuntimeOverrides;
  globalStore[RUNTIME_OVERRIDES_GLOBAL_KEY] = {};
}

export function getVigilRuntimeOverrides(): VigilRuntimeOverrides {
  return getRuntimeOverridesStore();
}
