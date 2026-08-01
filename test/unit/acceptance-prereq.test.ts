import { describe, expect, it } from "vitest";
import { requireLiveAcceptanceEnv } from "../acceptance/live-prereq";

describe("live acceptance prerequisites", () => {
  it("fails fast without PI_VIGIL_LIVE=1", () => {
    const previous = process.env.PI_VIGIL_LIVE;
    delete process.env.PI_VIGIL_LIVE;

    expect(() => requireLiveAcceptanceEnv()).toThrow(/PI_VIGIL_LIVE=1/);

    if (previous === undefined) {
      delete process.env.PI_VIGIL_LIVE;
    } else {
      process.env.PI_VIGIL_LIVE = previous;
    }
  });
});
