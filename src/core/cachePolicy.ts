/** 歌单缓存刷新策略（主进程服务与渲染层共用） */

/**
 * 歌单缓存数据 schema 版本：平台字段映射调整后 +1。
 * 读取缓存时版本不匹配不清空数据：旧缓存仍兜底展示（视为过期），
 * 立即后台重新验证并用新格式数据覆盖。
 * v2→v3：酷狗映射修正后，早期版本按平台记录版本导致同平台旧歌单缓存残留。
 * v3→v4：酷狗歌单列表不再显示收藏的他人歌单（type=1 过滤），旧缓存含收藏歌单需重新验证。
 * v4→v5：网易云歌单列表不再显示收藏的他人歌单（subscribed=true 过滤），旧缓存含收藏歌单需重新验证。
 * v5→v6：封面 URL 统一升级 https（打包版 CSP 只放行 https 图片），旧缓存 http 封面需重新验证。
 * v6→v7：歌曲缓存补次级标识列（songMid/albumMid/singerIds），百科歌词/发行时间定位需要，旧缓存缺标识需重新验证。
 */
export const PLAYLIST_CACHE_SCHEMA_VERSION = 7

/**
 * 歌单列表重新验证间隔：TTL 内直接返回缓存不请求接口；
 * 过期后先返回缓存兜底、后台重新请求接口并逐行 diff 更新。
 */
export const PLAYLIST_LIST_TTL_MS = 10 * 60_000

/** 歌单歌曲重新验证间隔（同上语义） */
export const PLAYLIST_SONGS_TTL_MS = 30 * 60_000

/**
 * 刷新限流令牌桶容量：允许短时间内连续调用接口的次数（突发容忍）。
 * 列表与歌曲各自独立一个桶。
 */
export const REFRESH_BUCKET_CAPACITY = 3

/**
 * 令牌补充间隔：平均每 10 秒恢复 1 个令牌。
 * 一段时间内整体调用量 ≈ 容量 + 时长 / 补充间隔（10 分钟约 63 次上限，
 * 实际由 TTL/可见性触发频率约束，远低于上限）。
 */
export const REFRESH_BUCKET_REFILL_MS = 10_000

/** 打开状态下定期检查缓存是否过期并重新验证的周期 */
export const VISIBLE_REFRESH_CHECK_MS = 60_000
