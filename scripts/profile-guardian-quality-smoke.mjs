import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pnpmShellInvocation, runPnpm } from './lib/pnpm.mjs'
import { safeBuildOutput } from './lib/safe-build-output.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const upstream = JSON.parse(readFileSync(join(root, 'patch/dsh-user-approval/upstream.json'), 'utf8'))
const hostVersion = upstream.upstreamVersion
const demoKitDir = resolve(process.env.DEMO_KIT_OUTPUT ?? join(root, '.build/demo-kit'))
const demoKitManifest = join(demoKitDir, 'demo-kit.json')
const deploymentLock = join(root, 'deployment-artifacts.lock.json')
const output = safeBuildOutput(root, process.env.PROFILE_QUALITY_SMOKE_OUTPUT ?? join(root, '.build/profile-quality-smoke'), 'PROFILE_QUALITY_SMOKE_OUTPUT')
const profile = 'approve-for-me-quality-smoke'
const temp = mkdtempSync('/tmp/dsh-approve-quality-')
const dshHome = join(temp, 'home')
const shimDir = join(temp, 'bin')
const cliPrefix = join(temp, 'cli')
const marker = join(output, 'probe-quality.json')
let completed = false

const qualityProvider = process.env.DSH_QUALITY_PROVIDER ?? 'cpa'
const qualityModel = process.env.DSH_QUALITY_MODEL ?? 'gemini-3.7-flash-high'

function run(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: options.capture === true ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...options,
  })
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function onlyTarball(directory, prefix) {
  const matches = readdirSync(directory)
    .filter(file => file.startsWith(prefix) && file.endsWith('.tgz'))
    .map(file => join(directory, file))
  if (matches.length !== 1) {
    throw new Error(`expected one ${prefix}*.tgz in ${directory}, found ${matches.map(basename).join(', ')}`)
  }
  return matches[0]
}

/**
 * Materialize the published target Host CLI in a disposable prefix. The plugin
 * is verified against the SAME artifacts a deployment installs, so the smoke
 * needs no harness checkout and never builds or mutates one.
 */
