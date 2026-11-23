import { findBestMatch } from '@core/matcher/matchSong'
import { classifyCandidates } from '@core/matcher/exactMatch'
import type { MatchQuery } from '@core/models/match'
import type { PlatformSong } from '@core/models/platform'
import {
  SearchError,
  type SyncFailedItem,
  type SyncOptions,
  type SyncPlan,
  type SyncReport,
  type SyncSelection,
  type SyncTarget,
} from '@core/models/sync'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : '搜索失败'
}

/**
 * 阶段一：逐首搜索 + 金标准判定。
 * 完全匹配（标题+歌手精确）自动选定；同歌不同作者进入 choices 待手动选择；
 * 其余交给评分引擎。纯逻辑、平台无关，搜索限速 + 可重试错误重试。
 */
export async function planSync(
  queries: MatchQuery[],
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncPlan> {
  const threshold = options.threshold ?? 0.6
  const searchIntervalMs = options.searchIntervalMs ?? 500
  const searchRetries = options.searchRetries ?? 2

  const matched: SyncPlan['matched'] = []
  const choices: SyncPlan['choices'] = []
  const failed: SyncFailedItem[] = []

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i]
    // 主候选 + 备选候选：主候选无匹配时逐个搜索验证（金标准闭环）
    const attempts: Array<{ title: string; artist?: string }> = [
      { title: query.title, artist: query.artist },
      ...(query.alternatives ?? []),
    ]

    let settled:
      | { type: 'matched'; songId: string }
      | { type: 'choice'; attempt: MatchQuery; candidates: PlatformSong[] }
      | null = null
    let lastError: unknown = null

    for (const attempt of attempts) {
      let candidates: Awaited<ReturnType<SyncTarget['searchSongs']>> | null = null

      for (let retry = 0; retry <= searchRetries && candidates === null; retry++) {
        try {
          candidates = await target.searchSongs(attempt.title, 10)
        } catch (e) {
          lastError = e
          const retryable = e instanceof SearchError ? e.retryable : false
          if (!retryable || retry === searchRetries) break
          await sleep(Math.min(1000 * 2 ** retry, 5000))
        }
      }

      if (candidates === null) break

      const disposition = classifyCandidates(attempt, candidates)
      if (disposition.kind === 'exact') {
        settled = { type: 'matched', songId: disposition.songId }
        break
      }
      if (disposition.kind === 'title-only') {
        settled = { type: 'choice', attempt, candidates: disposition.candidates }
        break
      }
      const best = findBestMatch(attempt, candidates, { threshold })
      if (best && best.matched) {
        settled = { type: 'matched', songId: best.candidate.id }
        break
      }
      // no-match：尝试下一个备选候选
    }

    if (settled === null) {
      if (lastError !== null) {
        const isRateLimited =
          lastError instanceof SearchError && /频繁|405/i.test(lastError.message)
        failed.push({
          query,
          reason: isRateLimited ? 'rate-limited' : 'search-failed',
          message: errorMessage(lastError),
        })
      } else {
        failed.push({
          query,
          reason: 'no-match',
          message: `未找到匹配歌曲：${query.title}${query.artist ? ` - ${query.artist}` : ''}`,
        })
      }
    } else if (settled.type === 'matched') {
      matched.push({ query, songId: settled.songId })
    } else {
      choices.push({ query: settled.attempt, candidates: settled.candidates })
    }

    options.onProgress?.((i + 1) / queries.length, 'matching')
    if (i < queries.length - 1) await sleep(searchIntervalMs)
  }

  return { total: queries.length, matched, choices, failed }
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
  const pending: Array<{ query: MatchQuery; songId: string }> = [...plan.matched]

  for (let i = 0; i < plan.choices.length; i++) {
    const choice = plan.choices[i]
    const selection = selections.find((s) => s.choiceIndex === i)
    const candidate = selection
      ? choice.candidates.find((c) => c.id === selection.songId)
      : undefined
    if (!candidate) {
      failed.push({
        query: choice.query,
        reason: 'unresolved',
        message: `同歌不同作者，未选择版本：${choice.query.title}${choice.query.artist ? ` - ${choice.query.artist}` : ''}`,
      })
      continue
    }
    pending.push({ query: choice.query, songId: candidate.id })
  }

  const baseReport = {
    playlistName,
    playlistId: '',
    total: plan.total,
    matched: plan.matched.length,
    added: 0,
    failed,
    choices: [],
  }

  // 全部未匹配/未确认时不创建空歌单，避免污染用户账号
  if (pending.length === 0) {
    return { status: 'done', ...baseReport }
  }

  const playlistId = await target.createPlaylist(playlistName)

  let added = 0
  const batchCount = Math.ceil(pending.length / batchSize)
  for (let b = 0; b < batchCount; b++) {
    const batch = pending.slice(b * batchSize, (b + 1) * batchSize)
    try {
      await target.addSongs(playlistId, batch.map((m) => m.songId))
      added += batch.length
    } catch (e) {
      const message = errorMessage(e)
      for (const item of batch) {
        failed.push({ query: item.query, reason: 'search-failed', message })
      }
    }
    options.onProgress?.((b + 1) / Math.max(batchCount, 1), 'adding')
  }

  return {
    status: 'done',
    playlistName,
    playlistId,
    total: plan.total,
    matched: plan.matched.length,
    added,
    failed,
    choices: [],
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
    return {
      status: 'choice-needed',
      playlistName,
      playlistId: '',
      total: plan.total,
      matched: plan.matched.length,
      added: 0,
      failed: plan.failed,
      choices: plan.choices,
    }
  }

  return executeSync(plan, [], playlistName, target, options)
}
