import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// By default verify the development install. Profile smoke tests pass the
// disposable profile package.json so every resolution is proven from the
// deployed artifact graph rather than from this source checkout.
const resolutionAnchor = process.env.DSH_VERIFY_RESOLVE_FROM ?? import.meta.url
const require = createRequire(resolutionAnchor)

/** Exact resolved versions the deployment must install. */
const HOST_VERSION = '0.1.2-rc.1'
const expected = Object.freeze({
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
  '@deepseek-ai/dsh-agent': HOST_VERSION,
  '@deepseek-ai/dsh-llm': HOST_VERSION,
  '@deepseek-ai/dsh-sandbox': HOST_VERSION,
  '@deepseek-ai/dsh-sandbox-policy': HOST_VERSION,
  '@deepseek-ai/dsh-session': HOST_VERSION,
  '@deepseek-ai/dsh-subagent': HOST_VERSION,
  '@deepseek-ai/dsh-system-prompt': HOST_VERSION,
  '@deepseek-ai/dsh-storage': HOST_VERSION,
  '@deepseek-ai/dsh-storage-domain': HOST_VERSION,
  '@deepseek-ai/dsh-tools': HOST_VERSION,
  '@deepseek-ai/dsh-user-approval': HOST_VERSION,
  'dsh-managed-agent': '0.1.0-dev.0',
})

/**
 * Declared peer ranges. Vendor packages float within their published patch
 * line; every DSH package and the managed Host stay exactly pinned, because a
 * host minor drift changes the approval seam this plugin authorizes against.
 */
const expectedPeerRange = Object.freeze({
  ...Object.fromEntries(Object.entries(expected)),
  '@deepseek-ai/cordis': '^4.0.2',
  '@deepseek-ai/schemastery': '^3.18.2',
})

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const [name, version] of Object.entries(expected)) {
  if (root.peerDependencies?.[name] !== expectedPeerRange[name]) {
    throw new Error(`peer dependency ${name} must be declared as ${expectedPeerRange[name]}`)
  }
  const manifestPath = require.resolve(`${name}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== version) {
    throw new Error(`${name} resolved to ${manifest.version} at ${manifestPath}; expected ${version}`)
  }
  console.log(`PASS ${name}@${version} (${realpathSync(manifestPath)})`)
}

const upstream = JSON.parse(readFileSync(new URL('../patch/dsh-user-approval/upstream.json', import.meta.url), 'utf8'))
const approvalManifest = require('@deepseek-ai/dsh-user-approval/package.json')
const patch = approvalManifest.dshApprovalPatch
if (patch?.fork !== true
  || patch.patchVersion !== upstream.patchVersion
  || patch.upstreamCommit !== upstream.upstreamCommit) {
  throw new Error(`installed @deepseek-ai/dsh-user-approval is not the pinned approve-for-me fork v${upstream.patchVersion}`)
}
const approval = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-user-approval')).href)
if (typeof approval.ApprovalService?.prototype?.registerMachinePolicy !== 'function') {
  throw new Error('installed approval fork does not export ApprovalService.registerMachinePolicy()')
}

const managedManifest = require('dsh-managed-agent/package.json')
const managedPeers = managedManifest.peerDependencies ?? {}
for (const [name, version] of Object.entries(managedPeers)) {
  if (name.startsWith('@deepseek-ai/dsh-') && version !== HOST_VERSION) {
    throw new Error(`dsh-managed-agent peer ${name} is not pinned to ${HOST_VERSION}`)
  }
}
if ('@deepseek-ai/dsh-client-runtime' in managedPeers || '@deepseek-ai/dsh-client-runtime' in (managedManifest.devDependencies ?? {})) {
  throw new Error('dsh-managed-agent still depends on removed @deepseek-ai/dsh-client-runtime')
}

console.log(`PASS approval fork v${patch.patchVersion} for ${patch.upstreamCommit}`)
console.log(`PASS exact DSH ${HOST_VERSION} target install`)
