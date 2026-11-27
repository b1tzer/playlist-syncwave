import { Converter } from 'opencc-js'

/** 简繁转换器（全局单例：opencc 初始化有成本，百科消歧与歌曲匹配共用） */
const t2s = Converter({ from: 'tw', to: 'cn' })

/** 简繁归一：转换失败回退原文，不向调用方抛错 */
export function simplify(raw: string): string {
  try {
    return t2s(raw)
  } catch {
    return raw
  }
}
