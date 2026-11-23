import type { PlatformAdapter } from '../platforms/base'

export interface PlatformServices {
  adapter: PlatformAdapter | Promise<PlatformAdapter>
  getCredential: () => string | null
  saveCredential: (value: string) => void
  logout: () => void
}

const registry = new Map<string, PlatformServices>()

export function registerPlatform(id: string, services: PlatformServices): void {
  registry.set(id, services)
}

export function getPlatform(id: string): PlatformServices {
  const services = registry.get(id)
  if (!services) throw new Error(`未知平台：${id}`)
  return services
}

/** 解析可能为异步工厂的适配器 */
export async function resolveAdapter(id: string): Promise<PlatformAdapter> {
  return getPlatform(id).adapter
}

export function listPlatforms(): string[] {
  return [...registry.keys()]
}
