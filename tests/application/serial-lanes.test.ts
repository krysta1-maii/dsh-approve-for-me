import { describe, expect, it } from 'vitest'
import { SerialLanes } from '../../src/index.js'

describe('SerialLanes', () => {
  it('serializes per key and allows different keys to progress independently', async () => {
    const lanes = new SerialLanes()
    const order: string[] = []
    const first = lanes.run('a', async () => {
      order.push('a-start')
      await Promise.resolve()
      order.push('a-end')
    })
    const second = lanes.run('a', async () => {
      order.push('b-start')
      await Promise.resolve()
      order.push('b-end')
    })
    const parallel = lanes.run('z', async () => {
      order.push('z-start')
      await Promise.resolve()
      order.push('z-end')
    })
    await Promise.all([first, second, parallel])
    expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'))
    expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'))
  })

  it('drain waits for all currently queued lane tasks', async () => {
    const lanes = new SerialLanes()
    const settled: string[] = []
    const first = lanes.run('a', async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      settled.push('a')
    })
    const second = lanes.run('b', async () => {
      await Promise.resolve()
      settled.push('b')
    })
    await lanes.drain()
    await Promise.all([first, second])
    expect(settled.sort()).toEqual(['a', 'b'])
  })
})
