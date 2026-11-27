import { BrowserWindow } from 'electron'
import { choiceNeededReport, executeSync, planSync, resumeSync } from '@core/sync/syncPlaylist'
import { normalize } from '@core/matcher/matchSong'
import { errorMessage } from '@core/logging'
import {
  SearchError,
  SyncAbortedError,
  type SyncCheckpoint,
  type SyncFailedItem,
  type SyncItemResult,
  type SyncMatchedResource,
  type SyncOptions,
  type SyncPlan,
  type SyncReport,
  type SyncTarget,
  type SyncTaskRecord,
} from '@core/models/sync'
import type { MatchQuery } from '@core/models/match'
import { getPlatform, resolveAdapter } from './platformRegistry'
import { findMappings, saveAutoMapping } from './mappingService'
import { deriveTaskCounts, markTaskDetailFailed } from '@core/sync/taskStats'
import { getDatabase } from './appDatabase'
import { getSetting, syncTuning } from './settingsService'
import { isUserReadableMessage, normalizeIpcError } from '@core/ipcError'
import { notifySyncResult, notifySyncStopped } from './notifications'
import { logCenter } from './logging/logCenter'

const log = logCenter.logger('sync-pipeline')

/** 待确认的同步会话：choice-needed 后缓存 plan，等待用户选择（同步发起与恢复执行共用） */
export const pendingSyncs = new Map<
  string,
  {
    platform: string
    plan: SyncPlan
    target: SyncTarget
    playlistName: string
    /** 先建单流程：目标歌单已创建，确认后直接写入该歌单 */
    playlistId: string
    batchSize?: number
    /** 来源本地歌单 id：确认写入成功后登记反向关联 */
    sourceLocalPlaylistId?: string
  }
>()

/** 执行中的同步任务：支持停止（abort）与跳过当前歌曲（skip 标志，一次性消耗） */
export interface RunningSync {
  abort: AbortController
  skip: { requested: boolean }
}
const runningSyncs = new Map<string, RunningSync>()

/** 注册运行中的同步任务并构建引擎控制选项（abort / skip），渲染发起与恢复执行共用 */
export function beginRunningSync(taskId: string): {
  signal: AbortSignal
  skipCheck: () => boolean
  done: () => void
} {
  const ctrl = new AbortController()
  const skip = { requested: false }
  runningSyncs.set(taskId, { abort: ctrl, skip })
  return {
    signal: ctrl.signal,
    skipCheck: () => {
      const requested = skip.requested
      skip.requested = false
      return requested
    },
    done: () => runningSyncs.delete(taskId),
  }
}

/** 停止运行中的任务（stop-sync IPC 使用） */
export function abortRunningSync(taskId: string): boolean {
  const running = runningSyncs.get(taskId)
  if (running) {
    running.abort.abort()
    return true
  }
  return false
}

/** 请求跳过当前正在处理的歌曲（skip-sync IPC 使用） */
export function skipRunningSync(taskId: string): boolean {
  const running = runningSyncs.get(taskId)
  if (running) {
    running.skip.requested = true
    return true
  }
  return false
}

/** 搜索请求超时：正常 1~2s 内返回，收紧到 15s 快速失败进入退避重试（并发池下卡死请求不再长时间占坑） */
const SEARCH_TIMEOUT_MS = 15_000
/** 建单/批量写入超时：批量操作平台端处理较慢，保留宽松上限 */
const MUTATION_TIMEOUT_MS = 60_000
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SearchError(`请求超时（${Math.round(ms / 1000)}s），已放弃等待`, true))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 引擎中止后收敛为 stopped 报告（已完成部分保留，渲染层据此归因任务状态） */
export function stoppedReport(partial: SyncAbortedError['partial'], playlistName: string): SyncReport {
  return {
    status: 'stopped',
    playlistName,
    playlistId: partial.playlistId ?? '',
    total: partial.total,
    matched: partial.matched ?? 0,
    added: partial.added ?? 0,
    failed: partial.failed,
    choices: [],
    items: partial.items,
  }
}

