import { findBestMatch, normalize } from '@core/matcher/matchSong'
import { classifyCandidates } from '@core/matcher/exactMatch'
import { createLogger, errorMessage } from '@core/logging'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'
import {
  SearchError,
  SyncAbortedError,
  type SyncChoice,
  type SyncFailedItem,
  type SyncItemResult,
  type SyncMatchedResource,
  type SyncOptions,
  type SyncPlan,
  type SyncReport,
  type SyncSelection,
  type SyncTarget,
} from '@core/models/sync'

const log = createLogger({ module: 'sync.playlist' })

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 单首歌的处理结果（并发 worker 产物，flush 按 index 顺序收敛输出） */
interface SongOutcome {
  item: SyncItemResult
  matched?: { query: MatchQuery; songId: string }
  choice?: SyncChoice
  failed?: SyncFailedItem
  /** 匹配结果的风格（第一首用于自动命名歌单） */
  genre?: string
}

/** 单首歌搜索后的落定状态：自动匹配 / 待手动选择 */
type SettledMatch =
  | { type: 'matched'; songId: string; matchedSong?: SyncMatchedResource }
  | { type: 'choice'; attempt: MatchQuery; candidates: PlatformSong[] }

/** 限流触发后的全局冷却时长：所有在途/后续搜索暂停，等待平台风控窗口过去 */
const RATE_LIMIT_COOLDOWN_MS = 4_000

/**
 * 阶段一：受控并发搜索 + 金标准判定。
 * 并发池掩盖搜索 RTT（原来逐首串行 + 固定间隔，等待时间占大头）；
 * 输出仍按输入顺序收敛（onStep/检查点/明细顺序与串行语义一致）。
 * 完全匹配（标题+歌手精确）自动选定；同歌不同作者进入 choices 待手动选择；
 * 其余交给评分引擎。纯逻辑、平台无关，全局限速 + 限流冷却 + 可重试错误重试。
 */
