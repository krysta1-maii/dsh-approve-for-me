#!/usr/bin/env bash
# Build the dsh-approve-for-me fork tarball of @deepseek-ai/dsh-user-approval.
#
# The fork keeps the upstream package name and version (DSH resolves the
# package, including its /types subpath, by module name) and adds the
# `dshApprovalPatch` marker. The produced tarball is therefore a drop-in
# replacement for the official package at the pinned upstream commit.
#
# Prerequisites:
#   - a checkout of deepseek-harness CONTAINING the pinned commit (default:
#     sibling directory ../../deepseek-harness relative to the repository root)
#   - pnpm available (the patched sources are built in a throwaway local CLONE
#     of that checkout, so the upstream repository is only ever read)
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
CLONE_DIR="${BUILD_ROOT}/upstream-clone"
PKG_PATH="packages/interaction/user-approval"

PACKAGE_NAME="$(node -p "require('${UPSTREAM_JSON}').packageName")"
UPSTREAM_VERSION="$(node -p "require('${UPSTREAM_JSON}').upstreamVersion")"
UPSTREAM_COMMIT="$(node -p "require('${UPSTREAM_JSON}').upstreamCommit")"
PATCH_VERSION="$(node -p "require('${UPSTREAM_JSON}').patchVersion")"
TARBALL="dsh-user-approval-afm-${UPSTREAM_VERSION}.tgz"
PROVENANCE="${TARBALL}.provenance.json"
AFM_SOURCE_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
AFM_SOURCE_TREE="$(git -C "${REPO_ROOT}" rev-parse 'HEAD^{tree}')"
AFM_SOURCE_REMOTE="$(git -C "${REPO_ROOT}" remote get-url origin)"
if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
  echo "error: dsh-approve-for-me source must be clean before fork construction" >&2
  exit 2
fi
UPSTREAM_LOCK_SHA256="$(sha256sum "${UPSTREAM_JSON}" | cut -d' ' -f1)"

# Resolve a working pnpm before touching any checkout. The workspace pins
# pnpm 11.x; when no shell `pnpm` exists (or corepack's vm wrapper is broken
# on this Node install), execute the corepack cache's pnpm.cjs directly.
PNPM_COMMAND=()
resolve_pnpm() {
  if [[ -n "${PNPM:-}" ]]; then
    if [[ ! -x "${PNPM}" ]] || ! "${PNPM}" --version >/dev/null 2>&1; then
      echo "error: PNPM=${PNPM} is not an executable pnpm" >&2
      return 1
    fi
    PNPM_COMMAND=("${PNPM}")
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1 && pnpm --version >/dev/null 2>&1; then
    PNPM_COMMAND=(pnpm)
    return 0
  fi
  local node_bin corepack_bin cache_home candidate version
  node_bin="$(command -v node || true)"
  if [[ -n "${node_bin}" ]]; then
    corepack_bin="$(dirname "${node_bin}")/corepack"
    if [[ -x "${corepack_bin}" ]] && "${corepack_bin}" pnpm --version >/dev/null 2>&1; then
      PNPM_COMMAND=("${corepack_bin}" pnpm)
      return 0
    fi
    cache_home="${COREPACK_HOME:-${HOME:-}/.cache/node/corepack}"
    if [[ -d "${cache_home}/pnpm" ]]; then
      while IFS= read -r candidate; do
        [[ -f "${candidate}" ]] || continue
        version="$("${node_bin}" "${candidate}" --version 2>/dev/null || true)"
        [[ "${version}" == 11.* ]] || continue
        PNPM_COMMAND=("${node_bin}" "${candidate}")
        return 0
      done < <(find "${cache_home}/pnpm" -path '*/bin/pnpm.cjs' -type f 2>/dev/null | sort -Vr)
    fi
  fi
  echo 'error: no usable pnpm 11 found; activate pnpm@11.7.0 via corepack or set PNPM=<path>' >&2
  return 1
}
run_pnpm() { "${PNPM_COMMAND[@]}" "$@"; }

