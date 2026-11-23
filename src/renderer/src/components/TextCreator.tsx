import { useState } from 'react'
import { parseText } from '@core/parser/parseText'
import type { ParseResult } from '@core/models/parse'
import type { SyncChoice, SyncReport } from '@core/models/sync'
import type { PlatformAccount } from '@core/models/platform'
import type { SyncTaskRecord } from './SyncCenter'

const EXAMPLE = `晴天 - 周杰伦
稻香——周杰伦
夜曲 | 周杰伦
说谎 - 林宥嘉
1. 海阔天空 / Beyond
推荐你听《乌梅子酱》李荣浩`

export const TARGET_PLATFORMS: Array<{ id: string; name: string }> = [
  { id: 'netease', name: '网易云音乐' },
  { id: 'qqmusic', name: 'QQ音乐' },
]

interface TextCreatorProps {
  accounts: Record<string, PlatformAccount | null>
  onTaskUpdate: (task: SyncTaskRecord) => void
}

const FORMATS = [
  { icon: 'auto_fix_high', title: '自动嗅探模式', example: '歌名与歌手顺序自动识别' },
  { icon: 'format_list_numbered', title: '歌名 - 歌手', example: '晴天 - 周杰伦' },
  { icon: 'swap_vert', title: '歌手 - 歌名', example: 'Taylor Swift - Cruel Summer' },
  { icon: 'format_list_bulleted', title: '序列编号清单', example: '1. 海阔天空 / Beyond' },
  { icon: 'forum', title: '微信/社群聊天混排', example: '推荐你听《乌梅子酱》李荣浩' },
  { icon: 'filter_alt_off', title: '内置容错', example: '自动过滤表情包、多余标点、时间戳' },
]

