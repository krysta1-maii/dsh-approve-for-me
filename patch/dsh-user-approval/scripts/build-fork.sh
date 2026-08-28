#!/usr/bin/env bash
# Build the dsh-approve-for-me fork tarball of @deepseek-ai/dsh-user-approval.
#
# The fork keeps the upstream package name and version (DSH resolves the
# package, including its /types subpath, by module name) and adds the
# `dshApprovalPatch` marker. The produced tarball is therefore a drop-in
# replacement for the official package at the pinned upstream commit.
#
# Prerequisites:
#   - a checkout of deepseek-harness at the pinned commit (default: sibling
#     directory ../../deepseek-harness relative to the repository root)
#   - pnpm available (the patched sources are built in a throwaway upstream
#     worktree so your checkout stays clean)
#
# Usage:
#   DSH_REPO=/path/to/deepseek-harness ./build-fork.sh
#   DSH_REPO=/path/to/deepseek-harness SKIP_BUILD=1 ./build-fork.sh  # packaging only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${PATCH_DIR}/../.." && pwd)"
UPSTREAM_JSON="${PATCH_DIR}/upstream.json"
UPSTREAM_REPO="${DSH_REPO:-${REPO_ROOT}/../deepseek-harness}"
BUILD_ROOT="${REPO_ROOT}/.build"
BUILD_DIR="${BUILD_ROOT}/dsh-user-approval-afm"
WORKTREE_DIR="${BUILD_ROOT}/upstream-worktree"
PKG_PATH="packages/interaction/user-approval"

PACKAGE_NAME="$(node -p "require('${UPSTREAM_JSON}').packageName")"
UPSTREAM_VERSION="$(node -p "require('${UPSTREAM_JSON}').upstreamVersion")"
UPSTREAM_COMMIT="$(node -p "require('${UPSTREAM_JSON}').upstreamCommit")"
PATCH_VERSION="$(node -p "require('${UPSTREAM_JSON}').patchVersion")"
TARBALL="dsh-user-approval-afm-${UPSTREAM_VERSION}.tgz"

echo "==> building ${PACKAGE_NAME} fork v${PATCH_VERSION} from ${UPSTREAM_COMMIT}"

if [[ ! -d "${UPSTREAM_REPO}/.git" ]]; then
  echo "error: upstream checkout not found at ${UPSTREAM_REPO}" >&2
  exit 2
fi

ACTUAL_COMMIT="$(git -C "${UPSTREAM_REPO}" rev-parse HEAD)"
if [[ "${ACTUAL_COMMIT}" != "${UPSTREAM_COMMIT}" ]]; then
  echo "error: upstream HEAD is ${ACTUAL_COMMIT}, expected ${UPSTREAM_COMMIT}" >&2
  exit 2
fi

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Build from a throwaway worktree at the pinned commit; the caller's checkout
# is never modified.
worktree_cleanup() {
  git -C "${UPSTREAM_REPO}" worktree remove --force "${WORKTREE_DIR}" 2>/dev/null || true
}
trap worktree_cleanup EXIT

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> creating throwaway upstream worktree"
  git -C "${UPSTREAM_REPO}" worktree remove --force "${WORKTREE_DIR}" 2>/dev/null || true
  git -C "${UPSTREAM_REPO}" worktree add --detach "${WORKTREE_DIR}" "${UPSTREAM_COMMIT}"

  # A fresh `git worktree` does not carry the repo's ignored node_modules. The
  # 0.1.2 monorepo builds packages through the root aggregate (`build:lib:host`),
  # so install the workspace once before compiling the patched package.
  if [[ ! -d "${WORKTREE_DIR}/node_modules" ]]; then
    echo "==> installing upstream workspace dependencies in throwaway worktree"
    (
      cd "${WORKTREE_DIR}"
      if [[ -f pnpm-lock.yaml ]]; then
        pnpm install --frozen-lockfile
      else
        pnpm install
      fi
    )
  fi

  echo "==> applying overlay into worktree"
  PKG_DIR="${WORKTREE_DIR}/${PKG_PATH}"
  cp "${PATCH_DIR}/overlay/src/index.ts" "${PKG_DIR}/src/index.ts"
  cp "${PATCH_DIR}/overlay/src/types.ts" "${PKG_DIR}/src/types.ts"
  cp "${PATCH_DIR}/overlay/src/invariant.ts" "${PKG_DIR}/src/invariant.ts"
  mkdir -p "${PKG_DIR}/tests"
  cp "${PATCH_DIR}/overlay/tests/approval-machine-policy.spec.ts" "${PKG_DIR}/tests/approval-machine-policy.spec.ts"

  echo "==> marking package.json in worktree"
  node "${PATCH_DIR}/scripts/mark-package.mjs" "${PKG_DIR}/package.json" "${UPSTREAM_JSON}"

  echo "==> rebuilding lib/ from patched sources"
  (
    cd "${WORKTREE_DIR}"
    # Packages in 0.1.2 do not carry per-package build scripts; the patched
    # source is compiled by the root host aggregate (tsc -b + tsdown), which
    # emits lib/ for this package like every other workspace package.
    pnpm run build:lib:host
  )

  echo "==> copying built package out of the worktree"
  cp -R "${PKG_DIR}/." "${BUILD_DIR}/"
else
  echo "warning: SKIP_BUILD=1 — lib/ reused from the upstream checkout, which may not include the patch"
  cp -R "${UPSTREAM_REPO}/${PKG_PATH}/." "${BUILD_DIR}/"
  cp "${PATCH_DIR}/overlay/src/index.ts" "${BUILD_DIR}/src/index.ts"
  cp "${PATCH_DIR}/overlay/src/types.ts" "${BUILD_DIR}/src/types.ts"
  cp "${PATCH_DIR}/overlay/src/invariant.ts" "${BUILD_DIR}/src/invariant.ts"
  mkdir -p "${BUILD_DIR}/tests"
  cp "${PATCH_DIR}/overlay/tests/approval-machine-policy.spec.ts" "${BUILD_DIR}/tests/approval-machine-policy.spec.ts"
  node "${PATCH_DIR}/scripts/mark-package.mjs" "${BUILD_DIR}/package.json" "${UPSTREAM_JSON}"
fi

echo "==> packing"
(
  cd "${BUILD_DIR}"
  # pnpm pack rewrites `workspace:^` peer ranges to concrete versions;
  # npm pack would leave them invalid outside the workspace.
  pnpm pack --pack-destination "${BUILD_ROOT}"
)
# Pack tools name the tarball from package.json; rename to the fork artifact name.
NPM_TARBALL="${BUILD_ROOT}/$(node -p "require('${BUILD_DIR}/package.json').name.replace('@','').replace('/','-')")-${UPSTREAM_VERSION}.tgz"
mv "${NPM_TARBALL}" "${BUILD_ROOT}/${TARBALL}"

echo "==> verifying"
node "${PATCH_DIR}/scripts/verify-fork.mjs" "${BUILD_ROOT}/${TARBALL}" "${UPSTREAM_JSON}"

echo "==> done: ${BUILD_ROOT}/${TARBALL}"
