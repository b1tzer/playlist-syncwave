import { describe, it, expect, vi } from 'vitest'
import { executeSync, planSync, resumeSync, syncPlaylist } from '@core/sync/syncPlaylist'
import {
  SearchError,
  SyncAbortedError,
  type SyncOptions,
  type SyncTarget,
} from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'

const song = (id: string, title: string, artist: string, genre?: string): PlatformSong => ({
  id,
  title,
  artist,
  genre,
})

function makeTarget(
  index: Record<string, PlatformSong[]>,
  options: { createError?: boolean; addError?: boolean } = {},
): SyncTarget {
  return {
    searchSongs: vi.fn(async (keyword: string) => index[keyword] ?? []),
    createPlaylist: vi.fn(async (name: string) => {
      if (options.createError) throw new Error('建单失败')
      return `pl-${name}`
    }),
    addSongs: vi.fn(async () => {
      if (options.addError) throw new Error('添加失败')
    }),
  }
}

/** 测试专用：关闭限速，避免拖慢用例 */
const run = (
  queries: MatchQuery[],
  name: string,
  target: SyncTarget,
  options: SyncOptions = {},
) => syncPlaylist(queries, name, target, { searchIntervalMs: 0, ...options })

describe('syncPlaylist — 单向同步引擎（T4）', () => {
  it('全部匹配成功：创建歌单并添加歌曲，报告正确', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '稻香', artist: '周杰伦' }],
      '我的歌单',
      target,
    )
    expect(report).toMatchObject({ playlistName: '我的歌单', total: 2, matched: 2, added: 2 })
    expect(report.playlistId).toBe('pl-我的歌单')
    expect(report.failed).toHaveLength(0)
    expect(target.createPlaylist).toHaveBeenCalledWith('我的歌单')
    expect(target.addSongs).toHaveBeenCalledWith('pl-我的歌单', ['1', '2'])
  })

  it('搜索无结果 → no-match 失败项', async () => {
    const target = makeTarget({ 晴天: [song('1', '晴天', '周杰伦')] })
    const report = await run([{ title: '不存在的歌', artist: '某人' }], 'x', target)
    expect(report.matched).toBe(0)
    expect(report.added).toBe(0)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('no-match')
  })

  it('搜索抛异常 → search-failed 失败项，不中断整体', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
    })
    target.searchSongs = vi.fn(async (keyword: string) => {
      if (keyword === '坏歌') throw new Error('网络错误')
      return [{ id: '1', title: '晴天', artist: '周杰伦' }]
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '坏歌' }],
      'x',
      target,
    )
    expect(report.added).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('search-failed')
  })

  it('低置信度候选（<threshold）→ no-match，不添加', async () => {
    const target = makeTarget({
      晴天: [song('1', '完全不搭边', '另一个人')],
    })
    const report = await run([{ title: '晴天', artist: '周杰伦' }], 'x', target)
    expect(report.added).toBe(0)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('no-match')
  })

  it('批量添加：按 batchSize 分批调用', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 5; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    const report = await run(
      [1, 2, 3, 4, 5].map((i) => ({ title: `歌${i}`, artist: '某人' })),
      'x',
      target,
      { batchSize: 2 },
    )
    expect(report.added).toBe(5)
    const calls = (target.addSongs as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls[0][1]).toEqual(['1', '2'])
    expect(calls[2][1]).toEqual(['5'])
  })

  it('添加失败（单批）→ 该批全部计入失败，其他批不受影响', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 3; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    let callCount = 0
    target.addSongs = vi.fn(async () => {
      callCount++
      if (callCount === 2) throw new Error('添加失败')
    })
    const report = await run(
      [1, 2, 3].map((i) => ({ title: `歌${i}`, artist: '某人' })),
      'x',
      target,
      { batchSize: 1 },
    )
    expect(report.added).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].message).toContain('添加失败')
  })

  it('添加失败回写：明细改写为 failed 时实时广播 onStep（主进程检查点与最终报告一致）', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 2; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index, { addError: true })
    const steps: Array<{ index: number; status: string; reason?: string }> = []
    const report = await run(
      [1, 2].map((i) => ({ title: `歌${i}`, artist: '某人' })),
      'x',
      target,
      {
        batchSize: 1,
        onStep: (item) =>
          steps.push({ index: item.index, status: item.status, reason: item.reason }),
      },
    )
    // matching 阶段先广播 matched，写入失败后必须再广播一次改写为 failed
    expect(report.failed).toHaveLength(2)
    const failedSteps = steps.filter((s) => s.status === 'failed' && s.reason === 'add-failed')
    expect(failedSteps).toHaveLength(2)
    expect(report.items.every((i) => i.status === 'failed')).toBe(true)
  })

  it('进度回调：matching 与 adding 两个阶段，最终到达 1', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const ratios: Array<[number, string]> = []
    await run([{ title: '晴天' }, { title: '稻香' }], 'x', target, {
      onProgress: (ratio, stage) => ratios.push([ratio, stage]),
    })
    const stages = new Set(ratios.map(([, s]) => s))
    expect(stages).toContain('matching')
    expect(stages).toContain('adding')
    expect(ratios[ratios.length - 1][0]).toBe(1)
  })

  it('建单失败 → 抛出异常，不吞掉', async () => {
    const target = makeTarget(
      { 晴天: [song('1', '晴天', '周杰伦')] },
      { createError: true },
    )
    await expect(run([{ title: '晴天' }], 'x', target)).rejects.toThrow('建单失败')
  })

  it('空输入 → 不建单，报告全零', async () => {
    const target = makeTarget({})
    const report = await run([], 'x', target)
    expect(report.total).toBe(0)
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('全部未匹配 → 不创建空歌单，失败明细保留', async () => {
    const target = makeTarget({})
    const report = await run(
      [{ title: 'A' }, { title: 'B' }],
      'x',
      target,
    )
    expect(target.createPlaylist).not.toHaveBeenCalled()
    expect(report.playlistId).toBe('')
    expect(report.failed).toHaveLength(2)
  })

  it('风控错误（405 操作频繁）→ 分类为 rate-limited', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async () => {
      // rateLimited 标记由平台适配器判定（模拟网易云 405 风控）
      throw new SearchError('操作频繁，请稍候再试', true, true)
    })
    const report = await run([{ title: '晴天' }], 'x', target, { searchRetries: 0 })
    expect(report.failed[0].reason).toBe('rate-limited')
    expect(report.failed[0].message).toContain('操作频繁')
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('可重试错误 → 重试后成功', async () => {
    const target = makeTarget({})
    let calls = 0
    target.searchSongs = vi.fn(async () => {
      calls++
      if (calls === 1) throw new SearchError('网络抖动', true)
      return [song('1', '晴天', '周杰伦')]
    })
    const report = await run([{ title: '晴天' }], 'x', target, { searchRetries: 2 })
    expect(calls).toBe(2)
    expect(report.added).toBe(1)
  })

  it('不可重试错误 → 不重试', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async () => {
      throw new SearchError('参数错误', false)
    })
    await run([{ title: '晴天' }], 'x', target, { searchRetries: 2 })
    expect(target.searchSongs).toHaveBeenCalledTimes(1)
  })

  it('搜索限速：相邻两次搜索间隔不小于 searchIntervalMs', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const stamps: number[] = []
    target.searchSongs = vi.fn(async () => {
      stamps.push(Date.now())
      return [song('1', '晴天', '周杰伦')]
    })
    await syncPlaylist([{ title: '晴天' }, { title: '稻香' }], 'x', target, {
      searchIntervalMs: 120,
    })
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(110)
  })
})

