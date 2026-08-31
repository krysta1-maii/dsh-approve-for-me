import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const source = resolve(process.env.MANAGED_AGENT_SOURCE ?? join(root, '../dsh-managed-agent'))
const lockPath = resolve(process.env.MANAGED_AGENT_SOURCE_LOCK ?? join(root, 'managed-agent-source.lock.json'))

function sourceDigest(directory) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: directory,
    encoding: 'buffer',
  })
  const files = output.toString('utf8').split('\0').filter(Boolean).sort()
  const hash = createHash('sha256').update('dsh-managed-agent-reviewed-source-v1\0')
  for (const file of files) {
    const contentDigest = createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')
    hash.update(file).update('\0').update(contentDigest).update('\0')
  }
  return { sha256: hash.digest('hex'), files: files.length }
}

const actual = sourceDigest(source)
if (process.argv.includes('--print')) {
  console.log(JSON.stringify(actual, null, 2))
  process.exit(0)
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
if (lock.version !== 1 || lock.repository !== 'krysta1-maii/dsh-managed-agent'
  || typeof lock.remote !== 'string' || lock.remote.length === 0
  || typeof lock.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(lock.sourceCommit)
  || typeof lock.sourceTreeSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(lock.sourceTreeSha256)
  || !Number.isSafeInteger(lock.fileCount) || lock.fileCount < 1) {
  throw new Error(`invalid managed-agent source lock: ${lockPath}`)
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
const sourceRemote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: source, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim()
if (dirty !== '') throw new Error('managed-agent reviewed source must be clean before artifact construction')
if (sourceCommit !== lock.sourceCommit) {
  throw new Error(`managed-agent source commit differs from reviewed lock: expected ${lock.sourceCommit}, got ${sourceCommit}`)
}
if (sourceRemote !== lock.remote) {
  throw new Error(`managed-agent source remote differs from reviewed lock: expected ${lock.remote}, got ${sourceRemote}`)
}
if (actual.sha256 !== lock.sourceTreeSha256 || actual.files !== lock.fileCount) {
  throw new Error(`managed-agent source differs from reviewed lock: expected ${lock.sourceTreeSha256}/${lock.fileCount}, got ${actual.sha256}/${actual.files}`)
}
console.log(`managed-agent reviewed source ${sourceCommit} ${actual.sha256} (${actual.files} files)`)
