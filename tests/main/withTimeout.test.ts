import { describe, it, expect, vi } from 'vitest'
import { withTimeout } from '../../src/main/withTimeout'

describe('withTimeout — 平台请求超时保护', () => {
  it('成功路径透传结果', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42)
  })

  it('失败路径透传原始错误', async () => {
    const err = new Error('平台挂了')
    await expect(withTimeout(Promise.reject(err), 1000)).rejects.toBe(err)
  })

  it('超过时限 reject，挂起请求不再无限等待', async () => {
    vi.useFakeTimers()
    const pending = new Promise<never>(() => {})
    const timed = withTimeout(pending, 1000)
    const assertion = expect(timed).rejects.toThrow('请求超时')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    vi.useRealTimers()
  })
})