describe('syncPlaylist — 金标准两阶段（T6.4）', () => {
  it('完全匹配（标题+歌手精确）→ 自动选择并建单，无需确认', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦'), song('2', '晴天', '翻唱者')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }],
      'x',
      target,
    )
    expect(report.status).toBe('done')
    expect(report.choices).toHaveLength(0)
    expect(report.added).toBe(1)
    expect(target.addSongs).toHaveBeenCalledWith('pl-x', ['1'])
  })

  it('同歌不同作者（标题精确、歌手不匹配）→ choice-needed，不建单', async () => {
    const target = makeTarget({
      勇气: [song('1', '勇气', '棉子'), song('2', '勇气', '金志文')],
    })
    const report = await run([{ title: '勇气', artist: '梁静茹' }], 'x', target)
    expect(report.status).toBe('choice-needed')
    expect(report.playlistId).toBe('')
    expect(report.choices).toHaveLength(1)
    expect(report.choices[0].candidates.map((c) => c.id)).toEqual(['1', '2'])
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('query 无歌手且唯一标题精确 → 自动选择', async () => {
    const target = makeTarget({ 稻香: [song('1', '稻香', '周杰伦')] })
    const report = await run([{ title: '稻香' }], 'x', target)
    expect(report.status).toBe('done')
    expect(report.added).toBe(1)
  })

  it('query 无歌手且多个标题精确不同歌手 → choice-needed', async () => {
    const target = makeTarget({
      勇气: [song('1', '勇气', '棉子'), song('2', '勇气', '金志文')],
    })
    const report = await run([{ title: '勇气' }], 'x', target)
    expect(report.status).toBe('choice-needed')
    expect(report.choices[0].candidates).toHaveLength(2)
  })

  it('混合：确定的匹配暂不建单，等用户确认选择后一并写入', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '勇气', artist: '梁静茹' }],
      'x',
      target,
    )
    expect(report.status).toBe('choice-needed')
    expect(report.matched).toBe(1)
    expect(target.createPlaylist).not.toHaveBeenCalled()
  })

  it('executeSync：确认选择后建单，matched 与选定项一并添加', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const queries = [
      { title: '晴天', artist: '周杰伦' },
      { title: '勇气', artist: '梁静茹' },
    ]
    const plan = await planSync(queries, target, { searchIntervalMs: 0 })
    expect(plan.matched).toHaveLength(1)
    expect(plan.choices).toHaveLength(1)
    const final = await executeSync(plan, [{ choiceIndex: 0, songId: '3' }], 'x', target, {
      searchIntervalMs: 0,
    })
    expect(final.status).toBe('done')
    expect(final.added).toBe(2)
    expect(target.addSongs).toHaveBeenCalledWith('pl-x', ['1', '3'])
  })

  it('executeSync：写入顺序与文本清单一致（matched 与 choice 交错）', async () => {
    const target = makeTarget({
      稻香: [song('1', '稻香', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
      晴天: [song('4', '晴天', '周杰伦')],
    })
    // 文本顺序：稻香（自动）→ 勇气（手动选）→ 晴天（自动）
    const plan = await planSync(
      [
        { title: '稻香', artist: '周杰伦' },
        { title: '勇气', artist: '梁静茹' },
        { title: '晴天', artist: '周杰伦' },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(2)
    expect(plan.choices).toHaveLength(1)
    const final = await executeSync(plan, [{ choiceIndex: 0, songId: '3' }], 'x', target, {
      searchIntervalMs: 0,
    })
    expect(final.status).toBe('done')
    expect(final.added).toBe(3)
    // 必须按文本顺序写入，而不是「全部自动匹配在前、手动选择在后」
    expect(target.addSongs).toHaveBeenCalledTimes(1)
    expect(target.addSongs).toHaveBeenCalledWith('pl-x', ['1', '3', '4'])
  })

  it('executeSync：超过批量大小时分批写入，跨批次仍保持文本顺序', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async (keyword: string) => {
      const m = keyword.match(/s(\d+)/)
      const n = m ? Number(m[1]) : 0
      return [song(String(n), keyword, '某人')]
    })
    const queries = Array.from({ length: 5 }, (_, i) => ({ title: `s${i + 1}`, artist: '某人' }))
    const plan = await planSync(queries, target, { searchIntervalMs: 0 })
    const final = await executeSync(plan, [], 'x', target, { searchIntervalMs: 0, batchSize: 2 })
    expect(final.status).toBe('done')
    expect(final.added).toBe(5)
    expect(target.addSongs).toHaveBeenCalledTimes(3)
    expect(target.addSongs).toHaveBeenNthCalledWith(1, 'pl-x', ['1', '2'])
    expect(target.addSongs).toHaveBeenNthCalledWith(2, 'pl-x', ['3', '4'])
    expect(target.addSongs).toHaveBeenNthCalledWith(3, 'pl-x', ['5'])
  })

  it('executeSync：未选择的 choice 计为 unresolved 失败', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const plan = await planSync(
      [{ title: '晴天', artist: '周杰伦' }, { title: '勇气', artist: '梁静茹' }],
      target,
      { searchIntervalMs: 0 },
    )
    const final = await executeSync(plan, [], 'x', target, { searchIntervalMs: 0 })
    expect(final.status).toBe('done')
    expect(final.added).toBe(1)
    expect(final.failed).toHaveLength(1)
    expect(final.failed[0].reason).toBe('unresolved')
  })

  it('executeSync：显式跳过的 choice 计为 skipped 失败，明细同步标记', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const plan = await planSync(
      [{ title: '晴天', artist: '周杰伦' }, { title: '勇气', artist: '梁静茹' }],
      target,
      { searchIntervalMs: 0 },
    )
    const final = await executeSync(
      plan,
      [{ choiceIndex: 0, songId: '', skipped: true }],
      'x',
      target,
      { searchIntervalMs: 0 },
    )
    expect(final.status).toBe('done')
    expect(final.added).toBe(1)
    expect(final.failed).toHaveLength(1)
    expect(final.failed[0].reason).toBe('skipped')
    expect(final.failed[0].message).toContain('勇气')
    const choiceItem = final.items.find((it) => it.query.title === '勇气')
    expect(choiceItem).toMatchObject({ status: 'skipped', reason: 'skipped' })
    // 跳过的歌曲不写入歌单
    expect(target.addSongs).toHaveBeenCalledWith('pl-x', ['1'])
  })
})

