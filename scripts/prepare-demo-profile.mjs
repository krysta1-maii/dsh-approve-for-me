import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pnpmShellInvocation, runPnpm } from './lib/pnpm.mjs'
import { safeBuildOutput } from './lib/safe-build-output.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const output = safeBuildOutput(root, process.env.DSH_DEMO_OUTPUT ?? join(root, '.build/demo-profile'), 'DSH_DEMO_OUTPUT')
const kitDir = resolve(process.env.DEMO_KIT_OUTPUT ?? join(root, '.build/demo-kit'))
const kit = JSON.parse(readFileSync(join(kitDir, 'demo-kit.json'), 'utf8'))
const trackedKit = JSON.parse(readFileSync(join(root, 'deployment-artifacts.lock.json'), 'utf8'))
if (JSON.stringify(kit) !== JSON.stringify(trackedKit)) {
  throw new Error('demo kit does not match tracked deployment-artifacts.lock.json')
}
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const upstream = JSON.parse(readFileSync(join(root, 'patch/dsh-user-approval/upstream.json'), 'utf8'))
const managedSourceLock = JSON.parse(readFileSync(join(root, 'managed-agent-source.lock.json'), 'utf8'))
if (kit.target?.package !== '@deepseek-ai/dsh' || kit.target?.version !== upstream.upstreamVersion
  || kit.target?.tag !== upstream.upstreamTag || kit.target?.commit !== upstream.upstreamCommit) {
  throw new Error('demo kit target identity does not match the reviewed DSH target')
}
if (kit.atomicPackageCount !== 3 || !Array.isArray(kit.artifacts) || kit.artifacts.length !== 3
  || !Array.isArray(kit.installOrder) || kit.installOrder.length !== 3
  || kit.locks?.pnpmLockSha256 !== sha256(join(root, 'pnpm-lock.yaml'))
  || kit.locks?.approvalUpstreamSha256 !== sha256(join(root, 'patch/dsh-user-approval/upstream.json'))
  || kit.locks?.managedSourceSha256 !== sha256(join(root, 'managed-agent-source.lock.json'))) {
  throw new Error('demo kit must describe exactly three current atomic package artifacts')
}
const expectedPackages = new Map([
  ['dsh-plugin-family-patch', ['@deepseek-ai/dsh-user-approval', upstream.upstreamVersion]],
  ['managed-agent-plugin', ['dsh-managed-agent', '0.1.0-dev.0']],
  ['approval-guardian-plugin', ['dsh-approve-for-me', '0.1.0-dev.0']],
])
const requiredRoles = new Set(expectedPackages.keys())
const sources = new Map()
for (const artifact of kit.artifacts) {
  if (!requiredRoles.delete(artifact.role) || typeof artifact.file !== 'string'
    || basename(artifact.file) !== artifact.file || typeof artifact.sha256 !== 'string'
    || artifact.source === null || typeof artifact.source !== 'object') {
    throw new Error('demo kit contains an invalid artifact row')
  }
  const path = join(kitDir, artifact.file)
  if (!existsSync(path)) throw new Error(`demo artifact is missing: ${artifact.file}`)
  if (sha256(path) !== artifact.sha256) throw new Error(`demo artifact digest mismatch: ${artifact.file}`)
  const packed = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }))
  const [expectedName, expectedVersion] = expectedPackages.get(artifact.role)
  if (artifact.package !== expectedName || artifact.version !== expectedVersion
    || packed.name !== expectedName || packed.version !== expectedVersion) {
    throw new Error(`demo artifact identity mismatch for ${artifact.role}`)
  }
  if (typeof artifact.source.repository !== 'string' || artifact.source.repository === ''
    || typeof artifact.source.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(artifact.source.commit)) {
    throw new Error(`demo artifact source identity is invalid for ${artifact.role}`)
  }
  sources.set(artifact.role, artifact.source)
}
if (requiredRoles.size !== 0 || new Set(kit.installOrder).size !== 3
  || kit.installOrder.some(role => !kit.artifacts.some(artifact => artifact.role === role))) {
  throw new Error('demo kit roles or install order are incomplete')
}
const patchSource = sources.get('dsh-plugin-family-patch')
const managedSource = sources.get('managed-agent-plugin')
const approveSource = sources.get('approval-guardian-plugin')
if (patchSource.upstreamCommit !== upstream.upstreamCommit || patchSource.patchVersion !== upstream.patchVersion) {
  throw new Error('approval patch source does not match the reviewed upstream lock')
}
if (managedSource.repository !== managedSourceLock.remote || managedSource.commit !== managedSourceLock.sourceCommit
  || managedSource.treeSha256 !== managedSourceLock.sourceTreeSha256) {
  throw new Error('managed-agent source does not match the reviewed source lock')
}
let patchInputsUnchanged = false
try {
  const patchTree = execFileSync('git', ['rev-parse', `${patchSource.commit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()
  const approveTree = execFileSync('git', ['rev-parse', `${approveSource.commit}^{tree}`], { cwd: root, encoding: 'utf8' }).trim()
  execFileSync('git', ['merge-base', '--is-ancestor', patchSource.commit, approveSource.commit], { cwd: root })
  execFileSync('git', ['diff', '--quiet', patchSource.commit, approveSource.commit, '--', 'patch/dsh-user-approval'], { cwd: root })
  patchInputsUnchanged = patchTree === patchSource.tree && approveTree === approveSource.tree
} catch {
  // Rejected below.
}
if (patchSource.repository !== approveSource.repository || !patchInputsUnchanged) {
  throw new Error('approval patch source is not an unchanged reviewed ancestor of the Guardian plugin source')
}

const provider = process.env.DSH_DEMO_PROVIDER
const model = process.env.DSH_DEMO_MODEL
const reasoningEffort = process.env.DSH_DEMO_REASONING_EFFORT
if (provider === undefined || provider.length === 0 || model === undefined || model.length === 0) {
  throw new Error('set DSH_DEMO_PROVIDER and DSH_DEMO_MODEL to exact ids shown by the target DSH provider/model lists')
}
const profile = process.env.DSH_DEMO_PROFILE ?? 'web'
const dshHome = join(output, 'home')
const cliPrefix = join(output, 'cli')
const shimDir = join(output, 'bin')

if (existsSync(output)) throw new Error(`refusing to overwrite existing demo output: ${output}`)
mkdirSync(cliPrefix, { recursive: true })
mkdirSync(shimDir, { recursive: true })
writeFileSync(join(cliPrefix, 'package.json'), `${JSON.stringify({
  name: 'dsh-approve-for-me-demo-cli',
  private: true,
  version: '0.0.0',
  dependencies: { '@deepseek-ai/dsh': kit.target.version },
}, null, 2)}\n`)
runPnpm(['install', '--ignore-workspace', '--config.ignore-scripts=true'], { cwd: cliPrefix, stdio: 'inherit' })
const cli = join(cliPrefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
if (!existsSync(cli)) throw new Error(`target DSH CLI is missing: ${cli}`)

const pnpmShim = join(shimDir, 'pnpm')
writeFileSync(pnpmShim, `#!/bin/sh\nexec ${pnpmShellInvocation()} "$@"\n`)
chmodSync(pnpmShim, 0o755)
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  PATH: `${shimDir}:${process.env.PATH ?? ''}`,
}
const tarballs = kit.installOrder.map((role) => {
  const artifact = kit.artifacts.find(candidate => candidate.role === role)
  if (artifact === undefined) throw new Error(`demo kit has no artifact for role ${role}`)
  return join(kitDir, artifact.file)
})
execFileSync(process.execPath, [
  cli,
  'plugin', '--profile', profile,
  'add', '--save-exact',
  ...tarballs,
], { cwd: output, env, stdio: 'inherit' })

const profileDir = join(dshHome, 'profiles', profile)
const patch = join(profileDir, 'cordis.patch.yml')
const reasoningLine = reasoningEffort === undefined || reasoningEffort.length === 0
  ? ''
  : `      reasoningEffort: ${JSON.stringify(reasoningEffort)}\n`
writeFileSync(patch, `# Generated disposable dsh-approve-for-me demo profile.\n# Provider/model ids are validated against ctx.llm.listProviders/listModels at boot.\n- id: dsh-approve-for-me\n  config:\n    mode: auto-then-user\n    timeoutMs: 30000\n    trustEnvelope:\n      version: 1\n      enabled: false\n    reviewer:\n      generation: demo-primary-v1\n      provider: ${JSON.stringify(provider)}\n      model: ${JSON.stringify(model)}\n${reasoningLine}      policyVersion: policy-v2\n      toolsetVersion: 1\n`)
const dump = execFileSync(process.execPath, [cli, '--profile', profile, '--dump-config'], {
  cwd: output,
  env,
  encoding: 'utf8',
})
for (const required of ['managed-agent-host', 'dsh-approve-for-me']) {
  if (!dump.includes(required)) throw new Error(`prepared Profile is missing ${required}`)
}
writeFileSync(join(output, 'composed-profile.yml'), dump)

const runner = join(output, 'run-demo.sh')
writeFileSync(runner, `#!/bin/sh\nset -eu\nexport DSH_HOME=${JSON.stringify(dshHome)}\nexport PATH=${JSON.stringify(`${shimDir}:${process.env.PATH ?? ''}`)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} --profile ${JSON.stringify(profile)} --no-open "$@"\n`)
chmodSync(runner, 0o755)
writeFileSync(join(output, 'README.txt'), `Disposable DSH approve-for-me demo\n\nTarget: @deepseek-ai/dsh@${kit.target.version}\nProfile: ${profile}\nGuardian route: ${provider}/${model}${reasoningEffort ? ` (${reasoningEffort})` : ''}\nAtomic packages: 3 (see ../demo-kit/demo-kit.json)\n\nThe selected provider/model must be registered by the target DSH configuration.\nProvider credentials and private adapter settings remain owned by DSH and are not copied into this demo kit.\nRun: ${runner}\n`)
console.log(`PASS prepared isolated DSH demo Profile: ${output}`)
console.log(`Run only when ready: ${runner}`)
