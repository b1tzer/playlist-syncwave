import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLogger,
  HTTP_ERROR_MAX_BODY_BYTES,
  logHttpError,
  setDefaultTransports,
  type LogEntry,
  type LogTransport,
} from '@core/logging'

/** 收集日志的内存传输 */
class MemoryTransport implements LogTransport {
  readonly name = 'memory'
  entries: LogEntry[] = []
  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

function setup(): MemoryTransport {
  const memory = new MemoryTransport()
  setDefaultTransports([memory])
  return memory
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('logHttpError - 请求失败详情记录', () => {
  it('生产模式仅记录 method/url/status/durationMs 精简信息', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.http' })

    logHttpError(log, 'http.call', '请求失败', new Error('boom'), {
      method: 'POST',
      url: '/api/test',
      requestBody: { keyword: '测试', cookie: 'SECRET-COOKIE-VALUE' },
      requestHeaders: { authorization: 'Bearer TOKEN', 'x-qq-session': 'SESS' },
      status: 500,
      responseBody: { code: 500, message: 'server error' },
      durationMs: 123,
    })

    const entry = memory.entries[0]
    expect(entry.level).toBe('error')
    expect(entry.error?.message).toBe('boom')
    expect(entry.context).toEqual({
      method: 'POST',
      url: '/api/test',
      status: 500,
      durationMs: 123,
    })
    expect(entry.context).not.toHaveProperty('requestBody')
    expect(entry.context).not.toHaveProperty('requestHeaders')
    expect(entry.context).not.toHaveProperty('responseBody')
  })

  it('开发模式记录完整出入参，敏感字段脱敏、非敏感字段完整', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const memory = setup()
    const log = createLogger({ module: 'test.http' })

    logHttpError(log, 'http.call', '请求失败', new Error('boom'), {
      method: 'POST',
      url: '/api/test',
      requestBody: { keyword: '周杰伦', cookie: 'MUSIC_A_T=1234567890abcdef' },
      requestHeaders: { authorization: 'Bearer abcdefgh', 'x-qq-session': 'sess-value' },
      status: 500,
      responseBody: { code: 500, message: 'server error' },
      durationMs: 123,
    })

    const context = memory.entries[0].context!
    expect(context.method).toBe('POST')
    expect(context.url).toBe('/api/test')
    expect(context.status).toBe(500)
    expect(context.durationMs).toBe(123)

    // 出入参以脱敏 JSON 字符串落盘：敏感字段掩码、非敏感字段完整
    const requestBody = JSON.parse(context.requestBody as string) as Record<string, unknown>
    expect(requestBody.keyword).toBe('周杰伦')
    expect(requestBody.cookie).toContain('****')

    const requestHeaders = JSON.parse(context.requestHeaders as string) as Record<string, unknown>
    expect(requestHeaders.authorization).toContain('****')
    expect(requestHeaders['x-qq-session']).toContain('****')

    const responseBody = JSON.parse(context.responseBody as string) as Record<string, unknown>
    expect(responseBody.code).toBe(500)
    expect(responseBody.message).toBe('server error')
  })

  it('超长响应体截断到上限，防止 error 日志膨胀', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const memory = setup()
    const log = createLogger({ module: 'test.http' })

    logHttpError(log, 'http.call', '请求失败', new Error('boom'), {
      method: 'GET',
      url: '/api/large',
      responseBody: { songs: 'x'.repeat(HTTP_ERROR_MAX_BODY_BYTES + 100) },
    })

    const responseBody = memory.entries[0].context!.responseBody as string
    expect(responseBody).toContain('(truncated)')
    expect(responseBody.length).toBeLessThanOrEqual(HTTP_ERROR_MAX_BODY_BYTES + 32)
  })

  it('入参为数组时保留数组结构', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const memory = setup()
    const log = createLogger({ module: 'test.http' })

    logHttpError(log, 'http.call', '请求失败', new Error('boom'), {
      method: 'POST',
      url: '/api/list',
      requestBody: ['a', 'b'],
    })

    const requestBody = JSON.parse(memory.entries[0].context!.requestBody as string)
    expect(requestBody).toEqual(['a', 'b'])
  })

  it('不可序列化的出入参静默降级，绝不抛异常', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const memory = setup()
    const log = createLogger({ module: 'test.http' })

    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() =>
      logHttpError(log, 'http.call', '请求失败', new Error('boom'), {
        method: 'GET',
        url: '/api/loop',
        requestBody: circular,
      }),
    ).not.toThrow()

    expect(memory.entries).toHaveLength(1)
    expect(memory.entries[0].level).toBe('error')
  })

  it('非 Error 异常原样传给 logger，由日志层归一记录', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.http' })

    logHttpError(log, 'http.call', '请求失败', '纯字符串错误', {
      method: 'GET',
      url: '/api/fail',
      status: 502,
    })

    expect(memory.entries[0].error).toEqual({ name: 'Error', message: '纯字符串错误' })
  })
})