/** 广播到所有窗口（渲染层按 taskId 过滤） */
export function broadcastSync(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/**
 * 本地歌单 → 平台同步建单成功后：登记「本地歌单 → 平台歌单」反向关联并广播，
 * 本地列表据此点亮平台 logo。只写关系表，不覆盖本地歌单自身的来源/封面列。
 */
export function registerLocalPlaylistSyncTarget(
  sourceLocalPlaylistId: string | undefined,
  platform: string,
  playlistId: string,
): void {
  if (!sourceLocalPlaylistId || !playlistId) return
  getDatabase().localPlaylists.linkSyncTarget(
    sourceLocalPlaylistId,
    platform,
    playlistId,
    new Date().toISOString(),
  )
  broadcastSync('local-playlist:changed', { id: sourceLocalPlaylistId })
}

/**
 * 失败明细行：`歌名 - 歌手（原因）`（主进程恢复执行终态写入用，与渲染层同格式）。
 * 原因经友好化过滤：剥离 IPC 包装，技术性报错回退通用文案，保证落库/广播内容可直接展示。
 */
export function failedDetailLines(failed: SyncFailedItem[]): string[] {
  const zh = getSetting<string>('language', 'zh-CN') !== 'en-US'
  const fallback = zh ? '同步失败' : 'Sync failed'
  return failed.map((f) => {
    const reason = normalizeIpcError(f.message ?? '')
    const readable = reason && isUserReadableMessage(reason) ? reason : fallback
    return `${f.query.title}${f.query.artist ? ` - ${f.query.artist}` : ''}（${readable}）`
  })
}

/** 恢复输入清单：原始输入优先，旧任务缺失时按明细 index 重建 */
export function rebuildQueries(task: SyncTaskRecord): MatchQuery[] {
  if (task.rawInput.length > 0) return task.rawInput
  return [...task.detail].sort((a, b) => a.index - b.index).map((d) => d.query)
}

/** 已匹配项复用映射：dupKey -> songId + 目标资源信息 */
export function buildReuseMatches(
  detail: SyncItemResult[],
): Array<{ key: string; songId: string; matchedSong?: SyncMatchedResource }> {
  return detail
    .filter((d) => d.status === 'matched' && typeof d.songId === 'string' && d.songId !== '')
    .map((d) => ({
      key: `${normalize(d.query.title)}|${normalize(d.query.artist ?? '')}`,
      songId: d.songId as string,
      matchedSong: d.matchedSong,
    }))
}

export interface RunSyncPipelineArgs {
  platform: string
  taskId: string
  queries: MatchQuery[]
  playlistName: string
  /** 渲染层按当前语言格式化的今日日期：歌单名留空时与第一首歌风格拼成默认名 */
  autoNameDate?: string
  batchSize?: number
  /** 重新执行/恢复执行时复用上次已匹配结果：命中后跳过搜索 */
  reuseMatches?: Array<{ key: string; songId: string; matchedSong?: SyncMatchedResource }>
  /** 来源本地歌单 id：目标平台建单成功后登记反向关联（本地列表点亮平台 logo） */
  sourceLocalPlaylistId?: string
  /** 中断恢复：已创建的目标歌单，跳过匹配阶段直接续写剩余批次 */
  resumePlaylistId?: string
  resumeAdded?: number
  resumeDetail?: SyncItemResult[]
  /** 引擎控制（渲染发起时可用；恢复执行不传） */
  signal?: AbortSignal
  skipCheck?: () => boolean
  /** 逐首明细回调（调用方负责广播与持久化） */
  onStep: (item: SyncItemResult) => void
  /** 进度回调（调用方负责广播） */
  onProgress: (ratio: number, stage: 'matching' | 'adding') => void
  /** 检查点回调（调用方负责定期持久化） */
  onCheckpoint: (checkpoint: SyncCheckpoint) => void
  /** choice-needed：主进程挂起会话等待用户选择（歌单已按先建单流程创建，playlistId 一并传入） */
  onChoiceNeeded: (
    plan: SyncPlan,
    finalName: string,
    target: SyncTarget,
    batchSize: number | undefined,
    playlistId: string,
  ) => void
}

/**
 * 同步执行核心：凭证校验 → 构造 SyncTarget →（断点续写 | 匹配计划 → 建单写入）。
 * 渲染发起的同步与重启恢复执行共用；检查点/进度/明细经回调交给调用方广播与落库。
 */
export async function runSyncPipeline(args: RunSyncPipelineArgs): Promise<SyncReport> {
  const {
    platform,
    taskId,
    queries,
    playlistName,
    autoNameDate,
    batchSize,
    reuseMatches,
    sourceLocalPlaylistId,
    resumePlaylistId,
    resumeAdded,
    resumeDetail,
    signal,
    skipCheck,
    onStep,
    onProgress,
    onCheckpoint,
    onChoiceNeeded,
  } = args

  const services = getPlatform(platform)
  const credential = services.getCredential()
  if (!credential) throw new Error('尚未登录目标平台')
  const adapter = await resolveAdapter(platform)

  const target: SyncTarget = {
    searchSongs: (keyword, limit) =>
      withTimeout(adapter.searchSongs(credential, keyword, limit), SEARCH_TIMEOUT_MS),
    createPlaylist: (name) =>
      withTimeout(adapter.createPlaylist(credential, name), MUTATION_TIMEOUT_MS),
    addSongs: (playlistId, songIds) =>
      withTimeout(adapter.addSongsToPlaylist(credential, playlistId, songIds), MUTATION_TIMEOUT_MS),
    lookupMapping: (query) => {
      // 重新/恢复执行：上次任务已匹配到的目标资源直接命中复用，无需重新搜索
      if (reuseMatches && reuseMatches.length > 0) {
        const key = `${normalize(query.title)}|${normalize(query.artist ?? '')}`
        const reused = reuseMatches.find((m) => m.key === key)
        if (reused) return { songId: reused.songId, confirmed: true, resource: reused.matchedSong }
      }
      const rows = findMappings(platform, query)
      const confirmed = rows.find((r) => r.confirmed === 1)
      if (confirmed) return { songId: confirmed.songId, confirmed: true }
      return null
    },
    saveMapping: (query, songId) => {
      // 只缓存非人工确认的自动匹配（人工确认经 confirm-sync 单独写入）
      saveAutoMapping(
        platform,
        query,
        {
          id: songId,
          title: query.title,
          artist: query.artist ?? '',
        },
        1,
      )
    },
  }

  const engineOptions = {
    batchSize,
    ...syncTuning(),
    signal,
    skipCheck,
    onStep,
    onProgress,
    onCheckpoint,
  }

  // 断点续写：目标歌单已创建（上次中断），按检查点阶段决定恢复方式
  if (resumePlaylistId) {
    try {
      const detail = resumeDetail ?? []
      // 匹配已完整落定（逐首终态覆盖全部输入）→ 跳过匹配直接续写剩余批次；
      // 匹配中断（先建单流程中建单后匹配未完）→ 复用已匹配结果补跑匹配后写入
      const matchingComplete =
        detail.length >= queries.length &&
        detail.every(
          (d) =>
            (d.status === 'matched' && typeof d.songId === 'string' && d.songId !== '') ||
            d.status === 'failed' ||
            d.status === 'skipped',
        )
      const report = matchingComplete
        ? await resumeSync(resumePlaylistId, resumeAdded ?? 0, detail, playlistName, target, engineOptions)
        : await completeAfterCreate(
            queries,
            playlistName,
            resumePlaylistId,
            target,
            engineOptions,
            onChoiceNeeded,
            batchSize,
          )
      if (report.playlistId !== '') {
        getDatabase().playlistCache.markStalePlaylists(platform)
        registerLocalPlaylistSyncTarget(sourceLocalPlaylistId, platform, report.playlistId)
      }
      log.info('pipeline.resume-done', '恢复同步续写完成', {
        platform,
        taskId,
        playlistId: report.playlistId,
        added: report.added,
        failed: report.failed.length,
        matchingComplete,
      })
      notifySyncResult(playlistName, report.added, report.failed.length)
      return report
    } catch (e) {
      if (e instanceof SyncAbortedError) {
        log.info('pipeline.resume-stopped', '恢复同步续写被用户停止', { platform, taskId })
        notifySyncStopped(playlistName)
        return stoppedReport(e.partial, playlistName)
      }
      throw e
    }
  }

  // 常规路径：先建单，再匹配写入，或进入待确认
  try {
    // 歌单名留空时自动命名：先建单流程下无法预知第一首歌风格，仅用日期
    const finalName = (playlistName ?? '').trim() || autoNameDate || '未命名歌单'
    const report = await createThenSync(
      finalName,
      queries,
      target,
      engineOptions,
      onChoiceNeeded,
      batchSize,
    )
    // 目标平台新建了歌单：标记列表缓存过期，下次访问先兜底再重新验证
    if (report.playlistId !== '') {
      getDatabase().playlistCache.markStalePlaylists(platform)
      registerLocalPlaylistSyncTarget(sourceLocalPlaylistId, platform, report.playlistId)
    }
    log.info('pipeline.done', '同步完成', {
      platform,
      taskId,
      playlistName: finalName,
      playlistId: report.playlistId,
      total: report.total,
      added: report.added,
      failed: report.failed.length,
    })
    notifySyncResult(finalName, report.added, report.failed.length)
    return report
  } catch (e) {
    if (e instanceof SyncAbortedError) {
      const fallbackName = (playlistName ?? '').trim() || autoNameDate || '未命名歌单'
      log.info('pipeline.stopped', '同步被用户停止', { platform, taskId })
      notifySyncStopped(fallbackName)
      // 停止前可能已建单并写入部分批次：歌单已存在于平台，同样登记反向关联
      registerLocalPlaylistSyncTarget(sourceLocalPlaylistId, platform, e.partial.playlistId ?? '')
      return stoppedReport(e.partial, fallbackName)
    }
    throw e
  }
}

/**
 * 先建单再匹配流程：建单 → planSync → choice-needed 挂起（歌单已建）或 executeSync 复用歌单写入。
 * 建单失败直接抛出（失败语义与「歌单不存在」严格一致）。
 */
async function createThenSync(
  finalName: string,
  queries: MatchQuery[],
  target: SyncTarget,
  options: SyncOptions,
  onChoiceNeeded: RunSyncPipelineArgs['onChoiceNeeded'],
  batchSize?: number,
): Promise<SyncReport> {
  const playlistId = await target.createPlaylist(finalName)
  log.info('pipeline.playlist-created', '目标歌单已创建', {
    playlistName: finalName,
    playlistId,
  })
  options.onCheckpoint?.({ stage: 'created', playlistId, added: 0 })

  const plan = await planSync(queries, target, options)
  if (plan.choices.length > 0) {
    log.info('pipeline.choice-needed', '同步需要用户确认', {
      playlistName: finalName,
      total: plan.total,
      matched: plan.matched.length,
      choices: plan.choices.length,
      failed: plan.failed.length,
    })
    onChoiceNeeded(plan, finalName, target, batchSize, playlistId)
    return choiceNeededReport(finalName, plan, playlistId)
  }
  return executeSync(plan, [], finalName, target, { ...options, existingPlaylistId: playlistId })
}

/** 恢复执行补匹配：复用已匹配项（lookupMapping 命中免搜索），匹配完成后写入已建歌单 */
async function completeAfterCreate(
  queries: MatchQuery[],
  playlistName: string,
  playlistId: string,
  target: SyncTarget,
  options: SyncOptions,
  onChoiceNeeded: RunSyncPipelineArgs['onChoiceNeeded'],
  batchSize?: number,
): Promise<SyncReport> {
  const plan = await planSync(queries, target, options)
  if (plan.choices.length > 0) {
    log.info('pipeline.resume-choice-needed', '恢复执行产生待确认选择', {
      playlistName,
      choices: plan.choices.length,
    })
    onChoiceNeeded(plan, playlistName, target, batchSize, playlistId)
    return choiceNeededReport(playlistName, plan, playlistId)
  }
  return executeSync(plan, [], playlistName, target, { ...options, existingPlaylistId: playlistId })
}

/**
 * 执行中任务检查点持久化器：主进程侧兜底定期落库（不依赖渲染进程），
 * 每次写入后广播 sync-history:task-updated 让界面实时刷新。
 * 中断后（含进程崩溃），SQLite 中保留最近检查点：detail（逐首明细）+ playlistId + added。
 */
export function createTaskCheckpoint(taskId: string) {
  const store = getDatabase().syncHistory
  const fallback: SyncTaskRecord = {
    id: taskId,
    name: '',
    targetPlatform: '',
    source: '',
    status: 'running',
    total: 0,
    added: 0,
    failed: 0,
    createdAt: '',
    createdAtMs: 0,
    progress: 0,
    failedDetail: [],
    detail: [],
    rawInput: [],
  }
  let current: SyncTaskRecord = store.getTask(taskId) ?? fallback
  const detailRef: SyncItemResult[] = [...current.detail]
  // 进度类字段高频变化：节流写入，明细/阶段切换立即写入
  let lastProgressWrite = 0
  const PROGRESS_WRITE_INTERVAL_MS = 2000

  const persist = (patch: Partial<SyncTaskRecord>): void => {
    current = { ...current, ...patch }
    getDatabase().syncHistory.upsertTask(current)
    broadcastSync('sync-history:task-updated', current)
  }

  return {
    /** 逐首明细实时落库（同 index 覆盖） */
    onStep(item: SyncItemResult): void {
      const idx = detailRef.findIndex((d) => d.index === item.index)
      if (idx === -1) detailRef.push(item)
      else detailRef[idx] = item
      persist({ detail: [...detailRef] })
    },
    /** 进度节流落库 */
    onProgress(ratio: number): void {
      const now = Date.now()
      if (now - lastProgressWrite < PROGRESS_WRITE_INTERVAL_MS) return
      lastProgressWrite = now
      persist({ progress: ratio })
    },
    /** 阶段切换 / 批次写入检查点立即落库（playlistId + added） */
    onCheckpoint(checkpoint: SyncCheckpoint): void {
      const patch: Partial<SyncTaskRecord> = { status: 'running' }
      if (checkpoint.playlistId !== undefined) patch.playlistId = checkpoint.playlistId
      if (checkpoint.added !== undefined) patch.added = checkpoint.added
      persist(patch)
    },
    /** 终态落库（done/failed/interrupted 等，含失败原因） */
    persistFinal(patch: Partial<SyncTaskRecord>): void {
      persist(patch)
    },
    /** 当前最新任务快照 */
    currentTask(): SyncTaskRecord {
      return current
    },
  }
}

/**
 * 重启自动恢复：应用启动后对上次异常退出残留的 running 任务继续执行。
 * - 有 playlistId：跳过匹配，从已添加数量处续写剩余批次
 * - 无 playlistId：复用已匹配结果重新匹配（已匹配项跳过搜索），再次产生待选择时恢复确认会话
 * 无法恢复（未登录/服务不可用/无输入）时补写失败原因，任务保持 interrupted。
 */
export async function resumePendingSyncTask(task: SyncTaskRecord): Promise<void> {
  const checkpoint = createTaskCheckpoint(task.id)
  const markUnavailable = (reason: string): void => {
    log.warn('resume.unavailable', '任务无法自动恢复执行', { taskId: task.id, reason })
    const detail = task.failedDetail.includes(reason)
      ? task.failedDetail
      : [...task.failedDetail, reason]
    checkpoint.persistFinal({ failedDetail: detail })
  }

  // 恢复执行开始：任务重新进入 running（启动归因时已置 interrupted）
  checkpoint.persistFinal({ status: 'running', progress: 0 })

  const services = getPlatform(task.targetPlatform)
  if (!services.getCredential()) {
    markUnavailable('应用重启后无法自动继续：目标平台未登录')
    return
  }
  try {
    await resolveAdapter(task.targetPlatform)
  } catch (e) {
    markUnavailable(`应用重启后无法自动继续：目标平台服务不可用（${errorMessage(e)}）`)
    return
  }

  const queries = rebuildQueries(task)
  if (queries.length === 0) {
    markUnavailable('应用重启后无法自动继续：缺少原始输入与处理明细')
    return
  }

  const reuseMatches = buildReuseMatches(task.detail)
  const resumePlaylistId = task.playlistId && task.playlistId !== '' ? task.playlistId : undefined
  log.info('resume.start', '开始恢复执行同步任务', {
    taskId: task.id,
    platform: task.targetPlatform,
    queries: queries.length,
    reuse: reuseMatches.length,
    resumePlaylistId: resumePlaylistId ?? '',
    resumeAdded: task.added,
  })

  const notifyProgress = (ratio: number, stage: 'matching' | 'adding'): void => {
    checkpoint.onProgress(ratio)
    broadcastSync('sync:progress', { platform: task.targetPlatform, taskId: task.id, ratio, stage })
  }

  // 恢复执行同样注册运行控制：用户可随时停止（引擎在检查点中止，已保存部分保留）
  const control = beginRunningSync(task.id)
  try {
    const report = await runSyncPipeline({
      platform: task.targetPlatform,
      taskId: task.id,
      queries,
      playlistName: task.name,
      reuseMatches,
      sourceLocalPlaylistId: task.sourceLocalPlaylistId,
      resumePlaylistId,
      resumeAdded: task.added,
      resumeDetail: task.detail,
      signal: control.signal,
      skipCheck: control.skipCheck,
      onStep: (item) => {
        broadcastSync('sync:step', { taskId: task.id, item })
        checkpoint.onStep(item)
      },
      onProgress: notifyProgress,
      onCheckpoint: checkpoint.onCheckpoint,
      onChoiceNeeded: (plan, finalName, target, batchSize, playlistId) => {
        pendingSyncs.set(task.id, {
          platform: task.targetPlatform,
          plan,
          target,
          playlistName: finalName,
          playlistId,
          batchSize,
          sourceLocalPlaylistId: task.sourceLocalPlaylistId,
        })
      },
    })

    if (report.status === 'choice-needed') {
      // 再次产生待选择：任务保持 running，会话由渲染进程启动时恢复确认窗口
      checkpoint.persistFinal({
        status: 'running',
        name: report.playlistName,
        failed: report.failed.length,
        progress: 1,
        failedDetail: failedDetailLines(report.failed),
        detail: report.items,
      })
      log.info('resume.choice-needed', '恢复执行产生待确认选择', {
        taskId: task.id,
        choices: report.choices.length,
      })
      return
    }

    if (report.status === 'stopped') {
      // 停止：已写入部分保留，计数用权威标量（部分 matched 尚未写入，明细派生会虚高）
      checkpoint.persistFinal({
        status: 'stopped',
        name: report.playlistName,
        playlistId: report.playlistId || undefined,
        added: report.added,
        failed: report.failed.length,
        progress: 1,
        failedDetail: failedDetailLines(report.failed),
        detail: report.items,
      })
      log.info('resume.stopped', '恢复执行被用户停止', { taskId: task.id })
      return
    }

    // 先建单流程：歌单已创建即为成功（空歌单在明细与提示中如实呈现，不再虚报失败）
    const ok = report.playlistId !== ''
    // 终态计数以最终明细为权威口径，行摘要与展开明细保持一致
    const counts = deriveTaskCounts(report.items, {
      added: report.added,
      failed: report.failed.length,
    })
    checkpoint.persistFinal({
      status: ok ? 'done' : 'failed',
      name: report.playlistName,
      playlistId: report.playlistId || undefined,
      added: counts.added,
      failed: counts.failed,
      progress: 1,
      failedDetail: failedDetailLines(report.failed),
      detail: report.items,
    })
    log.info('resume.done', '恢复执行完成', {
      taskId: task.id,
      status: ok ? 'done' : 'failed',
      playlistId: report.playlistId,
      added: counts.added,
      failed: counts.failed,
    })
  } catch (e) {
    const msg = errorMessage(e)
    log.error('resume.failed', '恢复执行失败', e, { taskId: task.id })
    // 整体异常：明细收敛为全失败，与 failed=total 标量自洽（不再出现「失败 N / 展开成功 N 首」）
    const detail = markTaskDetailFailed(
      checkpoint.currentTask().detail,
      rebuildQueries(task),
      msg,
    )
    checkpoint.persistFinal({
      status: 'failed',
      progress: 1,
      failed: detail.length || task.total,
      failedDetail: [msg],
      detail,
    })
  } finally {
    control.done()
  }
}
