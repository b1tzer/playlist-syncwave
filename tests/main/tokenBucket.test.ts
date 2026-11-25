import { describe, it, expect } from 'vitest'
import { createTokenBucket } from '../../src/main/tokenBucket'

describe('tokenBucket — 令牌桶限流', () => {
  function makeBucket(capacity = 3, refillMs = 10_000) {
    let clock = 1_000_000
    const bucket = createTokenBucket(capacity, refillMs, () => clock)
    return {
      bucket,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  it('容量内连续取令牌全部成功', () => {
    const { bucket } = makeBucket(3)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.available()).toBe(0)
  })

  it('超过容量被拒绝（突发上限）', () => {
    const { bucket } = makeBucket(3)
    bucket.tryTake()
    bucket.tryTake()
    bucket.tryTake()
    expect(bucket.tryTake()).toBe(false)
  })

  it('按速率补充后恢复调用额度', () => {
    const { bucket, advance } = makeBucket(3, 10_000)
    bucket.tryTake()
    bucket.tryTake()
    bucket.tryTake()
    expect(bucket.tryTake()).toBe(false)

    advance(10_000)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })

  it('长时间闲置补充不超过容量上限', () => {
    const { bucket, advance } = makeBucket(3, 10_000)
    bucket.tryTake()
    advance(120_000) // 12 个周期，只补到容量 3
    expect(bucket.available()).toBe(3)
  })

  it('不足一个补充周期不补充', () => {
    const { bucket, advance } = makeBucket(3, 10_000)
    bucket.tryTake()
    bucket.tryTake()
    bucket.tryTake()
    advance(9_999)
    expect(bucket.tryTake()).toBe(false)
    advance(1)
    expect(bucket.tryTake()).toBe(true)
  })

  it('多个补充周期累积补充（零头不丢失）', () => {
    const { bucket, advance } = makeBucket(3, 10_000)
    bucket.tryTake()
    bucket.tryTake()
    bucket.tryTake()
    advance(25_000) // 2 个完整周期
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })
})
