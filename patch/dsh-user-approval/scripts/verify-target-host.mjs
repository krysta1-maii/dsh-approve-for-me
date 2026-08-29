/**
 * Verify the complete host identity used to build an approval fork.
 *
 * Usage:
 *   node verify-target-host.mjs <deepseek-harness-root> <fork-tarball> <upstream.json> [installed-package-dir]
 *
 * The optional installed package directory is the resolved
 * @deepseek-ai/dsh-user-approval directory in the target Profile. Supplying it
 * proves that the Profile, rather than merely a build artifact, contains the
 * marked fork.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [hostRootArg, tarballArg, upstreamArg, installedPackageArg] = process.argv.slice(2)
if (!hostRootArg || !tarballArg || !upstreamArg) {
  console.error('usage: node verify-target-host.mjs <deepseek-harness-root> <fork-tarball> <upstream.json> [installed-package-dir]')
  process.exit(2)
}

const hostRoot = resolve(hostRootArg)
const tarball = resolve(tarballArg)
const upstream = JSON.parse(readFileSync(resolve(upstreamArg), 'utf8'))
if (!/^[0-9a-f]{40}$/i.test(upstream.upstreamCommit)) {
  throw new Error('upstreamCommit must be a full 40-character Git SHA')
}
if (!existsSync(tarball)) throw new Error(`fork tarball does not exist: ${tarball}`)

const hostPackage = JSON.parse(readFileSync(resolve(hostRoot, 'package.json'), 'utf8'))
if (hostPackage.version !== upstream.upstreamVersion) {
  throw new Error(`host version mismatch: expected ${upstream.upstreamVersion}, got ${hostPackage.version}`)
}
const actualCommit = execFileSync('git', ['-C', hostRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (actualCommit !== upstream.upstreamCommit) {
  throw new Error(`host commit mismatch: expected ${upstream.upstreamCommit}, got ${actualCommit}`)
}
const actualTag = execFileSync('git', ['-C', hostRoot, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' }).trim()
if (actualTag !== upstream.upstreamTag) {
  throw new Error(`host tag mismatch: expected ${upstream.upstreamTag}, got ${actualTag}`)
}

execFileSync(process.execPath, [
  new URL('./verify-fork.mjs', import.meta.url).pathname,
  tarball,
  resolve(upstreamArg),
], { stdio: 'inherit' })

const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
if (installedPackageArg !== undefined) {
  const installedPackage = resolve(installedPackageArg, 'package.json')
  const installed = JSON.parse(readFileSync(installedPackage, 'utf8'))
  const marker = installed[upstream.forkMarker]
  if (installed.name !== upstream.packageName || installed.version !== upstream.upstreamVersion) {
    throw new Error(`installed package is not ${upstream.packageName}@${upstream.upstreamVersion}`)
  }
  if (!marker?.fork || marker.patchVersion !== upstream.patchVersion || marker.upstreamCommit !== upstream.upstreamCommit) {
    throw new Error('installed package does not carry the expected dshApprovalPatch marker')
  }
}

console.log(`PASS target ${upstream.upstreamTag} (${actualCommit}), fork sha256=${digest}`)
