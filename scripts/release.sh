#!/usr/bin/env bash
# Interactive release helper: pick next semver tag, bump package version, tag, push, and npm publish.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TOTAL_STEPS=7
step=0

progress() {
  step=$((step + 1))
  echo ""
  echo "==> [$step/$TOTAL_STEPS] $1"
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

semver_bump_patch() {
  local tag="$1"
  node -e "
    const raw = process.argv[1].replace(/^v/i, '');
    const parts = raw.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[0-9]+$/.test(p))) {
      process.exit(1);
    }
    parts[2] = String(Number(parts[2]) + 1);
    process.stdout.write('v' + parts.join('.'));
  " "$tag"
}

normalize_tag() {
  local input="$1"
  if [[ "$input" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "$input"
    return 0
  fi
  if [[ "$input" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "v$input"
    return 0
  fi
  return 1
}

tag_to_version() {
  echo "${1#v}"
}

update_package_versions() {
  local version="$1"
  node -e "
    const fs = require('node:fs');
    const version = process.argv[1];

    const pkgPath = 'package.json';
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    const lockPath = 'package-lock.json';
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      lock.version = version;
      if (lock.packages && lock.packages['']) {
        lock.packages[''].version = version;
      }
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    }
  " "$version"
}

require_command git
require_command node
require_command npm

progress "Checking repository state"
branch="$(git branch --show-current)"
[[ -n "$branch" ]] || die "detached HEAD; checkout a branch before releasing"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes:"
  git status --short
  die "working tree is not clean; commit or stash changes before releasing"
fi

progress "Finding latest release tag"
latest_tag="$(git tag -l 'v*' --sort=-v:refname | head -n 1 || true)"
if [[ -z "$latest_tag" ]]; then
  latest_tag="(none)"
  suggested_tag="v0.1.0"
else
  suggested_tag="$(semver_bump_patch "$latest_tag")" || die "could not auto-increment latest tag: $latest_tag"
fi

echo "Latest tag:    $latest_tag"
echo "Suggested tag: $suggested_tag"
echo ""

read -r -p "Next release tag [$suggested_tag] (Enter to auto-increment): " next_tag_input
if [[ -z "$next_tag_input" ]]; then
  next_tag="$suggested_tag"
else
  next_tag="$(normalize_tag "$next_tag_input")" || die "tag must look like v1.2.3 or 1.2.3"
fi

version="$(tag_to_version "$next_tag")"
current_pkg_version="$(node -p "require('./package.json').version")"

if git rev-parse -q --verify "refs/tags/$next_tag" >/dev/null; then
  die "tag already exists: $next_tag"
fi

echo ""
echo "Release plan:"
echo "  Branch:          $branch"
echo "  Commit:          $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
echo "  Package version: $current_pkg_version -> $version"
echo "  Git tag:         $next_tag"
echo ""

read -r -p "Proceed with release? [y/N]: " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || die "release cancelled"

progress "Updating package.json and package-lock.json to $version"
update_package_versions "$version"

progress "Committing version bump"
git add package.json package-lock.json
git commit -m "chore: release $next_tag"

progress "Creating annotated git tag $next_tag"
git tag -a "$next_tag" -m "Release $next_tag"

progress "Pushing branch and tag to origin"
git push origin "$branch"
git push origin "$next_tag"

progress "Publishing to npm (runs prepublishOnly checks)"
npm publish

echo ""
echo "Release complete: $next_tag (npm $version)"
echo "  Tag:   https://github.com/itgeorge/pi-vigil/releases/tag/$next_tag"
echo "  npm:   https://www.npmjs.com/package/pi-vigil/v/$version"
