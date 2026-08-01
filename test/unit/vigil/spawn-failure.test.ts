import { describe, expect, it } from "vitest";
import { spawnDetachedPiChild } from "../../../src/vigil/node-runtime";

describe("spawnDetachedPiChild", () => {
  it("surfaces spawn failures without leaving an unhandled ChildProcess error event", async () => {
    await expect(
      spawnDetachedPiChild("/definitely/missing/pi-executable", {
        sessionId: "vigil-spawn-failure",
        message: "hello",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow();
  });
});
