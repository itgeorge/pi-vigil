import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRunner } from "../../../src/vigil/ports";
import {
  getVigilRuntimeOverrides,
  resetVigilRuntimeOverrides,
  setVigilRuntimeOverrides,
} from "../../../src/vigil/runtime-overrides";

const RUNTIME_OVERRIDES_GLOBAL_KEY = Symbol.for("pi-vigil.runtime-overrides");

describe("vigil runtime overrides global bridge", () => {
  afterEach(() => {
    resetVigilRuntimeOverrides();
  });

  it("shares overrides through globalThis for dual-module extension loads", () => {
    const processRunner = {
      spawnDetached: async () => ({ pid: 42 }),
      isAlive: () => false,
      terminateAndWait: async () => {},
    } satisfies ProcessRunner;

    setVigilRuntimeOverrides({ processRunner, sessionDir: "/tmp/shared-vigil" });

    const globalStore = (globalThis as Record<symbol, ReturnType<typeof getVigilRuntimeOverrides>>)[
      RUNTIME_OVERRIDES_GLOBAL_KEY
    ];
    expect(globalStore?.processRunner).toBe(processRunner);
    expect(globalStore?.sessionDir).toBe("/tmp/shared-vigil");
    expect(getVigilRuntimeOverrides().processRunner).toBe(processRunner);
    expect(getVigilRuntimeOverrides().sessionDir).toBe("/tmp/shared-vigil");
  });

  it("reset clears the global bridge store", () => {
    setVigilRuntimeOverrides({ sessionDir: "/tmp/a" });
    resetVigilRuntimeOverrides();
    expect(getVigilRuntimeOverrides()).toEqual({});

    const globalStore = (globalThis as Record<symbol, ReturnType<typeof getVigilRuntimeOverrides>>)[
      RUNTIME_OVERRIDES_GLOBAL_KEY
    ];
    expect(globalStore).toEqual({});
  });
});
