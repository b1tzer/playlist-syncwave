/** 封面 URL 兜底升级 https：打包版渲染层 CSP 只放行 https 图片，本地导入等路径的 http 封面需要兜底 */
export function toHttpsCover(url: string | undefined): string | undefined {
  if (!url) return url
  return url.replace(/^http:/, 'https:')
}
