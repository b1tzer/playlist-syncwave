import type { PlatformMeta, PlatformOperation } from '@core/models/platform'

/** 平台是否支持某写操作（write 能力 + 操作级能力清单） */
export function operationAllowed(meta: PlatformMeta | undefined, op: PlatformOperation): boolean {
  if (!meta?.capabilities.write) return false
  return !meta.capabilities.unsupportedOperations?.[op]
}

/** 操作不可用的原因（悬浮提示文案）；允许时返回 undefined */
export function operationReason(meta: PlatformMeta | undefined, op: PlatformOperation): string | undefined {
  return meta?.capabilities.unsupportedOperations?.[op]?.reason
}