export default function TextCreator({ accounts, onTaskUpdate }: TextCreatorProps) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<ParseResult | null>(null)
  const [playlistName, setPlaylistName] = useState('')
  const [target, setTarget] = useState('netease')
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ ratio: number; stage: string } | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [syncError, setSyncError] = useState<string>('')
  const [showFormats, setShowFormats] = useState(false)
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [pendingChoices, setPendingChoices] = useState<SyncChoice[] | null>(null)
  const [selections, setSelections] = useState<Record<number, string>>({})

  const loggedIn = accounts[target] !== null

  const handleParse = () => {
    setResult(parseText(text))
    setReport(null)
    setSyncError('')
  }

  const applyCandidate = (index: number, title: string, artist?: string) => {
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
    setSyncing(true)
    setSyncError('')
    setReport(null)
    setProgress({ ratio: 0, stage: 'matching' })

    const name = playlistName.trim() || `文本导入 ${new Date().toLocaleDateString()}`
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
      source: '文本导入',
      status: 'running',
      total: queries.length,
      added: 0,
      failed: 0,
      createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
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
          source: '文本导入',
          status: 'running',
          total: queries.length,
          added: 0,
          failed: 0,
          createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          progress: p.ratio,
          failedDetail: [],
        })
      }
    })

    try {
      const { taskId: syncTaskId, report: rep } =
        await window.electronAPI.platforms.syncPlaylist(target, queries, name)

      if (rep.status === 'choice-needed') {
        setPendingTaskId(syncTaskId)
        setPendingChoices(rep.choices)
        setSelections({})
        onTaskUpdate({
          id: taskId,
          name,
          targetPlatform: target,
          source: '文本导入',
          status: 'running',
          total: queries.length,
          added: 0,
          failed: rep.failed.length,
          createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
          progress: 1,
          failedDetail: rep.failed.map((f) => `${f.query.title}（${f.message}）`),
        })
        return
      }

      setReport(rep)
      const ok = rep.playlistId !== ''
      onTaskUpdate({
        id: taskId,
        name,
        targetPlatform: target,
        source: '文本导入',
        status: ok ? 'done' : 'failed',
        total: queries.length,
        added: rep.added,
        failed: rep.failed.length,
        createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        progress: 1,
        failedDetail: rep.failed.map((f) => `${f.query.title}（${f.message}）`),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '同步失败'
      setSyncError(msg)
      onTaskUpdate({
        id: taskId,
        name,
        targetPlatform: target,
        source: '文本导入',
        status: 'failed',
        total: queries.length,
        added: 0,
        failed: queries.length,
        createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
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

    setSyncing(true)
    setSyncError('')
    setReport(null)
    setProgress({ ratio: 0, stage: 'adding' })

    const off = window.electronAPI.platforms.onSyncProgress((p) => {
      if (p.platform === target) setProgress(p)
    })

    try {
      const rep = await window.electronAPI.platforms.confirmSync(target, pendingTaskId, sel)
      setReport(rep)
      setPendingTaskId(null)
      setPendingChoices(null)
      setSelections({})
      const ok = rep.playlistId !== ''
      onTaskUpdate({
        id: `task-${Date.now()}`,
        name: rep.playlistName,
        targetPlatform: target,
        source: '文本导入',
        status: ok ? 'done' : 'failed',
        total: rep.total,
        added: rep.added,
        failed: rep.failed.length,
        createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        progress: 1,
        failedDetail: rep.failed.map((f) => `${f.query.title}（${f.message}）`),
      })
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : '同步失败')
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
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">文本快速创建</h1>
          <p className="mt-1 max-w-xl font-body-md text-body-md text-on-surface-variant">
            粘贴混合文本、聊天记录或杂乱歌曲清单，本地智能正则与语义解析引擎将快速提取歌名与歌手，支持跨平台即时检索与同步。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setText(EXAMPLE)
              setResult(null)
            }}
            className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-base">auto_fix_high</span>
            载入示例数据
            <span className="font-label-mono text-label-mono text-outline">⌥E</span>
          </button>
          <button
            onClick={() => setShowFormats((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            <span className="material-symbols-outlined text-base">help_outline</span>
            支持格式说明
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
              <div key={f.title} className="flex items-start gap-2">
                <span className="material-symbols-outlined text-base text-primary">{f.icon}</span>
                <div>
                  <p className="font-label-md text-label-md font-medium">{f.title}</p>
                  <p className="font-label-sm text-label-sm text-on-surface-variant">{f.example}</p>
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
            placeholder={`每行一首，支持「歌名 - 歌手」等格式。例如：\n${EXAMPLE}`}
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
              解析歌曲
            </button>
            <button
              onClick={() => {
                setText('')
                setResult(null)
                setReport(null)
                setSyncError('')
              }}
              disabled={syncing}
              className="flex items-center gap-1.5 rounded-lg border border-outline-variant px-4 py-2 font-label-md text-label-md text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">delete_sweep</span>
              清空
            </button>
            <span className="ml-auto font-label-sm text-label-sm text-on-surface-variant">
              <span className="material-symbols-outlined align-bottom text-sm">auto_awesome</span>{' '}
              格式与字段顺序自动识别，无需手动指定
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
                {TARGET_PLATFORMS.map((p) => (
                  <option key={p.id} value={p.id}>
                    同步到 {p.name}
                  </option>
                ))}
              </select>
              <input
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                placeholder="新歌单名称（留空自动命名）"
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
                {syncing ? '同步中…' : '创建歌单并同步'}
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
                    {progress.stage === 'matching' ? '正在匹配歌曲…' : '正在写入歌单…'}{' '}
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
                      <span className="font-medium text-primary">同步完成</span>
                      ：{report.added}/{report.total} 首已写入「{report.playlistName}」
                    </p>
                  ) : (
                    <p className="text-on-surface">
                      <span className="font-medium text-tertiary">未创建歌单</span>
                      ：没有匹配到任何歌曲，请检查后重试
                    </p>
                  )}
                  {report.failed.length > 0 && (
                    <ul className="max-h-24 space-y-1 overflow-y-auto text-error">
                      {report.failed.map((f, i) => (
                        <li key={i}>
                          · {f.query.title}
                          {f.reason === 'rate-limited'
                            ? '（操作频繁被限流，请稍等几分钟再试）'
                            : `（${f.message}）`}
                        </li>
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
                请先在「账号管理」登录{' '}
                {TARGET_PLATFORMS.find((p) => p.id === target)?.name ?? ''}
              </p>
            </div>
          )}
        </div>
      </div>

      {result && (
        <div className="mt-4 rounded-lg border border-outline-variant bg-surface-container-low">
          <div className="flex items-center justify-between border-b border-outline-variant px-4 py-2">
            <p className="font-label-md text-label-md text-on-surface">
              识别出{' '}
              <span className="font-medium text-primary">{result.songs.length}</span> 首歌曲
              {failedCount > 0 && (
                <span className="ml-2 text-tertiary">{failedCount} 行解析失败</span>
              )}
              {result.detectedOrder && (
                <span className="ml-2 rounded-full bg-surface-container-highest px-2 py-0.5 text-label-sm text-on-surface-variant">
                  已自动识别：{result.detectedOrder === 'title-first' ? '歌名 - 歌手' : '歌手 - 歌名'}
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
                      <span className="text-tertiary">未识别歌手</span>
                    )}
                    {ambiguous && (
                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        {s.candidates!.map((c) => {
                          const active = c.title === s.title
                          return (
                            <button
                              key={c.title}
                              onClick={() => applyCandidate(i, c.title, c.artist)}
                              title="点选使用该候选"
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
                  第 {f.lineNumber} 行：{f.raw || '（空）'}（
                  {f.reason === 'missing-title' ? '缺少歌名' : '缺少歌手'}）
                </li>
              ))}
            </ul>
          )}

          {result.ignoredLines.length > 0 && (
            <p className="border-t border-outline-variant px-4 py-2 font-label-sm text-label-sm text-on-surface-variant">
              已自动忽略 {result.ignoredLines.length} 行非歌曲内容（分享文案/歌词信息等）
            </p>
          )}
        </div>
      )}

      {pendingChoices && pendingChoices.length > 0 && (
        <div className="mt-4 rounded-lg border border-tertiary bg-surface-container-low p-4">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-tertiary">playlist_add_check</span>
            <p className="font-body-md text-body-md font-medium">
              发现 {pendingChoices.length} 首同名不同歌手的歌曲，请手动选择
            </p>
            <span className="ml-auto font-label-sm text-label-sm text-on-surface-variant">
              其余完全匹配的歌曲将自动添加
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
            {syncing ? '写入中…' : '确认选择并创建歌单'}
          </button>
          {syncError && <p className="mt-2 font-label-sm text-label-sm text-error">{syncError}</p>}
        </div>
      )}
    </div>
  )
}