export async function planSync(
  queries: MatchQuery[],
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncPlan> {
  const threshold = options.threshold ?? 0.6
  const searchIntervalMs = options.searchIntervalMs ?? 500
  const searchRetries = options.searchRetries ?? 2
  const concurrency = Math.max(1, options.searchConcurrency ?? 3)
  const budget = options.maxSearchesPerSong ?? 4

  const matched: SyncPlan['matched'] = []
  const choices: SyncPlan['choices'] = []
  const failed: SyncFailedItem[] = []
  const items: SyncItemResult[] = []
  let firstGenre: string | undefined

  log.info('plan.start', '开始匹配计划', { total: queries.length, threshold, concurrency })

  /** 每首歌的处理结果槽位：并发完成，flush 按 index 顺序收敛输出 */
  const slots: Array<SongOutcome | null> = new Array(queries.length).fill(null)

  /** 任务内关键词缓存：同关键词共享一次搜索（含在途 promise，避免并发重复请求）；失败不缓存 */
  const keywordCache = new Map<string, Promise<PlatformSong[] | null>>()

  /** 全局请求限速：并发池内所有搜索请求共享的最小发起间隔（原逐首间隔收敛为全局限速） */
  let nextRequestAt = 0
  async function throttleSearch(): Promise<void> {
    if (searchIntervalMs <= 0) return
    const wait = nextRequestAt - Date.now()
    nextRequestAt = Math.max(Date.now(), nextRequestAt) + searchIntervalMs
    if (wait > 0) await sleep(wait)
  }

  /** 限流全局冷却：任一搜索被平台风控后，暂停后续发起，避免火上浇油 */
  let cooldownUntil = 0

  async function processSong(i: number, query: MatchQuery): Promise<SongOutcome | null> {
    // 用户停止：立即中止
    if (options.signal?.aborted) return null
    // 用户请求跳过当前歌曲：记 skipped 后直接下一首
    if (options.skipCheck?.()) {
      const message = `已跳过：${query.title}${query.artist ? ` - ${query.artist}` : ''}`
      const item: SyncItemResult = { index: i, query, status: 'skipped', reason: 'skipped', message }
      log.info('plan.item-skipped', '歌曲被用户跳过', { title: query.title })
      return { item, failed: { query, reason: 'skipped', message } }
    }
    // 映射缓存：人工确认过的映射直接命中，跳过搜索
    if (target.lookupMapping) {
      const hit = target.lookupMapping(query)
      if (hit?.confirmed) {
        const item: SyncItemResult = {
          index: i,
          query,
          status: 'matched',
          songId: hit.songId,
          matchedSong: hit.resource,
        }
        log.debug('plan.cache-hit', '映射缓存命中，跳过搜索', {
          title: query.title,
          artist: query.artist,
          songId: hit.songId,
        })
        return { item, matched: { query, songId: hit.songId } }
      }
    }

    // 主候选 + 备选候选：主候选无匹配时逐个搜索验证（金标准闭环）
    const attempts: Array<{ title: string; artist?: string; album?: string }> = [
      { title: query.title, artist: query.artist, album: query.album },
      ...(query.alternatives ?? []),
    ]

    let settled: SettledMatch | null = null
    let lastError: unknown = null
    let genre: string | undefined
    let searchCount = 0

    /** 单次关键词搜索：缓存命中免请求；全局限速 + 冷却；可重试错误按指数退避重试 */
    const searchKeyword = (keyword: string): Promise<PlatformSong[] | null> => {
      const cacheKey = normalize(keyword)
      const inFlight = keywordCache.get(cacheKey)
      if (inFlight) return inFlight
      const task = (async (): Promise<PlatformSong[] | null> => {
        // 限流冷却期内暂停发起，等待平台风控窗口过去
        while (Date.now() < cooldownUntil) {
          if (options.signal?.aborted) return null
          await sleep(Math.min(200, cooldownUntil - Date.now()))
        }
        if (searchCount >= budget) return null
        await throttleSearch()
        searchCount++
        for (let retry = 0; retry <= searchRetries; retry++) {
          try {
            const candidates = await target.searchSongs(keyword, 10)
            return candidates
          } catch (e) {
            lastError = e
            if (e instanceof SearchError && e.rateLimited) {
              // 平台风控：全局冷却，其他在途/后续搜索暂停
              cooldownUntil = Math.max(cooldownUntil, Date.now() + RATE_LIMIT_COOLDOWN_MS)
            }
            const retryable = e instanceof SearchError ? e.retryable : false
            if (!retryable || retry === searchRetries) return null
            const waitMs = Math.min(1000 * 2 ** retry, 5000)
            log.warn('plan.search-retry', '搜索失败，准备重试', {
              title: query.title,
              keyword,
              attempt: retry + 1,
              waitMs,
              message: errorMessage(e),
            })
            await sleep(waitMs)
            // 重试等待期间用户可能已请求停止：立即响应，不再发起下一次请求
            if (options.signal?.aborted) return null
            if (searchCount >= budget) return null
            await throttleSearch()
            searchCount++
          }
        }
        return null
      })()
      keywordCache.set(cacheKey, task)
      // 失败结果不缓存：后续歌曲仍可重试该关键词
      void task.then((result) => {
        if (result === null) keywordCache.delete(cacheKey)
      })
      return task
    }

    for (const attempt of attempts) {
      if (searchCount >= budget) {
        log.warn('plan.budget-exhausted', '单曲搜索预算用尽', {
          title: query.title,
          budget,
        })
        break
      }
      // 搜索关键词策略：「歌名 + 歌手」提高召回精度；纯歌名并行预取，组合无精确命中时直接可用
      const keywords = attempt.artist
        ? [`${attempt.title} ${attempt.artist}`, attempt.title]
        : [attempt.title]
      const planned = keywords.slice(0, budget - searchCount)
      const results = await Promise.all(planned.map((kw) => searchKeyword(kw)))

      let anySucceeded = false
      for (let k = 0; k < planned.length && settled === null; k++) {
        const candidates = results[k]
        if (candidates === null) continue
        anySucceeded = true
        const disposition = classifyCandidates(attempt, candidates)
        if (disposition.kind === 'exact') {
          const song = candidates.find((c) => c.id === disposition.songId)
          settled = {
            type: 'matched',
            songId: disposition.songId,
            matchedSong: song ? { title: song.title, artist: song.artist, album: song.album } : undefined,
          }
          if (genre === undefined) genre = song?.genre
        } else if (disposition.kind === 'title-only') {
          settled = { type: 'choice', attempt, candidates: disposition.candidates }
          if (genre === undefined) genre = disposition.candidates[0]?.genre
        } else {
          const best = findBestMatch(attempt, candidates, { threshold })
          if (best && best.matched) {
            settled = {
              type: 'matched',
              songId: best.candidate.id,
              matchedSong: {
                title: best.candidate.title,
                artist: best.candidate.artist,
                album: best.candidate.album,
              },
            }
            if (genre === undefined) genre = best.candidate.genre
          }
        }
      }

      // 全部关键词搜索失败：网络/风控错误时换候选再发请求无意义
      if (settled !== null || !anySucceeded || searchCount >= budget) break
      // no-match：尝试下一个备选候选
    }

    if (settled === null) {
      if (lastError !== null) {
        // 限流/可重试判定由平台适配器完成（SearchError 标记），主流程不做平台文案匹配
        const isRateLimited = lastError instanceof SearchError && lastError.rateLimited
        const fail: SyncFailedItem = {
          query,
          reason: isRateLimited ? 'rate-limited' : 'search-failed',
          message: errorMessage(lastError),
        }
        log.warn('plan.item-failed', '歌曲匹配失败', {
          title: query.title,
          artist: query.artist,
          reason: fail.reason,
          message: fail.message,
        })
        return {
          item: { index: i, query, status: 'failed', reason: fail.reason, message: fail.message },
          failed: fail,
          genre,
        }
      }
      const fail: SyncFailedItem = {
        query,
        reason: 'no-match',
        message: `未找到匹配歌曲：${query.title}${query.artist ? ` - ${query.artist}` : ''}`,
      }
      log.info('plan.item-no-match', '未找到匹配歌曲', {
        title: query.title,
        artist: query.artist,
      })
      return {
        item: { index: i, query, status: 'failed', reason: 'no-match', message: fail.message },
        failed: fail,
        genre,
      }
    }
    if (settled.type === 'matched') {
      // 自动匹配结果写入缓存（下次可命中）
      target.saveMapping?.(query, settled.songId)
      const item: SyncItemResult = {
        index: i,
        query,
        status: 'matched',
        songId: settled.songId,
        matchedSong: settled.matchedSong,
      }
      log.debug('plan.item-matched', '歌曲匹配成功', {
        title: query.title,
        artist: query.artist,
        songId: settled.songId,
      })
      return { item, matched: { query, songId: settled.songId }, genre }
    }
    const item: SyncItemResult = { index: i, query: settled.attempt, status: 'choice' }
    log.info('plan.item-choice', '同歌不同作者，进入手动选择', {
      title: query.title,
      artist: query.artist,
      candidates: settled.candidates.length,
    })
    return { item, choice: { query: settled.attempt, candidates: settled.candidates }, genre }
  }

  let nextIndex = 0
  let flushIdx = 0

  /** 按输入顺序收敛输出：并发完成的结果先入槽位，flush 只输出连续就绪前缀（保证顺序语义） */
  function flush(): void {
    while (flushIdx < queries.length && slots[flushIdx] !== null) {
      const outcome = slots[flushIdx] as SongOutcome
      if (flushIdx === 0 && firstGenre === undefined) firstGenre = outcome.genre
      items.push(outcome.item)
      if (outcome.matched) matched.push(outcome.matched)
      if (outcome.choice) choices.push(outcome.choice)
      if (outcome.failed) failed.push(outcome.failed)
      options.onStep?.(outcome.item)
      options.onProgress?.((flushIdx + 1) / queries.length, 'matching')
      // 每首歌处理完触发检查点：主进程定期持久化，中断后可从此处附近恢复
      options.onCheckpoint?.({ stage: 'matching' })
      flushIdx++
    }
  }

  async function worker(): Promise<void> {
    while (true) {
      if (options.signal?.aborted) return
      const i = nextIndex++
      if (i >= queries.length) return
      const outcome = await processSong(i, queries[i])
      if (outcome === null) return
      slots[i] = outcome
      flush()
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queries.length) }, () => worker()),
  )
  flush()

  if (options.signal?.aborted) {
    log.info('plan.aborted', '匹配计划被用户停止', { done: items.length, total: queries.length })
    throw new SyncAbortedError({ items, failed, total: queries.length, matched: matched.length })
  }

  log.info('plan.complete', '匹配计划完成', {
    total: queries.length,
    matched: matched.length,
    choices: choices.length,
    failed: failed.length,
  })

  return { total: queries.length, matched, choices, failed, items, firstGenre }
}

