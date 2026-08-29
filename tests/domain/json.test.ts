import { describe, expect, it } from 'vitest'
import { parseUniqueJson } from '../../src/domain/json.js'

describe('parseUniqueJson', () => {
  it('accepts only JSON whitespace and rejects duplicate keys', () => {
    expect(parseUniqueJson(' \t\n\r{"value":[true,null,1]}')).toEqual({ value: [true, null, 1] })
    expect(() => parseUniqueJson('{"value":1,"value":1}')).toThrow(SyntaxError)
    expect(() => parseUniqueJson('\u000b{"value":1}')).toThrow(SyntaxError)
  })
})
