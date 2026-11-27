// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { EncyclopediaLookupResult } from '@core/models/encyclopedia'
import EncyclopediaPopover, {
  type EncyclopediaTarget,
} from '../../src/renderer/src/components/EncyclopediaPopover'
import { I18nProvider } from '../../src/renderer/src/i18n'

const encyclopediaTarget = (overrides: Partial<Extract<EncyclopediaTarget, { type: 'encyclopedia' }>> = {}): EncyclopediaTarget => ({
  type: 'encyclopedia',
  platform: 'netease',
  platformName: '网易云音乐',
  kind: 'singer',
  name: '周杰伦',
  ...overrides,
})

const songTarget = (
  overrides: Partial<Extract<EncyclopediaTarget, { type: 'song' }>> = {},
): EncyclopediaTarget => ({
  type: 'song',
  song: {
    id: '186016',
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    durationMs: 269_000,
    coverUrl: 'https://p.example/cover.jpg',
  },
  platform: 'netease',
  platformName: '网易云音乐',
  encyclopedia: true,
  ...overrides,
})

const lookup = vi.fn<() => Promise<EncyclopediaLookupResult>>()
const confirm = vi.fn<() => Promise<void>>()
const songDetailLookup = vi.fn<() => Promise<import('@core/models/songDetail').SongDetailData | null>>()
const openExternal = vi.fn<() => Promise<void>>()

beforeEach(() => {
  cleanup()
  lookup.mockReset()
  confirm.mockReset()
  songDetailLookup.mockReset().mockResolvedValue(null)
  openExternal.mockReset().mockResolvedValue(undefined)
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    initialSettings: { language: 'zh-CN' },
    platform: 'darwin',
    encyclopedia: { lookup, confirm },
    songDetail: { lookup: songDetailLookup },
    openExternal,
  }
})

function renderPopover(target: EncyclopediaTarget) {
  return render(
    <I18nProvider>
      <EncyclopediaPopover target={target} x={20} y={20} onClose={() => undefined} />
    </I18nProvider>,
  )
}

