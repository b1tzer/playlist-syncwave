import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type { PlatformSong } from '@core/models/platform'
import type {
  EncyclopediaCandidate,
  EncyclopediaConfirmRequest,
  EncyclopediaContent,
  EncyclopediaKind,
  EncyclopediaLookupResult,
} from '@core/models/encyclopedia'
import type { SongDetailData } from '@core/models/songDetail'
import { useI18n } from '../i18n'
import { formatDuration } from '../sync/helpers'
import CoverImage from './CoverImage'
import PlatformLogo from './PlatformLogo'
import Tooltip from './Tooltip'

/** 点击目标：歌曲详情卡（本地数据）或百科查询（歌手/专辑） */
export type EncyclopediaTarget =
  | {
      type: 'song'
      song: PlatformSong
      /** 来源平台 id：提供时详情卡异步补充歌词/发行时间 */
      platform?: string
      platformName?: string
      platformIcon?: string
      /** 来源平台是否支持百科：决定详情卡内歌手/专辑是否可点 */
      encyclopedia?: boolean
    }
  | {
      type: 'encyclopedia'
      platform: string
      platformName: string
      platformIcon: string
      kind: EncyclopediaKind
      name: string
      id?: string
      albumId?: string
      albumMid?: string
      /** 点击来源歌曲（本地歌单回写纠偏映射定位用，直接传引用避免按 id 反查） */
      song?: PlatformSong
      /** 点击的歌手在 artist 文本中的下标（与 identifiers.singerIds 对齐） */
      singerIndex?: number
    }

interface EncyclopediaPopoverProps {
  target: EncyclopediaTarget
  x: number
  y: number
  onClose: () => void
  /** 用户选定候选后回调（本地歌单回写歌手 id） */
  onConfirmEntity?: (req: EncyclopediaConfirmRequest, target: EncyclopediaTarget) => void
  /** 面板内导航（详情卡点歌手/专辑 → 换为百科查询），父组件更新 target 后原位继续展示 */
  onNavigate?: (next: EncyclopediaTarget) => void
}

/**
 * 可点击文本（歌名/歌手/专辑）：
 * 鼠标点击与键盘（Tab + Enter/Space）等价，满足键盘可达性要求。
 */
export function EncyclopediaLink({
  label,
  onOpen,
}: {
  label: string
  onOpen: (e: SyntheticEvent<HTMLElement>) => void
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="encyclopedia-link"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(e)
        }
      }}
    >
      {label}
    </span>
  )
}

/**
 * 歌手名拆分为可点击片段（列表行与详情卡共用）：
 * 「A / B / C」按 artist 文本下标与 identifiers.singerIds 对齐；
 * clickable 为 false 时纯文本展示。
 */
export function ArtistLinks({
  artist,
  singerIds,
  clickable,
  onOpen,
}: {
  artist: string
  singerIds?: string[]
  clickable: boolean
  onOpen: (e: SyntheticEvent<HTMLElement>, part: string, idx: number, singerId?: string) => void
}) {
  return (
    <>
      {artist.split(' / ').map((part, idx) => (
        <span key={idx}>
          {idx > 0 && ' / '}
          {clickable && part.trim() ? (
            <EncyclopediaLink
              label={part.trim()}
              onOpen={(e) => onOpen(e, part.trim(), idx, singerIds?.[idx])}
            />
          ) : (
            part
          )}
        </span>
      ))}
    </>
  )
}

type Phase =
  | { type: 'loading' }
  | { type: 'content'; content: EncyclopediaContent }
  | { type: 'candidates'; candidates: EncyclopediaCandidate[]; resolvingId: string | null }
  | { type: 'empty' }
  | { type: 'unsupported' }
  | { type: 'error' }

const VIEWPORT_MARGIN = 8

