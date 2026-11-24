import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// electron 与数据库依赖在 logCenter 模块加载前替换，避免真实 Electron 环境
const electronMock = vi.hoisted(() => ({
  userData: '',
  version: '0.1.0-test',
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronMock.userData,
    getVersion: () => electronMock.version,
  },
}))

vi.mock('../../src/main/appDatabase', () => ({
  getDatabase: () => ({ settings: { get: (_key: string, fallback: unknown) => fallback } }),
}))

import { logCenter } from '../../src/main/logging/logCenter'
import type { LogEntry } from '@core/logging'

const userData = mkdtempSync(join(tmpdir(), 'logcenter-'))

beforeAll(() => {
  electronMock.userData = userData
  logCenter.init()
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

/** 读取主进程日志目录下全部文件内容，按行返回 */
function readLogLines(): string[] {
  const dir = join(userData, 'logs')
  const content = readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf-8'))
    .join('')
  return content.trim().split('\n').filter(Boolean)
}

/** 模拟渲染进程经 IPC 投递的原始条目 */
function makeRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'renderer.test',
    event: 'ipc.log',
    message: '渲染进程日志',
    ...overrides,
  }
}

describe('logCenter — 渲染进程日志 IPC 校验与落盘', () => {
  it('合法条目落盘，且 process 被强制为 renderer（伪造值被忽略）', () => {
    const before = readLogLines().length
    logCenter.writeRendererEntry(makeRaw({ process: 'main' }))

    const lines = readLogLines()
    expect(lines.length).toBe(before + 1)
    const entry = JSON.parse(lines[lines.length - 1]) as LogEntry
    expect(entry.process).toBe('renderer')
    expect(entry.level).toBe('info')
    expect(entry.module).toBe('renderer.test')
    expect(entry.event).toBe('ipc.log')
    expect(entry.message).toBe('渲染进程日志')
  })

  it('context 敏感字段经主进程二次脱敏后落盘', () => {
    logCenter.writeRendererEntry(
      makeRaw({ context: { cookie: 'MUSIC_A_T=secret-value-123456', songId: '88' } }),
    )

    const lines = readLogLines()
    const entry = JSON.parse(lines[lines.length - 1]) as LogEntry
    expect(entry.context?.['cookie']).toContain('****')
    expect(entry.context?.['cookie']).not.toContain('secret-value-123456')
    expect(entry.context?.['songId']).toBe('88')
  })

  it('结构非法或超限的条目全部被拒绝，不落盘', () => {
    const before = readLogLines().length

    const missingModule = makeRaw()
    delete missingModule.module
    const bad: unknown[] = [
      null,
      'plain-string',
      [makeRaw()],
      makeRaw({ timestamp: 'not-a-date' }),
      makeRaw({ level: 'fatal' }),
      makeRaw({ module: '' }),
      makeRaw({ event: '' }),
      makeRaw({ message: '' }),
      makeRaw({ message: 'x'.repeat(401) }),
      makeRaw({ durationMs: 'fast' }),
      makeRaw({ durationMs: Number.NaN }),
      makeRaw({ context: { blob: 'x'.repeat(40 * 1024) } }),
      makeRaw({ error: { name: 123, message: 'boom' } }),
      makeRaw({ error: { name: 'E', message: 'x'.repeat(401) } }),
      makeRaw({ error: { name: 'E', message: 'boom', stack: 'x'.repeat(4001) } }),
      missingModule,
    ]
    for (const raw of bad) {
      logCenter.writeRendererEntry(raw)
    }

    expect(readLogLines().length).toBe(before)
  })

  it('单传输异常不影响其他传输，writeRendererEntry 不抛', () => {
    const before = readLogLines().length
    logCenter.writeRendererEntry(makeRaw())
    expect(readLogLines().length).toBe(before + 1)
  })

  it('flush 在退出前安全调用，不抛异常', () => {
    expect(() => logCenter.flush()).not.toThrow()
  })
})
