import { describe, it, expect, vi } from 'vitest'
import {
  createEncyclopediaService,
  decideDirect,
  normalizeName,
  rankCandidates,
} from '../../src/main/encyclopediaService'
import type { EncyclopediaCandidate } from '@core/models/encyclopedia'
import type { PlatformAdapter } from '../../src/platforms/base'
import type { EncyclopediaStore } from '../../src/main/encyclopediaStore'

const candidate = (overrides: Partial<EncyclopediaCandidate>): EncyclopediaCandidate => ({
  id: 'c1',
  name: '周杰伦',
  ...overrides,
})

const makeStore = (): EncyclopediaStore =>
  ({
    find: vi.fn().mockReturnValue(null),
    save: vi.fn(),
    remove: vi.fn(),
  }) as unknown as EncyclopediaStore

function makeAdapter(encyclopedia: PlatformAdapter['encyclopedia']): PlatformAdapter {
  return { platform: 'netease', encyclopedia } as PlatformAdapter
}

/** 永不补充令牌的时钟：固定 now，便于测限流 */
const fixedNow = () => 1_000_000

describe('rankCandidates — 同名消歧打分', () => {
  it('精确全名得分最高，前缀/子串依次递减', () => {
    const ranked = rankCandidates('周杰伦', [
      candidate({ id: 'a', name: '周杰伦的小弟' }),
      candidate({ id: 'b', name: '周杰伦' }),
      candidate({ id: 'c', name: '陌生人' }),
    ])
    expect(ranked.map((r) => r.candidate.id)).toEqual(['b', 'a', 'c'])
    expect(ranked[0].score).toBeGreaterThanOrEqual(1000)
    expect(ranked[1].score).toBeGreaterThanOrEqual(600)
    expect(ranked[2].score).toBe(0)
  })

  it('别名精确命中弱于名字精确命中，简繁归一后仍匹配', () => {
    const ranked = rankCandidates('Jay Chou', [
      candidate({ id: 'a', name: '周杰倫', aliases: ['Jay Chou'] }),
      candidate({ id: 'b', name: '周杰伦', aliases: [] }),
    ])
    expect(ranked[0].candidate.id).toBe('a')
    expect(normalizeName('週杰倫')).toBe(normalizeName('周杰伦'))
  })

  it('名字精确候选优先于「名字前缀 + 别名精确」的干扰候选', () => {
    const ranked = rankCandidates('周杰伦', [
      candidate({ id: 'a', name: '周杰伦国际后援会', aliases: ['周杰伦'] }),
      candidate({ id: 'b', name: '周杰伦' }),
    ])
    expect(ranked[0].candidate.id).toBe('b')
    // 干扰候选（前缀 + 别名精确）总分低于名字精确档位，不触发直达
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })

  it('热度加成影响同名排序', () => {
    const ranked = rankCandidates('陈奕迅', [
      candidate({ id: 'a', name: '陈奕迅', followerCount: 10 }),
      candidate({ id: 'b', name: '陈奕迅', followerCount: 1_000_000 }),
    ])
    expect(ranked[0].candidate.id).toBe('b')
  })

  it('decideDirect：唯一精确命中直达，多个精确命中回候选', () => {
    const ranked = rankCandidates('周杰伦', [
      candidate({ id: 'a', name: '周杰伦' }),
      candidate({ id: 'b', name: '周杰伦的小弟' }),
    ])
    expect(decideDirect(ranked)).toBe(true)
    const tied = rankCandidates('周杰伦', [
      candidate({ id: 'a', name: '周杰伦' }),
      candidate({ id: 'b', name: '周杰伦' }),
    ])
    expect(decideDirect(tied)).toBe(false)
  })

  it('decideDirect：榜首无 id 的残缺候选不直达', () => {
    const ranked = rankCandidates('周杰伦', [candidate({ id: '', name: '周杰伦' })])
    expect(decideDirect(ranked)).toBe(false)
  })
})

