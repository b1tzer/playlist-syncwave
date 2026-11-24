import { useEffect, useMemo, useRef, useState } from 'react'
import { parseText } from '@core/parser/parseText'
import { normalize } from '@core/matcher/matchSong'
import type { FailedLine } from '@core/models/parse'
import type { PendingConfirmSession, SyncFailedItem, SyncReport, SyncTaskRecord } from '@core/models/sync'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'

const log = createRendererLogger('renderer.text-creator')

/** 歌曲去重键：标题+歌手归一化（与匹配引擎同口径） */
const songDupKey = (s: { title: string; artist?: string }): string =>
  `${normalize(s.title)}|${normalize(s.artist ?? '')}`

/** 输入区草稿持久化：刷新/重启后保留用户输入 */
const STORAGE_LINES = 'textCreator.lines'
const STORAGE_DRAFT = 'textCreator.draft'

function loadLines(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_LINES)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : []
  } catch {
    return []
  }
}

function loadDraft(): string {
  try {
    return localStorage.getItem(STORAGE_DRAFT) ?? ''
  } catch {
    return ''
  }
}

interface EditInputProps {
  value: string
  /** 与被替换文本等宽，避免布局重排引起页面跳动 */
  width: number
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}

/** 原位编辑框：继承 tag 字体与行高，零边框零内边距，宽度与原文一致 */
function EditInput({ value, width, onChange, onCommit, onCancel }: EditInputProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit()
        if (e.key === 'Escape') onCancel()
      }}
      ref={(el) => {
        // 仅首次聚焦，且禁止滚动：聚焦不应引起页面跳动
        if (el && document.activeElement !== el) {
          el.focus({ preventScroll: true })
        }
      }}
      style={{ width }}
      className="m-0 min-w-8 max-w-56 border-0 bg-surface p-0 font-label-md text-label-md text-on-surface caret-primary outline-none [font-family:inherit]"
    />
  )
}

interface TextCreatorProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  onTaskUpdate: (task: SyncTaskRecord) => void
  /** 待确认会话（App 层持有，选择流程由 ConfirmSyncDialog 完成） */
  pendingConfirm: PendingConfirmSession | null
  onPendingConfirmChange: (session: PendingConfirmSession | null) => void
}

