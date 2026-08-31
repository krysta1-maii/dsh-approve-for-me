import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

/** Resolve an output strictly beneath this repository's real `.build` tree. */
export function safeBuildOutput(repositoryRoot, candidate, label) {
  const buildRoot = resolve(repositoryRoot, '.build')
  mkdirSync(buildRoot, { recursive: true })
  const realBuildRoot = realpathSync(buildRoot)
  const output = resolve(candidate)
  if (output === buildRoot || !output.startsWith(`${buildRoot}${sep}`)) {
    throw new Error(`${label} must stay below this repository's .build directory`)
  }

  let existing = output
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error(`${label} has no existing parent`)
    existing = parent
  }
  const canonical = resolve(realpathSync(existing), relative(existing, output))
  if (canonical === realBuildRoot || !canonical.startsWith(`${realBuildRoot}${sep}`)) {
    throw new Error(`${label} escapes this repository's real .build directory`)
  }
  if (existsSync(output)) {
    const realOutput = realpathSync(output)
    if (!realOutput.startsWith(`${realBuildRoot}${sep}`)) {
      throw new Error(`${label} resolves outside this repository's real .build directory`)
    }
  }
  return output
}
