// 剥离 macOS app bundle 内所有 Mach-O 的 linker 签名，使 app 完全未签名。
//
// 背景：electron-builder 跳过代码签名后，Xcode 工具链仍会给每个 Mach-O
// 留下 linker-signed 的 ad-hoc 签名（无 CodeResources、无 bundle seal）。
// macOS 15 起 Gatekeeper 把这种「有 linker 签名但无完整 bundle 签名」的
// app 判为「已损坏」，且右键「打开」无法绕过；完全未签名的 app 只会提示
// 「无法验证开发者」，右键打开可放行（README 已记录的安装路径）。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function unsignMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { appOutDir } = context

  const isMachO = (file) => {
    try {
      return execFileSync('file', ['-b', file], { encoding: 'utf8' }).includes('Mach-O')
    } catch {
      return false
    }
  }

  const machoFiles = []
  // withFileTypes 不跟随符号链接（Electron Framework 的 Versions/Current
  // 是指向 Versions/A 的符号链接，跟随会死循环）
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && isMachO(full)) machoFiles.push(full)
    }
  }
  walk(appOutDir)

  for (const file of machoFiles) {
    execFileSync('codesign', ['--remove-signature', file])
    console.log(`  • stripped linker signature: ${path.relative(appOutDir, file)}`)
  }
}
