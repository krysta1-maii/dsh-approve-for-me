export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

/** Parse JSON while rejecting duplicate object keys before materialization. */
export function parseUniqueJson(input: string): JsonValue {
  let index = 0
  const whitespace = () => { while (/\s/.test(input[index] ?? '')) index += 1 }
  const fail = (): never => { throw new SyntaxError('invalid JSON') }
  const string = (): string => {
    if (input[index] !== '"') return fail()
    const start = index++
    while (index < input.length) {
      const character = input[index++]!
      if (character === '"') {
        const token = input.slice(start, index)
        try {
          const parsed: unknown = JSON.parse(token)
          return typeof parsed === 'string' ? parsed : fail()
        } catch { return fail() }
      }
      if (character === '\\') index += 1
      else if (character.codePointAt(0)! < 0x20) return fail()
    }
    return fail()
  }
  const value = (): JsonValue => {
    whitespace()
    const character = input[index]
    if (character === '"') return string()
    if (character === '{') {
      index += 1
      const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
      const keys = new Set<string>()
      whitespace()
      if (input[index] === '}') { index += 1; return output }
      while (true) {
        whitespace()
        const key = string()
        if (keys.has(key)) return fail()
        keys.add(key)
        whitespace()
        if (input[index++] !== ':') return fail()
        output[key] = value()
        whitespace()
        if (input[index] === '}') { index += 1; return output }
        if (input[index++] !== ',') return fail()
      }
    }
    if (character === '[') {
      index += 1
      const output: JsonValue[] = []
      whitespace()
      if (input[index] === ']') { index += 1; return output }
      while (true) {
        output.push(value())
        whitespace()
        if (input[index] === ']') { index += 1; return output }
        if (input[index++] !== ',') return fail()
      }
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (input.startsWith(token, index)) { index += token.length; return parsed }
    }
    const token = input.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0]
    if (token === undefined) return fail()
    index += token.length
    const parsed = Number(token)
    if (!Number.isFinite(parsed) || Object.is(parsed, -0)) return fail()
    return parsed
  }
  const parsed = value()
  whitespace()
  if (index !== input.length) return fail()
  return parsed
}

/** Error raised when a value would not survive a lossless JSON snapshot. */
export class JsonSnapshotError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'JsonSnapshotError'
  }
}

function cloneJson(input: unknown, path: string, ancestors: WeakSet<object>): JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      throw new JsonSnapshotError(`${path} must be a finite JSON number that is not -0`)
    }
    return input
  }
  if (typeof input !== 'object') {
    throw new JsonSnapshotError(`${path} is not lossless JSON`)
  }
  if (ancestors.has(input)) throw new JsonSnapshotError(`${path} contains a cycle`)
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      const output: JsonValue[] = []
      for (let index = 0; index < input.length; index += 1) {
        if (!Object.hasOwn(input, index)) throw new JsonSnapshotError(`${path}[${index}] is a sparse array hole`)
        output.push(cloneJson(input[index], `${path}[${index}]`, ancestors))
      }
      return output
    }
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonSnapshotError(`${path} must be a plain object`)
    }
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(input)) {
      output[key] = cloneJson((input as Record<string, unknown>)[key], `${path}.${key}`, ancestors)
    }
    return output
  } finally {
    ancestors.delete(input)
  }
}

/** Clone an unknown value across the project's strict lossless-JSON boundary. */
export function snapshotJson(input: unknown): JsonValue {
  return cloneJson(input, '$', new WeakSet())
}

/** Recursively freeze a JSON value. */
export function freezeJson<T extends JsonValue>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      for (const item of value) freezeJson(item)
    } else {
      for (const item of Object.values(value)) freezeJson(item)
    }
    Object.freeze(value)
  }
  return value
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
  return `{${entries.join(',')}}`
}

/** Serialize a value with recursively sorted object keys. */
export function canonicalJson(input: unknown): string {
  return canonicalize(snapshotJson(input))
}
