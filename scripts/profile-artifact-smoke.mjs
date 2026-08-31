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
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pnpmShellInvocation, runPnpm } from './lib/pnpm.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const upstream = JSON.parse(readFileSync(join(root, 'patch/dsh-user-approval/upstream.json'), 'utf8'))
const hostVersion = upstream.upstreamVersion
const managedArtifactDir = resolve(process.env.MANAGED_AGENT_ARTIFACT_DIR ?? join(root, '.artifacts/managed-agent'))
const managedArtifactManifest = join(managedArtifactDir, 'artifact.json')
const forkTarball = resolve(process.env.APPROVAL_FORK_TARBALL
  ?? join(root, `.build/dsh-user-approval-afm-${hostVersion}.tgz`))
const output = resolve(process.env.PROFILE_SMOKE_OUTPUT ?? join(root, '.build/profile-smoke'))
const profile = 'approve-for-me-artifact-smoke'
const temp = mkdtempSync(join(tmpdir(), 'dsh-approve-profile-'))
const dshHome = join(temp, 'home')
const shimDir = join(temp, 'bin')
const cliPrefix = join(temp, 'cli')
const marker = join(output, 'boot-probe.json')
const restartMarker = join(output, 'boot-probe-restart.json')
let completed = false

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
    name: 'dsh-approve-for-me-profile-smoke-cli',
    private: true,
    version: '0.0.0',
    dependencies: { '@deepseek-ai/dsh': hostVersion },
  }, null, 2)}\n`)
  runPnpm(['install', '--config.ignore-scripts=true'], { cwd: cliPrefix, stdio: 'inherit' })
  const cli = join(cliPrefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(cli)) throw new Error(`published @deepseek-ai/dsh@${hostVersion} has no lib/bin.js`)
  const manifest = JSON.parse(readFileSync(join(cliPrefix, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  if (manifest.version !== hostVersion) {
    throw new Error(`installed CLI is ${manifest.version}; expected ${hostVersion}`)
  }
  return cli
}

try {
  if (!existsSync(forkTarball)) throw new Error(`approval fork tarball is missing at ${forkTarball}`)
  if (!existsSync(managedArtifactManifest)) throw new Error(`managed-agent artifact manifest is missing at ${managedArtifactManifest}`)
  const managedManifest = JSON.parse(readFileSync(managedArtifactManifest, 'utf8'))
  if (typeof managedManifest.file !== 'string' || basename(managedManifest.file) !== managedManifest.file
    || typeof managedManifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(managedManifest.sha256)) {
    throw new Error('managed-agent artifact manifest has an invalid file or sha256 field')
  }
  const materializedManagedTarball = join(managedArtifactDir, managedManifest.file)
  if (!existsSync(materializedManagedTarball)) throw new Error(`materialized managed-agent tarball is missing at ${materializedManagedTarball}`)
  const managedDigest = sha256(materializedManagedTarball)
  if (managedDigest !== managedManifest.sha256) {
    throw new Error(`managed-agent artifact digest mismatch: expected ${managedManifest.sha256}, got ${managedDigest}`)
  }

  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  mkdirSync(shimDir, { recursive: true })

  const pnpmShim = join(shimDir, 'pnpm')
  writeFileSync(pnpmShim, `#!/bin/sh\nexec ${pnpmShellInvocation()} "$@"\n`)
  chmodSync(pnpmShim, 0o755)

  const cli = installTargetCli()

  copyFileSync(materializedManagedTarball, join(output, basename(materializedManagedTarball)))
  copyFileSync(managedArtifactManifest, join(output, 'managed-agent-artifact.json'))
  runPnpm(['pack', '--pack-destination', output], { cwd: root, stdio: 'inherit' })
  runPnpm(['pack', '--pack-destination', output], { cwd: join(root, 'tests/fixtures/profile-probe'), stdio: 'inherit' })
  copyFileSync(forkTarball, join(output, basename(forkTarball)))

  const managedTarball = onlyTarball(output, 'dsh-managed-agent-0.1.0-dev.0')
  const approveTarball = onlyTarball(output, 'dsh-approve-for-me-0.1.0-dev.0')
  const probeTarball = onlyTarball(output, 'dsh-approve-for-me-profile-probe-0.0.0')
  const deployedFork = join(output, basename(forkTarball))
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
    approveTarball,
    probeTarball,
  ], { cwd: temp, env })

  const profileDir = join(dshHome, 'profiles', profile)
  const profileManifest = join(profileDir, 'package.json')
  const userPatch = join(profileDir, 'cordis.patch.yml')
  writeFileSync(userPatch, `- id: dsh-approve-for-me\n  config:\n    mode: auto-then-user\n    timeoutMs: 5000\n    trustEnvelope:\n      version: 1\n      enabled: false\n    reviewer:\n      generation: profile-smoke-v1\n      provider: profile-smoke-provider\n      model: profile-smoke-model\n      policyVersion: policy-v2\n      toolsetVersion: 1\n`)

  const dump = run(process.execPath, [
    cli, '--profile', profile, '--dump-config',
  ], { cwd: temp, env, capture: true })
  for (const required of ['managed-agent-host', 'dsh-approve-for-me', 'dsh-approve-for-me-profile-probe']) {
    if (!dump.includes(required)) throw new Error(`composed Profile is missing ${required}`)
  }
  writeFileSync(join(output, 'composed-profile.yml'), dump)

  const boot = (markerPath, phase) => {
    rmSync(markerPath, { force: true })
    run(process.execPath, [cli, '--profile', profile], {
      cwd: temp,
      env: { ...env, DSH_APPROVE_FOR_ME_PROFILE_PROBE: markerPath },
      timeout: 60_000,
    })
    if (!existsSync(markerPath)) throw new Error(`${phase} Profile boot exited without the injected probe marker`)
    const probe = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (probe.managedAgents !== true || probe.approvalMachinePolicy !== true || probe.toolCount < 1
      || probe.automaticApproval?.outcome !== 'allowed-once'
      || probe.automaticApproval?.terminalFallbackCalls !== 0
      || probe.automaticApproval?.sideEffect !== true
      || probe.humanFallback?.outcome !== 'rejected'
      || probe.humanFallback?.terminalFallbackCalls !== 1
      || probe.humanFallback?.sideEffect !== false) {
      throw new Error(`invalid ${phase} boot probe: ${JSON.stringify(probe)}`)
    }
    return probe
  }

  const probe = boot(marker, 'initial')

  // A real boot heals the installation-owned profiles/node_modules fallback.
  // Verify from the Profile anchor only after that deployment graph exists.
  run(process.execPath, [join(root, 'scripts/verify-target-install.mjs')], {
    cwd: root,
    env: { ...env, DSH_VERIFY_RESOLVE_FROM: profileManifest },
  })

  // Start a fresh Host process from the already-installed Profile. This catches
  // accidental dependence on the install command's process state or source tree.
  const restarted = boot(restartMarker, 'cold-restart')
  if (JSON.stringify(restarted.toolNames) !== JSON.stringify(probe.toolNames)) {
    throw new Error('cold-restart Profile exposed a different effective tool catalog')
  }

  copyFileSync(profileManifest, join(output, 'profile-package.json'))
  copyFileSync(join(profileDir, 'pnpm-lock.yaml'), join(output, 'profile-pnpm-lock.yaml'))
  copyFileSync(userPatch, join(output, 'profile-cordis.patch.yml'))
  console.log(`PASS published-host artifact Profile install + cold-restart smoke (${probe.toolCount} effective tools)`)
  console.log(`Artifacts: ${output}`)
  completed = true
} finally {
  if (!completed && process.env.PROFILE_SMOKE_KEEP_TEMP === '1') {
    console.error(`Preserved failed Profile smoke home: ${temp}`)
  } else {
    rmSync(temp, { recursive: true, force: true })
  }
}
