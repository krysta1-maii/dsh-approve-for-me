/**
 * Stamp the forked package.json with the dshApprovalPatch marker while keeping
 * the original `name` and `version` untouched: DSH resolves
 * `@deepseek-ai/dsh-user-approval` (including its `/types` subpath) by module
 * name, so a drop-in fork must keep both fields identical to upstream.
 *
 * Usage: node mark-package.mjs <package.json> <upstream.json>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [packageJsonPath, upstreamJsonPath] = process.argv.slice(2)
if (!packageJsonPath || !upstreamJsonPath) {
  console.error('usage: node mark-package.mjs <package.json> <upstream.json>')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(resolve(packageJsonPath), 'utf8'))
const upstream = JSON.parse(readFileSync(resolve(upstreamJsonPath), 'utf8'))

if (pkg.name !== upstream.packageName) {
  throw new Error(`refusing to mark package: name must stay "${upstream.packageName}", got "${pkg.name}"`)
}
if (pkg.version !== upstream.upstreamVersion) {
  throw new Error(`refusing to mark package: version must stay "${upstream.upstreamVersion}", got "${pkg.version}"`)
}

pkg.dshApprovalPatch = {
  fork: true,
  project: 'dsh-approve-for-me',
  patchVersion: upstream.patchVersion,
  upstream: upstream.upstreamVersion,
  upstreamTag: upstream.upstreamTag,
  upstreamCommit: upstream.upstreamCommit,
  changes: upstream.changes,
}
pkg.description = `${pkg.description} [dsh-approve-for-me fork v${upstream.patchVersion}: requestId + registerMachinePolicy]`

writeFileSync(resolve(packageJsonPath), `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`marked ${pkg.name}@${pkg.version} as dsh-approve-for-me fork v${upstream.patchVersion}`)