/**
 * 阶段二：用户确认选择后建单并写入。
 * matched 与选定项一并分批添加；未确认的 choice 计为 unresolved。
 */
export async function executeSync(
  plan: SyncPlan,
  selections: SyncSelection[],
  playlistName: string,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const batchSize = options.batchSize ?? 500
  const failed: SyncFailedItem[] = [...plan.failed]
  const items: SyncItemResult[] = plan.items.map((item) => ({ ...item }))

  log.info('execute.start', '开始执行同步', {
    playlistName,
    matched: plan.matched.length,
    choices: plan.choices.length,
    selections: selections.length,
  })

  for (let i = 0; i < plan.choices.length; i++) {
    const choice = plan.choices[i]
    const selection = selections.find((s) => s.choiceIndex === i)
    // 显式跳过：用户明确放弃该首，不再参与候选匹配
    const skipped = selection?.skipped === true
    const candidate =
      !skipped && selection ? choice.candidates.find((c) => c.id === selection.songId) : undefined
    const item = items.find((it) => it.status === 'choice' && it.query === choice.query)
    if (!candidate) {
      const fail: SyncFailedItem = skipped
        ? {
            query: choice.query,
            reason: 'skipped',
            message: `已跳过：${choice.query.title}${choice.query.artist ? ` - ${choice.query.artist}` : ''}`,
          }
        : {
            query: choice.query,
            reason: 'unresolved',
            message: `同歌不同作者，未选择版本：${choice.query.title}${choice.query.artist ? ` - ${choice.query.artist}` : ''}`,
          }
      failed.push(fail)
      if (item) {
        item.status = skipped ? 'skipped' : 'failed'
        item.reason = fail.reason
        item.message = fail.message
        // 明细状态变化实时广播：主进程检查点持久化与详情清单展示保持一致
        options.onStep?.(item)
      }
      if (skipped) {
        log.info('execute.choice-skipped', '同歌不同作者，用户选择跳过', {
          title: choice.query.title,
          artist: choice.query.artist,
        })
      } else {
        log.warn('execute.choice-unresolved', '同歌不同作者，未选择版本', {
          title: choice.query.title,
          artist: choice.query.artist,
        })
      }
      continue
    }
    if (item) {
      item.status = 'matched'
      item.songId = candidate.id
      // 手动确认的候选同样记录目标资源关键信息，供重新执行复用
      item.matchedSong = {
        title: candidate.title,
        artist: candidate.artist,
        album: candidate.album,
      }
      // 明细状态变化实时广播：主进程检查点持久化与详情清单展示保持一致
      options.onStep?.(item)
    }
  }

  // 写入顺序必须与文本清单一致：自动匹配与手动确认合并后，按原始输入 index 重排。
  // （先 matched 再 choices 的拼接会把需要手动选择的歌挪到末尾，打乱用户文本顺序）
  const pending: Array<{ query: MatchQuery; songId: string }> = items
    .filter(
      (it): it is SyncItemResult & { songId: string } =>
        it.status === 'matched' && typeof it.songId === 'string' && it.songId !== '',
    )
    .sort((a, b) => a.index - b.index)
    .map((it) => ({ query: it.query, songId: it.songId }))

  const baseReport = {
    playlistName,
    playlistId: '',
    total: plan.total,
    matched: plan.matched.length,
    added: 0,
    failed,
    choices: [],
    items,
    firstGenre: plan.firstGenre,
  }

  // 全部未匹配/未确认时不创建空歌单，避免污染用户账号
  if (pending.length === 0) {
    log.warn('execute.skipped', '无可添加歌曲，跳过创建歌单', { playlistName })
    return { status: 'done', ...baseReport }
  }

  // 用户停止：建单前最后检查，避免建出空歌单
  if (options.signal?.aborted) {
    throw new SyncAbortedError({
      items,
      failed,
      total: plan.total,
      matched: plan.matched.length,
      added: 0,
    })
  }

  const playlistId = await target.createPlaylist(playlistName)
  log.info('execute.playlist-created', '目标歌单已创建', { playlistName, playlistId })
  // 建单检查点：中断恢复时据此跳过匹配阶段，直接续写剩余批次
  options.onCheckpoint?.({ stage: 'adding', playlistId, added: 0 })

  let added = 0
  const batchCount = Math.ceil(pending.length / batchSize)
  for (let b = 0; b < batchCount; b++) {
    // 用户停止：批次之间响应，已写入的批次保留
    if (options.signal?.aborted) {
      throw new SyncAbortedError({
        items,
        failed,
        total: plan.total,
        matched: plan.matched.length,
        added,
        playlistId,
      })
    }
    const batch = pending.slice(b * batchSize, (b + 1) * batchSize)
    try {
      await target.addSongs(playlistId, batch.map((m) => m.songId))
      added += batch.length
      log.debug('execute.batch-added', '批次写入成功', {
        playlistId,
        batch: b + 1,
        totalBatches: batchCount,
        count: batch.length,
      })
    } catch (e) {
      const message = errorMessage(e)
      log.error('execute.batch-failed', '批次写入失败', e, {
        playlistId,
        batch: b + 1,
        count: batch.length,
      })
      for (const pendingItem of batch) {
        failed.push({ query: pendingItem.query, reason: 'add-failed', message })
        const item = items.find((it) => it.query === pendingItem.query)
        if (item) {
          item.status = 'failed'
          item.reason = 'add-failed'
          item.message = message
        }
      }
    }
    options.onProgress?.((b + 1) / Math.max(batchCount, 1), 'adding')
    // 批次检查点：每批写入后持久化已添加数量，中断后从此处继续
    options.onCheckpoint?.({ stage: 'adding', playlistId, added })
  }

  log.info('execute.complete', '同步执行完成', {
    playlistName,
    playlistId,
    total: plan.total,
    added,
    failed: failed.length,
  })

  return {
    status: 'done',
    playlistName,
    playlistId,
    total: plan.total,
    matched: plan.matched.length,
    added,
    failed,
    choices: [],
    items,
    firstGenre: plan.firstGenre,
  }
}

