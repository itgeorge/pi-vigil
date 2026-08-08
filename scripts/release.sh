#!/usr/bin/env bash
# Interactive release helper: pick next semver tag, bump package version, tag, push, and npm publish.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step=0
TOTAL_STEPS=0
NPM_REGISTRY=""
NPM_USER=""
PKG_NAME=""

progress() {
  step=$((step + 1))
  echo ""
  if [[ "$TOTAL_STEPS" -gt 0 ]]; then
    echo "==> [$step/$TOTAL_STEPS] $1"
  else
    echo "==> [$step] $1"
  fi
}

reset_progress() {
  step=0
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

get_npm_registry() {
  local from_pkg
  from_pkg="$(node -p "require('./package.json').publishConfig?.registry || ''")"
  if [[ -n "$from_pkg" && "$from_pkg" != "undefined" ]]; then
    echo "$from_pkg"
  else
    npm config get registry
  fi
}

check_npm_login() {
  NPM_REGISTRY="$(get_npm_registry)"
  if ! NPM_USER="$(npm whoami --registry "$NPM_REGISTRY" 2>/dev/null)"; then
    die "not logged in to npm registry $NPM_REGISTRY. Run: npm login"
  fi
  echo "Logged in as: $NPM_USER on $NPM_REGISTRY"
}

is_version_on_npm() {
  local version="$1"
  npm view "${PKG_NAME}@${version}" version --registry "$NPM_REGISTRY" >/dev/null 2>&1
}

latest_published_version_on_npm() {
  npm view "$PKG_NAME" version --registry "$NPM_REGISTRY" 2>/dev/null || true
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

run_npm_publish() {
  progress "Publishing to npm (runs prepublishOnly checks)"
  npm publish --registry "$NPM_REGISTRY"
}

run_republish() {
  local tag="$1"
  local version="$2"
  local tag_commit head_commit current_pkg_version

  TOTAL_STEPS=3
  reset_progress

  progress "Verifying local tree matches $tag"
  tag_commit="$(git rev-parse "$tag^{commit}")"
  head_commit="$(git rev-parse HEAD)"
  current_pkg_version="$(node -p "require('./package.json').version")"

  if [[ "$tag_commit" != "$head_commit" ]]; then
    die "HEAD ($(git rev-parse --short HEAD)) is not at $tag ($(git rev-parse --short "$tag_commit")). Checkout that commit before republishing."
  fi
  if [[ "$current_pkg_version" != "$version" ]]; then
    die "package.json version is $current_pkg_version, expected $version for $tag"
  fi

  echo ""
  echo "Republish plan:"
  echo "  npm user:        $NPM_USER"
  echo "  Registry:        $NPM_REGISTRY"
  echo "  Package:         $PKG_NAME"
  echo "  Version:         $version"
  echo "  Git tag:         $tag (already pushed)"
  echo "  Commit:          $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
  echo ""

  read -r -p "Publish $PKG_NAME@$version to npm? [y/N]: " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || die "republish cancelled"

  run_npm_publish

  echo ""
  echo "Republish complete: $tag (npm $version)"
  echo "  Tag:   https://github.com/itgeorge/pi-vigil/releases/tag/$tag"
  echo "  npm:   https://www.npmjs.com/package/$PKG_NAME/v/$version"
}

run_full_release() {
  local branch="$1"
  local latest_tag="$2"
  local suggested_tag next_tag_input next_tag version current_pkg_version

  if [[ "$latest_tag" == "(none)" ]]; then
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

  TOTAL_STEPS=7
  reset_progress

  echo ""
  echo "Release plan:"
  echo "  npm user:        $NPM_USER"
  echo "  Registry:        $NPM_REGISTRY"
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

  run_npm_publish

  echo ""
  echo "Release complete: $next_tag (npm $version)"
  echo "  Tag:   https://github.com/itgeorge/pi-vigil/releases/tag/$next_tag"
  echo "  npm:   https://www.npmjs.com/package/$PKG_NAME/v/$version"
}

require_command git
require_command node
require_command npm

PKG_NAME="$(node -p "require('./package.json').name")"

TOTAL_STEPS=3
progress "Verifying npm login"
check_npm_login

progress "Checking repository state"
branch="$(git branch --show-current)"
[[ -n "$branch" ]] || die "detached HEAD; checkout a branch before releasing"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Uncommitted changes:"
  git status --short
  die "working tree is not clean; commit or stash changes before releasing"
fi

progress "Checking whether the latest git tag is published to npm"
latest_tag="$(git tag -l 'v*' --sort=-v:refname | head -n 1 || true)"
if [[ -z "$latest_tag" ]]; then
  latest_tag="(none)"
  echo "No release tags found locally."
  run_full_release "$branch" "$latest_tag"
  exit 0
fi

latest_tag_version="$(tag_to_version "$latest_tag")"
npm_latest_version="$(latest_published_version_on_npm)"

if is_version_on_npm "$latest_tag_version"; then
  echo "Latest tag $latest_tag is already published to npm."
  run_full_release "$branch" "$latest_tag"
  exit 0
fi

echo "Latest git tag $latest_tag is not published to npm."
if [[ -n "$npm_latest_version" ]]; then
  echo "Latest version on npm: $npm_latest_version"
else
  echo "Package is not published on npm yet."
fi
echo ""

read -r -p "Publish $latest_tag to npm instead of creating a new release? [y/N]: " republish_confirm
if [[ "$republish_confirm" =~ ^[Yy]$ ]]; then
  run_republish "$latest_tag" "$latest_tag_version"
  exit 0
fi

run_full_release "$branch" "$latest_tag"