export default function TextCreator({
  platforms,
  accounts,
  onTaskUpdate,
  pendingConfirm,
  onPendingConfirmChange,
}: TextCreatorProps) {
  const { t, formatTime, formatDate } = useI18n()
  const [lines, setLines] = useState<string[]>(loadLines)
  const [draft, setDraft] = useState(loadDraft)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingText, setEditingText] = useState('')
  const [editingWidth, setEditingWidth] = useState(120)
  const [removedExtra, setRemovedExtra] = useState<Set<number>>(new Set())
  const draftRef = useRef<HTMLInputElement>(null)
  const cancelEditRef = useRef(false)
  const [playlistName, setPlaylistName] = useState('')
  const [target, setTarget] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ ratio: number; stage: string } | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [syncError, setSyncError] = useState<string>('')

  // 草稿持久化：任意变化即写回，刷新/重启后恢复
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_LINES, JSON.stringify(lines))
    } catch {
      // 存储不可用时静默降级（内存态仍可用）
    }
  }, [lines])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_DRAFT, draft)
    } catch {
      // 同上
    }
  }, [draft])

  // 输入即解析：行集合为唯一数据源，逐行转换为标签
  const result = useMemo(() => parseText(lines.join('\n')), [lines])

  // 行号（1-based）→ songs 下标（结构化格式行号可能重复，只取第一个）
  const songIdxByLine = useMemo(() => {
    const map = new Map<number, number>()
    result.songs.forEach((s, i) => {
      if (!map.has(s.lineNumber)) map.set(s.lineNumber, i)
    })
    return map
  }, [result])

  // 无对应行可挂载的歌曲（结构化格式行号错位）追加渲染在标签流之后
  const extraSongs = useMemo(() => {
    const used = new Set(songIdxByLine.values())
    return result.songs
      .map((s, i) => ({ song: s, index: i }))
      .filter(({ index }) => !used.has(index) && !removedExtra.has(index))
  }, [result, songIdxByLine, removedExtra])

  // 每首歌是否重复（首次出现为 false，后续重复项标记灰调）
  const dupFlags = useMemo(() => {
    const seen = new Set<string>()
    return result.songs.map((s) => {
      const key = songDupKey(s)
      const dup = seen.has(key)
      seen.add(key)
      return dup
    })
  }, [result])

  /** 可作为同步目标的平台（声明 write 能力） */
  const targetPlatforms = useMemo(
    () => platforms.filter((p) => p.capabilities.write),
    [platforms],
  )

  // 目标平台列表动态变化时，校正当前选择
  useEffect(() => {
    if (!targetPlatforms.some((p) => p.id === target)) {
      setTarget(targetPlatforms[0]?.id ?? '')
    }
  }, [targetPlatforms, target])

  const loggedIn = target !== '' && accounts[target] !== null

  /** 同步失败条目按稳定 reason 码翻译；平台原始错误（search-failed）直接透传。 */
  const failedMessage = (f: SyncFailedItem): string => {
    const title = `${f.query.title}${f.query.artist ? ` - ${f.query.artist}` : ''}`
    switch (f.reason) {
      case 'no-match':
        return t('sync.failedNoMatch', { title })
      case 'unresolved':
        return t('sync.failedUnresolved', { title })
      case 'rate-limited':
        return t('sync.failedRateLimited')
      default:
        return f.message
    }
  }

  const failedReason = (reason: FailedLine['reason']): string => {
    switch (reason) {
      case 'missing-title':
        return t('textCreator.missingTitle')
      case 'missing-artist':
        return t('textCreator.missingArtist')
      case 'ambiguous-order':
        return t('textCreator.ambiguousOrder')
      default:
        return t('textCreator.unrecognized')
    }
  }

  // 字段顺序歧义不再提供手动切换：同步阶段由平台搜索自动验证（正反候选搜索）裁决

  const handleSync = async () => {
    if (result.songs.length === 0) return
    const autoNameDate = formatDate(new Date())
    // 留空则由主进程按「今日日期 + 第一首歌风格」自动命名
    const name = playlistName.trim()
    log.info('sync.start', '开始同步', {
      targetPlatform: target,
      playlistName: name || '(自动命名)',
      total: result.songs.length,
    })
    setSyncing(true)
    setSyncError('')
    setReport(null)
    setProgress({ ratio: 0, stage: 'matching' })

    const taskId = `task-${Date.now()}`
    // 创建时自动去重：保留首次出现的歌曲，重复项跳过
    const seen = new Set<string>()
    const queries = result.songs
      .filter((s) => {
        const key = songDupKey(s)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((s) => ({
        title: s.title,
        artist: s.artist,
        alternatives: s.candidates?.map((c) => ({ title: c.title, artist: c.artist })),
      }))

    onTaskUpdate({
      id: taskId,
      name: name || autoNameDate,
      targetPlatform: target,
      source: 'text-import',
      status: 'running',
      total: queries.length,
      added: 0,
      failed: 0,
      createdAt: formatTime(new Date()),
      progress: 0,
      failedDetail: [],
    })

    const off = window.electronAPI.platforms.onSyncProgress((p) => {
      if (p.platform === target) {
        setProgress(p)
        onTaskUpdate({
          id: taskId,
          name: name || autoNameDate,
          targetPlatform: target,
          source: 'text-import',
          status: 'running',
          total: queries.length,
          added: 0,
          failed: 0,
          createdAt: formatTime(new Date()),
          progress: p.ratio,
          failedDetail: [],
        })
      }
    })

    try {
      const { taskId: syncTaskId, report: rep } =
        await window.electronAPI.platforms.syncPlaylist(target, queries, name, autoNameDate)

      if (rep.status === 'choice-needed') {
        log.info('sync.choice-needed', '同步需要手动选择', {
          targetPlatform: target,
          choices: rep.choices.length,
        })
        const runningTask: SyncTaskRecord = {
          id: taskId,
          name: rep.playlistName,
          targetPlatform: target,
          source: 'text-import',
          status: 'running',
          total: queries.length,
          added: 0,
          failed: rep.failed.length,
          createdAt: formatTime(new Date()),
          progress: 1,
          failedDetail: rep.failed.map(failedMessage),
        }
        onTaskUpdate(runningTask)
        // 会话提升到 App 层：分步确认弹窗接管选择流程
        onPendingConfirmChange({
          syncTaskId,
          task: runningTask,
          target,
          choices: rep.choices,
        })
        return
      }

      setReport(rep)
      const ok = rep.playlistId !== ''
      log.info('sync.done', '同步结束', {
        targetPlatform: target,
        playlistId: rep.playlistId,
        added: rep.added,
        failed: rep.failed.length,
      })
      onTaskUpdate({
        id: taskId,
        name: rep.playlistName,
        targetPlatform: target,
        source: 'text-import',
        status: ok ? 'done' : 'failed',
        total: queries.length,
        added: rep.added,
        failed: rep.failed.length,
        createdAt: formatTime(new Date()),
        progress: 1,
        failedDetail: rep.failed.map(failedMessage),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('sync.failedGeneric')
      log.error('sync.failed', '同步失败', e, { targetPlatform: target })
      setSyncError(msg)
      onTaskUpdate({
        id: taskId,
        name: name || autoNameDate,
        targetPlatform: target,
        source: 'text-import',
        status: 'failed',
        total: queries.length,
        added: 0,
        failed: queries.length,
        createdAt: formatTime(new Date()),
        progress: 1,
        failedDetail: [msg],
      })
    } finally {
      off()
      setSyncing(false)
      setProgress(null)
    }
  }

  const commitDraft = () => {
    const rows = draft.split(/\r?\n/)
    setDraft('')
    if (rows.some((r) => r.trim() !== '')) {
      setLines((prev) => [...prev, ...rows])
    }
  }

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx))
    setEditingIdx((cur) => (cur === idx ? null : cur))
  }

  const startEdit = (idx: number, width: number) => {
    cancelEditRef.current = false
    setEditingIdx(idx)
    setEditingText(lines[idx])
    setEditingWidth(width)
  }

  const commitEdit = (idx: number) => {
    if (cancelEditRef.current) {
      cancelEditRef.current = false
    } else {
      setLines((prev) => prev.map((l, i) => (i === idx ? editingText : l)))
    }
    setEditingIdx(null)
  }

  return (
    <div>
      <div>
        <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">
          {t('textCreator.title')}
        </h1>
        <p className="mt-1 max-w-xl font-body-md text-body-md text-on-surface-variant">
          {t('textCreator.subtitle')}
        </p>
      </div>

      <div className="mt-4 flex gap-4">
        <div className="min-w-0 flex-1">
          <div
            onClick={() => {
              if (editingIdx === null) draftRef.current?.focus()
            }}
            className="flex min-h-52 w-full cursor-text flex-wrap content-start items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low p-3 font-body-md text-body-md text-on-surface transition-colors focus-within:border-primary"
          >
            {lines.map((raw, idx) => {
              const lineNo = idx + 1
              const isEditing = editingIdx === idx
              const songIdx = songIdxByLine.get(lineNo)
              if (songIdx !== undefined) {
                const song = result.songs[songIdx]
                const dup = dupFlags[songIdx] ?? false
                return (
                  <span
                    key={`s-${idx}`}
                    title={dup ? t('textCreator.duplicateHint') : raw}
                    className={
                      dup
                        ? 'group inline-flex max-w-full items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high/60 px-2.5 py-1.5 font-label-md text-label-md text-on-surface-variant'
                        : 'group inline-flex max-w-full items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-label-md text-label-md text-on-surface'
                    }
                  >
                    {dup && (
                      <span
                        title={t('textCreator.duplicateHint')}
                        className="flex items-center rounded bg-outline-variant/60 p-0.5 text-on-surface-variant"
                      >
                        <span className="material-symbols-outlined text-xs">content_copy</span>
                      </span>
                    )}
                    <span
                      className={
                        dup
                          ? 'material-symbols-outlined text-sm text-outline'
                          : 'material-symbols-outlined text-sm text-primary'
                      }
                    >
                      music_note
                    </span>
                    {isEditing ? (
                      <EditInput
                        value={editingText}
                        width={editingWidth}
                        onChange={setEditingText}
                        onCommit={() => commitEdit(idx)}
                        onCancel={() => {
                          cancelEditRef.current = true
                          setEditingIdx(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => startEdit(idx, e.currentTarget.offsetWidth)}
                        title={`${raw}（${t('textCreator.editHint')}）`}
                        className={
                          dup
                            ? 'max-w-56 cursor-text truncate transition-colors hover:text-on-surface hover:underline'
                            : 'max-w-56 cursor-text truncate transition-colors hover:text-primary hover:underline'
                        }
                      >
                        {song.title}
                        {song.artist ? (
                          <span className={dup ? 'text-outline' : 'text-on-surface-variant'}>
                            {' '}
                            · {song.artist}
                          </span>
                        ) : null}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeLine(idx)
                      }}
                      className="material-symbols-outlined text-sm text-outline transition-colors hover:text-error"
                    >
                      close
                    </button>
                  </span>
                )
              }

              const failed = result.failedLines.find((f) => f.lineNumber === lineNo)
              if (failed) {
                return (
                  <span
                    key={`f-${idx}`}
                    title={t('textCreator.failedLine', {
                      line: lineNo,
                      raw: failed.raw || t('textCreator.emptyLine'),
                      reason: failedReason(failed.reason),
                    })}
                    className="group inline-flex max-w-full items-center gap-1 rounded-lg border border-error/50 bg-error/10 px-2.5 py-1.5 font-label-md text-label-md text-error"
                  >
                    <span className="material-symbols-outlined text-sm">error_outline</span>
                    {isEditing ? (
                      <EditInput
                        value={editingText}
                        width={editingWidth}
                        onChange={setEditingText}
                        onCommit={() => commitEdit(idx)}
                        onCancel={() => {
                          cancelEditRef.current = true
                          setEditingIdx(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => startEdit(idx, e.currentTarget.offsetWidth)}
                        className="max-w-56 cursor-text truncate transition-colors hover:underline"
                      >
                        {failed.raw || t('textCreator.emptyLine')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeLine(idx)
                      }}
                      className="material-symbols-outlined text-sm text-outline transition-colors hover:text-error"
                    >
                      close
                    </button>
                  </span>
                )
              }

              const ignored = result.ignoredLines.find((f) => f.lineNumber === lineNo)
              if (ignored) {
                return (
                  <span
                    key={`i-${idx}`}
                    className="group inline-flex max-w-full items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high/40 px-2.5 py-1.5 font-label-md text-label-md text-outline"
                  >
                    <span className="material-symbols-outlined text-sm">filter_alt_off</span>
                    {isEditing ? (
                      <EditInput
                        value={editingText}
                        width={editingWidth}
                        onChange={setEditingText}
                        onCommit={() => commitEdit(idx)}
                        onCancel={() => {
                          cancelEditRef.current = true
                          setEditingIdx(null)
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => startEdit(idx, e.currentTarget.offsetWidth)}
                        title={t('textCreator.ignoredLine')}
                        className="max-w-56 cursor-text truncate line-through transition-colors hover:text-on-surface"
                      >
                        {raw || t('textCreator.emptyLine')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeLine(idx)
                      }}
                      className="material-symbols-outlined text-sm text-outline transition-colors hover:text-error"
                    >
                      close
                    </button>
                  </span>
                )
              }
              if (raw.trim() === '') return null

              return (
                <span
                  key={`r-${idx}`}
                  className="group inline-flex max-w-full items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high px-2.5 py-1.5 font-label-md text-label-md text-on-surface-variant"
                >
                  {isEditing ? (
                    <EditInput
                      value={editingText}
                      width={editingWidth}
                      onChange={setEditingText}
                      onCommit={() => commitEdit(idx)}
                      onCancel={() => {
                        cancelEditRef.current = true
                        setEditingIdx(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => startEdit(idx, e.currentTarget.offsetWidth)}
                      className="max-w-56 cursor-text truncate transition-colors hover:text-on-surface hover:underline"
                    >
                      {raw}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeLine(idx)
                    }}
                    className="material-symbols-outlined text-sm text-outline transition-colors hover:text-error"
                  >
                    close
                  </button>
                </span>
              )
            })}

            {extraSongs.map(({ song, index }) => {
              const dup = dupFlags[index] ?? false
              return (
                <span
                  key={`x-${index}`}
                  title={dup ? t('textCreator.duplicateHint') : undefined}
                  className={
                    dup
                      ? 'group inline-flex max-w-full items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-high/60 px-2.5 py-1.5 font-label-md text-label-md text-on-surface-variant'
                      : 'group inline-flex max-w-full items-center gap-1 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-label-md text-label-md text-on-surface'
                  }
                >
                  {dup && (
                    <span
                      title={t('textCreator.duplicateHint')}
                      className="flex items-center rounded bg-outline-variant/60 p-0.5 text-on-surface-variant"
                    >
                      <span className="material-symbols-outlined text-xs">content_copy</span>
                    </span>
                  )}
                  <span
                    className={
                      dup
                        ? 'material-symbols-outlined text-sm text-outline'
                        : 'material-symbols-outlined text-sm text-primary'
                    }
                  >
                    music_note
                  </span>
                  <span className="max-w-56 truncate">
                    {song.title}
                    {song.artist ? (
                      <span className={dup ? 'text-outline' : 'text-on-surface-variant'}>
                        {' '}
                        · {song.artist}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRemovedExtra((prev) => new Set(prev).add(index))}
                    className="material-symbols-outlined text-sm text-outline transition-colors hover:text-error"
                  >
                    close
                  </button>
                </span>
              )
            })}

            <input
              ref={draftRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                // 单行 input 会把粘贴的换行符净化为空格，需在净化前按行拆分提交
                const text = e.clipboardData.getData('text')
                if (!/[\r\n]/.test(text)) return
                e.preventDefault()
                const parts = text.split(/\r\n|\r|\n/)
                const last = parts.pop() ?? ''
                if (parts.length > 0) {
                  parts[0] = draft + parts[0]
                  setLines((prev) => [...prev, ...parts])
                }
                setDraft(last)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commitDraft()
                }
                if (e.key === 'Backspace' && draft === '' && lines.length > 0 && editingIdx === null) {
                  removeLine(lines.length - 1)
                }
              }}
              placeholder={lines.length === 0 ? t('textCreator.tagPlaceholder') : ''}
              className="min-w-48 flex-1 bg-transparent px-1 py-1.5 font-mono text-body-md text-on-surface outline-none placeholder:text-outline"
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => {
                log.info('parse.clear', '清空输入')
                setLines([])
                setDraft('')
                setEditingIdx(null)
                setRemovedExtra(new Set())
                setReport(null)
                setSyncError('')
              }}
              disabled={syncing}
              className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-4 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">delete_sweep</span>
              {t('textCreator.clear')}
            </button>
          </div>
        </div>

        <div className="w-72 shrink-0">
          {loggedIn ? (
            <div className="flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
              <p className="font-label-mono text-label-mono text-outline">SYNC TARGET</p>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-body-md text-body-md text-on-surface outline-none focus:border-primary"
              >
                {targetPlatforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t('textCreator.syncTo', { name: p.name })}
                  </option>
                ))}
              </select>
              <input
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                placeholder={t('textCreator.playlistNamePlaceholder')}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary"
              />
              <button
                onClick={handleSync}
                disabled={syncing || pendingConfirm !== null || result.songs.length === 0}
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-base">
                  {syncing ? 'progress_activity' : 'rocket_launch'}
                </span>
                {syncing ? t('textCreator.syncing') : t('textCreator.createAndSync')}
              </button>

              {syncing && progress && (
                <div className="mt-1">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.round(progress.ratio * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">
                    {progress.stage === 'matching'
                      ? t('textCreator.matching')
                      : t('textCreator.adding')}{' '}
                    {Math.round(progress.ratio * 100)}%
                  </p>
                </div>
              )}

              {syncError && (
                <p className="font-label-sm text-label-sm text-error">{syncError}</p>
              )}

              {report && (
                <div className="space-y-1 font-label-sm text-label-sm">
                  {report.playlistId ? (
                    <p className="text-on-surface">
                      <span className="font-medium text-primary">{t('textCreator.syncDone')}</span>
                      {t('textCreator.syncDoneDetail', {
                        added: report.added,
                        total: report.total,
                        name: report.playlistName,
                      })}
                    </p>
                  ) : (
                    <p className="text-on-surface">
                      <span className="font-medium text-tertiary">
                        {t('textCreator.noPlaylist')}
                      </span>
                      {t('textCreator.noPlaylistDetail')}
                    </p>
                  )}
                  {report.failed.length > 0 && (
                    <ul className="max-h-24 space-y-1 overflow-y-auto text-error">
                      {report.failed.map((f, i) => (
                        <li key={i}>· {failedMessage(f)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-outline-variant p-4 text-center">
              <span className="material-symbols-outlined text-3xl text-outline">switch_account</span>
              <p className="mt-2 font-label-sm text-label-sm text-on-surface-variant">
                {t('textCreator.loginFirst')}{' '}
                {targetPlatforms.find((p) => p.id === target)?.name ?? ''}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