describe('planSync — 备选候选搜索验证（T6.4 闭环）', () => {
  it('主候选无匹配、备选精确匹配 → 自动采用备选', async () => {
    const target = makeTarget({
      'Black Country, New Road': [],
      'Basketball Shoes': [song('1', 'Basketball Shoes', 'Black Country, New Road')],
    })
    const plan = await planSync(
      [
        {
          title: 'Black Country, New Road',
          artist: 'Basketball Shoes',
          alternatives: [{ title: 'Basketball Shoes', artist: 'Black Country, New Road' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].songId).toBe('1')
    expect(plan.choices).toHaveLength(0)
    expect(plan.failed).toHaveLength(0)
  })

  it('备选精确匹配（歌手命中）→ 自动选择，不产生 choice', async () => {
    const target = makeTarget({
      'Cory Wong': [],
      Golden: [song('2', 'Golden', 'Harry Styles'), song('3', 'Golden', 'Cory Wong')],
    })
    const plan = await planSync(
      [
        {
          title: 'Cory Wong',
          artist: 'Golden',
          alternatives: [{ title: 'Golden', artist: 'Cory Wong' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].songId).toBe('3')
    expect(plan.choices).toHaveLength(0)
  })

  it('备选多版本且歌手均不匹配 → choice-needed 供用户手动选择', async () => {
    const target = makeTarget({
      'Cory Wong': [],
      Golden: [song('2', 'Golden', 'Harry Styles'), song('3', 'Golden', 'Jill Scott')],
    })
    const plan = await planSync(
      [
        {
          title: 'Cory Wong',
          artist: 'Golden',
          alternatives: [{ title: 'Golden', artist: 'Cory Wong' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.choices).toHaveLength(1)
    expect(plan.choices[0].query).toMatchObject({ title: 'Golden', artist: 'Cory Wong' })
    expect(plan.choices[0].candidates.map((c) => c.id)).toEqual(['2', '3'])
  })

  it('组合关键词与纯歌名并行搜索：组合精确命中时采用组合结果', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async (keyword: string) => {
      if (keyword === 'Hidden Place Björk') return [song('1', 'Hidden Place', 'Björk')]
      if (keyword === 'Hidden Place') return [song('9', 'Hidden Place', '其他人')]
      throw new Error(`不应搜索：${keyword}`)
    })
    const plan = await planSync(
      [
        {
          title: 'Hidden Place',
          artist: 'Björk',
          alternatives: [{ title: 'Björk', artist: 'Hidden Place' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].songId).toBe('1')
    // 并行预取：组合与纯歌名各发一次；组合命中后不再尝试备选候选
    expect(target.searchSongs).toHaveBeenCalledTimes(2)
    expect(target.searchSongs).toHaveBeenNthCalledWith(1, 'Hidden Place Björk', 10)
    expect(target.searchSongs).toHaveBeenNthCalledWith(2, 'Hidden Place', 10)
  })

  it('组合关键词无命中 → 降级纯歌名搜索并命中，不触发备选候选', async () => {
    const target = makeTarget({
      'Hidden Place': [song('1', 'Hidden Place', 'Björk')],
    })
    target.searchSongs = vi.fn(async (keyword: string) => {
      if (keyword === 'Hidden Place Björk') return []
      if (keyword === 'Hidden Place') return [song('1', 'Hidden Place', 'Björk')]
      throw new Error(`不应搜索：${keyword}`)
    })
    const plan = await planSync(
      [
        {
          title: 'Hidden Place',
          artist: 'Björk',
          alternatives: [{ title: 'Björk', artist: 'Hidden Place' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.matched).toHaveLength(1)
    expect(plan.matched[0].songId).toBe('1')
    expect(target.searchSongs).toHaveBeenCalledTimes(2)
    expect(target.searchSongs).toHaveBeenNthCalledWith(1, 'Hidden Place Björk', 10)
    expect(target.searchSongs).toHaveBeenNthCalledWith(2, 'Hidden Place', 10)
  })

  it('主备均无匹配 → no-match 失败', async () => {
    const target = makeTarget({})
    const plan = await planSync(
      [
        {
          title: '无名乐队',
          artist: '无名歌',
          alternatives: [{ title: '无名歌', artist: '无名乐队' }],
        },
      ],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.failed).toHaveLength(1)
    expect(plan.failed[0].reason).toBe('no-match')
  })

  it('风控（rate-limited）→ 主候选两个并行关键词均失败，不尝试备选，直接失败', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async () => {
      throw new SearchError('操作频繁', false, true)
    })
    const plan = await planSync(
      [
        {
          title: '主候选',
          artist: '某人',
          alternatives: [{ title: '备选候选', artist: '某人' }],
        },
      ],
      target,
      { searchIntervalMs: 0, searchRetries: 0 },
    )
    expect(plan.failed).toHaveLength(1)
    expect(plan.failed[0].reason).toBe('rate-limited')
    // 并行预取下组合+纯歌名两个在途请求均失败，但不再搜备选候选
    expect(target.searchSongs).toHaveBeenCalledTimes(2)
  })

  it('搜索预算 maxSearchesPerSong：超预算停止搜索', async () => {
    const target = makeTarget({})
    target.searchSongs = vi.fn(async () => [])
    const plan = await planSync(
      [
        {
          title: '主候选',
          artist: '某人',
          alternatives: [{ title: '备选候选', artist: '某人' }],
        },
      ],
      target,
      { searchIntervalMs: 0, maxSearchesPerSong: 2 },
    )
    expect(target.searchSongs).toHaveBeenCalledTimes(2)
    expect(plan.failed).toHaveLength(1)
    expect(plan.failed[0].reason).toBe('no-match')
  })
})

describe('syncPlaylist — 第一首歌曲风格（自动命名）', () => {
  it('完全匹配：报告携带第一首歌曲的风格', async () => {
    const target = makeTarget({
      '晴天 周杰伦': [song('1', '晴天', '周杰伦', '流行')],
      '稻香 周杰伦': [song('2', '稻香', '周杰伦', '流行')],
    })
    const report = await run(
      [{ title: '晴天', artist: '周杰伦' }, { title: '稻香', artist: '周杰伦' }],
      'x',
      target,
    )
    expect(report.firstGenre).toBe('流行')
  })

  it('同歌不同作者：firstGenre 取第一候选的风格', async () => {
    const target = makeTarget({
      '勇气 梁静茹': [song('1', '勇气', '棉子', '民谣'), song('2', '勇气', '金志文', '流行')],
    })
    const report = await run([{ title: '勇气', artist: '梁静茹' }], 'x', target)
    expect(report.status).toBe('choice-needed')
    expect(report.firstGenre).toBe('民谣')
  })

  it('搜索结果无风格字段 → firstGenre 为 undefined', async () => {
    const target = makeTarget({ '晴天 周杰伦': [song('1', '晴天', '周杰伦')] })
    const report = await run([{ title: '晴天', artist: '周杰伦' }], 'x', target)
    expect(report.firstGenre).toBeUndefined()
  })
})

describe('planSync — 映射缓存（SQLite 命中免搜索）', () => {
  it('人工确认映射命中 → 跳过搜索直接匹配', async () => {
    const target = makeTarget({})
    target.lookupMapping = vi.fn((query: MatchQuery) => {
      if (query.title === '晴天') return { songId: 'cached-1', confirmed: true }
      return null
    })
    const plan = await planSync([{ title: '晴天', artist: '周杰伦' }], target, {
      searchIntervalMs: 0,
    })
    expect(plan.matched).toEqual([{ query: { title: '晴天', artist: '周杰伦' }, songId: 'cached-1' }])
    expect(target.searchSongs).not.toHaveBeenCalled()
  })

  it('缓存未确认（confirmed=false）→ 不命中，正常搜索', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
    })
    target.lookupMapping = vi.fn(() => ({ songId: 'x', confirmed: false }))
    const plan = await planSync([{ title: '晴天', artist: '周杰伦' }], target, {
      searchIntervalMs: 0,
    })
    expect(target.searchSongs).toHaveBeenCalled()
    expect(plan.matched).toHaveLength(1)
  })

  it('自动匹配成功后写入缓存', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
    })
    const saved: string[] = []
    target.saveMapping = vi.fn((_query: MatchQuery, songId: string) => {
      saved.push(songId)
    })
    await planSync([{ title: '晴天', artist: '周杰伦' }], target, { searchIntervalMs: 0 })
    expect(saved).toEqual(['1'])
  })
})

describe('planSync — 受控并发池与任务内关键词缓存（性能优化）', () => {
  it('并发搜索池：多首歌搜索在途重叠（并发数大于 1）', async () => {
    const target = makeTarget({})
    let inFlight = 0
    let peak = 0
    target.searchSongs = vi.fn(async (keyword: string) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      const m = keyword.match(/^歌(\d+)$/)
      return m ? [song(m[1], keyword, '某人')] : []
    })
    const queries = [1, 2, 3, 4, 5].map((i) => ({ title: `歌${i}` }))
    const plan = await planSync(queries, target, { searchIntervalMs: 0, searchConcurrency: 3 })
    expect(plan.matched).toHaveLength(5)
    expect(peak).toBeGreaterThan(1)
  })

  it('任务内关键词缓存：重复歌曲共享搜索结果，不重复请求', async () => {
    const target = makeTarget({
      '晴天 周杰伦': [song('1', '晴天', '周杰伦')],
      晴天: [song('1', '晴天', '周杰伦')],
    })
    const queries = [
      { title: '晴天', artist: '周杰伦' },
      { title: '晴天', artist: '周杰伦' },
    ]
    // 串行并发保证第二首在第一首处理完后开始，缓存命中确定
    const plan = await planSync(queries, target, { searchIntervalMs: 0, searchConcurrency: 1 })
    expect(plan.matched).toHaveLength(2)
    // 组合与纯歌名各搜索一次；第二首两个关键词均命中缓存
    expect(target.searchSongs).toHaveBeenCalledTimes(2)
  })

  it('searchConcurrency 无效值（0/负数）→ 回退为 1，仍可完成匹配', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const plan = await planSync(
      [{ title: '晴天' }, { title: '稻香' }],
      target,
      { searchIntervalMs: 0, searchConcurrency: 0 },
    )
    expect(plan.matched).toHaveLength(2)
  })
})

describe('同步引擎 — 介入控制与任务明细（T9）', () => {
  it('report.items 覆盖全部歌曲：matched/choice/failed 均有明细', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const report = await run(
      [
        { title: '晴天', artist: '周杰伦' },
        { title: '勇气', artist: '梁静茹' },
        { title: '不存在的歌', artist: '某人' },
      ],
      'x',
      target,
    )
    expect(report.status).toBe('choice-needed')
    expect(report.items).toHaveLength(3)
    expect(report.items[0]).toMatchObject({ index: 0, status: 'matched', songId: '1' })
    expect(report.items[1]).toMatchObject({ index: 1, status: 'choice' })
    expect(report.items[2]).toMatchObject({ index: 2, status: 'failed', reason: 'no-match' })
  })

  it('onStep 逐首回调：每次处理一首触发一次且带 index', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const steps: Array<{ index: number; status: string }> = []
    await run([{ title: '晴天' }, { title: '稻香' }], 'x', target, {
      onStep: (item) => steps.push({ index: item.index, status: item.status }),
    })
    expect(steps).toEqual([
      { index: 0, status: 'matched' },
      { index: 1, status: 'matched' },
    ])
  })

  it('skipCheck 为真 → 跳过该首记 skipped，不搜索，不中断整体', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    // 主进程语义：跳过请求一次性消耗（第一次询问返回 true，后续返回 false）
    const skipFirst = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const report = await run(
      [{ title: '晴天' }, { title: '稻香' }],
      'x',
      target,
      { skipCheck: skipFirst },
    )
    expect(skipFirst).toHaveBeenCalledTimes(2)
    expect(target.searchSongs).not.toHaveBeenCalledWith('晴天', 10)
    expect(report.added).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('skipped')
    expect(report.items[0]).toMatchObject({ index: 0, status: 'skipped', reason: 'skipped' })
    expect(report.items[1]).toMatchObject({ index: 1, status: 'matched' })
  })

  it('signal 中止 → planSync 抛 SyncAbortedError，在途结果保留、后续歌不再发起搜索', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
      阳光: [song('3', '阳光', '周杰伦')],
    })
    const ctrl = new AbortController()
    target.searchSongs = vi.fn(async (keyword: string) => {
      // 第一首歌搜索发起后请求停止（微任务时点）：第二首已并发在途，第三首不再发起
      if (keyword === '晴天') {
        await Promise.resolve()
        ctrl.abort()
      }
      const byKeyword: Record<string, PlatformSong> = {
        晴天: song('1', '晴天', '周杰伦'),
        稻香: song('2', '稻香', '周杰伦'),
      }
      return byKeyword[keyword] ? [byKeyword[keyword]] : []
    })
    let caught: SyncAbortedError | null = null
    try {
      await planSync([{ title: '晴天' }, { title: '稻香' }, { title: '阳光' }], target, {
        searchIntervalMs: 0,
        searchConcurrency: 2,
        signal: ctrl.signal,
      })
    } catch (e) {
      caught = e as SyncAbortedError
    }
    expect(caught).toBeInstanceOf(SyncAbortedError)
    expect(caught?.partial.total).toBe(3)
    expect(caught?.partial.items.map((i) => i.status)).toEqual(['matched', 'matched'])
    expect(caught?.partial.failed).toEqual([])
    // 第三首未发起搜索（abort 后 worker 不再取新歌）
    expect(target.searchSongs).toHaveBeenCalledTimes(2)
  })

  it('executeSync 批次之间中止 → 抛 SyncAbortedError，已写入批次保留', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const plan = await planSync([{ title: '晴天' }, { title: '稻香' }], target, {
      searchIntervalMs: 0,
    })
    const ctrl = new AbortController()
    target.addSongs = vi.fn(async () => {
      // 第一批写入后请求停止：下一批开始前的检查点应抛错
      ctrl.abort()
    })
    let caught: SyncAbortedError | null = null
    try {
      await executeSync(plan, [], 'x', target, { batchSize: 1, signal: ctrl.signal })
    } catch (e) {
      caught = e as SyncAbortedError
    }
    expect(caught).toBeInstanceOf(SyncAbortedError)
    expect(caught?.partial.added).toBe(1)
    expect(caught?.partial.playlistId).toBe('pl-x')
    expect(caught?.partial.items).toHaveLength(2)
  })

  it('executeSync：add-failed 与 unresolved 同步回写明细清单', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
      稻香: [song('4', '稻香', '周杰伦')],
    })
    const plan = await planSync(
      [{ title: '晴天' }, { title: '勇气' }, { title: '稻香' }],
      target,
      { searchIntervalMs: 0 },
    )
    expect(plan.choices).toHaveLength(1)
    let call = 0
    target.addSongs = vi.fn(async () => {
      call++
      if (call === 2) throw new Error('添加失败')
    })
    const report = await executeSync(plan, [], 'x', target, { batchSize: 1 })
    const items = report.items
    expect(items[0]).toMatchObject({ status: 'matched', songId: '1' })
    expect(items[1]).toMatchObject({ status: 'failed', reason: 'unresolved' })
    expect(items[2]).toMatchObject({ status: 'failed', reason: 'add-failed' })
    expect(report.added).toBe(1)
  })

  it('建单前中止 → 不建单，partial 无 playlistId', async () => {
    const target = makeTarget({ 晴天: [song('1', '晴天', '周杰伦')] })
    const plan = await planSync([{ title: '晴天' }], target, { searchIntervalMs: 0 })
    const ctrl = new AbortController()
    ctrl.abort()
    try {
      await executeSync(plan, [], 'x', target, { signal: ctrl.signal })
      throw new Error('应当抛出 SyncAbortedError')
    } catch (e) {
      expect(e).toBeInstanceOf(SyncAbortedError)
      expect(target.createPlaylist).not.toHaveBeenCalled()
    }
  })
})