resolve_pnpm

echo "==> building ${PACKAGE_NAME} fork v${PATCH_VERSION} from ${UPSTREAM_COMMIT}"

if [[ ! -d "${UPSTREAM_REPO}/.git" ]]; then
  echo "error: upstream checkout not found at ${UPSTREAM_REPO}" >&2
  exit 2
fi

# The patch is tied to one immutable upstream commit. A shortened SHA would
# accept a collision and undermine reproducible fork builds. The upstream
# checkout only has to CONTAIN that commit: the build clones it and checks the
# exact object out, so a moved upstream HEAD neither blocks nor changes it.
if ! git -C "${UPSTREAM_REPO}" cat-file -e "${UPSTREAM_COMMIT}^{commit}" 2>/dev/null; then
  echo "error: upstream checkout ${UPSTREAM_REPO} does not contain ${UPSTREAM_COMMIT}" >&2
  exit 2
fi

rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Build from a throwaway CLONE at the pinned commit. `git clone` only reads the
# upstream checkout (no worktree registration, no index or config writes), so
# the official repository is never modified by this build.
clone_cleanup() {
  rm -rf "${CLONE_DIR}"
}
trap clone_cleanup EXIT

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> creating throwaway upstream clone"
  rm -rf "${CLONE_DIR}"
  git clone --quiet --no-checkout --no-tags "${UPSTREAM_REPO}" "${CLONE_DIR}"
  git -C "${CLONE_DIR}" checkout --quiet --detach "${UPSTREAM_COMMIT}"

  # A fresh clone does not carry the repo's ignored node_modules. The
  # 0.1.2 monorepo builds packages through the root aggregate (`build:lib:host`),
  # so install the workspace once before compiling the patched package.
  # pnpm treats the `vendor/CLAUDE.md -> AGENTS.md` symlink as a workspace
  # package and fails with ENOTDIR in a fresh checkout; it is only a doc
  # alias, so remove it from this throwaway clone before installing.
  rm -f "${CLONE_DIR}/vendor/CLAUDE.md"
  if [[ ! -d "${CLONE_DIR}/node_modules" ]]; then
    echo "==> installing upstream workspace dependencies in throwaway clone"
    (
      cd "${CLONE_DIR}"
      if [[ -f pnpm-lock.yaml ]]; then
        # The throwaway clone cannot inherit the upstream repository-local
        # hooks configuration. Dependency lifecycle scripts are irrelevant to
        # compiling this TypeScript package, so never let host hook install
        # mutate/reject this isolated build.
        run_pnpm install --frozen-lockfile --ignore-scripts
      else
        run_pnpm install --ignore-scripts
      fi
    )
  fi

  echo "==> applying overlay into clone"
  PKG_DIR="${CLONE_DIR}/${PKG_PATH}"
  cp "${PATCH_DIR}/overlay/src/index.ts" "${PKG_DIR}/src/index.ts"
  cp "${PATCH_DIR}/overlay/src/types.ts" "${PKG_DIR}/src/types.ts"
  cp "${PATCH_DIR}/overlay/src/invariant.ts" "${PKG_DIR}/src/invariant.ts"
  mkdir -p "${PKG_DIR}/tests"
  cp "${PATCH_DIR}/overlay/tests/approval-machine-policy.spec.ts" "${PKG_DIR}/tests/approval-machine-policy.spec.ts"

  echo "==> marking package.json in clone"
  node "${PATCH_DIR}/scripts/mark-package.mjs" "${PKG_DIR}/package.json" "${UPSTREAM_JSON}"

  echo "==> testing patched source overlay"
  (
    cd "${CLONE_DIR}"
    # Invoke the installed binary directly. `pnpm exec` performs a workspace
    # dependency-status install after the overlay changes package metadata,
    # which would re-run the upstream clone hook scripts.
    node node_modules/vitest/vitest.mjs run "${PKG_PATH}/tests/approval-machine-policy.spec.ts"
  )

  echo "==> rebuilding patched package lib/ from sources"
  (
    cd "${CLONE_DIR}"
    # The 0.1.2 package has no npm build script, but it does ship a package
    # tsdown config and a project tsconfig. Build only this package rather
    # than the whole host aggregate: `tsc -b` emits lib/types and the package
    # tsdown requires an optional loader absent from the upstream lock. Install
    # the complete loader edge at exact versions into this throwaway clone;
    # do not mutate package.json or pnpm-lock.yaml.
    run_pnpm add -Dw --ignore-scripts \
      unrun@0.3.1 rolldown@1.1.1 synckit@0.11.12
    node node_modules/typescript/bin/tsc -b "${PKG_DIR}/tsconfig.json"
    cat > "${PKG_DIR}/.afm-tsdown.config.mjs" <<'EOF'
import { defineConfig } from 'tsdown'
export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false },
  { entry: ['lib/types/invariant.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false },
])
EOF
  )
  (
    cd "${PKG_DIR}"
    ../../../node_modules/.bin/tsdown --config .afm-tsdown.config.mjs
    rm -f .afm-tsdown.config.mjs
  )

  echo "==> copying built package out of the clone"
  cp -R "${PKG_DIR}/." "${BUILD_DIR}/"
