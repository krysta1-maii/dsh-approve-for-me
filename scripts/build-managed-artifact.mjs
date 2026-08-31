import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runPnpm } from './lib/pnpm.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const sibling = resolve(root, process.env.MANAGED_AGENT_SOURCE ?? '../dsh-managed-agent')
const out = join(root, '.artifacts', 'managed-agent')
if (!existsSync(join(sibling, '.git'))) throw new Error(`managed-agent sibling not found: ${sibling}`)
execFileSync(process.execPath, [join(root, 'scripts/verify-managed-agent-source.mjs')], {
  cwd: root,
  env: { ...process.env, MANAGED_AGENT_SOURCE: sibling },
  stdio: 'inherit',
})
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true })
runPnpm(['pack', '--pack-destination', out], { cwd: sibling, stdio: 'inherit' })
// `prepack` is executable source code. Re-run the full identity/cleanliness gate
// after packing so an artifact can never be published after source drift.
execFileSync(process.execPath, [join(root, 'scripts/verify-managed-agent-source.mjs')], {
  cwd: root,
  env: { ...process.env, MANAGED_AGENT_SOURCE: sibling },
  stdio: 'inherit',
})
const files = readdirSync(out).filter(file => file.endsWith('.tgz'))
if (files.length !== 1) throw new Error(`expected one managed-agent tarball, found ${files.join(', ')}`)
const tarball = join(out, files[0])
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
const sourceFiles = execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/*.ts'], { cwd: sibling, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
const expectedEntries = new Set([
  'package/package.json', 'package/cordis.patch.yml', 'package/THIRD_PARTY_NOTICES.md',
  'package/LICENSE', 'package/README.md',
])
for (const source of sourceFiles) {
  const stem = source.replace(/^src\//, '').replace(/\.ts$/, '')
  for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) expectedEntries.add(`package/dist/${stem}${suffix}`)
}
for (const entry of entries) {
  if (!expectedEntries.has(entry) || entry.endsWith('.tgz')) {
    throw new Error(`managed artifact contains unexpected file ${entry}`)
  }
}
for (const required of ['package/dist/index.js', 'package/dist/index.d.ts', 'package/cordis.patch.yml']) if (!entries.includes(required)) throw new Error(`managed artifact lacks ${required}`)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const sourceLock = JSON.parse(readFileSync(join(root, 'managed-agent-source.lock.json'), 'utf8'))
writeFileSync(join(out, 'artifact.json'), JSON.stringify({
  sourceRemote: sourceLock.remote,
  sourceCommit: sourceLock.sourceCommit,
  sourceTreeSha256: sourceLock.sourceTreeSha256,
  dirty: false,
  file: files[0],
  sha256,
}, null, 2) + '\n')
console.log(`managed-agent artifact ${sha256} from ${sourceLock.sourceCommit} (clean source)`)
