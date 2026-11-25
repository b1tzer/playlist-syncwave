/**
 * 同步引擎调优参数的单一事实源：
 * 引擎默认值、越界回退范围、匹配阈值语义预设均在此定义。
 * 主进程（settingsService）、渲染层（设置页滑块/预设）与引擎层共同引用，
 * 避免默认值散落多处导致漂移。
 */

export interface SyncTuning {
  /** 匹配阈值（0~1，分数达到阈值才自动匹配） */
  threshold: number
  /** 可重试错误（限流/超时）的最大重试次数 */
  searchRetries: number
  /** 相邻两次搜索的最小间隔（ms） */
  searchIntervalMs: number
}

export const SYNC_TUNING_DEFAULTS: Readonly<SyncTuning> = {
  threshold: 0.6,
  searchRetries: 2,
  searchIntervalMs: 500,
}

/** 设置页允许的取值范围（越界回退默认值，见 settingsService.syncTuning） */
export const SYNC_TUNING_RANGE: Readonly<{
  [K in keyof SyncTuning]: { min: number; max: number }
}> = {
  threshold: { min: 0.4, max: 0.9 },
  searchRetries: { min: 0, max: 5 },
  searchIntervalMs: { min: 300, max: 3000 },
}

/** 匹配阈值语义预设：用户选语义档位，内部映射为数值 */
export const THRESHOLD_PRESETS = {
  /** 宽松：多匹配少漏配 */
  loose: 0.45,
  /** 平衡（默认） */
  balanced: SYNC_TUNING_DEFAULTS.threshold,
  /** 严格：宁缺毋滥 */
  strict: 0.75,
} as const

export type ThresholdPreset = keyof typeof THRESHOLD_PRESETS
