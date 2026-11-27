import { describe, it, expect, vi } from 'vitest'
import { createSongDetailService } from '../../src/main/songDetailService'
import type { PlatformAdapter } from '../../src/platforms/base'
import type { SongDetailRequest } from '@core/models/songDetail'

const baseRequest: SongDetailRequest = {
  platform: 'netease',
  songId: '186016',
  identifiers: { albumId: '18915' },
}

function makeAdapter(
  songDetail: PlatformAdapter['songDetail'] | undefined,
): PlatformAdapter {
  return { platform: 'netease', songDetail } as PlatformAdapter
}

describe('createSongDetailService.lookup', () => {
  it('返回歌词/发行时间/跳转链接', async () => {
    const detail = vi.fn().mockResolvedValue({
      lyrics: '[00:00.00]晴天',
      releaseDate: '2003-07-16',
      webUrl: 'https://music.163.com/#/song?id=186016',
    })
    const service = createSongDetailService({
      resolveAdapter: vi.fn().mockResolvedValue(makeAdapter({ detail })),
    })
    const result = await service.lookup(baseRequest)
    expect(result).toMatchObject({ releaseDate: '2003-07-16', lyrics: expect.stringContaining('晴天') })
    expect(detail).toHaveBeenCalledWith(
      '186016',
      { albumId: '18915' },
      { title: undefined, artist: undefined },
    )
  })

  it('把歌名/歌手透传给适配器（QQ 次级标识缺失时搜索兜底定位）', async () => {
    const detail = vi.fn().mockResolvedValue({ lyrics: 'x' })
    const service = createSongDetailService({
      resolveAdapter: vi.fn().mockResolvedValue(makeAdapter({ detail })),
    })
    await service.lookup({ ...baseRequest, title: '晴天', artist: '周杰伦' })
    expect(detail).toHaveBeenCalledWith(
      '186016',
      { albumId: '18915' },
      { title: '晴天', artist: '周杰伦' },
    )
  })

  it('平台未实现歌曲详情原语 → null（渲染层保持本地信息）', async () => {
    const service = createSongDetailService({
      resolveAdapter: vi.fn().mockResolvedValue(makeAdapter(undefined)),
    })
    expect(await service.lookup(baseRequest)).toBeNull()
  })

  it('接口异常静默返回 null，不向调用方抛错', async () => {
    const service = createSongDetailService({
      resolveAdapter: vi
        .fn()
        .mockResolvedValue(makeAdapter({ detail: vi.fn().mockRejectedValue(new Error('挂了')) })),
    })
    expect(await service.lookup(baseRequest)).toBeNull()
  })

  it('同键查询命中 LRU，不重复请求平台', async () => {
    const detail = vi.fn().mockResolvedValue({ lyrics: '晴天' })
    const service = createSongDetailService({
      resolveAdapter: vi.fn().mockResolvedValue(makeAdapter({ detail })),
    })
    await service.lookup(baseRequest)
    await service.lookup(baseRequest)
    expect(detail).toHaveBeenCalledTimes(1)
  })

  it('不同 songMid 视为不同键（同一首歌不同平台版本不串缓存）', async () => {
    const detail = vi.fn().mockResolvedValue({ lyrics: 'x' })
    const service = createSongDetailService({
      resolveAdapter: vi.fn().mockResolvedValue(makeAdapter({ detail })),
    })
    await service.lookup({ ...baseRequest, platform: 'qqmusic', identifiers: { songMid: 'A1' } })
    await service.lookup({ ...baseRequest, platform: 'qqmusic', identifiers: { songMid: 'B2' } })
    expect(detail).toHaveBeenCalledTimes(2)
  })

  it('令牌桶耗尽时静默返回 null', async () => {
    const service = createSongDetailService({
      resolveAdapter: vi
        .fn()
        .mockResolvedValue(makeAdapter({ detail: vi.fn().mockResolvedValue({}) })),
      now: () => 1_000_000,
    })
    let last: unknown = {}
    for (let i = 0; i < 11; i++) {
      last = await service.lookup({ ...baseRequest, songId: String(i) })
    }
    expect(last).toBeNull()
  })
})
