import { useEffect, useMemo, useRef, useState } from 'react'
import { parseText } from '@core/parser/parseText'
import type { FailedLine } from '@core/models/parse'
import type { PendingConfirmSession, SyncTaskRecord } from '@core/models/sync'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import { useI18n } from '../i18n'
import { useSyncRunner } from '../sync/useSyncRunner'
import { songDupKey, syncFailedText } from '../sync/helpers'
import LineTag from './LineTag'
import PlatformLogo from './PlatformLogo'
import ProgressBar from './ProgressBar'
import { notify } from './toast'

const log = createRendererLogger('renderer.text-creator')

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
  const { t, formatDate } = useI18n()
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
  const [savingLocal, setSavingLocal] = useState(false)

  const { run, running, progress, report, error: syncError, reset: resetResult } = useSyncRunner()

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

  /** 可作为同步目标的平台（声明 write 能力且已连接账号；未配置平台仅在账号管理页出现） */
  const targetPlatforms = useMemo(
    () => platforms.filter((p) => p.capabilities.write && accounts[p.id] !== null),
    [platforms, accounts],
  )

  // 目标平台列表动态变化时，校正当前选择
  useEffect(() => {
    if (!targetPlatforms.some((p) => p.id === target)) {
      setTarget(targetPlatforms[0]?.id ?? '')
    }
  }, [targetPlatforms, target])

  const loggedIn = target !== '' && accounts[target] !== null

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

  /** 导入歌单文件（m3u/m3u8/csv/txt/lrc/json）：内容追加为行，复用自动解析管线 */
  const handleImportFile = async () => {
    try {
      const file = await window.electronAPI.openTextFile()
      if (!file) return
      log.info('text-creator.import-file', '导入歌单文件', { name: file.name })
      const rows = file.content.split(/\r\n|\r|\n/)
      setLines((prev) => [...prev, ...rows])
    } catch (e) {
      log.error('text-creator.import-file-failed', '导入文件失败', e)
      notify('error', t('textCreator.importFailed'), e instanceof Error ? e.message : '')
    }
  }

  /** 保存解析结果到本地歌单库（去重后写入，无需登录） */
  const handleSaveLocal = async () => {
    if (result.songs.length === 0 || savingLocal) return
    setSavingLocal(true)
    try {
      const seen = new Set<string>()
      const songs = result.songs
        .filter((s) => {
          const key = songDupKey(s)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .map((s) => ({ title: s.title, artist: s.artist ?? '' }))
      const name = playlistName.trim() || `${t('textCreator.defaultLocalName')} ${formatDate(new Date())}`
      const created = await window.electronAPI.localPlaylists.create(name, songs)
      log.info('text-creator.save-local', '已保存到本地歌单', {
        id: created?.id,
        count: songs.length,
      })
      notify('success', t('textCreator.savedLocal'), t('textCreator.savedLocalDetail', { name }))
    } catch (e) {
      log.error('text-creator.save-local-failed', '保存到本地歌单失败', e)
      notify('error', t('textCreator.saveLocalFailed'), e instanceof Error ? e.message : '')
    } finally {
      setSavingLocal(false)
    }
  }

  const handleSync = async () => {
    if (result.songs.length === 0) return
    // 留空则由主进程按「今日日期 + 第一首歌风格」自动命名
    const name = playlistName.trim()
    log.info('sync.start', '开始同步', {
      targetPlatform: target,
      playlistName: name || '(自动命名)',
      total: result.songs.length,
    })
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
    await run({
      targetPlatform: target,
      queries,
      name,
      source: 'text-import',
      onTaskUpdate,
      onPendingConfirmChange,
    })
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

  const cancelEdit = () => {
    cancelEditRef.current = true
    setEditingIdx(null)
  }

  return (
    <div>
      <h1 className="font-headline-lg text-headline-lg font-semibold">
        {t('textCreator.title')}
      </h1>
      <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
        {t('textCreator.subtitle')}
      </p>

      <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low">
        {/* 顶部工具行：歌单名（左上）+ 目标平台图标（右上，选中高亮未选置灰） */}
        <div className="flex items-center justify-between gap-3 border-b border-outline-variant px-3 py-2">
          <input
            value={playlistName}
            onChange={(e) => setPlaylistName(e.target.value)}
            placeholder={t('textCreator.playlistNamePlaceholder')}
            className="w-64 rounded-lg border border-outline-variant bg-surface px-3 py-1.5 font-body-md text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary"
          />
          <div className="flex items-center gap-1.5">
            {targetPlatforms.map((p) => {
              const selected = p.id === target
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setTarget(p.id)}
                  title={p.name}
                  className={
                    selected
                      ? 'flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 font-label-sm text-label-sm text-primary'
                      : 'flex items-center gap-1.5 rounded-lg border border-outline-variant px-2.5 py-1 font-label-sm text-label-sm text-on-surface-variant opacity-40 transition-colors hover:opacity-80'
                  }
                >
                  <PlatformLogo platform={p.id} name={p.name} icon={p.icon} />
                  {p.name}
                </button>
              )
            })}
          </div>
        </div>

        {/* TAG 流输入区 */}
        <div
          onClick={() => {
            if (editingIdx === null) draftRef.current?.focus()
          }}
          className="flex min-h-52 w-full cursor-text flex-wrap content-start items-center gap-1.5 p-3 font-body-md text-body-md text-on-surface transition-colors focus-within:border-primary"
        >
            {lines.map((raw, idx) => {
              const lineNo = idx + 1
              const isEditing = editingIdx === idx
              const songIdx = songIdxByLine.get(lineNo)
              if (songIdx !== undefined) {
                const song = result.songs[songIdx]
                const dup = dupFlags[songIdx] ?? false
                return (
                  <LineTag
                    key={`s-${idx}`}
                    kind="song"
                    text={song.title}
                    subtitle={song.artist}
                    dup={dup}
                    raw={raw}
                    tooltip={dup ? t('textCreator.duplicateHint') : raw}
                    editing={isEditing}
                    editingText={editingText}
                    editingWidth={editingWidth}
                    onEditingChange={setEditingText}
                    onStartEdit={(w) => startEdit(idx, w)}
                    onCommitEdit={() => commitEdit(idx)}
                    onCancelEdit={cancelEdit}
                    onRemove={() => removeLine(idx)}
                  />
                )
              }

              const failed = result.failedLines.find((f) => f.lineNumber === lineNo)
              if (failed) {
                return (
                  <LineTag
                    key={`f-${idx}`}
                    kind="failed"
                    text={failed.raw || t('textCreator.emptyLine')}
                    tooltip={t('textCreator.failedLine', {
                      line: lineNo,
                      raw: failed.raw || t('textCreator.emptyLine'),
                      reason: failedReason(failed.reason),
                    })}
                    editing={isEditing}
                    editingText={editingText}
                    editingWidth={editingWidth}
                    onEditingChange={setEditingText}
                    onStartEdit={(w) => startEdit(idx, w)}
                    onCommitEdit={() => commitEdit(idx)}
                    onCancelEdit={cancelEdit}
                    onRemove={() => removeLine(idx)}
                  />
                )
              }

              const ignored = result.ignoredLines.find((f) => f.lineNumber === lineNo)
              if (ignored) {
                return (
                  <LineTag
                    key={`i-${idx}`}
                    kind="ignored"
                    text={raw || t('textCreator.emptyLine')}
                    editing={isEditing}
                    editingText={editingText}
                    editingWidth={editingWidth}
                    onEditingChange={setEditingText}
                    onStartEdit={(w) => startEdit(idx, w)}
                    onCommitEdit={() => commitEdit(idx)}
                    onCancelEdit={cancelEdit}
                    onRemove={() => removeLine(idx)}
                  />
                )
              }
              if (raw.trim() === '') return null

              return (
                <LineTag
                  key={`r-${idx}`}
                  kind="raw"
                  text={raw}
                  editing={isEditing}
                  editingText={editingText}
                  editingWidth={editingWidth}
                  onEditingChange={setEditingText}
                  onStartEdit={(w) => startEdit(idx, w)}
                  onCommitEdit={() => commitEdit(idx)}
                  onCancelEdit={cancelEdit}
                  onRemove={() => removeLine(idx)}
                />
              )
            })}

            {extraSongs.map(({ song, index }) => {
              const dup = dupFlags[index] ?? false
              return (
                <LineTag
                  key={`x-${index}`}
                  kind="song"
                  text={song.title}
                  subtitle={song.artist}
                  dup={dup}
                  editable={false}
                  tooltip={dup ? t('textCreator.duplicateHint') : undefined}
                  onRemove={() => setRemovedExtra((prev) => new Set(prev).add(index))}
                />
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

          {/* 底部条：清空与登录提示（左），创建歌单按钮（右下角） */}
          <div className="flex items-center justify-between gap-3 border-t border-outline-variant px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={() => {
                  log.info('parse.clear', '清空输入')
                  setLines([])
                  setDraft('')
                  setEditingIdx(null)
                  setRemovedExtra(new Set())
                  resetResult()
                }}
                disabled={running}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-base">delete_sweep</span>
                {t('textCreator.clear')}
              </button>
              <button
                onClick={() => void handleImportFile()}
                disabled={running}
                title={t('textCreator.importFile')}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-base">upload_file</span>
                {t('textCreator.importFile')}
              </button>
              <button
                onClick={() => void handleSaveLocal()}
                disabled={savingLocal || result.songs.length === 0}
                title={t('textCreator.saveLocal')}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-1.5 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-primary disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-base">
                  {savingLocal ? 'progress_activity' : 'save'}
                </span>
                {t('textCreator.saveLocal')}
              </button>
              {!loggedIn && (
                <span className="flex min-w-0 items-center gap-1 truncate font-label-sm text-label-sm text-on-surface-variant">
                  <span className="material-symbols-outlined text-sm">switch_account</span>
                  <span className="truncate">
                    {targetPlatforms.length === 0
                      ? t('textCreator.noTarget')
                      : `${t('textCreator.loginFirst')} ${targetPlatforms.find((p) => p.id === target)?.name ?? ''}`}
                  </span>
                </span>
              )}
            </div>
            <button
              onClick={() => void handleSync()}
              disabled={running || pendingConfirm !== null || !loggedIn || result.songs.length === 0}
              className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">
                {running ? 'progress_activity' : 'rocket_launch'}
              </span>
              {running ? t('textCreator.syncing') : t('textCreator.create')}
            </button>
          </div>
        </div>

        {/* 进度与结果（输入块下方） */}
        {running && progress && (
          <div className="mt-3">
            <ProgressBar
              ratio={progress.ratio}
              label={
                <>
                  {progress.stage === 'matching'
                    ? t('textCreator.matching')
                    : t('textCreator.adding')}{' '}
                  {Math.round(progress.ratio * 100)}%
                </>
              }
            />
          </div>
        )}

        {syncError && <p className="mt-2 font-label-sm text-label-sm text-error">{syncError}</p>}

        {report && (
          <div className="mt-2 space-y-1 font-label-sm text-label-sm">
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
                  <li key={i}>· {syncFailedText(t, f)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
    </div>
  )
}
