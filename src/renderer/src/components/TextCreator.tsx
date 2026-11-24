import { useEffect, useMemo, useState } from 'react'
import { parseText } from '@core/parser/parseText'
import type { FailedLine, ParseResult } from '@core/models/parse'
import type { SyncChoice, SyncFailedItem, SyncReport } from '@core/models/sync'
import type { PlatformAccount, PlatformMeta } from '@core/models/platform'
import { createRendererLogger } from '../logging/rendererLogger'
import type { SyncTaskRecord } from '@core/models/sync'
import { useI18n } from '../i18n'
import type { TranslationKey } from '../i18n/translations'

const log = createRendererLogger('renderer.text-creator')

const EXAMPLE = `晴天 - 周杰伦
稻香——周杰伦
夜曲 | 周杰伦
说谎 - 林宥嘉
1. 海阔天空 / Beyond
推荐你听《乌梅子酱》李荣浩`

interface TextCreatorProps {
  platforms: PlatformMeta[]
  accounts: Record<string, PlatformAccount | null>
  onTaskUpdate: (task: SyncTaskRecord) => void
}

const FORMATS: Array<{ icon: string; titleKey: TranslationKey; exampleKey: TranslationKey }> = [
  {
    icon: 'auto_fix_high',
    titleKey: 'textCreator.formats.auto.title',
    exampleKey: 'textCreator.formats.auto.example',
  },
  {
    icon: 'format_list_numbered',
    titleKey: 'textCreator.formats.titleArtist.title',
    exampleKey: 'textCreator.formats.titleArtist.example',
  },
  {
    icon: 'swap_vert',
    titleKey: 'textCreator.formats.artistTitle.title',
    exampleKey: 'textCreator.formats.artistTitle.example',
  },
  {
    icon: 'format_list_bulleted',
    titleKey: 'textCreator.formats.numbered.title',
    exampleKey: 'textCreator.formats.numbered.example',
  },
  {
    icon: 'forum',
    titleKey: 'textCreator.formats.chat.title',
    exampleKey: 'textCreator.formats.chat.example',
  },
  {
    icon: 'filter_alt_off',
    titleKey: 'textCreator.formats.tolerant.title',
    exampleKey: 'textCreator.formats.tolerant.example',
  },
]

