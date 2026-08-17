import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { spawnDetachedPiChild } from "../../../src/vigil/node-runtime";

type SpawnChildFn = (
  command: string,
  args: string[],
  spawnOptions: SpawnOptions,
) => ChildProcess;

function createMockSpawnChild(pid = 12_345) {
  return vi.fn<SpawnChildFn>(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid });
    child.unref = () => child;
    queueMicrotask(() => {
      child.emit("spawn");
    });
    return child;
  });
}

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

  it("on simulated Windows uses node execPath and cli.js prefix instead of spawn pi", async () => {
    const cliPath = "C:\\fake\\dist\\cli.js";
    const spawnChild = createMockSpawnChild();

    await spawnDetachedPiChild(
      "pi",
      {
        sessionId: "vigil-windows-spawn",
        message: "hello",
        cwd: process.cwd(),
        name: "Quick task",
      },
      {
        platform: "win32",
        resolvePiCliEntrypoint: () => cliPath,
        spawnChild,
      },
    );

    expect(spawnChild).toHaveBeenCalledOnce();
    const [command, spawnArgs, spawnOptions] = spawnChild.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(spawnArgs).toEqual([
      cliPath,
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-windows-spawn",
      "--name",
      "Quick task",
      "hello",
    ]);
    expect(spawnOptions).toMatchObject({
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
  });

  it("on simulated non-Windows uses pi executable directly", async () => {
    const spawnChild = createMockSpawnChild();

    await spawnDetachedPiChild(
      "pi",
      {
        sessionId: "vigil-linux-spawn",
        message: "hello",
        cwd: process.cwd(),
      },
      {
        platform: "linux",
        spawnChild,
      },
    );

    expect(spawnChild).toHaveBeenCalledOnce();
    const [command, spawnArgs] = spawnChild.mock.calls[0]!;
    expect(command).toBe("pi");
    expect(spawnArgs).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "vigil-linux-spawn",
      "hello",
    ]);
  });
});