/**
 * 百科信息面板：点击歌名/歌手名/专辑名后弹出。
 * - 歌名 → 本地歌曲详情卡（封面/时长/歌手/专辑/来源平台，无网络请求）
 * - 歌手/专辑 → 平台详情接口 + 同名消歧；同名多候选时面板内点选并持久化纠偏
 * - 锚点定位与关闭交互沿用 ContextMenu 模式（portal + 视口翻转 + 点外部/Esc/滚动关闭）
 * - 打开时聚焦面板、关闭时归还焦点；面板内导航（详情卡 → 百科）经 onNavigate 换目标
 */
export default function EncyclopediaPopover({
  target,
  x,
  y,
  onClose,
  onConfirmEntity,
  onNavigate,
}: EncyclopediaPopoverProps) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [phase, setPhase] = useState<Phase>({ type: 'loading' })
  const [retryTick, setRetryTick] = useState(0)
  const [switchTip, setSwitchTip] = useState<{ x: number; y: number } | null>(null)
  /** 打开面板前的焦点元素：关闭时归还，键盘用户不迷失焦点 */
  const previouslyFocused = useRef<HTMLElement | null>(null)

  // 首次打开：记录触发元素；卸载（关闭）时归还焦点
  useEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) previouslyFocused.current = active
    return () => {
      const el = previouslyFocused.current
      if (el && typeof el.focus === 'function') el.focus()
    }
  }, [])

  // 打开/目标变化时聚焦面板容器；目标变化源于面板内导航，焦点不能留在已卸载节点
  useEffect(() => {
    ref.current?.focus()
  }, [target])

  // 打开/面板尺寸变化时：按布局尺寸做视口翻转定位。
  // 挂载时面板还是 loading 态（矮），内容异步加载、歌词展开都会变高（最高 70vh），
  // 必须用 ResizeObserver 跟随重新放置，否则底部点击时面板被窗口截断。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      // offsetWidth/Height 为布局尺寸，不受 dialog-panel-enter 的 transform 动画影响
      const width = el.offsetWidth
      const height = el.offsetHeight
      const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
      const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)
      let nx = x
      let ny = y
      // 右边缘溢出 → 翻转到锚点左侧（右对齐）
      if (nx + width > window.innerWidth - VIEWPORT_MARGIN) {
        nx = x - width
      }
      // 底部溢出 → 翻转到锚点上方（底边留 4px 间距）；仍放不下时夹在视口内，面板 max-h 内部滚动
      if (ny + height > window.innerHeight - VIEWPORT_MARGIN) {
        ny = y - height - 4
      }
      setPos({
        x: Math.min(Math.max(VIEWPORT_MARGIN, nx), maxX),
        y: Math.min(Math.max(VIEWPORT_MARGIN, ny), maxY),
      })
    }
    place()
    // jsdom 无 ResizeObserver（单测环境），守卫跳过
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(place)
    observer.observe(el)
    return () => observer.disconnect()
  }, [x, y])

  // 外部交互关闭：面板内部的滚动（歌词区滚动）与点击不关闭面板；
  // scroll 不冒泡，用 capture 捕获，但需要排除事件源在面板内部的情况
  useEffect(() => {
    const close = () => onClose()
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  /** lookup 结果 → 面板状态（主查询/候选点选/「换一个」三处共用） */
  const applyLookup = (result: EncyclopediaLookupResult): void => {
    if (result.status === 'content') setPhase({ type: 'content', content: result.content })
    else if (result.status === 'candidates') {
      setPhase({ type: 'candidates', candidates: result.candidates, resolvingId: null })
    } else if (result.status === 'unsupported') setPhase({ type: 'unsupported' })
    else setPhase({ type: 'empty' })
  }

  // 目标变化时重置并查询；retryTick 递增触发重试
  useEffect(() => {
    if (target.type === 'song') return
    setPhase({ type: 'loading' })
    let cancelled = false
    const run = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.encyclopedia.lookup({
          platform: target.platform,
          kind: target.kind,
          name: target.name,
          id: target.id,
          albumId: target.albumId,
          albumMid: target.albumMid,
        })
        if (cancelled) return
        applyLookup(result)
      } catch {
        if (!cancelled) setPhase({ type: 'error' })
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [target, retryTick])

  if (target.type === 'song') {
    return (
      <Frame ref={ref} x={pos.x} y={pos.y}>
        <SongDetailCard target={target} onNavigate={onNavigate} />
      </Frame>
    )
  }

  const kindLabel = target.kind === 'singer' ? t('encyclopedia.singer') : t('encyclopedia.album')

  /** 选定候选：写入纠偏映射后按 id 直达详情 */
  const pickCandidate = async (candidate: EncyclopediaCandidate): Promise<void> => {
    setPhase((prev) =>
      prev.type === 'candidates' ? { ...prev, resolvingId: candidate.id } : prev,
    )
    try {
      const req: EncyclopediaConfirmRequest = {
        platform: target.platform,
        kind: target.kind,
        name: target.name,
        entityId: candidate.id,
        entityName: candidate.name,
      }
      await window.electronAPI.encyclopedia.confirm(req)
      onConfirmEntity?.(req, target)
      const result = await window.electronAPI.encyclopedia.lookup({
        platform: target.platform,
        kind: target.kind,
        name: target.name,
        id: candidate.id,
        albumId: target.albumId,
        albumMid: target.albumMid,
      })
      applyLookup(result)
    } catch {
      setPhase({ type: 'error' })
    }
  }

  /** 「换一个」：强制重新搜索候选（弱化为头部图标，常驻纠偏入口不打扰） */
  const switchEntity = async (): Promise<void> => {
    setPhase({ type: 'loading' })
    try {
      const result = await window.electronAPI.encyclopedia.lookup({
        platform: target.platform,
        kind: target.kind,
        name: target.name,
        forceSearch: true,
      })
      applyLookup(result)
    } catch {
      setPhase({ type: 'error' })
    }
  }

  let body: ReactNode = null
  if (phase.type === 'loading') {
    body = (
      <div className="flex items-center justify-center gap-2 py-8 font-label-md text-label-md text-on-surface-variant">
        <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>
        {t('encyclopedia.loading')}
      </div>
    )
  } else if (phase.type === 'candidates') {
    body = (
      <div>
        <p className="px-1 pb-1.5 font-label-sm text-label-sm text-on-surface-variant">
          {t('encyclopedia.candidatesHint', { kind: kindLabel })}
        </p>
        <ul className="flex flex-col gap-1">
          {phase.candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                disabled={phase.resolvingId !== null}
                onClick={() => void pickCandidate(candidate)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-container-high disabled:opacity-60"
              >
                {candidate.picUrl ? (
                  <img
                    src={candidate.picUrl}
                    alt={candidate.name}
                    loading="lazy"
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-outline">
                    <span className="material-symbols-outlined text-lg">person</span>
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-body-md text-body-md text-on-surface">
                    {candidate.name}
                  </span>
                  {Boolean(candidate.aliases?.length || candidate.singer) && (
                    <span className="block truncate font-label-sm text-label-sm text-on-surface-variant">
                      {[candidate.aliases?.join(' / '), candidate.singer].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                {phase.resolvingId === candidate.id && (
                  <span className="material-symbols-outlined animate-spin text-sm text-primary">
                    progress_activity
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  } else if (phase.type === 'content') {
    const content = phase.content
    const songs = content.songs ?? []
    body = (
      <div>
        <div className="flex items-start gap-3">
          <CoverImage src={content.imageUrl} alt={content.name} size="lg" fallbackIcon="music_note" />
          <div className="min-w-0 flex-1">
            <p className="break-words font-body-md text-body-md font-semibold text-on-surface">
              {content.name}
              <button
                type="button"
                aria-label={t('encyclopedia.switchEntity')}
                onClick={() => void switchEntity()}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setSwitchTip({ x: r.left + r.width / 2, y: r.bottom })
                }}
                onMouseLeave={() => setSwitchTip(null)}
                className="relative -bottom-0.5 ml-0.5 inline-flex shrink-0 rounded p-0.5 text-on-surface-variant/60 transition-colors hover:text-primary"
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 14, lineHeight: 1 }}
                >
                  swap_horiz
                </span>
              </button>
            </p>
            {content.releaseDate && (
              <p className="mt-1 font-label-sm text-label-sm text-on-surface-variant">
                {t('encyclopedia.releaseDate')}：{content.releaseDate}
              </p>
            )}
          </div>
        </div>
        {songs.length > 0 ? (
          <div className="mt-3 border-t border-outline-variant pt-2">
            <p className="pb-1 flex items-center gap-1 font-label-sm text-label-sm text-outline">
              <span className="material-symbols-outlined text-sm">queue_music</span>
              {t('encyclopedia.trackCount', { count: songs.length })}
            </p>
            <ul className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
              {songs.map((song, idx) => (
                <li key={`${song.id}-${idx}`}>
                  <TrackRow song={song} idx={idx} />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-3 py-2 text-center font-label-md text-label-md text-on-surface-variant">
            {t('encyclopedia.emptySongs')}
          </p>
        )}
        <SourceBar
          platformId={content.source}
          platformName={target.platformName}
          sourceUrl={content.sourceUrl}
        />
      </div>
    )
  } else if (phase.type === 'unsupported') {
    body = (
      <div className="flex flex-col items-center gap-2 py-8 font-label-md text-label-md text-on-surface-variant">
        <span className="material-symbols-outlined text-2xl">block</span>
        {t('encyclopedia.unsupported')}
      </div>
    )
  } else if (phase.type === 'error') {
    body = (
      <div className="flex flex-col items-center gap-2 py-8">
        <span className="font-label-md text-label-md text-on-surface-variant">
          {t('encyclopedia.failed')}
        </span>
        <button
          type="button"
          onClick={() => setRetryTick((n) => n + 1)}
          className="flex items-center gap-1 rounded-md px-2.5 py-1 font-label-md text-label-md text-primary transition-colors hover:bg-primary/10"
        >
          <span className="material-symbols-outlined text-sm">refresh</span>
          {t('encyclopedia.retry')}
        </button>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col items-center gap-2 py-8 font-label-md text-label-md text-on-surface-variant">
        <span className="material-symbols-outlined text-2xl">menu_book</span>
        {t('encyclopedia.empty', { kind: kindLabel })}
      </div>
    )
  }

  return (
    <Frame ref={ref} x={pos.x} y={pos.y}>
      <p className="pb-1 font-label-sm text-label-sm text-outline">{kindLabel}</p>
      {body}
      {switchTip && <Tooltip x={switchTip.x} y={switchTip.y} text={t('encyclopedia.switchEntity')} />}
    </Frame>
  )
}

/**
 * 浮窗底部来源栏（百科内容面板与歌曲详情卡共用模板）：
 * 平台 logo + 名称固定在左下角，「在平台打开」可选放右侧。
 * platformId 必须是平台 id（如 netease），PLATFORM_LOGOS 按其取品牌 logo。
 */
function SourceBar({
  platformId,
  platformName,
  sourceUrl,
}: {
  platformId: string
  platformName?: string
  sourceUrl?: string
}) {
  const { t } = useI18n()
  if (!platformName && !sourceUrl) return null
  return (
    <div className="mt-3 flex items-center justify-between gap-2 border-t border-outline-variant pt-2">
      {platformName && (
        <span className="flex min-w-0 items-center gap-1.5 truncate font-label-sm text-label-sm text-on-surface-variant">
          <PlatformLogo
            platform={platformId}
            name={platformName}
            icon="public"
            size="h-3.5 w-3.5"
            iconSize="text-xs"
          />
          {platformName}
        </span>
      )}
      {sourceUrl && (
        <button
          type="button"
          onClick={() => void window.electronAPI.openExternal(sourceUrl)}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-label-md text-label-md text-primary transition-colors hover:bg-primary/10"
        >
          <span className="material-symbols-outlined text-sm">open_in_new</span>
          {t('encyclopedia.openInPlatform')}
        </button>
      )}
    </div>
  )
}

/** 面板曲目行：有歌曲页链接时整行可点击跳平台；否则纯展示（无 hover 误导） */
function TrackRow({ song, idx }: { song: PlatformSong & { webUrl?: string }; idx: number }) {
  const inner = (
    <>
      <span className="w-4 shrink-0 text-right font-label-mono text-label-mono text-outline">
        {idx + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-on-surface">{song.title}</span>
      {song.durationMs !== undefined && (
        <span className="shrink-0 font-label-mono text-label-mono text-outline">
          {formatDuration(song.durationMs)}
        </span>
      )}
    </>
  )
  if (song.webUrl) {
    return (
      <button
        type="button"
        aria-label={song.artist ? `${song.title} · ${song.artist}` : song.title}
        onClick={() => void window.electronAPI.openExternal(song.webUrl!)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs leading-5 transition-colors hover:bg-surface-container-high"
      >
        {inner}
      </button>
    )
  }
  return <div className="flex items-center gap-2 px-1.5 py-1 text-xs leading-5">{inner}</div>
}

/** LRC/文本歌词 → 展示行：剥离时间戳、去空行（副歌重复行保留，忠实原文） */
export function lyricsLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/\[\d{1,2}:\d{2}([.:]\d{1,3})?\]/g, '')
        .replace(/\[(ti|ar|al|by|offset):[^\]]*\]/gi, '')
        .trim(),
    )
    .filter((line) => line.length > 0)
}

const LYRICS_PREVIEW_LINES = 6

/** 歌曲详情卡：身份信息本地即时渲染，歌词/发行时间异步补充（失败静默保持本地信息） */
function SongDetailCard({
  target,
  onNavigate,
}: {
  target: Extract<EncyclopediaTarget, { type: 'song' }>
  onNavigate?: (next: EncyclopediaTarget) => void
}) {
  const { t } = useI18n()
  const [detail, setDetail] = useState<SongDetailData | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!target.platform) return
    let cancelled = false
    window.electronAPI.songDetail
      .lookup({
        platform: target.platform,
        // 本地歌单歌曲 id 是歌单内序号，平台详情查询用原始平台歌曲 id
        songId: target.song.sourceSongId ?? target.song.id,
        identifiers: target.song.identifiers,
        title: target.song.title,
        artist: target.song.artist,
      })
      .then((data) => {
        if (!cancelled && data) setDetail(data)
      })
      .catch(() => {
        // 补充信息失败静默：详情卡保持本地身份信息
      })
    return () => {
      cancelled = true
    }
  }, [target])

  /** 详情卡内点歌手/专辑 → 面板原地切换为百科查询（与列表点击行为一致） */
  const openEntity = (
    kind: EncyclopediaKind,
    name: string,
    opts: { id?: string; albumId?: string; albumMid?: string; singerIndex?: number },
  ): void => {
    if (!target.platform || !target.encyclopedia) return
    onNavigate?.({
      type: 'encyclopedia',
      platform: target.platform,
      platformName: target.platformName ?? '',
      platformIcon: target.platformIcon ?? '',
      kind,
      name,
      id: opts.id,
      albumId: opts.albumId,
      albumMid: opts.albumMid,
      song: target.song,
      singerIndex: opts.singerIndex,
    })
  }

  const lines = detail?.lyrics ? lyricsLines(detail.lyrics) : []
  const overflow = lines.length > LYRICS_PREVIEW_LINES
  const visible = expanded ? lines : lines.slice(0, LYRICS_PREVIEW_LINES)

  return (
    <div>
      <p className="pb-1 font-label-sm text-label-sm text-outline">{t('encyclopedia.songDetail')}</p>
      <div className="flex items-start gap-3">
        <CoverImage src={target.song.coverUrl} alt={target.song.title} size="lg" fallbackIcon="music_note" />
        <div className="min-w-0 flex-1">
          <p className="break-words font-body-md text-body-md font-semibold text-on-surface">
            {target.song.title}
          </p>
        </div>
      </div>
      {target.song.artist && (
        <p className="mt-3 font-body-sm text-body-sm text-on-surface-variant">
          <span className="text-on-surface">{t('encyclopedia.artist')}：</span>
          <ArtistLinks
            artist={target.song.artist}
            singerIds={target.song.identifiers?.singerIds}
            clickable={target.encyclopedia === true}
            onOpen={(_e, part, idx, singerId) =>
              openEntity('singer', part, { id: singerId, singerIndex: idx })
            }
          />
        </p>
      )}
      {target.song.album && (
        <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
          <span className="text-on-surface">{t('encyclopedia.albumLabel')}：</span>
          {target.encyclopedia === true ? (
            <EncyclopediaLink
              label={target.song.album}
              onOpen={() =>
                openEntity('album', target.song.album!, {
                  albumId: target.song.identifiers?.albumId,
                  albumMid: target.song.identifiers?.albumMid,
                })
              }
            />
          ) : (
            target.song.album
          )}
        </p>
      )}
      {target.song.durationMs !== undefined && (
        <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
          <span className="text-on-surface">{t('encyclopedia.duration')}：</span>
          {formatDuration(target.song.durationMs)}
        </p>
      )}
      {detail?.releaseDate && (
        <p className="mt-1 font-body-sm text-body-sm text-on-surface-variant">
          <span className="text-on-surface">{t('encyclopedia.releaseDate')}：</span>
          {detail.releaseDate}
        </p>
      )}
      {lines.length > 0 && (
        <div className="mt-3 border-t border-outline-variant pt-2">
          <p className="pb-1 flex items-center gap-1 font-label-sm text-label-sm text-outline">
            <span className="material-symbols-outlined text-sm">lyrics</span>
            {t('encyclopedia.lyrics')}
          </p>
          {/* 歌词独立排版：12px 小字号 + 宽行距，固定高度内部滚动 */}
          <div className="max-h-56 space-y-1 overflow-y-auto pr-1 text-xs leading-6 text-on-surface-variant">
            {visible.map((line, idx) => (
              <p key={`${idx}-${line}`} className="break-words">
                {line}
              </p>
            ))}
          </div>
          {overflow && (
            <button
              type="button"
              aria-label={expanded ? t('encyclopedia.collapseLyrics') : t('encyclopedia.expandLyrics')}
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 flex w-full items-center justify-center rounded-md py-0.5 text-primary transition-colors hover:bg-primary/10"
            >
              <span className="material-symbols-outlined text-base">
                {expanded ? 'expand_less' : 'expand_more'}
              </span>
            </button>
          )}
        </div>
      )}
      {/* 底部来源栏：平台 logo 需平台 id（此前误传图标名导致 logo 缺失） */}
      <SourceBar
        platformId={target.platform ?? 'local'}
        platformName={target.platformName}
        sourceUrl={detail?.webUrl}
      />
    </div>
  )
}

/** 面板外壳：portal 挂载 + 锚点定位 + 面板内交互不触发外部关闭 */
function Frame({
  ref,
  x,
  y,
  children,
}: {
  ref: RefObject<HTMLDivElement | null>
  x: number
  y: number
  children: ReactNode
}) {
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="encyclopedia"
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: x, top: y }}
      className="dialog-panel-enter fixed z-50 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container p-3 shadow-[0_4px_16px_var(--sw-menu-shadow)] outline-none"
    >
      {children}
    </div>,
    document.body,
  )
}
