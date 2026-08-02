import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePackDryRunPaths,
  verifyFromPackDryRunOutput,
  verifyPackageSurface,
} from "../../scripts/verify-package-surface";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("package surface verification", () => {
  it("parses npm pack dry-run tarball paths", () => {
    const sample = `
npm notice
npm notice 📦  pi-vigil@0.1.0
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 18.3kB README.md
npm notice 865B package.json
npm notice 13.8kB src/index.ts
npm notice Tarball Details
`;

    expect(parsePackDryRunPaths(sample)).toEqual([
      "LICENSE",
      "README.md",
      "package.json",
      "src/index.ts",
    ]);
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
    const output = execSync("npm pack --dry-run 2>&1", {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const peerDependencies = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ).peerDependencies;

    const errors = verifyFromPackDryRunOutput(output, { peerDependencies });
    expect(errors).toEqual([]);
  });
});
