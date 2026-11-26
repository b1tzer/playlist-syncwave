import { app } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * 数据目录隔离：必须在 app.ready 之前、且在任何 getPath('userData') 之前执行。
 * 正式版保持默认 userData，开发版落到 userData/dev，可用环境变量整体覆盖。
 */
export function configureUserDataPath(): void {
  const override = process.env.PLAYLIST_USER_DATA_DIR
  if (override) {
    app.setPath('userData', isAbsolute(override) ? override : resolve(override))
    return
  }
  if (!app.isPackaged) {
    app.setPath('userData', join(app.getPath('userData'), 'dev'))
  }
}

configureUserDataPath()
