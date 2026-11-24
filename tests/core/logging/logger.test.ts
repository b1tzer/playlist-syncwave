import { describe, expect, it } from 'vitest'
import {
  createLogger,
  setDefaultTransports,
  setLogLocale,
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
  reset(): void {
    this.entries = []
  }
}

function setup(): MemoryTransport {
  const memory = new MemoryTransport()
  setDefaultTransports([memory])
  return memory
}

describe('日志核心 - 必备要素', () => {
  it('每条日志包含时间戳/级别/模块/事件/消息/进程标识', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.module' })

    log.info('op.run', '操作完成', { count: 3 })

    const entry = memory.entries[0]
    expect(entry).toBeDefined()
    expect(entry.level).toBe('info')
    expect(entry.module).toBe('test.module')
    expect(entry.event).toBe('op.run')
    expect(entry.message).toBe('操作完成')
    expect(entry.context).toEqual({ count: 3 })
    expect(entry.process).toBe('test')
    // ISO 8601 毫秒级时间戳，可被 Date 解析
    expect(Date.parse(entry.timestamp)).not.toBeNaN()
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('按级别过滤：低于阈值的日志被丢弃', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.level', level: 'warn' })

    log.debug('op.debug', '不应出现')
    log.info('op.info', '不应出现')
    log.warn('op.warn', '应该出现')
    log.error('op.error', '应该出现', new Error('boom'))

    expect(memory.entries.map((e) => e.level)).toEqual(['warn', 'error'])
  })

  it('错误日志携带 name/message/stack', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.error' })

    log.error('op.fail', '操作失败', new TypeError('类型错误'))

    const entry = memory.entries[0]
    expect(entry.error).toEqual({
      name: 'TypeError',
      message: '类型错误',
      stack: expect.any(String),
    })
  })

  it('非 Error 异常也能被记录', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.error' })

    log.error('op.fail', '操作失败', '纯字符串错误')

    expect(memory.entries[0].error).toEqual({ name: 'Error', message: '纯字符串错误' })
  })

  it('time 包裹记录开始/完成与耗时 durationMs', async () => {
    const memory = setup()
    const log = createLogger({ module: 'test.time', level: 'debug' })

    const result = await log.time('op.async', async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 42
    })

    expect(result).toBe(42)
    expect(memory.entries).toHaveLength(2)
    const start = memory.entries[0]
    expect(start.level).toBe('debug')
    expect(start.message).toBe('开始')
    const done = memory.entries[1]
    expect(done.level).toBe('info')
    expect(done.event).toBe('op.async')
    expect(done.message).toBe('完成')
    expect(typeof done.durationMs).toBe('number')
    expect(done.durationMs!).toBeGreaterThanOrEqual(0)
  })

  it('time 包裹的操作失败时记录 error 并重新抛出', async () => {
    const memory = setup()
    const log = createLogger({ module: 'test.time', level: 'debug' })

    await expect(
      log.time('op.async-fail', async () => {
        throw new Error('任务失败')
      }),
    ).rejects.toThrow('任务失败')

    const entry = memory.entries[1]
    expect(entry.level).toBe('error')
    expect(entry.message).toBe('失败')
    expect(entry.error?.message).toBe('任务失败')
    expect(typeof entry.durationMs).toBe('number')
  })

  it('child 派生 logger 合并固定上下文', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.child' }).child({ platform: 'netease' })

    log.info('op.with-context', '带上下文')

    expect(memory.entries[0].context).toEqual({ platform: 'netease' })
  })
})

describe('日志核心 - 脱敏', () => {
  it('敏感字段（cookie/token/session 等）被掩码', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.redact' })

    log.info('op.with-secret', '含敏感字段', {
      cookie: 'MUSIC_A_T=1234567890abcdef',
      token: 'abc',
      Authorization: 'Bearer xyz',
      session: 'sess-12345678901234567890',
      songId: '12345',
      count: 10,
    })

    const context = memory.entries[0].context!
    expect(context['cookie']).not.toBe('MUSIC_A_T=1234567890abcdef')
    expect(context['cookie']).toContain('****')
    expect(context['token']).toBe('***')
    expect(context['Authorization']).toContain('****')
    expect(context['session']).toContain('****')
    // 非敏感字段保持原样
    expect(context['songId']).toBe('12345')
    expect(context['count']).toBe(10)
  })

  it('嵌套对象中的敏感字段同样被掩码', () => {
    const memory = setup()
    const log = createLogger({ module: 'test.redact' })

    log.info('op.nested', '嵌套对象', {
      auth: { cookie: 'MUSIC_A_T=nested-secret-value', userId: 'u1' },
    })

    const auth = memory.entries[0].context!['auth'] as Record<string, unknown>
    expect(auth['cookie']).toContain('****')
    expect(auth['userId']).toBe('u1')
  })
})

describe('日志核心 - 国际化', () => {
  it('英文语言下按目录翻译日志消息，缺失消息回退中文', () => {
    const memory = setup()
    setLogLocale('en-US')
    const log = createLogger({ module: 'test.i18n' })

    log.info('app.startup', '应用启动')
    log.info('custom.event', '自定义消息无翻译')

    expect(memory.entries[0].message).toBe('App started')
    expect(memory.entries[1].message).toBe('自定义消息无翻译')
    setLogLocale('zh-CN')
  })

  it('中文语言下消息原样输出', () => {
    const memory = setup()
    setLogLocale('zh-CN')
    const log = createLogger({ module: 'test.i18n' })

    log.info('app.startup', '应用启动')

    expect(memory.entries[0].message).toBe('应用启动')
  })
})
