// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { PlatformSong } from '@core/models/platform'
import SongList from '../../src/renderer/src/components/SongList'
import { I18nProvider } from '../../src/renderer/src/i18n'

const songs: PlatformSong[] = [
  { id: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', durationMs: 269_000 },
  { id: '2', title: '青花瓷', artist: '周杰伦', album: '我很忙', durationMs: 239_000 },
]

beforeEach(() => {
  cleanup()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    initialSettings: { language: 'zh-CN' },
    platform: 'darwin',
    encyclopedia: { lookup: vi.fn(), confirm: vi.fn() },
    songDetail: { lookup: vi.fn().mockResolvedValue(null) },
    openExternal: vi.fn().mockResolvedValue(undefined),
  }
})

function renderList(overrides: { selectable?: boolean; encyclopediaSupported?: boolean } = {}) {
  return render(
    <I18nProvider>
      <SongList
        songs={songs}
        showIndex
        showHeader
        selectable={overrides.selectable ?? true}
        encyclopediaPlatform="netease"
        encyclopediaSupported={overrides.encyclopediaSupported ?? true}
        platformName="网易云音乐"
      />
    </I18nProvider>,
  )
}

describe('SongList — 百科面板与行选择交互', () => {
  it('点击歌名打开详情卡面板', () => {
    const view = renderList()
    fireEvent.click(view.getByText('晴天'))
    expect(view.getByText('歌曲详情')).toBeTruthy()
  })

  it('面板打开时点击其他行：只关闭面板，不选中该行', () => {
    const view = renderList()
    fireEvent.click(view.getByText('晴天'))
    expect(view.getByText('歌曲详情')).toBeTruthy()

    // 点击另一行（mousedown 先触发面板关闭，click 不应选中该行）
    const row = view.getByText('青花瓷').closest('li')!
    fireEvent.mouseDown(row, { button: 0 })
    fireEvent.click(row)

    expect(view.queryByText('歌曲详情')).toBeNull()
    // 未出现批量选择工具条（未选中任何行）
    expect(view.queryByText(/已选/)).toBeNull()
  })

  it('面板未打开时点击行正常切换选中', () => {
    const view = renderList()
    const row = view.getByText('青花瓷').closest('li')!
    fireEvent.mouseDown(row, { button: 0 })
    fireEvent.click(row)
    expect(view.getByText(/已选 1 首/)).toBeTruthy()
  })

  it('平台不支持百科时歌手/专辑为纯文本，歌名详情卡仍可点', () => {
    const view = renderList({ encyclopediaSupported: false })
    // 歌手/专辑没有可点链接（无 role=button 的歌手/专辑文本）
    expect(view.queryByRole('button', { name: '周杰伦' })).toBeNull()
    expect(view.queryByRole('button', { name: '叶惠美' })).toBeNull()
    // 歌名仍可点开详情卡（本地信息始终可用）
    fireEvent.click(view.getByText('晴天'))
    expect(view.getByText('歌曲详情')).toBeTruthy()
  })
})
