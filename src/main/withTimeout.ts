/**
 * 给 Promise 包超时：超时后 reject。
 * 底层请求无法真正取消，仅释放调用方等待与单飞槽位，
 * 避免平台接口挂起时面板永久 loading、并发查询被卡住。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`请求超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
