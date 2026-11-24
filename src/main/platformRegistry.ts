import type { PlatformAdapter } from '../platforms/base'
import type { PlatformMeta } from '@core/models/platform'
import type { AdapterContext, PlatformModule } from '../platforms/meta'
import { getCredential, setCredential, clearCredential } from './credentialStore'
import { createLogger } from '@core/logging'

const log = createLogger({ module: 'platform.registry' })

export interface PlatformServices {
  adapter: Promise<PlatformAdapter>
  meta: PlatformMeta
  getCredential: () => string | null
  saveCredential: (value: string) => void
  logout: () => void
}

const registry = new Map<string, PlatformServices>()

/** 注册平台插件模块；凭证统一按平台 id 走通用加密存储 */
export function registerPlatform(module: PlatformModule, ctx: AdapterContext): void {
  const { meta } = module
  registry.set(meta.id, {
    adapter: Promise.resolve(module.createAdapter(ctx)),
    meta,
    getCredential: () => getCredential(meta.id),
    saveCredential: (value) => setCredential(meta.id, value),
    logout: () => clearCredential(meta.id),
  })
  log.info('platform.register', '注册平台适配器', {
    platform: meta.id,
    capabilities: meta.capabilities,
  })
}

export function getPlatform(id: string): PlatformServices {
  const services = registry.get(id)
  if (!services) {
    log.error('platform.get', '未知平台', undefined, { platform: id })
    throw new Error(`未知平台：${id}`)
  }
  return services
}

/** 解析平台适配器（首次调用时创建并缓存） */
export async function resolveAdapter(id: string): Promise<PlatformAdapter> {
  return getPlatform(id).adapter
}

/** 已注册平台的元数据列表（供渲染层动态渲染，无需硬编码平台信息） */
export function listPlatforms(): PlatformMeta[] {
  return [...registry.values()].map((s) => s.meta)
}
