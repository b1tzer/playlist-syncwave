// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SyncTaskRecord, SyncTaskStatus } from '@core/models/sync'
import TaskCenter from '../../src/renderer/src/components/TaskCenter'
import { ToastHost } from '../../src/renderer/src/components/toast'
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

// TaskCenter 声明在 ToastHost 之后：挂载 effects 按声明顺序执行，先订阅后推送
const renderWithI18n = (tasks: SyncTaskRecord[]) =>
  render(
    <I18nProvider>
      <ToastHost />
      <TaskCenter tasks={tasks} />
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

describe('TaskCenter — 同步任务经通知栈展示', () => {
  it('运行中任务以持久通知卡展示：任务名与进度百分比', () => {
    const view = renderWithI18n([makeTask('t1', 'running', { progress: 0.42 })])
    expect(view.getByText('任务-t1')).toBeTruthy()
    expect(view.getByText(/42%/)).toBeTruthy()
    expect(view.queryByText(/同步完成/)).toBeNull()
  })

  it('运行中任务卡带停止按钮，点击调 stopSync', () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    fireEvent.click(view.getByRole('button', { name: '停止任务' }))
    expect(window.electronAPI.platforms.stopSync).toHaveBeenCalledWith('t1')
  })

  it('任务由运行中转失败：运行卡消失，弹失败通知与失败原因', async () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    view.rerender(
      <I18nProvider>
        <ToastHost />
        <TaskCenter tasks={[makeTask('t1', 'failed')]} />
      </I18nProvider>,
    )
    // 运行卡按退出动画关闭（250ms 后移除）
    await waitFor(() => expect(view.queryByText(/50%/)).toBeNull())
    expect(view.getByText('任务-t1')).toBeTruthy()
    expect(view.getByText('目标平台服务不可用')).toBeTruthy()
  })

  it('任务由运行转成功：弹「同步完成」通知，无失败原因', async () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    view.rerender(
      <I18nProvider>
        <ToastHost />
        <TaskCenter tasks={[makeTask('t1', 'done')]} />
      </I18nProvider>,
    )
    // 运行卡退出动画完成后仅剩结果通知
    await waitFor(() => expect(view.queryByText(/50%/)).toBeNull())
    expect(view.getByText('任务-t1')).toBeTruthy()
    expect(view.getByText('同步完成')).toBeTruthy()
    expect(view.queryByText('目标平台服务不可用')).toBeNull()
  })

  it('应用启动恢复的历史任务不弹结果通知（回归：历史恢复时结果轰炸）', () => {
    const view = renderWithI18n([makeTask('t-done', 'done'), makeTask('t-fail', 'failed')])
    expect(view.queryByText('任务-t-done')).toBeNull()
    expect(view.queryByText('任务-t-fail')).toBeNull()
  })

  it('通知卡可手动关闭', async () => {
    const view = renderWithI18n([makeTask('t1', 'running')])
    expect(view.getByText('任务-t1')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'close' }))
    await waitFor(() => expect(view.queryByText('任务-t1')).toBeNull())
  })
})