describe('同步引擎 — 检查点与断点续写（定期保存/重启恢复）', () => {
  it('executeSync 建单与每批写入后触发 onCheckpoint（playlistId + added）', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 3; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    const checkpoints: Array<{ stage: string; playlistId?: string; added?: number }> = []
    const plan = await planSync(
      [1, 2, 3].map((i) => ({ title: `歌${i}`, artist: '某人' })),
      target,
      { searchIntervalMs: 0 },
    )
    await executeSync(plan, [], 'x', target, {
      batchSize: 2,
      onCheckpoint: (cp) => checkpoints.push(cp),
    })
    expect(checkpoints[0]).toEqual({ stage: 'adding', playlistId: 'pl-x', added: 0 })
    expect(checkpoints[1]).toEqual({ stage: 'adding', playlistId: 'pl-x', added: 2 })
    expect(checkpoints[2]).toEqual({ stage: 'adding', playlistId: 'pl-x', added: 3 })
  })

  it('planSync 每首歌处理后触发 matching 检查点', async () => {
    const target = makeTarget({
      晴天: [song('1', '晴天', '周杰伦')],
      稻香: [song('2', '稻香', '周杰伦')],
    })
    const checkpoints: string[] = []
    await planSync([{ title: '晴天' }, { title: '稻香' }], target, {
      searchIntervalMs: 0,
      onCheckpoint: (cp) => checkpoints.push(cp.stage),
    })
    expect(checkpoints).toEqual(['matching', 'matching'])
  })

  it('resumeSync：从 addedSoFar 处续写剩余批次，不重复写入已添加部分', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 5; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    // 模拟中断前：已建单且已添加前 2 首（批次大小 1）
    const detail = [1, 2, 3, 4, 5].map((i) => ({
      index: i - 1,
      query: { title: `歌${i}`, artist: '某人' },
      status: 'matched' as const,
      songId: String(i),
    }))
    const report = await resumeSync('pl-断点', 2, detail, '断点歌单', target, { batchSize: 1 })
    expect(report.status).toBe('done')
    expect(report.added).toBe(5)
    const calls = (target.addSongs as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls.map((c) => c[1])).toEqual([['3'], ['4'], ['5']])
  })

  it('resumeSync：不建新单，报告 playlistId 为续写目标', async () => {
    const target = makeTarget({})
    const detail = [
      {
        index: 0,
        query: { title: '晴天' },
        status: 'matched' as const,
        songId: '1',
      },
    ]
    const report = await resumeSync('pl-existing', 0, detail, 'x', target)
    expect(report.playlistId).toBe('pl-existing')
    expect(target.createPlaylist).not.toHaveBeenCalled()
    expect(target.addSongs).toHaveBeenCalledWith('pl-existing', ['1'])
  })

  it('resumeSync：续写中批次失败记 add-failed，其余批次继续', async () => {
    const index: Record<string, PlatformSong[]> = {}
    for (let i = 1; i <= 3; i++) index[`歌${i}`] = [song(String(i), `歌${i}`, '某人')]
    const target = makeTarget(index)
    let call = 0
    target.addSongs = vi.fn(async () => {
      call++
      if (call === 2) throw new Error('续写失败')
    })
    const detail = [1, 2, 3].map((i) => ({
      index: i - 1,
      query: { title: `歌${i}`, artist: '某人' },
      status: 'matched' as const,
      songId: String(i),
    }))
    const steps: Array<{ index: number; status: string }> = []
    const report = await resumeSync('pl-x', 0, detail, 'x', target, {
      batchSize: 1,
      onStep: (item) => steps.push({ index: item.index, status: item.status }),
    })
    expect(report.added).toBe(2)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0].reason).toBe('add-failed')
    expect(report.items.find((i) => i.index === 1)).toMatchObject({
      status: 'failed',
      reason: 'add-failed',
    })
    // 续写失败同样实时广播明细改写（回归：重启后检查点明细与报告不一致）
    expect(steps).toContainEqual({ index: 1, status: 'failed' })
  })

  it('executeSync 用户确认的明细实时触发 onStep（供主进程检查点持久化）', async () => {
    const target = makeTarget({
      勇气: [song('2', '勇气', '棉子'), song('3', '勇气', '金志文')],
    })
    const plan = await planSync([{ title: '勇气' }], target, { searchIntervalMs: 0 })
    expect(plan.choices).toHaveLength(1)
    const steps: Array<{ status: string; songId?: string }> = []
    await executeSync(plan, [{ choiceIndex: 0, songId: '2' }], 'x', target, {
      onStep: (item) => steps.push({ status: item.status, songId: item.songId }),
    })
    expect(steps).toEqual([{ status: 'matched', songId: '2' }])
  })
})
