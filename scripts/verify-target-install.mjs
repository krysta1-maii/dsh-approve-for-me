import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// By default verify the development install. Profile smoke tests pass the
// disposable profile package.json so every resolution is proven from the
// deployed artifact graph rather than from this source checkout.
const resolutionAnchor = process.env.DSH_VERIFY_RESOLVE_FROM ?? import.meta.url
const require = createRequire(resolutionAnchor)
const expected = Object.freeze({
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/schemastery': '3.18.1',
  '@deepseek-ai/dsh-agent': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-llm': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-sandbox': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-sandbox-policy': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-session': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-subagent': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-system-prompt': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-storage': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-storage-domain': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-tools': '0.1.2-alpha.1',
  '@deepseek-ai/dsh-user-approval': '0.1.2-alpha.1',
  'dsh-managed-agent': '0.1.0-dev.0',
})

const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const [name, version] of Object.entries(expected)) {
  if (root.peerDependencies?.[name] !== version) {
    throw new Error(`peer dependency ${name} must be pinned to ${version}`)
  }
  const manifestPath = require.resolve(`${name}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.version !== version) {
    throw new Error(`${name} resolved to ${manifest.version} at ${manifestPath}; expected ${version}`)
  }
  console.log(`PASS ${name}@${version} (${realpathSync(manifestPath)})`)
}

const approvalManifest = require('@deepseek-ai/dsh-user-approval/package.json')
const patch = approvalManifest.dshApprovalPatch
if (patch?.fork !== true
  || patch.patchVersion !== 2
  || patch.upstreamCommit !== 'cd5ef8148158c3a752a658978873241fdf8e2bbc') {
  throw new Error('installed @deepseek-ai/dsh-user-approval is not the pinned approve-for-me fork v2')
}
const approval = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-user-approval')).href)
if (typeof approval.ApprovalService?.prototype?.registerMachinePolicy !== 'function') {
  throw new Error('installed approval fork does not export ApprovalService.registerMachinePolicy()')
}

const managedManifest = require('dsh-managed-agent/package.json')
const managedPeers = managedManifest.peerDependencies ?? {}
for (const [name, version] of Object.entries(managedPeers)) {
  if (name.startsWith('@deepseek-ai/dsh-') && version !== '0.1.2-alpha.1') {
    throw new Error(`dsh-managed-agent peer ${name} is not pinned to 0.1.2-alpha.1`)
  }
}
if ('@deepseek-ai/dsh-client-runtime' in managedPeers || '@deepseek-ai/dsh-client-runtime' in (managedManifest.devDependencies ?? {})) {
  throw new Error('dsh-managed-agent still depends on removed @deepseek-ai/dsh-client-runtime')
}

console.log(`PASS approval fork v${patch.patchVersion} for ${patch.upstreamCommit}`)
console.log('PASS exact DSH 0.1.2-alpha.1 target install')
