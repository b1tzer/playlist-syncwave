import type { PlatformModule } from './meta'

/**
 * 自动收集所有平台插件模块。
 *
 * 约定：每个平台在 src/platforms/<id>/index.ts 中 default 导出 PlatformModule。
 * 新增平台只需新建目录并实现适配器，无需修改任何历史代码。
 */
const collected = import.meta.glob<{ default: PlatformModule }>('./*/index.ts', {
  eager: true,
})

export const platformModules: PlatformModule[] = Object.values(collected).map((m) => m.default)
