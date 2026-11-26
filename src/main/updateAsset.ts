const RELEASE_BASE = 'https://github.com/b1tzer/playlist-syncwave/releases/download'

export interface ReleaseAssetInfo {
  url: string
  sha512?: string
  size?: number
}

const EXTENSIONS: Record<'darwin' | 'win32' | 'linux', RegExp> = {
  darwin: /\.dmg$/i,
  win32: /\.exe$/i,
  linux: /\.AppImage$/i,
}

/** 按运行平台从更新元数据中挑选用户可手动安装的安装包 */
export function findInstallerAsset<T extends ReleaseAssetInfo>(
  files: readonly T[] | undefined,
  platform: 'darwin' | 'win32' | 'linux',
): T | undefined {
  if (!files) return undefined
  const pattern = EXTENSIONS[platform]
  return files.find((file) => pattern.test(file.url))
}

/** 用 tag 固定 GitHub Release 资产地址，历史版本不覆盖，便于回滚 */
export function releaseAssetUrl(version: string, fileName: string): string {
  return `${RELEASE_BASE}/v${version}/${fileName}`
}
