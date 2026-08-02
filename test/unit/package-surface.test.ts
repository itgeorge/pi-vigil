import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPackDryRunJson,
  parsePackDryRunPaths,
  verifyFromPackDryRunOutput,
  verifyPackageSurface,
} from "../../scripts/verify-package-surface";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runPackDryRun(env: NodeJS.ProcessEnv = process.env): string {
  return execSync("npm pack --dry-run --json", {
    cwd: packageRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("package surface verification", () => {
  it("parses npm pack dry-run JSON tarball paths", () => {
    const sample = JSON.stringify([
      {
        id: "pi-vigil@0.1.0",
        files: [
          { path: "LICENSE", size: 1083 },
          { path: "README.md", size: 19872 },
          { path: "package.json", size: 1503 },
          { path: "src/index.ts", size: 13768 },
        ],
      },
    ]);

    expect(parsePackDryRunPaths(sample)).toEqual([
      "LICENSE",
      "README.md",
      "package.json",
      "src/index.ts",
    ]);
  });

  it("extracts JSON from mixed npm notice and JSON output", () => {
    const sample = `
npm notice
npm notice Tarball Contents
${JSON.stringify([
  {
    files: [{ path: "LICENSE" }, { path: "src/index.ts" }],
  },
])}
npm notice Tarball Details
`;

    expect(extractPackDryRunJson(sample)).toBe(
      JSON.stringify([{ files: [{ path: "LICENSE" }, { path: "src/index.ts" }] }]),
    );
    expect(parsePackDryRunPaths(sample)).toEqual(["LICENSE", "src/index.ts"]);
  });

  it("rejects forbidden and unexpected tarball entries", () => {
    const errors = verifyPackageSurface([
      "README.md",
      "LICENSE",
      "package.json",
      "src/index.ts",
      ".plans/slice-1-walking-skeleton-plan.md",
      "test/unit/package-surface.test.ts",
      "optional-followups.md",
      "tsconfig.json",
    ]);

    expect(errors).toEqual(
      expect.arrayContaining([
        "forbidden tarball entry: .plans/slice-1-walking-skeleton-plan.md",
        "forbidden tarball entry: test/unit/package-surface.test.ts",
        "forbidden tarball entry: optional-followups.md",
        "forbidden tarball entry: tsconfig.json",
      ]),
    );
  });

  it("requires Pi core peerDependencies to use the host-provided * range", () => {
    const errors = verifyPackageSurface(["README.md", "LICENSE", "package.json", "src/index.ts"], {
      peerDependencies: {
        "@earendil-works/pi-ai": ">=0.75.0",
        "@earendil-works/pi-coding-agent": "*",
        "@earendil-works/pi-tui": "*",
      },
    });

    expect(errors).toContain(
      'peerDependencies[@earendil-works/pi-ai] must be "*" (found ">=0.75.0")',
    );
  });

  it("matches the live npm pack dry-run surface for this package", () => {
    const output = runPackDryRun();
    const peerDependencies = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ).peerDependencies;

    const errors = verifyFromPackDryRunOutput(output, { peerDependencies });
    expect(errors).toEqual([]);
  });

  it("matches the live npm pack dry-run surface when npm_config_json=true is inherited", () => {
    const output = runPackDryRun({ ...process.env, npm_config_json: "true" });
    const peerDependencies = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ).peerDependencies;

    const errors = verifyFromPackDryRunOutput(output, { peerDependencies });
    expect(errors).toEqual([]);
  });
});