/**
 * 断点续写：目标歌单已创建（中断恢复），跳过匹配阶段，从已添加数量处继续写入剩余批次。
 * detail 中 matched 项按原始 index 排序重建待写清单；此前已写入的批次（addedSoFar）不再重复写入。
 */
export async function resumeSync(
  playlistId: string,
  addedSoFar: number,
  detail: SyncItemResult[],
  playlistName: string,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const batchSize = options.batchSize ?? 500
  const failed: SyncFailedItem[] = []
  const items: SyncItemResult[] = detail.map((item) => ({ ...item }))

  const pending: Array<{ query: MatchQuery; songId: string }> = items
    .filter(
      (it): it is SyncItemResult & { songId: string } =>
        it.status === 'matched' && typeof it.songId === 'string' && it.songId !== '',
    )
    .sort((a, b) => a.index - b.index)
    .map((it) => ({ query: it.query, songId: it.songId }))

  log.info('resume.start', '恢复同步：继续写入剩余批次', {
    playlistName,
    playlistId,
    pending: pending.length,
    addedSoFar,
  })

  const baseReport = {
    playlistName,
    playlistId,
    total: items.length,
    matched: pending.length,
    added: addedSoFar,
    failed,
    choices: [],
    items,
  }

  // 已写入部分不再重复添加，从检查点之后继续
  const remaining = pending.slice(addedSoFar)
  let added = addedSoFar
  const batchCount = Math.ceil(remaining.length / batchSize)
  for (let b = 0; b < batchCount; b++) {
    if (options.signal?.aborted) {
      throw new SyncAbortedError({
        items,
        failed,
        total: items.length,
        matched: pending.length,
        added,
        playlistId,
      })
    }
    const batch = remaining.slice(b * batchSize, (b + 1) * batchSize)
    try {
      await target.addSongs(playlistId, batch.map((m) => m.songId))
      added += batch.length
      log.debug('resume.batch-added', '恢复同步批次写入成功', {
        playlistId,
        batch: b + 1,
        totalBatches: batchCount,
        count: batch.length,
      })
    } catch (e) {
      const message = errorMessage(e)
      log.error('resume.batch-failed', '恢复同步批次写入失败', e, {
        playlistId,
        batch: b + 1,
        count: batch.length,
      })
      for (const pendingItem of batch) {
        failed.push({ query: pendingItem.query, reason: 'add-failed', message })
        const item = items.find((it) => it.query === pendingItem.query)
        if (item) {
          item.status = 'failed'
          item.reason = 'add-failed'
          item.message = message
        }
      }
    }
    options.onProgress?.((b + 1) / Math.max(batchCount, 1), 'adding')
    // 批次检查点：恢复执行同样定期持久化，可再次中断续写
    options.onCheckpoint?.({ stage: 'adding', playlistId, added })
  }

  log.info('resume.complete', '恢复同步完成', {
    playlistName,
    playlistId,
    total: items.length,
    added,
    failed: failed.length,
  })

  return { status: 'done', ...baseReport, added, failed }
}

/** 存在同歌不同作者时的 choice-needed 报告（未建单） */
export function choiceNeededReport(playlistName: string, plan: SyncPlan): SyncReport {
  return {
    status: 'choice-needed',
    playlistName,
    playlistId: '',
    total: plan.total,
    matched: plan.matched.length,
    added: 0,
    failed: plan.failed,
    choices: plan.choices,
    items: plan.items,
    firstGenre: plan.firstGenre,
  }
}

/**
 * 单向同步入口：先搜索判定，全自动则直接建单写入；
 * 存在同歌不同作者时返回 choice-needed，等待用户确认后调 executeSync 完成。
 */
export async function syncPlaylist(
  queries: MatchQuery[],
  playlistName: string,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const plan = await planSync(queries, target, options)

  if (plan.choices.length > 0) {
    log.info('sync.choice-needed', '同步等待用户确认', {
      playlistName,
      choices: plan.choices.length,
    })
    return choiceNeededReport(playlistName, plan)
  }

  return executeSync(plan, [], playlistName, target, options)
}