describe('EncyclopediaPopover — 百科信息面板', () => {
  it('歌曲详情卡：本地渲染标题/歌手/专辑/时长，不发起 IPC 查询', () => {
    const view = renderPopover(songTarget())
    expect(view.getByText('歌曲详情')).toBeTruthy()
    expect(view.getByText('晴天')).toBeTruthy()
    expect(view.getByText('周杰伦', { exact: false })).toBeTruthy()
    expect(view.getByText('叶惠美', { exact: false })).toBeTruthy()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('歌手面板：展示歌手歌曲清单与来源平台', async () => {
    lookup.mockResolvedValue({
      status: 'content',
      content: {
        kind: 'singer',
        id: '6452',
        name: '周杰伦',
        songs: [
          { id: '186016', title: '晴天', artist: '周杰伦', durationMs: 269000 },
          { id: '167827', title: '青花瓷', artist: '周杰伦', durationMs: 239000 },
        ],
        imageUrl: 'https://p.example/jay.jpg',
        source: 'netease',
        sourceUrl: 'https://music.163.com/#/artist?id=6452',
      },
    })
    const view = renderPopover(encyclopediaTarget())
    expect(await view.findByText('晴天')).toBeTruthy()
    expect(view.getByText('青花瓷')).toBeTruthy()
    expect(view.getByText('共 2 首')).toBeTruthy()
    expect(view.getByText('网易云音乐')).toBeTruthy()
    expect(lookup).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'netease', kind: 'singer', name: '周杰伦' }),
    )
  })

  it('专辑面板：展示发行时间与曲目清单', async () => {
    lookup.mockResolvedValue({
      status: 'content',
      content: {
        kind: 'album',
        id: '18905',
        name: '叶惠美',
        releaseDate: '2003-07-30',
        songs: [
          { id: '186016', title: '晴天', artist: '周杰伦', durationMs: 269000 },
          { id: '186024', title: '以父之名', artist: '周杰伦', durationMs: 342000 },
        ],
        source: 'netease',
        sourceUrl: 'https://music.163.com/#/album?id=18905',
      },
    })
    const view = renderPopover(encyclopediaTarget({ kind: 'album', name: '叶惠美' }))
    expect(await view.findByText('叶惠美')).toBeTruthy()
    expect(view.getByText(/发行时间/)).toBeTruthy()
    expect(view.getByText('以父之名')).toBeTruthy()
  })

  it('候选态：同名候选列表点选后写入纠偏并直达歌曲清单', async () => {
    lookup.mockResolvedValueOnce({
      status: 'candidates',
      candidates: [
        { id: 'c1', name: '周杰伦', aliases: ['Jay Chou'], picUrl: undefined },
        { id: 'c2', name: '周杰伦', aliases: ['其他'], picUrl: undefined },
      ],
    })
    lookup.mockResolvedValueOnce({
      status: 'content',
      content: {
        kind: 'singer',
        id: 'c1',
        name: '周杰伦',
        songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
        source: 'netease',
      },
    })
    const view = renderPopover(encyclopediaTarget())
    const hint = await view.findByText(/找到多个同名歌手/)
    expect(hint).toBeTruthy()
    fireEvent.click(view.getByText('Jay Chou', { exact: false }).closest('button')!)
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith({
        platform: 'netease',
        kind: 'singer',
        name: '周杰伦',
        entityId: 'c1',
        entityName: '周杰伦',
      })
    })
    expect(await view.findByText('晴天')).toBeTruthy()
  })

  it('平台不支持：展示 unsupported 空态', async () => {
    lookup.mockResolvedValue({ status: 'unsupported' })
    const view = renderPopover(encyclopediaTarget({ platform: 'kugou' }))
    expect(await view.findByText('该平台暂不支持')).toBeTruthy()
  })

  it('查询失败：展示错误态并可重试', async () => {
    lookup.mockRejectedValueOnce(new Error('操作失败，请稍后重试'))
    lookup.mockResolvedValueOnce({
      status: 'content',
      content: {
        kind: 'singer',
        id: '1',
        name: '周杰伦',
        songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
        source: 'netease',
      },
    })
    const view = renderPopover(encyclopediaTarget())
    expect(await view.findByText('加载失败')).toBeTruthy()
    fireEvent.click(view.getByText('重试'))
    expect(await view.findByText('晴天')).toBeTruthy()
  })

  it('歌曲详情卡：异步补出发行时间与「在平台打开」跳转', async () => {
    songDetailLookup.mockResolvedValue({
      lyrics: '[00:12.00]故事的小黄花\n[00:15.00]从出生那年就飘着',
      releaseDate: '2003-07-16',
      webUrl: 'https://music.163.com/#/song?id=186016',
    })
    const view = renderPopover(songTarget())
    expect(await view.findByText('2003-07-16')).toBeTruthy()
    fireEvent.click(view.getByText('在平台打开'))
    expect(openExternal).toHaveBeenCalledWith('https://music.163.com/#/song?id=186016')
    expect(songDetailLookup).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'netease', songId: '186016' }),
    )
  })

  it('歌曲详情卡：本地歌单按平台歌曲 id 查询，不用歌单内序号', async () => {
    const target = songTarget()
    if (target.type !== 'song') throw new Error('unexpected target')
    renderPopover({
      ...target,
      song: { ...target.song, id: '2', sourceSongId: '186016' },
    })
    await waitFor(() =>
      expect(songDetailLookup).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'netease', songId: '186016' }),
      ),
    )
  })

  it('歌曲详情卡：歌词剥离时间戳展示，超长可展开收起', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `[00:${String(i).padStart(2, '0')}.00]第${i + 1}句歌词`).join('\n')
    songDetailLookup.mockResolvedValue({ lyrics: lines })
    const view = renderPopover(songTarget())
    expect(await view.findByText('第1句歌词')).toBeTruthy()
    // 预览 6 行：第 7 句折叠中不可见
    expect(view.queryByText('第7句歌词')).toBeNull()
    fireEvent.click(view.getByLabelText('展开全部歌词'))
    expect(view.getByText('第7句歌词')).toBeTruthy()
    fireEvent.click(view.getByLabelText('收起歌词'))
    expect(view.queryByText('第7句歌词')).toBeNull()
  })

  it('点击展开按钮不会触发面板关闭', async () => {
    const onClose = vi.fn()
    const lines = Array.from({ length: 10 }, (_, i) => `第${i + 1}句歌词`).join('\n')
    songDetailLookup.mockResolvedValue({ lyrics: lines })
    const view = render(
      <I18nProvider>
        <EncyclopediaPopover target={songTarget()} x={20} y={20} onClose={onClose} />
      </I18nProvider>,
    )
    expect(await view.findByText('第1句歌词')).toBeTruthy()
    fireEvent.mouseDown(view.getByLabelText('展开全部歌词'))
    fireEvent.click(view.getByLabelText('展开全部歌词'))
    expect(onClose).not.toHaveBeenCalled()
    expect(view.getByText('第7句歌词')).toBeTruthy()
  })

  it('面板内歌词区滚动不关闭面板，面板外滚动才关闭', async () => {
    const onClose = vi.fn()
    const lines = Array.from({ length: 30 }, (_, i) => `第${i + 1}句歌词`).join('\n')
    songDetailLookup.mockResolvedValue({ lyrics: lines })
    const view = render(
      <I18nProvider>
        <EncyclopediaPopover target={songTarget()} x={20} y={20} onClose={onClose} />
      </I18nProvider>,
    )
    expect(await view.findByText('第1句歌词')).toBeTruthy()
    fireEvent.click(view.getByLabelText('展开全部歌词'))
    // 歌词容器内部滚动：capture 阶段窗口也会收到，但不该关闭面板
    const lyricsBox = view.getByText('第7句歌词').parentElement!
    fireEvent.scroll(lyricsBox)
    expect(onClose).not.toHaveBeenCalled()
    // 面板外滚动：关闭
    fireEvent.scroll(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('内容态「不对？换一个」（头部图标按钮）强制重新搜索候选', async () => {
    lookup.mockResolvedValueOnce({
      status: 'content',
      content: {
        kind: 'singer',
        id: '6452',
        name: '周杰伦',
        songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
        source: 'netease',
      },
    })
    lookup.mockResolvedValueOnce({
      status: 'candidates',
      candidates: [{ id: 'c9', name: '周杰伦 (另一个)', picUrl: undefined }],
    })
    const view = renderPopover(encyclopediaTarget())
    expect(await view.findByText('晴天')).toBeTruthy()
    fireEvent.click(view.getByLabelText('不对？换一个'))
    expect(await view.findByText('周杰伦 (另一个)')).toBeTruthy()
    expect(lookup).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceSearch: true }),
    )
  })

  it('面板曲目带歌曲页链接时整行可点击，跳到平台打开', async () => {
    lookup.mockResolvedValue({
      status: 'content',
      content: {
        kind: 'singer',
        id: '6452',
        name: '周杰伦',
        songs: [
          {
            id: '186016',
            title: '晴天',
            artist: '周杰伦',
            durationMs: 269000,
            webUrl: 'https://music.163.com/#/song?id=186016',
          },
        ],
        source: 'netease',
      },
    })
    const view = renderPopover(encyclopediaTarget())
    const row = await view.findByLabelText('晴天 · 周杰伦')
    fireEvent.click(row)
    expect(openExternal).toHaveBeenCalledWith('https://music.163.com/#/song?id=186016')
  })

  it('面板曲目无歌曲页链接时不可点击、不触发跳转', async () => {
    lookup.mockResolvedValue({
      status: 'content',
      content: {
        kind: 'singer',
        id: '6452',
        name: '周杰伦',
        songs: [{ id: '186016', title: '晴天', artist: '周杰伦', durationMs: 269000 }],
        source: 'netease',
      },
    })
    const view = renderPopover(encyclopediaTarget())
    const row = await view.findByText('晴天')
    fireEvent.click(row)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('歌曲详情卡：点击歌手名经 onNavigate 面板内切换为百科查询', async () => {
    const onNavigate = vi.fn()
    const view = render(
      <I18nProvider>
        <EncyclopediaPopover
          target={songTarget()}
          x={20}
          y={20}
          onClose={() => undefined}
          onNavigate={onNavigate}
        />
      </I18nProvider>,
    )
    const artistLink = view.getByRole('button', { name: '周杰伦' })
    fireEvent.click(artistLink)
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'encyclopedia',
        kind: 'singer',
        name: '周杰伦',
      }),
    )
    expect(lookup).not.toHaveBeenCalled()
  })

  it('歌曲详情卡：点击专辑名经 onNavigate 面板内切换为专辑曲目', async () => {
    const onNavigate = vi.fn()
    const view = render(
      <I18nProvider>
        <EncyclopediaPopover
          target={songTarget()}
          x={20}
          y={20}
          onClose={() => undefined}
          onNavigate={onNavigate}
        />
      </I18nProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: '叶惠美' }))
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'encyclopedia',
        kind: 'album',
        name: '叶惠美',
      }),
    )
  })

  it('来源平台不支持百科时，详情卡内歌手/专辑为纯文本不可点', () => {
    const view = renderPopover(songTarget({ encyclopedia: false }))
    expect(view.getByText('周杰伦', { exact: false })).toBeTruthy()
    expect(view.getByText('叶惠美', { exact: false })).toBeTruthy()
    expect(view.queryByRole('button', { name: '周杰伦' })).toBeNull()
    expect(view.queryByRole('button', { name: '叶惠美' })).toBeNull()
  })

  it('面板打开聚焦容器、关闭归还触发元素焦点', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const view = render(
      <I18nProvider>
        <EncyclopediaPopover target={songTarget()} x={20} y={20} onClose={() => undefined} />
      </I18nProvider>,
    )
    expect(document.activeElement).not.toBe(trigger)
    view.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
