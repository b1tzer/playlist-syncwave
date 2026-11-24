import { describe, expect, it } from 'vitest'
import {
  LOCALES,
  normalizeLocale,
  translate,
  translations,
  type TranslationKey,
} from '../../src/renderer/src/i18n/translations'

describe('i18n translations', () => {
  it('两种语言键集合一致', () => {
    const zhKeys = Object.keys(translations['zh-CN']).sort()
    const enKeys = Object.keys(translations['en-US']).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(50)
  })

  it('两种语言占位符集合一致', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const keys = Object.keys(translations['zh-CN']) as TranslationKey[]
    for (const key of keys) {
      expect(placeholders(translations['en-US'][key])).toEqual(
        placeholders(translations['zh-CN'][key]),
      )
    }
  })

  it('translate 支持参数插值', () => {
    expect(translate('zh-CN', 'sidebar.platformsOnline', { count: 1, total: 2 })).toBe(
      '1/2 平台在线',
    )
    expect(translate('en-US', 'sidebar.platformsOnline', { count: 1, total: 2 })).toBe(
      '1/2 platforms online',
    )
  })

  it('未知键回退为键名，缺参数保留占位符', () => {
    expect(translate('zh-CN', 'missing.key' as never)).toBe('missing.key')
    expect(translate('zh-CN', 'sidebar.platformsOnline')).toBe('{count}/{total} 平台在线')
  })

  it('normalizeLocale 过滤非法值', () => {
    expect(normalizeLocale('en-US')).toBe('en-US')
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-TW')).toBe('zh-CN')
    expect(normalizeLocale(undefined)).toBe('zh-CN')
    expect(normalizeLocale(true)).toBe('zh-CN')
  })

  it('LOCALES 覆盖 zh-CN 与 en-US', () => {
    expect(LOCALES).toEqual(['zh-CN', 'en-US'])
  })
})
