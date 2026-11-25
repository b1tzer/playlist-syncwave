/**
 * 令牌桶限流：允许短时间内连续调用（突发），同时以固定速率补充令牌，
 * 控制一段时间内的整体调用量。
 */
export interface TokenBucket {
  /** 尝试取一个令牌；桶空返回 false（被限流） */
  tryTake(): boolean
  /** 当前可用令牌数（调试/测试用） */
  available(): number
}

export function createTokenBucket(
  capacity: number,
  refillIntervalMs: number,
  now: () => number = Date.now,
): TokenBucket {
  let tokens = capacity
  let lastRefill = now()

  function refill(): void {
    const t = now()
    const elapsed = t - lastRefill
    if (elapsed < refillIntervalMs) return
    // 按流逝的完整周期补充，余数零头累积到下一轮
    const gained = Math.floor(elapsed / refillIntervalMs)
    tokens = Math.min(capacity, tokens + gained)
    lastRefill = t - (elapsed % refillIntervalMs)
  }

  return {
    tryTake(): boolean {
      refill()
      if (tokens < 1) return false
      tokens -= 1
      return true
    },
    available(): number {
      refill()
      return tokens
    },
  }
}
