import { describe, expect, it } from "vitest";
import {
  buildPiSpawnArgs,
  derivePiCliEntrypointFromPackageIndex,
  resolvePiSpawnCommand,
} from "../../../src/vigil/pi-spawn-command";

describe("resolvePiSpawnCommand", () => {
  it("on non-Windows returns command pi and no args prefix", () => {
    const result = resolvePiSpawnCommand({
      platform: "linux",
    });

    expect(result).toEqual({
      command: "pi",
      argsPrefix: [],
    });
  });

  it("on simulated Windows with default pi returns process.execPath and prepends resolved cli.js path", () => {
    const cliPath = "C:\\fake\\dist\\cli.js";
    const result = resolvePiSpawnCommand({
      platform: "win32",
      resolvePiCliEntrypoint: () => cliPath,
    });

    expect(result).toEqual({
      command: process.execPath,
      argsPrefix: [cliPath],
    });
  });

  it("on simulated Windows with explicit piExecutable preserves the override", () => {
    const result = resolvePiSpawnCommand({
      platform: "win32",
      piExecutable: "/definitely/missing/pi-executable",
      resolvePiCliEntrypoint: () => "C:\\fake\\dist\\cli.js",
    });

    expect(result).toEqual({
      command: "/definitely/missing/pi-executable",
      argsPrefix: [],
    });
  });
});

describe("derivePiCliEntrypointFromPackageIndex", () => {
  it("derives sibling dist/cli.js from dist/index.js", () => {
    expect(
      derivePiCliEntrypointFromPackageIndex(
        "C:\\Users\\itgeorge\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\index.js",
      ),
    ).toBe(
      "C:\\Users\\itgeorge\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
    );
  });

  it("derives sibling dist/cli.js from a forward-slash package index path", () => {
    expect(
      derivePiCliEntrypointFromPackageIndex(
        "C:/Users/itgeorge/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      ),
    ).toBe(
      "C:\\Users\\itgeorge\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
    );
  });
});

describe("buildPiSpawnArgs", () => {
  it("prepends args prefix before pi args", () => {
    const cliPath = "C:\\fake\\dist\\cli.js";
    const piArgs = ["--mode", "json", "-p", "--no-session", "hello"];

    expect(
      buildPiSpawnArgs(
        { command: process.execPath, argsPrefix: [cliPath] },
        piArgs,
      ),
    ).toEqual([cliPath, ...piArgs]);
  });
});
