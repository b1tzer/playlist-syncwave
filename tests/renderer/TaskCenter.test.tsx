// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import TaskCenter from '../../src/renderer/src/components/TaskCenter'
import { I18nProvider } from '../../src/renderer/src/i18n'

const makeTask = (
  id: string,
  status: SyncTaskStatus,
  overrides: Partial<SyncTaskRecord> = {},
): SyncTaskRecord => ({
  id,
  name: `任务-${id}`,
  targetPlatform: 'netease',
  source: 'local-playlist',
  status,
  total: 10,
  added: 5,
  failed: 2,
  createdAt: '2026/11/27 10:00:00',
  createdAtMs: 0,
  progress: status === 'running' ? 0.5 : 1,
  failedDetail: status === 'failed' ? ['目标平台服务不可用'] : [],
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

const renderWithI18n = (tasks: SyncTaskRecord[]) =>
  render(
    <I18nProvider>
      <TaskCenter tasks={tasks} platforms={platforms} />
    </I18nProvider>,
  )

beforeEach(() => {
  cleanup()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    initialSettings: { language: 'zh-CN' },
    platform: 'darwin',
    platforms: { stopSync: vi.fn() },
  }
})

describe('TaskCenter — 右上角任务中心组件', () => {
  it('运行中任务显示任务名与进度百分比', () => {
    const view = renderWithI18n([makeTask('t1', 'running', { progress: 0.42 })])
    const running = view.getByTestId('task-center-running')
    expect(running.textContent).toContain('任务-t1')
    expect(running.textContent).toContain('42%')
    expect(view.queryByTestId('task-center-finished')).toBeNull()
  })

  it('任务由运行中转失败：显示失败卡片与失败原因', () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    view.rerender(
      <I18nProvider>
        <TaskCenter tasks={[makeTask('t1', 'failed')]} platforms={platforms} />
      </I18nProvider>,
    )
    expect(view.queryByTestId('task-center-running')).toBeNull()
    const finished = view.getByTestId('task-center-finished')
    expect(finished.getAttribute('data-status')).toBe('failed')
    expect(finished.textContent).toContain('任务-t1')
    expect(finished.textContent).toContain('目标平台服务不可用')
  })

  it('任务由运行转成功：显示成功卡片，无失败原因', () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    view.rerender(
      <I18nProvider>
        <TaskCenter tasks={[makeTask('t1', 'done')]} platforms={platforms} />
      </I18nProvider>,
    )
    const finished = view.getByTestId('task-center-finished')
    expect(finished.getAttribute('data-status')).toBe('done')
    expect(finished.textContent).toContain('同步完成')
  })

  it('应用启动恢复的历史任务不弹出结果卡片（回归：历史恢复时结果轰炸）', () => {
    const view = renderWithI18n([makeTask('t-done', 'done'), makeTask('t-fail', 'failed')])
    expect(view.queryByTestId('task-center-finished')).toBeNull()
    expect(view.queryByTestId('task-center-running')).toBeNull()
  })

  it('失败卡片可手动关闭', () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    view.rerender(
      <I18nProvider>
        <TaskCenter tasks={[makeTask('t1', 'failed')]} platforms={platforms} />
      </I18nProvider>,
    )
    expect(view.getByTestId('task-center-finished')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '关闭' }))
    expect(view.queryByTestId('task-center-finished')).toBeNull()
  })
})
