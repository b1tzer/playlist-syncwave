import { useState } from 'react'
import { parseText } from '@core/parser/parseText'
import type { ParseResult } from '@core/models/parse'
import type { SyncReport } from '@core/models/sync'
import type { PlatformAccount } from '@core/models/platform'

const EXAMPLE = `晴天 - 周杰伦
稻香——周杰伦
夜曲 | 周杰伦
说谎 - 林宥嘉`

export const TARGET_PLATFORMS: Array<{ id: string; name: string }> = [
  { id: 'netease', name: '网易云音乐' },
  { id: 'qqmusic', name: 'QQ音乐' },
]

interface TextCreatorProps {
  accounts: Record<string, PlatformAccount | null>
}

export default function TextCreator({ accounts }: TextCreatorProps) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<ParseResult | null>(null)
  const [order, setOrder] = useState<'title-first' | 'artist-first'>('title-first')
  const [playlistName, setPlaylistName] = useState('')
  const [target, setTarget] = useState('netease')
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ ratio: number; stage: string } | null>(null)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [syncError, setSyncError] = useState<string>('')

  const loggedIn = accounts[target] !== null

  const handleParse = () => {
    setResult(parseText(text, { order }))
    setReport(null)
    setSyncError('')
  }

  const handleSync = async () => {
    if (!result || result.songs.length === 0) return
    setSyncing(true)
    setSyncError('')
    setReport(null)
    setProgress({ ratio: 0, stage: 'matching' })
    const off = window.electronAPI.platforms.onSyncProgress((p) => {
      if (p.platform === target) setProgress(p)
    })
    try {
      const name = playlistName.trim() || `文本导入 ${new Date().toLocaleDateString()}`
      const queries = result.songs.map((s) => ({ title: s.title, artist: s.artist }))
      setReport(await window.electronAPI.platforms.syncPlaylist(target, queries, name))
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : '同步失败')
    } finally {
      off()
      setSyncing(false)
      setProgress(null)
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-800">文本快速创建歌单</h2>
        <label className="text-xs text-slate-500">
          格式：
          <select
            value={order}
            onChange={(e) => setOrder(e.target.value as typeof order)}
            className="ml-1 rounded border border-slate-200 px-1 py-0.5 text-xs"
          >
            <option value="title-first">歌名 - 歌手</option>
            <option value="artist-first">歌手 - 歌名</option>
          </select>
        </label>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`每行一首，支持「歌名 - 歌手」等格式。例如：\n${EXAMPLE}`}
        rows={8}
        className="mt-3 w-full resize-y rounded-lg border border-slate-200 p-3 font-mono text-sm outline-none focus:border-red-300"
      />

      <div className="mt-3 flex gap-2">
        <button
          onClick={handleParse}
          disabled={!text.trim()}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          解析歌曲
        </button>
        <button
          onClick={() => {
            setText('')
            setResult(null)
            setReport(null)
            setSyncError('')
          }}
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-500 hover:bg-slate-50"
        >
          清空
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
        {loggedIn ? (
          <div className="flex items-center gap-2">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm outline-none"
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
              placeholder="新歌单名称（留空则自动命名）"
              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-300"
            />
            <button
              onClick={handleSync}
              disabled={syncing || !result || result.songs.length === 0}
              className="shrink-0 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {syncing ? '同步中…' : '创建歌单并同步'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-400">
            请先在左侧登录 {TARGET_PLATFORMS.find((p) => p.id === target)?.name ?? ''}
          </p>
        )}

        {syncing && progress && (
          <div className="mt-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className="h-full rounded-full bg-red-500 transition-all"
                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {progress.stage === 'matching' ? '正在匹配歌曲…' : '正在写入歌单…'}{' '}
              {Math.round(progress.ratio * 100)}%
            </p>
          </div>
        )}

        {syncError && <p className="mt-2 text-sm text-red-500">{syncError}</p>}

        {report && (
          <div className="mt-3 space-y-1 text-sm">
            {report.playlistId ? (
              <p className="text-slate-700">
                <span className="font-semibold text-green-600">同步完成</span>
                ：{report.added}/{report.total} 首已写入「{report.playlistName}」
              </p>
            ) : (
              <p className="text-slate-700">
                <span className="font-semibold text-amber-600">未创建歌单</span>
                ：没有匹配到任何歌曲，请检查后重试
              </p>
            )}
            {report.failed.length > 0 && (
              <ul className="max-h-32 overflow-y-auto text-xs text-amber-600">
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

      {result && (
        <div className="mt-4">
          <p className="text-sm text-slate-600">
            识别出 <span className="font-semibold text-slate-800">{result.songs.length}</span>{' '}
            首歌曲
            {result.failedLines.length > 0 && (
              <span className="ml-2 text-amber-600">
                {result.failedLines.length} 行解析失败
              </span>
            )}
          </p>

          {result.songs.length > 0 && (
            <ul className="mt-2 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-100">
              {result.songs.map((s, i) => (
                <li key={`${s.lineNumber}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="w-6 text-right text-xs text-slate-400">{i + 1}</span>
                  <span className="truncate text-slate-700">{s.title}</span>
                  {s.artist && (
                    <span className="truncate text-xs text-slate-400">- {s.artist}</span>
                  )}
                  {!s.artist && (
                    <span className="text-xs text-amber-500">未识别歌手</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {result.failedLines.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.failedLines.map((f) => (
                <li key={f.lineNumber} className="text-xs text-amber-600">
                  第 {f.lineNumber} 行：{f.raw || '（空）'}（
                  {f.reason === 'missing-title' ? '缺少歌名' : '缺少歌手'}）
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
