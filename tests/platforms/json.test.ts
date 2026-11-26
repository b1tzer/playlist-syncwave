import { describe, it, expect } from 'vitest'
import { toHttps } from '../../src/platforms/json'

describe('json 工具 — toHttps', () => {
  it('http 前缀升级为 https', () => {
    expect(toHttps('http://p1.music.126.net/a.jpg')).toBe('https://p1.music.126.net/a.jpg')
  })

  it('https 保持不变', () => {
    expect(toHttps('https://y.gtimg.cn/x.jpg')).toBe('https://y.gtimg.cn/x.jpg')
  })

  it('undefined 与空串原样返回', () => {
    expect(toHttps(undefined)).toBeUndefined()
    expect(toHttps('')).toBe('')
  })
})
