// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SyncTaskRecord } from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import SyncHistory from '../../src/renderer/src/components/SyncHistory'
import { I18nProvider } from '../../src/renderer/src/i18n'

const q = (title: string): MatchQuery => ({ title, artist: '某人' })

const baseTask = (overrides: Partial<SyncTaskRecord>): SyncTaskRecord => ({
  id: 'task-1',
  name: '我的歌单',
  targetPlatform: 'netease',
  source: 'text-import',
  status: 'done',
  total: 15,
  added: 15,
  failed: 0,
  createdAt: '2026/11/27 10:00:00',
  createdAtMs: 1_764_207_600_000,
  progress: 1,
  failedDetail: [],
  detail: [],
  rawInput: [],
  ...overrides,
})

const platforms = [
  {
    id: 'netease',
    name: '网易云音乐',
    icon: 'cloud',
    capabilities: { read: true, write: true },
  },
]

const renderSyncHistory = (tasks: SyncTaskRecord[]) =>
  render(
    <I18nProvider>
      <SyncHistory
        platforms={platforms}
        tasks={tasks}
        onNewTask={() => {}}
        onTaskRemove={() => {}}
        onClearAll={() => {}}
        pendingChoicesCount={0}
        onGoConfirm={() => {}}
        intervenableIds={[]}
        onStopTask={() => {}}
        onRetryTask={() => {}}
      />
    </I18nProvider>,
  )

beforeEach(() => {
  cleanup()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    initialSettings: { language: 'zh-CN' },
    platform: 'darwin',
  }
})

describe('SyncHistory — 行摘要与来源展示', () => {
  it('失败任务显示失败原因，不再显示与明细矛盾的「成功 N」计数', () => {
    // 回归场景：历史坏数据 failed=15 标量 + detail 15 首 matched
    const task = baseTask({
      status: 'failed',
      added: 0,
      failed: 15,
      failedDetail: ['目标平台服务不可用'],
      detail: Array.from({ length: 15 }, (_, i) => ({
        index: i,
        query: q(`歌${i}`),
        status: 'matched' as const,
      })),
    })
    const view = renderSyncHistory([task])
    const row = view.container.querySelector('[data-testid]') ?? view.container
    expect(row.textContent).toContain('目标平台服务不可用')
    // 失败状态不再渲染「成功: 15」这类误导计数
    expect(row.textContent).not.toMatch(/成功:\s*15/)
  })

  it('失败任务（明细已收敛为全失败）行摘要显示失败原因', () => {
    const task = baseTask({
      status: 'failed',
      added: 0,
      failed: 15,
      failedDetail: ['写入超时'],
      detail: Array.from({ length: 15 }, (_, i) => ({
        index: i,
        query: q(`歌${i}`),
        status: 'failed' as const,
        reason: 'add-failed' as const,
        message: '写入超时',
      })),
    })
    const view = renderSyncHistory([task])
    expect(view.container.textContent).toContain('写入超时')
    expect(view.container.textContent).not.toMatch(/成功:\s*15/)
  })

  it('已完成任务：失败计数以明细为权威口径（标量 failed 与明细脱节的历史数据自动纠正）', () => {
    const task = baseTask({
      status: 'done',
      added: 10, // 标量 failed=0 与明细脱节：明细里 5 首失败
      failed: 0,
      detail: [
        ...Array.from({ length: 10 }, (_, i) => ({
          index: i,
          query: q(`成${i}`),
          status: 'matched' as const,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          index: i + 10,
          query: q(`败${i}`),
          status: 'failed' as const,
          reason: 'no-match' as const,
          message: '未找到',
        })),
      ],
    })
    const view = renderSyncHistory([task])
    // 成功数以写入数为准；失败数按明细派生（展开「失败 5 首」与行摘要一致）
    expect(view.container.textContent).toMatch(/成功:\s*10/)
    expect(view.container.textContent).toMatch(/失败:\s*5/)
  })

  it('来源 local-playlist 显示「本地」，不再原样显示 local-playlist', () => {
    const task = baseTask({ source: 'local-playlist' })
    const view = renderSyncHistory([task])
    expect(view.container.textContent).toContain('本地')
    expect(view.container.textContent).not.toContain('local-playlist')
  })

  it('来源 text-import 显示「文本导入」', () => {
    const view = renderSyncHistory([baseTask({ source: 'text-import' })])
    expect(view.container.textContent).toContain('文本导入')
  })
})
