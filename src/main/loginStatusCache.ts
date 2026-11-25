import type { PlatformAccount } from '@core/models/platform'

/**
 * 各平台登录态内存缓存：渲染层 reload（Ctrl+R）后主进程不重启，
 * IPC 直接命中缓存秒回，避免每次刷新都全量网络查询登录态。
 * 由 login-status IPC 写入；登录成功/登出/凭证失效时清除，保活续期不影响缓存。
 */
const cache = new Map<string, PlatformAccount | null>()

/** 读取缓存；未缓存返回 undefined（调用方需真实查询） */
export function getCachedLoginStatus(platform: string): PlatformAccount | null | undefined {
  return cache.get(platform)
}

export function setCachedLoginStatus(platform: string, account: PlatformAccount | null): void {
  cache.set(platform, account)
}

export function clearCachedLoginStatus(platform: string): void {
  cache.delete(platform)
}
