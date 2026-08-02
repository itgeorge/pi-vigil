import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_EXACT = ["README.md", "LICENSE", "package.json"];
const REQUIRED_PREFIXES = ["src/"];
const FORBIDDEN_PREFIXES = [".plans/", "test/", "optional-followups"];
const FORBIDDEN_EXACT = [
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "optional-followups.md",
];
const PI_CORE_PEERS = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export function parsePackDryRunPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^npm notice \d+(?:\.\d+)?[kKmMgG]?B (.+)$/);
    if (match) {
      paths.push(match[1]!);
    }
  }
  return paths;
}

export function verifyPackageSurface(
  paths: string[],
  { peerDependencies }: { peerDependencies?: Record<string, string> } = {},
): string[] {
  const errors: string[] = [];

  for (const required of REQUIRED_EXACT) {
    if (!paths.includes(required)) {
      errors.push(`missing required tarball entry: ${required}`);
    }
  }

  const hasSrcEntry = paths.some((path) => path.startsWith("src/"));
  if (!hasSrcEntry) {
    errors.push("missing required tarball prefix: src/");
  }

  for (const path of paths) {
    if (FORBIDDEN_EXACT.includes(path)) {
      errors.push(`forbidden tarball entry: ${path}`);
    }
    for (const prefix of FORBIDDEN_PREFIXES) {
      if (path === prefix.slice(0, -1) || path.startsWith(prefix)) {
        errors.push(`forbidden tarball entry: ${path}`);
      }
    }
    if (path.startsWith("node_modules/")) {
      errors.push(`forbidden tarball entry: ${path}`);
    }

    const allowed =
      REQUIRED_EXACT.includes(path) ||
      REQUIRED_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!allowed) {
      errors.push(`unexpected tarball entry: ${path}`);
    }
  }

  if (peerDependencies) {
    for (const name of PI_CORE_PEERS) {
      if (peerDependencies[name] !== "*") {
        errors.push(
          `peerDependencies[${name}] must be "*" (found ${JSON.stringify(peerDependencies[name])})`,
        );
      }
    }
  }

  return errors;
}

export function loadPeerDependencies(packageJsonPath: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    peerDependencies?: Record<string, string>;
  };
  return manifest.peerDependencies ?? {};
}

export function verifyFromPackDryRunOutput(
  output: string,
  options: { peerDependencies?: Record<string, string> } = {},
): string[] {
  return verifyPackageSurface(parsePackDryRunPaths(output), options);
}

function main(): void {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const output = execSync("npm pack --dry-run 2>&1", {
    cwd: packageRoot,
    encoding: "utf8",
  });
  const peerDependencies = loadPeerDependencies(join(packageRoot, "package.json"));
  const errors = verifyFromPackDryRunOutput(output, { peerDependencies });

  if (errors.length > 0) {
    console.error("package surface verification failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  const paths = parsePackDryRunPaths(output);
  console.log(`package surface ok (${paths.length} tarball entries)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