export default function TextCreator({ platforms, accounts, onTaskUpdate }: TextCreatorProps) {
  const { t, formatTime, formatDate } = useI18n()
  const [text, setText] = useState('')
  const [result, setResult] = useState<ParseResult | null>(null)
  const [playlistName, setPlaylistName] = useState('')
  const [target, setTarget] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ ratio: number; stage: string } | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [syncError, setSyncError] = useState<string>('')
  const [showFormats, setShowFormats] = useState(false)
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [pendingChoices, setPendingChoices] = useState<SyncChoice[] | null>(null)
  const [selections, setSelections] = useState<Record<number, string>>({})

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

  const handleParse = () => {
    log.info('parse.click', '点击解析歌曲', { chars: text.length })
    setResult(parseText(text))
    setReport(null)
    setSyncError('')
  }

  const applyCandidate = (index: number, title: string, artist?: string) => {
    log.debug('parse.apply-candidate', '点选候选修正字段顺序', { index, title, artist })
    setResult((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        songs: prev.songs.map((s, i) =>
          i === index
            ? { ...s, title, artist, confidence: Math.max(s.confidence, 0.7) }
            : s,
        ),
      }
    })
  }

  const handleSync = async () => {
    if (!result || result.songs.length === 0) return
    log.info('sync.start', '开始同步', {
      targetPlatform: target,
      playlistName: playlistName.trim() || '(自动命名)',
      total: result.songs.length,
    })
    setSyncing(true)
    setSyncError('')
    setReport(null)
    setProgress({ ratio: 0, stage: 'matching' })

    const name =
      playlistName.trim() || t('textCreator.defaultPlaylistName', { date: formatDate(new Date()) })
    const taskId = `task-${Date.now()}`
    const queries = result.songs.map((s) => ({
      title: s.title,
      artist: s.artist,
      alternatives: s.candidates?.map((c) => ({ title: c.title, artist: c.artist })),
    }))

    onTaskUpdate({
      id: taskId,
      name,
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
          name,
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
        await window.electronAPI.platforms.syncPlaylist(target, queries, name)

      if (rep.status === 'choice-needed') {
        log.info('sync.choice-needed', '同步需要手动选择', {
          targetPlatform: target,
          choices: rep.choices.length,
        })
        setPendingTaskId(syncTaskId)
        setPendingChoices(rep.choices)
        setSelections({})
        onTaskUpdate({
          id: taskId,
          name,
          targetPlatform: target,
          source: 'text-import',
          status: 'running',
          total: queries.length,
          added: 0,
          failed: rep.failed.length,
          createdAt: formatTime(new Date()),
          progress: 1,
          failedDetail: rep.failed.map(failedMessage),
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
        name,
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
        name,
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

  const handleConfirm = async () => {
    if (!pendingTaskId || !pendingChoices) return
    const sel = pendingChoices
      .map((_, i) => ({ choiceIndex: i, songId: selections[i] }))
      .filter((s) => typeof s.songId === 'string')
    if (sel.length < pendingChoices.length) return

    log.info('sync.confirm', '确认手动选择并继续同步', {
      targetPlatform: target,
      selections: sel.length,
    })
    setSyncing(true)
    setSyncError('')
    setReport(null)
    setProgress({ ratio: 0, stage: 'adding' })

    const off = window.electronAPI.platforms.onSyncProgress((p) => {
      if (p.platform === target) setProgress(p)
    })

    try {
      const rep = await window.electronAPI.platforms.confirmSync(target, pendingTaskId, sel)
      log.info('sync.confirm-done', '确认同步完成', {
        targetPlatform: target,
        playlistId: rep.playlistId,
        added: rep.added,
        failed: rep.failed.length,
      })
      setReport(rep)
      setPendingTaskId(null)
      setPendingChoices(null)
      setSelections({})
      const ok = rep.playlistId !== ''
      onTaskUpdate({
        id: `task-${Date.now()}`,
        name: rep.playlistName,
        targetPlatform: target,
        source: 'text-import',
        status: ok ? 'done' : 'failed',
        total: rep.total,
        added: rep.added,
        failed: rep.failed.length,
        createdAt: formatTime(new Date()),
        progress: 1,
        failedDetail: rep.failed.map(failedMessage),
      })
    } catch (e) {
      log.error('sync.confirm-failed', '确认同步失败', e, { targetPlatform: target })
      setSyncError(e instanceof Error ? e.message : t('sync.failedGeneric'))
    } finally {
      off()
      setSyncing(false)
      setProgress(null)
    }
  }

  const failedCount = result?.failedLines.length ?? 0

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-label-mono text-label-mono text-primary">
            <span className="material-symbols-outlined text-sm">data_object</span>
            <span>MODULE://TEXT_IMPORT PARSER_CORE_V2.1</span>
          </div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">
            {t('textCreator.title')}
          </h1>
          <p className="mt-1 max-w-xl font-body-md text-body-md text-on-surface-variant">
            {t('textCreator.subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              log.info('parse.load-example', '载入示例数据')
              setText(EXAMPLE)
              setResult(null)
            }}
            className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-base">auto_fix_high</span>
            {t('textCreator.loadExample')}
            <span className="font-label-mono text-label-mono text-outline">⌥E</span>
          </button>
          <button
            onClick={() =>
              setShowFormats((v) => {
                log.info('parse.toggle-formats', '切换格式说明', { show: !v })
                return !v
              })
            }
            className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-base">help_outline</span>
            {t('textCreator.formatHelp')}
            <span className="material-symbols-outlined text-sm">
              {showFormats ? 'expand_less' : 'expand_more'}
            </span>
          </button>
        </div>
      </div>

      {showFormats && (
        <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low p-4">
          <p className="font-label-mono text-label-mono text-outline">SUPPORTED FORMATS</p>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            {FORMATS.map((f) => (
              <div key={f.titleKey} className="flex items-start gap-2">
                <span className="material-symbols-outlined text-base text-primary">{f.icon}</span>
                <div>
                  <p className="font-label-md text-label-md font-medium">{t(f.titleKey)}</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">
                    {t(f.exampleKey)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex gap-4">
        <div className="min-w-0 flex-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`${t('textCreator.textareaPlaceholder')}\n${EXAMPLE}`}
            rows={12}
            className="w-full resize-y rounded-lg border border-outline-variant bg-surface-container-low p-4 font-mono text-body-md text-on-surface outline-none placeholder:text-outline focus:border-primary"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={handleParse}
              disabled={!text.trim() || syncing}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">manage_search</span>
              {t('textCreator.parse')}
            </button>
            <button
              onClick={() => {
                log.info('parse.clear', '清空输入')
                setText('')
                setResult(null)
                setReport(null)
                setSyncError('')
              }}
              disabled={syncing}
              className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-4 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">delete_sweep</span>
              {t('textCreator.clear')}
            </button>
            <span className="ml-auto font-label-sm text-label-sm text-on-surface-variant">
              <span className="material-symbols-outlined align-bottom text-sm">auto_awesome</span>{' '}
              {t('textCreator.autoHint')}
            </span>
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
                disabled={syncing || pendingChoices !== null || !result || result.songs.length === 0}
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

      {result && (
        <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low">
          <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2">
            <p className="font-label-md text-label-md text-on-surface">
              {t('textCreator.recognizedPrefix')}{' '}
              <span className="font-medium text-primary">{result.songs.length}</span>{' '}
              {t('textCreator.recognizedSuffix')}
              {failedCount > 0 && (
                <span className="ml-2 text-tertiary">
                  {t('textCreator.linesFailed', { count: failedCount })}
                </span>
              )}
              {result.detectedOrder && (
                <span className="ml-2 rounded-full bg-surface-container-highest px-2 py-0.5 text-label-sm text-on-surface-variant">
                  {t('textCreator.autoDetected')}
                  {result.detectedOrder === 'title-first'
                    ? t('textCreator.titleArtist')
                    : t('textCreator.artistTitle')}
                </span>
              )}
            </p>
            <span className="font-label-mono text-label-mono text-outline">
              {result.format === 'share' ? 'SHARE TEXT' : 'PARSE PREVIEW'}
            </span>
          </div>

          {result.songs.length > 0 && (
            <ul className="max-h-96 divide-y divide-outline-variant overflow-y-auto">
              {result.songs.map((s, i) => {
                const ambiguous = s.candidates && s.candidates.length > 1
                return (
                  <li
                    key={`${s.lineNumber}-${i}`}
                    className={`flex items-center gap-3 px-4 py-1.5 font-body-md text-body-md ${
                      ambiguous ? 'bg-tertiary/10' : ''
                    }`}
                  >
                    <span className="w-6 text-right font-label-mono text-label-mono text-outline">
                      {i + 1}
                    </span>
                    <span className="truncate">{s.title}</span>
                    {s.artist ? (
                      <span className="truncate text-on-surface-variant">- {s.artist}</span>
                    ) : (
                      <span className="text-tertiary">{t('textCreator.noArtist')}</span>
                    )}
                    {ambiguous && (
                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {s.candidates!.map((c) => {
                          const active = c.title === s.title
                          return (
                            <button
                              key={c.title}
                              onClick={() => applyCandidate(i, c.title, c.artist)}
                              title={t('textCreator.pickCandidate')}
                              className={
                                active
                                  ? 'rounded-lg border border-primary bg-primary px-2 py-0.5 font-label-sm text-label-sm text-on-primary'
                                  : 'rounded-lg border border-outline-variant bg-surface-container-low px-2 py-0.5 font-label-sm text-label-sm text-on-surface transition-colors hover:border-primary'
                              }
                            >
                              {c.title}
                              {c.artist ? ` · ${c.artist}` : ''}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {failedCount > 0 && (
            <ul className="space-y-1 border-t border-outline-variant px-4 py-2">
              {result.failedLines.map((f) => (
                <li key={f.lineNumber} className="font-label-sm text-label-sm text-error">
                  {t('textCreator.failedLine', {
                    line: f.lineNumber,
                    raw: f.raw || t('textCreator.emptyLine'),
                    reason: failedReason(f.reason),
                  })}
                </li>
              ))}
            </ul>
          )}

          {result.ignoredLines.length > 0 && (
            <p className="border-t border-outline-variant px-4 py-2 font-label-sm text-label-sm text-on-surface-variant">
              {t('textCreator.ignoredLines', { count: result.ignoredLines.length })}
            </p>
          )}
        </div>
      )}

      {pendingChoices && pendingChoices.length > 0 && (
        <div className="mt-4 rounded-lg border border-tertiary bg-surface-container-low p-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-tertiary">playlist_add_check</span>
            <p className="font-body-md text-body-md font-medium">
              {t('textCreator.choiceTitle', { count: pendingChoices.length })}
            </p>
            <span className="ml-auto font-label-sm text-label-sm text-on-surface-variant">
              {t('textCreator.choiceHint')}
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {pendingChoices.map((choice, i) => (
              <li
                key={i}
                className="rounded-lg border border-outline-variant bg-surface-container-lowest p-3"
              >
                <p className="font-label-md text-label-md text-on-surface">
                  {choice.query.title}
                  {choice.query.artist && (
                    <span className="ml-1 text-on-surface-variant">- {choice.query.artist}</span>
                  )}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {choice.candidates.map((c) => {
                    const selected = selections[i] === c.id
                    const duration = c.durationMs
                      ? ` · ${Math.floor(c.durationMs / 60_000)}:${String(
                          Math.floor((c.durationMs % 60_000) / 1000),
                        ).padStart(2, '0')}`
                      : ''
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelections((prev) => ({ ...prev, [i]: c.id }))}
                        className={
                          selected
                            ? 'flex items-center gap-1 rounded-lg border border-primary bg-primary px-3 py-1.5 font-label-sm text-label-sm text-on-primary'
                            : 'flex items-center gap-1 rounded-lg border border-outline-variant bg-surface-container-low px-3 py-1.5 font-label-sm text-label-sm text-on-surface transition-colors hover:border-primary'
                        }
                      >
                        <span className="font-medium">{c.artist}</span>
                        {c.album && <span className="opacity-70">{c.album}</span>}
                        {duration}
                      </button>
                    )
                  })}
                </div>
              </li>
            ))}
          </ul>
          <button
            onClick={handleConfirm}
            disabled={
              syncing || Object.keys(selections).length < pendingChoices.length
            }
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85 disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-base">
              {syncing ? 'progress_activity' : 'task_alt'}
            </span>
            {syncing ? t('textCreator.writing') : t('textCreator.confirmAndCreate')}
          </button>
          {syncError && <p className="mt-2 font-label-sm text-label-sm text-error">{syncError}</p>}
        </div>
      )}
    </div>
  )
}
