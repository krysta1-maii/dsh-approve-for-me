import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPnpm } from './lib/pnpm.mjs'

const HOST_COMMIT = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
const HOST_VERSION = '0.1.2-alpha.1'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = resolve(process.env.DSH_REPO ?? join(root, '..', 'deepseek-harness'))
const artifactDir = join(root, '.artifacts', 'dsh-0.1.2-alpha.1')
const lockPath = join(root, 'target-host-artifacts.lock.json')
const refresh = process.argv.includes('--refresh')

function run(command, args, cwd = root) { execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env }) }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function canonicalTarballSha256(path) {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-pack-digest-'))
  try {
    run('tar', ['-xzf', path, '-C', temp])
    const files = []
    const visit = directory => {
      for (const name of readdirSync(directory).sort()) {
        const entry = join(directory, name)
        const stat = statSync(entry)
        if (stat.isDirectory()) visit(entry)
        else if (stat.isFile()) files.push(entry)
      }
    }
    visit(temp)
    const digest = createHash('sha256')
    const normalize = value => Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
        : value
    for (const file of files) {
      const content = file.endsWith('.json')
        ? JSON.stringify(normalize(JSON.parse(readFileSync(file, 'utf8'))))
        : readFileSync(file)
      digest.update(relative(temp, file)).update('\0').update(content).update('\0')
    }
    return digest.digest('hex')
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
function normalizeTarball(path) {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-pack-normalize-'))
  try {
    run('tar', ['-xzf', path, '-C', temp])
    const visit = directory => {
      for (const name of readdirSync(directory).sort()) {
        const entry = join(directory, name)
        const stat = statSync(entry)
        if (stat.isDirectory()) visit(entry)
        else if (stat.isFile() && entry.endsWith('.json')) {
          const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
          writeFileSync(entry, `${JSON.stringify(normalize(JSON.parse(readFileSync(entry, 'utf8'))), null, 2)}\n`)
        }
      }
    }
    visit(temp)
    rmSync(path, { force: true })
    run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', path, '-C', temp, 'package'])
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
function ensurePinnedUnrun() {
  const installDir = join(host, 'node_modules', 'unrun')
  const temp = mkdtempSync(join(tmpdir(), 'dsh-unrun-'))
  try {
    if (!existsSync(join(installDir, 'package.json'))) {
      run('npm', ['pack', 'unrun@0.3.1', '--pack-destination', temp, '--ignore-scripts'])
      const tarball = join(temp, 'unrun-0.3.1.tgz')
      const integrity = createHash('sha512').update(readFileSync(tarball)).digest('base64')
      const expected = 'onIck/oNnCaytwths1ZVp1LK2Gq2hPoyFhiHebObuUXqR3S0uHuLLaBK8K6mRRgV7Ptip8AnNvaUsgzwWwBZuA=='
      if (integrity !== expected) throw new Error('unrun@0.3.1 integrity mismatch')
      rmSync(installDir, { recursive: true, force: true })
      mkdirSync(installDir, { recursive: true })
      run('tar', ['-xzf', tarball, '--strip-components=1', '-C', installDir])
    }
    const tsdownManifest = execFileSync(process.execPath, ['-e', "console.log(require.resolve('tsdown/package.json'))"], { cwd: host, encoding: 'utf8' }).trim()
    const peerLink = join(dirname(dirname(tsdownManifest)), 'unrun')
    rmSync(peerLink, { recursive: true, force: true })
    symlinkSync(installDir, peerLink, 'dir')
    mkdirSync(join(installDir, 'node_modules'), { recursive: true })
    for (const dependency of ['rolldown', 'synckit']) {
      const source = join(dirname(dirname(tsdownManifest)), dependency)
      const target = join(installDir, 'node_modules', dependency)
      if (existsSync(source)) {
        rmSync(target, { recursive: true, force: true })
        symlinkSync(source, target, 'dir')
      }
    }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
function collectPackages(directory, packages = new Map()) {
  for (const entry of readdirSync(directory)) {
    if (entry === '.git' || entry === 'node_modules' || entry === 'lib' || entry === 'dist') continue
    const path = join(directory, entry)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (!stat.isDirectory()) continue
    const manifestPath = join(path, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = json(manifestPath)
      if (typeof manifest.name === 'string') packages.set(manifest.name, { path, manifest })
    }
    collectPackages(path, packages)
  }
  return packages
}

if (!existsSync(join(host, '.git'))) throw new Error(`DSH checkout not found: ${host}`)
const commit = execFileSync('git', ['-C', host, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (commit !== HOST_COMMIT) throw new Error(`DSH HEAD ${commit} does not match ${HOST_COMMIT}`)
const hostManifest = json(join(host, 'package.json'))
if (hostManifest.version !== HOST_VERSION) throw new Error(`DSH version ${hostManifest.version} does not match ${HOST_VERSION}`)
if (process.env.DSH_SKIP_BUILD !== '1') {
  runPnpm(['install', '--frozen-lockfile'], { cwd: host, stdio: 'inherit' })
  ensurePinnedUnrun()
  runPnpm(['exec', 'tsc', '-b', 'tsconfig.host.json'], { cwd: host, stdio: 'inherit' })
  runPnpm(['exec', 'tsc', '-b', 'tsconfig.client.json'], { cwd: host, stdio: 'inherit' })
  for (const script of ['build:lib:host', 'build:lib:client']) {
    try { runPnpm(['run', script], { cwd: host, stdio: 'inherit' }) }
    catch { console.warn(`${script} reported an unrelated workspace bundling error; required package artifacts will be verified before packing`) }
  }
}

const available = collectPackages(host)
const consumer = json(join(root, 'package.json'))
const roots = [...new Set([
  ...Object.keys({ ...consumer.peerDependencies, ...consumer.devDependencies }),
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-projection',
])].filter(name => name.startsWith('@deepseek-ai/') && name !== '@deepseek-ai/dsh-user-approval')
const selected = new Map()
const queue = [...roots]
while (queue.length > 0) {
  const name = queue.shift()
  if (selected.has(name)) continue
  const entry = available.get(name)
  if (entry === undefined) throw new Error(`target package ${name} is absent from pinned DSH checkout`)
  selected.set(name, entry)
  for (const dependency of Object.keys({ ...entry.manifest.dependencies, ...entry.manifest.peerDependencies })) {
    if (available.has(dependency) && !selected.has(dependency)) queue.push(dependency)
  }
}
rmSync(artifactDir, { recursive: true, force: true })
mkdirSync(artifactDir, { recursive: true })
const records = []
for (const [name, entry] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
  if (name.startsWith('@deepseek-ai/dsh-') && entry.manifest.version !== HOST_VERSION) throw new Error(`${name} has unexpected version ${entry.manifest.version}`)
  const runtimeEntry = entry.manifest.module ?? entry.manifest.main
  if (typeof runtimeEntry === 'string' && !existsSync(join(entry.path, runtimeEntry))) {
    const source = runtimeEntry === 'lib/client.js' ? 'lib/types/client/index.js' : `lib/types/${runtimeEntry.split('/').at(-1)}`
    if (existsSync(join(entry.path, source))) copyFileSync(join(entry.path, source), join(entry.path, runtimeEntry))
  }
  if (typeof runtimeEntry === 'string' && !existsSync(join(entry.path, runtimeEntry))) throw new Error(`${name} is missing built runtime entry ${runtimeEntry}`)
  runPnpm(['pack', '--config.ignore-scripts=true', '--pack-destination', artifactDir], { cwd: entry.path, stdio: 'inherit' })
  const prefix = name.replace(/^@/, '').replace('/', '-') + '-'
  const matches = readdirSync(artifactDir).filter(file => file.startsWith(prefix) && file.endsWith('.tgz'))
  if (matches.length !== 1) throw new Error(`expected one tarball for ${name}, found ${matches.join(', ')}`)
  const file = matches[0]
  const artifact = join(artifactDir, file)
  normalizeTarball(artifact)
  records.push({ name, version: entry.manifest.version, file, sha256: canonicalTarballSha256(artifact) })
}
const actual = { hostCommit: HOST_COMMIT, hostVersion: HOST_VERSION, packages: records }
if (refresh) {
  const manifestPath = join(root, 'package.json')
  const manifest = json(manifestPath)
  const artifacts = new Map(records.filter(record => record.name !== '@deepseek-ai/dsh-user-approval').map(record => [record.name, `file:.artifacts/dsh-${HOST_VERSION}/${record.file}`]))
  for (const [name, value] of Object.entries(manifest.devDependencies ?? {})) {
    if (typeof value === 'string' && value.startsWith('link:') && artifacts.has(name)) manifest.devDependencies[name] = artifacts.get(name)
  }
  for (const [name, path] of artifacts) manifest.devDependencies[name] ??= path
  delete manifest.pnpm
  const versions = new Map(records.map(record => [record.name, record.version]))
  const overrides = [...artifacts].flatMap(([name, path]) => [[name, path], [`${name}@${versions.get(name)}`, path]]).sort(([a], [b]) => a.localeCompare(b))
  const workspace = ['autoInstallPeers: false', 'strictPeerDependencies: true', 'overrides:', ...overrides.map(([selector, path]) => `  '${selector}': '${path}'`), ''].join('\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), workspace)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(lockPath, `${JSON.stringify(actual, null, 2)}\n`)
  console.log(`refreshed package.json and ${relative(root, lockPath)} with ${records.length} package digests`)
} else {
  if (!existsSync(lockPath)) throw new Error(`missing ${lockPath}; run bootstrap:target-host:refresh once and review it`)
  const expected = json(lockPath)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedByName = new Map(expected.packages.map(item => [item.name, item]))
    const mismatch = actual.packages.find(item => JSON.stringify(item) !== JSON.stringify(expectedByName.get(item.name)))
    throw new Error(`target-host artifact digest mismatch for ${mismatch?.name ?? 'manifest'}; pinned source did not reproduce the reviewed contents`)
  }
  console.log(`verified ${records.length} target-host artifacts from ${HOST_COMMIT}`)
}