else
  echo "error: SKIP_BUILD=1 cannot produce a verifiable fork; build patched sources instead" >&2
  exit 2
fi

echo "==> packing"
# pnpm rewrites `workspace:^` ranges only when packing from inside the
# workspace that installed those dependencies; always pack from the verified
# patched clone package. SKIP_BUILD is intentionally rejected above.
PACK_SOURCE="${CLONE_DIR}/${PKG_PATH}"
(
  cd "${PACK_SOURCE}"
  run_pnpm pack --pack-destination "${BUILD_ROOT}"
)
# Pack tools name the tarball from package.json; rename to the fork artifact name.
NPM_TARBALL="${BUILD_ROOT}/$(node -p "require('${BUILD_DIR}/package.json').name.replace('@','').replace('/','-')")-${UPSTREAM_VERSION}.tgz"
mv "${NPM_TARBALL}" "${BUILD_ROOT}/${TARBALL}"

echo "==> verifying"
node "${PATCH_DIR}/scripts/verify-fork.mjs" "${BUILD_ROOT}/${TARBALL}" "${UPSTREAM_JSON}"

sha256sum "${BUILD_ROOT}/${TARBALL}" | tee "${BUILD_ROOT}/${TARBALL}.sha256"
if [[ "$(git -C "${REPO_ROOT}" rev-parse HEAD)" != "${AFM_SOURCE_COMMIT}" \
  || "$(git -C "${REPO_ROOT}" rev-parse 'HEAD^{tree}')" != "${AFM_SOURCE_TREE}" \
  || -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
  echo "error: dsh-approve-for-me source changed during fork construction" >&2
  exit 2
fi
FORK_SHA256="$(sha256sum "${BUILD_ROOT}/${TARBALL}" | cut -d' ' -f1)"
node -e 'const fs=require("fs"); const [path,digest,repository,commit,tree,upstreamDigest,upstreamCommit,patchVersion]=process.argv.slice(1); fs.writeFileSync(path, JSON.stringify({version:1,file:path.split("/").pop().replace(/\.provenance\.json$/, ""),sha256:digest,source:{repository,commit,tree},upstream:{lockSha256:upstreamDigest,commit:upstreamCommit,patchVersion:Number(patchVersion)}},null,2)+"\n")' \
  "${BUILD_ROOT}/${PROVENANCE}" "${FORK_SHA256}" "${AFM_SOURCE_REMOTE}" "${AFM_SOURCE_COMMIT}" "${AFM_SOURCE_TREE}" \
  "${UPSTREAM_LOCK_SHA256}" "${UPSTREAM_COMMIT}" "${PATCH_VERSION}"
echo "==> done: ${BUILD_ROOT}/${TARBALL}"