describe('createEncyclopediaService.lookup', () => {
  const baseQuery = { platform: 'netease', kind: 'singer' as const, name: '周杰伦' }

  function setup(overrides: {
    /** 显式传 undefined 表示平台未实现百科原语；缺省提供空实现 */
    encyclopedia?: NonNullable<PlatformAdapter['encyclopedia']> | undefined
    mapping?: { entityId: string; entityName: string } | null
    now?: () => number
  }) {
    const store = makeStore()
    if (overrides.mapping) {
      ;(store.find as ReturnType<typeof vi.fn>).mockReturnValue(overrides.mapping)
    }
    const encyclopedia =
      overrides.encyclopedia === undefined && !('encyclopedia' in overrides)
        ? {
            search: vi.fn().mockResolvedValue([]),
            detail: vi.fn().mockResolvedValue(null),
          }
        : overrides.encyclopedia
    const adapter = makeAdapter(encyclopedia)
    const service = createEncyclopediaService({
      store,
      resolveAdapter: vi.fn().mockResolvedValue(adapter),
      now: overrides.now,
    })
    return { service, store }
  }

  it('平台未实现百科原语 → unsupported', async () => {
    const { service } = setup({ encyclopedia: undefined })
    const result = await service.lookup(baseQuery)
    expect(result).toEqual({ status: 'unsupported' })
  })

  it('登录凭证注入搜索与详情（有登录态传登录 cookie）', async () => {
    const search = vi.fn().mockResolvedValue([{ id: 'c1', name: '周杰伦' }])
    const detail = vi.fn().mockResolvedValue({
      kind: 'singer',
      id: 'c1',
      name: '周杰伦',
      songs: [{ id: 'h1', title: '晴天', artist: '周杰伦' }],
      source: 'kugou',
    })
    const service = createEncyclopediaService({
      store: makeStore(),
      resolveAdapter: vi.fn().mockResolvedValue(makeAdapter({ search, detail })),
      getCredential: () => 'kugou-cookie',
    })
    const result = await service.lookup(baseQuery)
    expect(result.status).toBe('content')
    expect(detail).toHaveBeenCalledWith('singer', 'c1', '周杰伦', 'kugou-cookie')
  })

  it('请求自带 id 直达详情，跳过搜索与映射', async () => {
    const detail = vi.fn().mockResolvedValue({
      kind: 'singer',
      id: '6452',
      name: '周杰伦',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'netease',
    })
    const search = vi.fn()
    const { service, store } = setup({
      encyclopedia: { search, detail },
      mapping: { entityId: 'other', entityName: 'x' },
    })
    const result = await service.lookup({ ...baseQuery, id: '6452' })
    expect(result).toMatchObject({ status: 'content', content: { id: '6452' } })
    // detail 收到实体名（QQ 专辑曲目按名字搜索定位需要）与凭证（匿名平台为 undefined）
    expect(detail).toHaveBeenCalledWith('singer', '6452', '周杰伦', undefined)
    expect(search).not.toHaveBeenCalled()
    expect(store.find).not.toHaveBeenCalled()
  })

  it('纠偏映射命中 → 直达详情；forceSearch 跳过映射走搜索', async () => {
    const detail = vi.fn().mockImplementation(async (_kind: string, id: string) => ({
      kind: 'singer',
      id,
      name: '周杰伦',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'netease',
    }))
    const search = vi.fn().mockResolvedValue([
      { id: 'c1', name: '周杰伦', aliases: [], picUrl: undefined },
    ])
    const { service } = setup({
      encyclopedia: { search, detail },
      mapping: { entityId: 'm1', entityName: '周杰伦' },
    })
    const result = await service.lookup(baseQuery)
    expect(result).toMatchObject({ status: 'content', content: { id: 'm1' } })
    expect(search).not.toHaveBeenCalled()

    const forced = await service.lookup({ ...baseQuery, forceSearch: true })
    expect(forced).toMatchObject({ status: 'content', content: { id: 'c1' } })
    expect(search).toHaveBeenCalledWith('singer', '周杰伦', undefined)
  })

  it('无 id 时搜索消歧：唯一精确命中直达，多个同名返回候选列表', async () => {
    const detail = vi.fn().mockResolvedValue({
      kind: 'singer',
      id: 'c1',
      name: '周杰伦',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'qqmusic',
    })
    const { service } = setup({
      encyclopedia: {
        search: vi.fn().mockResolvedValue([{ id: 'c1', name: '周杰伦' }]),
        detail,
      },
    })
    const direct = await service.lookup({ ...baseQuery, platform: 'qqmusic' })
    expect(direct).toMatchObject({ status: 'content', content: { id: 'c1' } })

    const { service: multi } = setup({
      encyclopedia: {
        search: vi.fn().mockResolvedValue([
          { id: 'c1', name: '周杰伦' },
          { id: 'c2', name: '周杰伦', aliases: ['Jay Chou'] },
        ]),
        detail,
      },
    })
    const result = await multi.lookup(baseQuery)
    expect(result.status).toBe('candidates')
  })

  it('查询全程异常静默降级为空态，不向调用方抛错', async () => {
    const { service } = setup({
      encyclopedia: {
        search: vi.fn().mockRejectedValue(new Error('平台挂了')),
        detail: vi.fn(),
      },
    })
    const result = await service.lookup(baseQuery)
    expect(result).toEqual({ status: 'empty' })
  })

  it('同键查询命中 LRU，不重复请求平台；confirm 后缓存失效并写映射', async () => {
    const detail = vi.fn().mockResolvedValue({
      kind: 'singer',
      id: 'c1',
      name: '周杰伦',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'netease',
    })
    const search = vi.fn().mockResolvedValue([{ id: 'c1', name: '周杰伦' }])
    const { service, store } = setup({ encyclopedia: { search, detail } })
    await service.lookup(baseQuery)
    await service.lookup(baseQuery)
    expect(search).toHaveBeenCalledTimes(1)
    expect(detail).toHaveBeenCalledTimes(1)

    service.confirm({
      platform: 'netease',
      kind: 'singer',
      name: '周杰伦',
      entityId: 'c9',
      entityName: '周杰伦 (Live)',
    })
    expect(store.save).toHaveBeenCalledWith(
      'netease',
      'singer',
      '周杰伦',
      'c9',
      '周杰伦 (Live)',
    )
    // 映射已写：下一次查询走映射直达
    ;(store.find as ReturnType<typeof vi.fn>).mockReturnValue({
      entityId: 'c9',
      entityName: '周杰伦 (Live)',
      createdAt: 'x',
    })
    detail.mockResolvedValue({
      kind: 'singer',
      id: 'c9',
      name: '周杰伦 (Live)',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'netease',
    })
    const result = await service.lookup(baseQuery)
    expect(result).toMatchObject({ status: 'content', content: { id: 'c9' } })
  })

  it('令牌桶耗尽时静默降级为空态', async () => {
    const { service } = setup({
      encyclopedia: {
        search: vi.fn().mockResolvedValue([{ id: 'c1', name: 'x' }]),
        detail: vi.fn(),
      },
      now: fixedNow,
    })
    let last: { status: string } = { status: 'content' }
    // 容量 10：第 11 次同平台查询触发限流
    for (let i = 0; i < 11; i++) {
      last = await service.lookup({ ...baseQuery, name: `周杰伦${i}` })
    }
    expect(last).toEqual({ status: 'empty' })
  })

  it('限流产生的空态不冻结：恢复后同键重试仍会真正请求平台', async () => {
    let t = 1_000_000
    const now = () => t
    const detail = vi.fn().mockResolvedValue({
      kind: 'singer',
      id: 'c1',
      name: '周杰伦',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'netease',
    })
    const search = vi.fn().mockResolvedValue([{ id: 'c1', name: '周杰伦' }])
    const { service } = setup({ encyclopedia: { search, detail }, now })
    // 先用 10 个不同键耗尽令牌桶
    for (let i = 0; i < 10; i++) {
      await service.lookup({ ...baseQuery, name: `周杰伦${i}` })
    }
    // 第 11 个键被限流：空态（不进缓存）
    const throttled = await service.lookup(baseQuery)
    expect(throttled).toEqual({ status: 'empty' })
    // 时钟前进补满令牌：同键重试必须真正请求平台并直达内容
    t += 10 * 500
    const recovered = await service.lookup(baseQuery)
    expect(recovered).toMatchObject({ status: 'content', content: { id: 'c1' } })
    expect(detail).toHaveBeenCalled()
  })

  it('异常空态不缓存：平台恢复后同键重试成功', async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error('平台挂了'))
      .mockResolvedValue([{ id: 'c1', name: '周杰伦' }])
    const detail = vi.fn().mockResolvedValue({
      kind: 'singer',
      id: 'c1',
      name: '周杰伦',
      songs: [{ id: '186016', title: '晴天', artist: '周杰伦' }],
      source: 'netease',
    })
    const { service } = setup({ encyclopedia: { search, detail } })
    expect(await service.lookup(baseQuery)).toEqual({ status: 'empty' })
    expect(await service.lookup(baseQuery)).toMatchObject({ status: 'content' })
    expect(search).toHaveBeenCalledTimes(2)
  })
})
