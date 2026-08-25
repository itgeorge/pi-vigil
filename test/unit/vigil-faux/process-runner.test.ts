import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { accessSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPiChildArgs } from "../../../src/vigil/node-runtime.js";
import type { ProcessRunner } from "../../../src/vigil/ports.js";
import {
  buildVigilFauxPiChildArgs,
  createVigilFauxProcessRunner,
  getVigilFauxExtensionPath,
  writeVigilFauxScript,
} from "../../helpers/vigil-faux/index.js";
import { parseVigilFauxScript } from "../../helpers/vigil-faux/script.js";

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

describe("vigil-faux process runner helpers", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  describe("writeVigilFauxScript", () => {
    it("writes JSON and returns an absolute path", () => {
      tempDir = mkdtempSync(join(tmpdir(), "vigil-faux-script-"));
      const script = {
        version: 1 as const,
        steps: [{ when: { userTextIncludes: "marker" }, then: { type: "text" as const, text: "ok" } }],
      };

      const scriptPath = writeVigilFauxScript(tempDir, script);

      expect(scriptPath.startsWith("/")).toBe(true);
      accessSync(scriptPath);
      expect(parseVigilFauxScript(JSON.parse(readFileSync(scriptPath, "utf8")))).toEqual(script);
    });
  });

  describe("getVigilFauxExtensionPath", () => {
    it("returns an absolute path to extension.ts that exists", () => {
      const extensionPath = getVigilFauxExtensionPath();

      expect(extensionPath.endsWith("test/helpers/vigil-faux/extension.ts")).toBe(true);
      accessSync(extensionPath);
    });
  });

  describe("createVigilFauxProcessRunner", () => {
    it("leaves production buildPiChildArgs unchanged", () => {
      expect(
        buildPiChildArgs({
          sessionId: "vigil-faux-child",
          message: "hello",
          cwd: process.cwd(),
          model: "vigil-faux/scripted",
        }),
      ).toEqual([
        "--mode",
        "json",
        "-p",
        "--session-id",
        "vigil-faux-child",
        "--model",
        "vigil-faux/scripted",
        "hello",
      ]);
    });

    it("inserts --extension before the prompt message in spawned args", async () => {
      const spawnChild = createMockSpawnChild();
      const extensionPath = getVigilFauxExtensionPath();
      const runner = createVigilFauxProcessRunner({ spawnChild, platform: "linux" });

      await runner.spawnDetached({
        sessionId: "vigil-faux-spawn",
        message: "run scripted child",
        cwd: process.cwd(),
        model: "vigil-faux/scripted",
        name: "Faux child",
      });

      expect(spawnChild).toHaveBeenCalledOnce();
      const [, spawnArgs] = spawnChild.mock.calls[0]!;
      expect(spawnArgs).toEqual([
        "--mode",
        "json",
        "-p",
        "--session-id",
        "vigil-faux-spawn",
        "--name",
        "Faux child",
        "--model",
        "vigil-faux/scripted",
        "--extension",
        extensionPath,
        "run scripted child",
      ]);
    });

    it("delegates isAlive and terminateAndWait to the base runner", async () => {
      const base: ProcessRunner = {
        spawnDetached: vi.fn(async () => ({ pid: 1 })),
        isAlive: vi.fn(() => true),
        terminateAndWait: vi.fn(async () => {}),
      };
      const spawnChild = createMockSpawnChild();
      const runner = createVigilFauxProcessRunner({ base, spawnChild, platform: "linux" });

      expect(runner.isAlive(42)).toBe(true);
      expect(base.isAlive).toHaveBeenCalledWith(42);

      await runner.terminateAndWait(42, { timeoutMs: 100 });
      expect(base.terminateAndWait).toHaveBeenCalledWith(42, { timeoutMs: 100 });
    });

    it("buildVigilFauxPiChildArgs splices extension before the final message", () => {
      const extensionPath = getVigilFauxExtensionPath();
      const args = buildVigilFauxPiChildArgs({
        sessionId: "vigil-faux-args",
        message: "prompt last",
        cwd: process.cwd(),
        model: "vigil-faux/scripted",
      });

      expect(args.at(-1)).toBe("prompt last");
      expect(args).toContain("--extension");
      expect(args[args.indexOf("--extension") + 1]).toBe(extensionPath);
    });
  });
});
