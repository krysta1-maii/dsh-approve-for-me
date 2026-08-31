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
const files = readdirSync(out).filter(file => file.endsWith('.tgz'))
if (files.length !== 1) throw new Error(`expected one managed-agent tarball, found ${files.join(', ')}`)
const tarball = join(out, files[0])
const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
for (const required of ['package/dist/index.js', 'package/dist/index.d.ts', 'package/cordis.patch.yml']) if (!entries.includes(required)) throw new Error(`managed artifact lacks ${required}`)
const sourceCommit = execFileSync('git', ['-C', sibling, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['-C', sibling, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const sourceLock = JSON.parse(readFileSync(join(root, 'managed-agent-source.lock.json'), 'utf8'))
writeFileSync(join(out, 'artifact.json'), JSON.stringify({
  sourceCommit,
  sourceTreeSha256: sourceLock.sourceTreeSha256,
  dirty,
  file: files[0],
  sha256,
}, null, 2) + '\n')
console.log(`managed-agent artifact ${sha256} from ${sourceCommit}${dirty ? ' (dirty source)' : ''}`)
