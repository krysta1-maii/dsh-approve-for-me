import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runPnpm } from './lib/pnpm.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const temp = mkdtempSync(join(tmpdir(), 'dsh-approve-for-me-pack-'))
try {
  runPnpm(['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' })
  const tarballs = readdirSync(temp).filter(file => file.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.join(', ')}`)
  const tarball = join(temp, tarballs[0])
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
  for (const file of ['package/package.json', 'package/cordis.patch.yml', 'package/lib/index.js', 'package/lib/index.d.ts']) {
    if (!entries.includes(file)) throw new Error(`packed artifact is missing ${file}`)
  }
  for (const file of entries) {
    if (/(?:^|\/)(?:src|tests|node_modules|patch|scripts|docs)(?:\/|$)/.test(file)
      || /(?:^|\/)tsconfig(?:\.|$)/.test(file) || file.endsWith('.tgz')) {
      throw new Error(`packed artifact leaks development file ${file}`)
    }
  }
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
  if (manifest.name !== 'dsh-approve-for-me' || manifest.version !== '0.1.0-dev.0') throw new Error('packed identity mismatch')
  console.log(`PASS package smoke ${tarballs[0]} (${entries.length} entries)`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
