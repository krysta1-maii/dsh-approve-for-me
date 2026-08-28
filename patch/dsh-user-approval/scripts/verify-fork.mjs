/**
 * Verify that a fork tarball of @deepseek-ai/dsh-user-approval is a valid
 * dsh-approve-for-me patch artifact:
 *   - package.json keeps the upstream name/version,
 *   - the dshApprovalPatch marker matches upstream.json,
 *   - the built lib actually contains the patched APIs.
 *
 * Usage: node verify-fork.mjs <tarball> <upstream.json>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [tarballPath, upstreamJsonPath] = process.argv.slice(2)
if (!tarballPath || !upstreamJsonPath) {
  console.error('usage: node verify-fork.mjs <tarball> <upstream.json>')
  process.exit(2)
}

const tarball = resolve(tarballPath)
const upstream = JSON.parse(readFileSync(resolve(upstreamJsonPath), 'utf8'))

function tarRead(entry) {
  try {
    return execFileSync('tar', ['-xOf', tarball, entry], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`cannot read ${entry} from ${tarball}: ${error.message}`)
  }
}

const pkg = JSON.parse(tarRead('package/package.json'))

if (pkg.name !== upstream.packageName) {
  throw new Error(`fork must keep package name "${upstream.packageName}", got "${pkg.name}"`)
}
if (pkg.version !== upstream.upstreamVersion) {
  throw new Error(`fork must keep version "${upstream.upstreamVersion}", got "${pkg.version}"`)
}
const marker = pkg[upstream.forkMarker]
if (!marker || marker.fork !== true) {
  throw new Error(`missing ${upstream.forkMarker}.fork=true marker`)
}
if (marker.patchVersion !== upstream.patchVersion || marker.upstreamCommit !== upstream.upstreamCommit) {
  throw new Error(`marker does not match upstream.json: ${JSON.stringify(marker)}`)
}

const libIndex = tarRead('package/lib/index.js')
if (!libIndex.includes('registerMachinePolicy')) {
  throw new Error('lib/index.js does not contain registerMachinePolicy — lib/ was not rebuilt from patched sources')
}
const libTypes = tarRead('package/lib/types/index.d.ts')
if (!libTypes.includes('MachineApprovalPolicy') || !libTypes.includes('requestId')) {
  throw new Error('lib/types/index.d.ts does not expose MachineApprovalPolicy/requestId')
}

const entries = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' })
for (const required of ['package/lib/index.js', 'package/lib/types/index.d.ts', 'package/package.json']) {
  if (!entries.includes(required)) throw new Error(`tarball is missing ${required}`)
}

console.log(`PASS ${pkg.name}@${pkg.version} fork v${marker.patchVersion} (${marker.upstreamCommit})`)
