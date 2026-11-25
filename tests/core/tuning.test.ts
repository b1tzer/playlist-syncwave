import { describe, it, expect } from 'vitest'
import {
  SYNC_TUNING_DEFAULTS,
  SYNC_TUNING_RANGE,
  THRESHOLD_PRESETS,
} from '../../src/core/sync/tuning'

describe('sync tuning — 调优参数单一事实源', () => {
  it('默认值全部落在允许范围内（越界回退逻辑的前提）', () => {
    for (const key of ['threshold', 'searchRetries', 'searchIntervalMs'] as const) {
      const value = SYNC_TUNING_DEFAULTS[key]
      expect(value).toBeGreaterThanOrEqual(SYNC_TUNING_RANGE[key].min)
      expect(value).toBeLessThanOrEqual(SYNC_TUNING_RANGE[key].max)
    }
  })

  it('阈值语义预设全部落在阈值允许范围内，且宽松 < 平衡 < 严格', () => {
    const { min, max } = SYNC_TUNING_RANGE.threshold
    const { loose, balanced, strict } = THRESHOLD_PRESETS
    for (const v of [loose, balanced, strict]) {
      expect(v).toBeGreaterThanOrEqual(min)
      expect(v).toBeLessThanOrEqual(max)
    }
    expect(loose).toBeLessThan(balanced)
    expect(balanced).toBeLessThan(strict)
  })

  it('平衡预设与默认阈值一致（恢复默认后 UI 高亮平衡档）', () => {
    expect(THRESHOLD_PRESETS.balanced).toBe(SYNC_TUNING_DEFAULTS.threshold)
  })
})
