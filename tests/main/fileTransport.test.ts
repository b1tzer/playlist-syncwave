import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

  it('轮转时 .2→.3、.1→.2、当前→.1 级联，最旧的 .3 被丢弃', () => {
    const transport = new FileLogTransport(dir, { maxBytes: 100 })
    transport.init()
    transport.write(makeEntry({ message: 'seed' })) // 建立当前文件

    const dateFile = readdirSync(dir)[0]
    const currentPath = join(dir, dateFile)
    // 预置：当前文件超过上限，且 .1/.2/.3 各有标记内容
    const oversized = 'CURRENT-CONTENT-'.repeat(10) // 160 字节 > 100
    writeFileSync(currentPath, oversized, 'utf-8')
    writeFileSync(`${currentPath}.1`, 'ONE\n', 'utf-8')
    writeFileSync(`${currentPath}.2`, 'TWO\n', 'utf-8')
    writeFileSync(`${currentPath}.3`, 'THREE\n', 'utf-8')

    transport.write(makeEntry({ message: 'new-after-rotate' }))

    // 级联顺序：旧当前文件 → .1，原 .1 → .2，原 .2 → .3；原 .3 被删除
    expect(readFileSync(`${currentPath}.1`, 'utf-8')).toBe(oversized)
    expect(readFileSync(`${currentPath}.2`, 'utf-8')).toBe('ONE\n')
    expect(readFileSync(`${currentPath}.3`, 'utf-8')).toBe('TWO\n')
    // 新日志写入全新的当前文件
    const fresh = readFileSync(currentPath, 'utf-8')
    expect(fresh).toContain('new-after-rotate')
    expect(fresh).not.toContain('CURRENT-CONTENT-')
  })

  it('清理仅删除过期文件，保留期内与命名不符的文件不受影响', () => {
    const makeOld = (name: string, ageDays: number): void => {
      const p = join(dir, name)
      writeFileSync(p, '{"x":1}\n', 'utf-8')
      const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
      utimesSync(p, past, past)
    }
    makeOld('app-2026-11-20.log', 30) // 过期 → 删除
    makeOld('app-2026-11-21.log', 3) // 保留期内（默认 7 天）→ 保留
    makeOld('other.log', 30) // 命名不符 → 保留
    makeOld('app-2026-11-22.log.txt', 30) // 命名不符 → 保留
    makeOld('app.log', 30) // 命名不符 → 保留

    const transport = new FileLogTransport(dir)
    transport.init()
    transport.write(makeEntry())

    const files = readdirSync(dir)
    expect(files).not.toContain('app-2026-11-20.log')
    expect(files).toContain('app-2026-11-21.log')
    expect(files).toContain('other.log')
    expect(files).toContain('app-2026-11-22.log.txt')
    expect(files).toContain('app.log')
  })

  it('自定义前缀生效，清理只作用于该前缀的文件', () => {
    const transport = new FileLogTransport(dir, { prefix: 'sync' })
    transport.init()
    transport.write(makeEntry())

    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const otherPrefix = join(dir, 'app-2020-01-01.log')
    writeFileSync(otherPrefix, '{"x":1}\n', 'utf-8')
    utimesSync(otherPrefix, past, past)
    const staleSamePrefix = join(dir, 'sync-2020-01-01.log')
    writeFileSync(staleSamePrefix, '{"x":1}\n', 'utf-8')
    utimesSync(staleSamePrefix, past, past)

    // 再次 init 触发清理
    new FileLogTransport(dir, { prefix: 'sync' }).init()

    const files = readdirSync(dir)
    expect(files.some((f) => /^sync-\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true)
    expect(files).not.toContain('sync-2020-01-01.log')
    expect(files).toContain('app-2020-01-01.log')
  })

  it('levels 过滤：error 文件只写 error，app 文件排除 error', () => {
    const errorTransport = new FileLogTransport(dir, { prefix: 'error', levels: ['error'] })
    const appTransport = new FileLogTransport(dir, { levels: ['debug', 'info', 'warn'] })
    errorTransport.init()
    appTransport.init()

    errorTransport.write(makeEntry({ level: 'info', message: '不应落入 error 文件' }))
    errorTransport.write(makeEntry({ level: 'error', message: '错误日志' }))
    appTransport.write(makeEntry({ level: 'info', message: 'info 日志' }))
    appTransport.write(makeEntry({ level: 'warn', message: 'warn 日志' }))
    appTransport.write(makeEntry({ level: 'error', message: '不应落入 app 文件' }))

    const files = readdirSync(dir)
    const errorFile = files.find((f) => /^error-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    const appFile = files.find((f) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    expect(errorFile).toBeDefined()
    expect(appFile).toBeDefined()

    const errorLines = readFileSync(join(dir, errorFile!), 'utf-8').trim().split('\n')
    expect(errorLines).toHaveLength(1)
    expect(errorLines[0]).toContain('错误日志')
    expect(errorLines[0]).not.toContain('不应落入 error 文件')

    const appLines = readFileSync(join(dir, appFile!), 'utf-8').trim().split('\n')
    expect(appLines).toHaveLength(2)
    const appContent = appLines.join('\n')
    expect(appContent).toContain('info 日志')
    expect(appContent).toContain('warn 日志')
    expect(appContent).not.toContain('不应落入 app 文件')
  })

  it('目标文件不可写时写入静默，不抛异常', () => {
    const transport = new FileLogTransport(dir)
    transport.init()
    transport.write(makeEntry({ message: 'seed' }))

    const path = join(dir, readdirSync(dir)[0])
    rmSync(path)
    mkdirSync(path) // 同名目录使 appendFileSync 失败

    expect(() => transport.write(makeEntry({ message: 'should-not-throw' }))).not.toThrow()
  })
})
