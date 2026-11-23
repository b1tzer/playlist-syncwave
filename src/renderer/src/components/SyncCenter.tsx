export type TaskStatus = 'running' | 'done' | 'failed'

export interface SyncTaskRecord {
  id: string
  name: string
  /** 目标平台 id */
  targetPlatform: string
  /** 来源描述，如「文本导入」 */
  source: string
  status: TaskStatus
  total: number
  added: number
  failed: number
  createdAt: string
  /** 0-1，运行中更新 */
  progress: number
  failedDetail: string[]
}

interface SyncCenterProps {
  tasks: SyncTaskRecord[]
  onNewTask: () => void
}

const PLATFORM_LABELS: Record<string, string> = {
  netease: '网易云音乐',
  qqmusic: 'QQ音乐',
}

export default function SyncCenter({ tasks, onNewTask }: SyncCenterProps) {
  const running = tasks.filter((t) => t.status === 'running').length
  const done = tasks.filter((t) => t.status === 'done').length
  const failed = tasks.filter((t) => t.status === 'failed').length

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 font-label-mono text-label-mono text-primary">
            <span className="material-symbols-outlined text-sm">hub</span>
            <span>Hub Engine v2.4</span>
            <span className="rounded-full bg-primary-container/15 px-2 py-0.5 text-primary">
              DAEMON ONLINE
            </span>
          </div>
          <h1 className="mt-1 font-headline-lg text-headline-lg font-semibold">歌单同步中心</h1>
          <p className="mt-1 font-body-md text-body-md text-on-surface-variant">
            管理跨平台歌单同步任务，实时查看匹配进度与结果报告
          </p>
        </div>
        <button
          onClick={onNewTask}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-label-md text-label-md font-medium text-on-primary transition-colors hover:bg-primary/85"
        >
          <span className="material-symbols-outlined text-base">add</span>
          新建同步任务
          <span className="font-label-mono text-label-mono opacity-70">⌘N</span>
        </button>
      </div>

      <div className="mt-6 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
        <span className="material-symbols-outlined text-base">terminal</span>
        <span>任务日志</span>
        <span className="mx-2 h-3 w-px bg-outline-variant" />
        <span>
          全部任务 <span className="font-medium text-on-surface">{tasks.length}</span>
        </span>
        <span>
          进行中 <span className="font-medium text-tertiary">{running}</span>
        </span>
        <span>
          已完成 <span className="font-medium text-primary">{done}</span>
        </span>
        <span>
          异常拦截 <span className="font-medium text-error">{failed}</span>
        </span>
        <span className="ml-auto flex items-center gap-1 font-label-mono text-label-mono text-outline">
          <span className="material-symbols-outlined text-sm">database</span>
          Buffer: 48MB / Latency: 14ms
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {tasks.length === 0 && (
          <div className="flex flex-col items-center rounded-lg border border-dashed border-outline-variant bg-surface-container-low px-6 py-14 text-center">
            <span className="material-symbols-outlined text-5xl text-outline">sync_alt</span>
            <p className="mt-3 font-body-md text-body-md text-on-surface-variant">
              暂无同步任务
            </p>
            <p className="mt-1 font-label-sm text-label-sm text-outline">
              从「快速创建」粘贴歌曲文本，一键同步到目标平台
            </p>
            <button
              onClick={onNewTask}
              className="mt-4 flex items-center gap-2 rounded-lg border border-outline-variant px-4 py-2 font-label-md text-label-md text-primary transition-colors hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-base">add</span>
              创建第一个任务
            </button>
          </div>
        )}

        {tasks.map((t) => (
          <div
            key={t.id}
            className="rounded-lg border border-outline-variant bg-surface-container-low p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {t.status === 'running' && (
                  <span className="material-symbols-outlined animate-spin text-base text-tertiary">
                    progress_activity
                  </span>
                )}
                {t.status === 'done' && (
                  <span className="material-symbols-outlined text-base text-primary">
                    check_circle
                  </span>
                )}
                {t.status === 'failed' && (
                  <span className="material-symbols-outlined text-base text-error">
                    error_outline
                  </span>
                )}
                <p className="font-body-md text-body-md font-medium">{t.name}</p>
                <span className="rounded-full bg-surface-container-highest px-2 py-0.5 font-label-sm text-label-sm text-on-surface-variant">
                  {t.status === 'running' ? '进行中' : t.status === 'done' ? '已完成' : '异常'}
                </span>
              </div>
              <span className="font-label-mono text-label-mono text-outline">{t.createdAt}</span>
            </div>

            <div className="mt-3 flex items-center gap-2 font-label-sm text-label-sm text-on-surface-variant">
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">description</span>
                {t.source}
              </span>
              <span className="material-symbols-outlined text-sm text-outline">arrow_forward</span>
              <span className="flex items-center gap-1">
                <span className="material-symbols-outlined text-sm">library_music</span>
                {PLATFORM_LABELS[t.targetPlatform] ?? t.targetPlatform}
              </span>
              {t.status === 'running' && (
                <span className="ml-auto flex items-center gap-1 text-tertiary">
                  <span className="material-symbols-outlined text-sm">refresh</span>
                  正在匹配: 第 {Math.round(t.progress * t.total)} / {t.total} 首
                </span>
              )}
              {(t.status === 'done' || t.status === 'failed') && (
                <span className="ml-auto">
                  成功: <span className="text-primary">{t.added}</span>
                  {t.failed > 0 && (
                    <>
                      {' '}
                      失败: <span className="text-error">{t.failed}</span>
                    </>
                  )}
                </span>
              )}
            </div>

            {t.status === 'running' && (
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.round(t.progress * 100)}%` }}
                />
              </div>
            )}

            {t.status === 'failed' && t.failedDetail.length > 0 && (
              <ul className="mt-3 max-h-24 space-y-1 overflow-y-auto font-label-sm text-label-sm text-error">
                {t.failedDetail.map((f, i) => (
                  <li key={i}>· {f}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
