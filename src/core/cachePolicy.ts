/** 歌单缓存刷新策略（主进程服务与渲染层共用） */

/**
 * 歌单缓存数据 schema 版本：平台字段映射调整后 +1。
 * 读取缓存时版本不匹配即视为无缓存，旧数据自动失效重新拉取。
 */
export const PLAYLIST_CACHE_SCHEMA_VERSION = 2

/** 歌单列表缓存有效期：过期后首次访问自动重新拉取 */
export const PLAYLIST_LIST_TTL_MS = 10 * 60_000

/** 歌单歌曲缓存有效期 */
export const PLAYLIST_SONGS_TTL_MS = 30 * 60_000

/** 手动强制刷新的最小间隔：防连点触发平台风控（限流） */
export const MANUAL_REFRESH_MIN_INTERVAL_MS = 30_000
