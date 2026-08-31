import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { runPnpm } from './lib/pnpm.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const upstream = JSON.parse(readFileSync(join(root, 'patch/dsh-user-approval/upstream.json'), 'utf8'))
const output = resolve(process.env.DEMO_KIT_OUTPUT ?? join(root, '.build/demo-kit'))
const fork = join(root, `.build/dsh-user-approval-afm-${upstream.upstreamVersion}.tgz`)
const forkSidecar = `${fork}.sha256`
const managedManifestPath = join(root, '.artifacts/managed-agent/artifact.json')
const approveSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const approveSourceRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
const approveDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (approveDirty !== '') throw new Error('dsh-approve-for-me source must be clean before constructing a demo kit')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function packageManifest(tarball) {
  return JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
}

function assertAtomic(tarball) {
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
  const nested = entries.filter(entry => entry.endsWith('.tgz'))
  if (nested.length > 0) throw new Error(`${basename(tarball)} embeds package tarballs: ${nested.join(', ')}`)
}

if (!existsSync(fork) || !existsSync(forkSidecar)) {
  throw new Error('approval fork is missing; run npm run build:approval-fork first')
}
if (!existsSync(managedManifestPath)) {
  throw new Error('managed-agent artifact is missing; run npm run build:managed-artifact first')
}
const forkExpected = readFileSync(forkSidecar, 'utf8').trim().split(/\s+/)[0]
if (forkExpected !== sha256(fork)) throw new Error('approval fork digest does not match its sidecar')

const managedArtifact = JSON.parse(readFileSync(managedManifestPath, 'utf8'))
const managedSourceLock = JSON.parse(readFileSync(join(root, 'managed-agent-source.lock.json'), 'utf8'))
if (managedArtifact.dirty !== false
  || managedArtifact.sourceRemote !== managedSourceLock.remote
  || managedArtifact.sourceCommit !== managedSourceLock.sourceCommit
  || managedArtifact.sourceTreeSha256 !== managedSourceLock.sourceTreeSha256) {
  throw new Error('managed-agent artifact does not match the clean reviewed source lock')
}
const managed = join(root, '.artifacts/managed-agent', managedArtifact.file)
if (!existsSync(managed) || sha256(managed) !== managedArtifact.sha256) {
  throw new Error('managed-agent artifact digest does not match artifact.json')
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
copyFileSync(fork, join(output, basename(fork)))
copyFileSync(managed, join(output, basename(managed)))
runPnpm(['pack', '--pack-destination', output], { cwd: root, stdio: 'inherit' })

const tarballs = readdirSync(output).filter(file => file.endsWith('.tgz')).sort()
if (tarballs.length !== 3) throw new Error(`demo kit must contain exactly three tarballs, found ${tarballs.join(', ')}`)
const roleByName = new Map([
  ['@deepseek-ai/dsh-user-approval', 'dsh-plugin-family-patch'],
  ['dsh-managed-agent', 'managed-agent-plugin'],
  ['dsh-approve-for-me', 'approval-guardian-plugin'],
])
const artifacts = tarballs.map((file) => {
  const path = join(output, file)
  assertAtomic(path)
  const manifest = packageManifest(path)
  const role = roleByName.get(manifest.name)
  if (role === undefined) throw new Error(`unexpected demo artifact ${manifest.name}@${manifest.version}`)
  const source = manifest.name === 'dsh-managed-agent'
    ? {
        repository: managedArtifact.sourceRemote,
        commit: managedArtifact.sourceCommit,
        treeSha256: managedArtifact.sourceTreeSha256,
      }
    : manifest.name === '@deepseek-ai/dsh-user-approval'
      ? {
          repository: approveSourceRemote,
          commit: approveSourceCommit,
          upstreamCommit: upstream.upstreamCommit,
          patchVersion: upstream.patchVersion,
        }
      : { repository: approveSourceRemote, commit: approveSourceCommit }
  return Object.freeze({ role, package: manifest.name, version: manifest.version, file, sha256: sha256(path), source })
})
if (new Set(artifacts.map(artifact => artifact.role)).size !== 3) {
  throw new Error('demo kit does not contain one artifact for each atomic role')
}

const installOrder = [
  'dsh-plugin-family-patch',
  'managed-agent-plugin',
  'approval-guardian-plugin',
]
writeFileSync(join(output, 'demo-kit.json'), `${JSON.stringify({
  version: 1,
  target: {
    package: '@deepseek-ai/dsh',
    version: upstream.upstreamVersion,
    tag: upstream.upstreamTag,
    commit: upstream.upstreamCommit,
  },
  locks: {
    pnpmLockSha256: sha256(join(root, 'pnpm-lock.yaml')),
    approvalUpstreamSha256: sha256(join(root, 'patch/dsh-user-approval/upstream.json')),
    managedSourceSha256: sha256(join(root, 'managed-agent-source.lock.json')),
  },
  atomicPackageCount: 3,
  installOrder,
  artifacts: installOrder.map(role => artifacts.find(artifact => artifact.role === role)),
}, null, 2)}\n`)
console.log(`PASS three-package demo kit for DSH ${upstream.upstreamVersion}: ${output}`)
