import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '@core/logging'
import { FileLogTransport } from '../../src/main/logging/fileTransport'

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'test.file',
    event: 'op.write',
    message: '测试日志',
    process: 'test',
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('主进程文件日志传输', () => {
  it('写入日志生成按天命名的 JSON Lines 文件', () => {
    const transport = new FileLogTransport(dir)
    transport.init()

    transport.write(makeEntry())
    transport.write(makeEntry({ level: 'error', message: '错误日志' }))

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^app-\d{4}-\d{2}-\d{2}\.log$/)

    const content = readFileSync(join(dir, files[0]), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    // 每行是可解析的完整 JSON（结构化必备要素）
    const first = JSON.parse(lines[0]) as LogEntry
    expect(first).toMatchObject({
      level: 'info',
      module: 'test.file',
      event: 'op.write',
      message: '测试日志',
      process: 'test',
    })
    expect(Date.parse(first.timestamp)).not.toBeNaN()
  })

  it('超过大小上限时轮转为 .1/.2/.3', () => {
    const transport = new FileLogTransport(dir, { maxBytes: 500 })
    transport.init()

    const LAST = '最后一条日志标记'
    for (let i = 0; i < 30; i++) {
      transport.write(makeEntry({ message: i === 29 ? LAST : `日志内容 ${'x'.repeat(60)} ${i}` }))
    }

    const files = readdirSync(dir).sort()
    // 当前文件 + 最多 3 个轮转文件（超出上限的旧文件被丢弃）
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.length).toBeLessThanOrEqual(4)
    for (const f of files) {
      expect(f).toMatch(/^app-\d{4}-\d{2}-\d{2}\.log(\.\d+)?$/)
      const content = readFileSync(join(dir, f), 'utf-8')
      expect(content.length).toBeGreaterThan(0)
      // 每行都是合法 JSON
      for (const line of content.trim().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
    // 最新日志保留在当前文件（未带轮转序号）
    const current = files.find((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    expect(current).toBeDefined()
    expect(readFileSync(join(dir, current!), 'utf-8')).toContain(LAST)
    // 轮转发生：存在至少一个 .N 文件
    expect(files.some((f) => /\.log\.\d+$/.test(f))).toBe(true)
  })

  it('启动时清理超过保留天数的旧日志', () => {
    const transport = new FileLogTransport(dir, { keepDays: 1 })
    // 构造一个 3 天前的旧日志文件
    const old = join(dir, 'app-2020-01-01.log')
    writeFileSync(old, '{"old":true}\n', 'utf-8')
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    utimesSync(old, past, past)

    transport.init()
    transport.write(makeEntry())

    const files = readdirSync(dir)
    expect(files).not.toContain('app-2020-01-01.log')
    expect(files.some((f) => f.startsWith('app-'))).toBe(true)
  })
})