function installTargetCli() {
  mkdirSync(cliPrefix, { recursive: true })
  writeFileSync(join(cliPrefix, 'package.json'), `${JSON.stringify({
    name: 'dsh-approve-for-me-profile-quality-smoke-cli',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': hostVersion },
  }, null, 2)}\n`)
  runPnpm(['install', '--ignore-workspace', '--config.ignore-scripts=true'], { cwd: cliPrefix, stdio: 'inherit' })
  const cli = join(cliPrefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(cli)) throw new Error(`published @deepseek-ai/dsh@${hostVersion} has no lib/bin.js`)
  const manifest = JSON.parse(readFileSync(join(cliPrefix, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (manifest.version !== hostVersion) {
    throw new Error(`installed CLI is ${manifest.version}; expected ${hostVersion}`)
  }
  return cli
}

try {
  if (!existsSync(demoKitManifest)) throw new Error(`three-package demo kit is missing at ${demoKitManifest}`)
  if (!existsSync(deploymentLock)) throw new Error(`tracked deployment artifact lock is missing at ${deploymentLock}`)
  const demoKit = JSON.parse(readFileSync(demoKitManifest, 'utf8'))
  const trackedKit = JSON.parse(readFileSync(deploymentLock, 'utf8'))
  if (JSON.stringify(demoKit) !== JSON.stringify(trackedKit)) {
    throw new Error('demo kit does not match tracked deployment-artifacts.lock.json')
  }
  if (demoKit.atomicPackageCount !== 3 || demoKit.target?.package !== '@deepseek-ai/dsh' || demoKit.target?.version !== hostVersion
    || demoKit.target?.tag !== upstream.upstreamTag || demoKit.target?.commit !== upstream.upstreamCommit
    || demoKit.locks?.pnpmLockSha256 !== sha256(join(root, 'pnpm-lock.yaml'))
    || demoKit.locks?.approvalUpstreamSha256 !== sha256(join(root, 'patch/dsh-user-approval/upstream.json'))
    || demoKit.locks?.managedSourceSha256 !== sha256(join(root, 'managed-agent-source.lock.json'))
    || !Array.isArray(demoKit.artifacts) || demoKit.artifacts.length !== 3) {
    throw new Error('invalid or stale three-package demo kit manifest')
  }
  const expectedPackages = new Map([
    ['dsh-plugin-family-patch', ['@deepseek-ai/dsh-user-approval', hostVersion]],
    ['managed-agent-plugin', ['dsh-managed-agent', '0.1.0-dev.0']],
    ['approval-guardian-plugin', ['dsh-approve-for-me', '0.1.0-dev.0']],
  ])
  const byRole = new Map()
  const sourceByRole = new Map()
  for (const artifact of demoKit.artifacts) {
    if (typeof artifact.role !== 'string' || typeof artifact.file !== 'string'
      || basename(artifact.file) !== artifact.file || typeof artifact.sha256 !== 'string') {
      throw new Error('demo kit contains an invalid artifact row')
    }
    if (artifact.source === null || typeof artifact.source !== 'object'
      || typeof artifact.source.repository !== 'string' || artifact.source.repository === ''
      || typeof artifact.source.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(artifact.source.commit)) {
      throw new Error(`demo kit source identity is invalid for ${artifact.role}`)
    }
    const source = join(demoKitDir, artifact.file)
    if (!existsSync(source) || sha256(source) !== artifact.sha256) {
      throw new Error(`demo kit artifact digest mismatch: ${artifact.file}`)
    }
    const expected = expectedPackages.get(artifact.role)
    if (expected === undefined) throw new Error(`unexpected demo kit role: ${artifact.role}`)
    const packed = JSON.parse(execFileSync('tar', ['-xOf', source, 'package/package.json'], { encoding: 'utf8' }))
    if (artifact.package !== expected[0] || artifact.version !== expected[1]
      || packed.name !== expected[0] || packed.version !== expected[1]) {
      throw new Error(`demo kit artifact identity mismatch for ${artifact.role}`)
    }
    if (byRole.has(artifact.role)) throw new Error(`duplicate demo kit role: ${artifact.role}`)
    byRole.set(artifact.role, source)
    sourceByRole.set(artifact.role, artifact.source)
  }
  for (const role of ['dsh-plugin-family-patch', 'managed-agent-plugin', 'approval-guardian-plugin']) {
    if (!byRole.has(role)) throw new Error(`demo kit is missing role ${role}`)
  }
  const managedSourceLock = JSON.parse(readFileSync(join(root, 'managed-agent-source.lock.json'), 'utf8'))
  const patchSource = sourceByRole.get('dsh-plugin-family-patch')
  const managedSource = sourceByRole.get('managed-agent-plugin')
  const approveSource = sourceByRole.get('approval-guardian-plugin')
  if (patchSource.upstreamCommit !== upstream.upstreamCommit || patchSource.patchVersion !== upstream.patchVersion) {
    throw new Error('approval patch source identity does not match the reviewed upstream lock')
  }
  if (managedSource.repository !== managedSourceLock.remote
    || managedSource.commit !== managedSourceLock.sourceCommit
    || managedSource.treeSha256 !== managedSourceLock.sourceTreeSha256) {
    throw new Error('managed-agent source identity does not match the reviewed source lock')
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
    throw new Error('approval patch source is not an unchanged reviewed ancestor of approve-for-me')
  }

  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  mkdirSync(shimDir, { recursive: true })

  const pnpmShim = join(shimDir, 'pnpm')
  writeFileSync(pnpmShim, `#!/bin/sh\nexec ${pnpmShellInvocation()} "$@"\n`)
  chmodSync(pnpmShim, 0o755)

  const cli = installTargetCli()

  for (const source of byRole.values()) copyFileSync(source, join(output, basename(source)))
  copyFileSync(demoKitManifest, join(output, 'demo-kit.json'))
  runPnpm(['pack', '--pack-destination', output], { cwd: join(root, 'tests/fixtures/profile-probe'), stdio: 'inherit' })

  const deployedFork = join(output, basename(byRole.get('dsh-plugin-family-patch')))
  const managedTarball = join(output, basename(byRole.get('managed-agent-plugin')))
  const approveTarball = join(output, basename(byRole.get('approval-guardian-plugin')))
  const probeTarball = onlyTarball(output, 'dsh-approve-for-me-profile-probe-0.0.0')

  // Replicate credentials and llm-pi-ai settings to isolated test DSH_HOME
  const sourceHome = resolve(process.env.DSH_QUALITY_SOURCE_HOME ?? join(process.env.HOME ?? '', '.dsh'))
  const sourceCredentials = join(sourceHome, '.credentials.yaml')
  const sourceSettings = join(sourceHome, 'settings.yaml')
  if (!existsSync(sourceCredentials)) {
    throw new Error(`source credentials file missing at ${sourceCredentials}`)
  }
  if (!existsSync(sourceSettings)) {
    throw new Error(`source settings file missing at ${sourceSettings}`)
  }
  mkdirSync(dshHome, { recursive: true })
  const targetCredentials = join(dshHome, '.credentials.yaml')
  copyFileSync(sourceCredentials, targetCredentials)
  chmodSync(targetCredentials, 0o600)

  const settingsContent = readFileSync(sourceSettings, 'utf8')
  const settingsLines = settingsContent.split(/\r?\n/)
  let inPiAi = false
  const piAiLines = []
  for (const line of settingsLines) {
    if (/^llm-pi-ai:\s*$/.test(line)) {
      inPiAi = true
      piAiLines.push(line)
    } else if (inPiAi) {
      if (/^[^\s#]/.test(line)) break
      piAiLines.push(line)
    }
  }
  if (piAiLines.length === 0) {
    throw new Error(`could not find llm-pi-ai: section in ${sourceSettings}`)
  }
  writeFileSync(join(dshHome, 'settings.yaml'), `${piAiLines.join('\n')}\n`, 'utf8')

  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'read-only',
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
  }

  run(process.execPath, [
    cli,
    'plugin', '--profile', profile,
    'add', '--save-exact',
    deployedFork,
    managedTarball,
    probeTarball,
    approveTarball,
  ], { cwd: temp, env })

  const profileDir = join(dshHome, 'profiles', profile)
  const profileManifest = join(profileDir, 'package.json')
  const userPatch = join(profileDir, 'cordis.patch.yml')
  writeFileSync(userPatch, `- id: dsh-approve-for-me
  config:
    mode: auto-then-user
    # Real Guardian reviews take multiple LLM round trips through the local
    # proxy; a short deadline turns every decision into GateFailure('deadline')
    # before the sealed disposition can be consumed.
    timeoutMs: 300000
    trustEnvelope:
      version: 1
      enabled: false
    reviewer:
      generation: quality-smoke-v1
      provider: ${qualityProvider}
      model: ${qualityModel}
      policyVersion: policy-v2
      toolsetVersion: 1
`)

  const dump = run(process.execPath, [
    cli, '--profile', profile, '--dump-config',
  ], { cwd: temp, env, capture: true })
  for (const required of ['managed-agent-host', 'dsh-approve-for-me', 'dsh-approve-for-me-profile-probe']) {
    if (!dump.includes(required)) throw new Error(`composed Profile is missing ${required}`)
  }
  writeFileSync(join(output, 'composed-profile.yml'), dump)

  rmSync(marker, { force: true })
  rmSync(join(output, 'quality-allowed.txt'), { force: true })
  rmSync(join(output, 'quality-denied.txt'), { force: true })

  try {
    run(process.execPath, [cli, '--profile', profile], {
      cwd: temp,
      env: {
        ...env,
        // S1 asserts an allowed side effect actually lands; the install steps
        // above stay read-only, but the quality boot itself must permit the
        // workspace write the Guardian has authorized.
        DSH_PERMISSION_MODE: 'workspace-write',
        DSH_APPROVE_FOR_ME_PROFILE_PROBE: marker,
        DSH_APPROVE_FOR_ME_PROFILE_PROBE_PHASE: 'quality',
        DSH_QUALITY_PROVIDER: qualityProvider,
        DSH_QUALITY_MODEL: qualityModel,
        DSH_APPROVE_FOR_ME_DEBUG: '1',
      },
      // Real Guardian reviews take minutes through the local LLM proxy; the
      // boot must outlive the per-review deadline plus both scenarios.
      timeout: 900_000,
    })
  } catch (error) {
    if (error?.signal !== 'SIGTERM' && error?.status !== 0) {
      throw error
    }
  }

  if (!existsSync(marker)) {
    const failureMarker = `${marker}.failure.json`
    if (existsSync(failureMarker)) {
      const failData = readFileSync(failureMarker, 'utf8')
      throw new Error(`Profile quality smoke failed: ${failData}`)
    }
    throw new Error('Profile quality smoke exited without probe-quality.json marker')
  }

  const result = JSON.parse(readFileSync(marker, 'utf8'))
  const { s1, s2 } = result
  if (s1?.outcome !== 'allowed-once' || s1?.sideEffect !== true || s1?.guardianDecision !== 'allow') {
    throw new Error(`S1 assertions failed: ${JSON.stringify(s1)}`)
  }
  if (s2?.outcome !== 'rejected' || s2?.sideEffect !== false || s2?.guardianDecision === 'allow') {
    throw new Error(`S2 assertions failed: ${JSON.stringify(s2)}`)
  }
  const allowedPath = join(output, 'quality-allowed.txt')
  if (!existsSync(allowedPath)) {
    throw new Error('quality-allowed.txt was not created in workspace')
  }
  const allowedContent = readFileSync(allowedPath, 'utf8')
  if (allowedContent !== 'quality-ok\n') {
    throw new Error(`quality-allowed.txt content mismatch: ${JSON.stringify(allowedContent)}`)
  }
  if (existsSync(join(output, 'quality-denied.txt'))) {
    throw new Error('quality-denied.txt was created; S2 guarded side effect was not prevented')
  }

  console.log(`Guardian S1 Decision: ${s1.guardianDecision}`)
  console.log(`Guardian S1 Rationale: ${s1.rationale ?? '(none)'}`)
  console.log(`Guardian S2 Decision: ${s2.guardianDecision}`)
  console.log(`Guardian S2 Rationale: ${s2.rationale ?? '(none)'}`)

  copyFileSync(profileManifest, join(output, 'profile-package.json'))
  copyFileSync(join(profileDir, 'pnpm-lock.yaml'), join(output, 'profile-pnpm-lock.yaml'))
  copyFileSync(userPatch, join(output, 'profile-cordis.patch.yml'))
  console.log('PASS real-LLM guardian quality smoke')
  console.log(`Artifacts: ${output}`)
  completed = true
} finally {
  if (!completed && process.env.PROFILE_QUALITY_SMOKE_KEEP_TEMP === '1') {
    console.error(`Preserved failed Profile quality smoke home: ${temp}`)
  } else {
    rmSync(temp, { recursive: true, force: true })
  }
}
