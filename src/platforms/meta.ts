import type { PlatformAdapter } from './base'
import type { PlatformMeta } from '@core/models/platform'

/**
 * 平台适配器构造上下文：由主进程注入。
 * 平台模块代码不得直接依赖 electron，以便在测试环境中加载。
 */
export interface AdapterContext {
  /** 应用数据目录（等价 app.getPath('userData')） */
  userDataDir: string
}

/**
 * 平台插件模块（自描述）：
 * 新增平台只需在 src/platforms/<id>/index.ts 新建一个目录，
 * 实现 PlatformAdapter 并 default 导出 PlatformModule，
 * 由 src/platforms/index.ts 的 import.meta.glob 自动收集注册，无需修改任何历史代码。
 */
export interface PlatformModule {
  /** 平台元数据（名称/图标/能力/登录渠道），供注册表与渲染层动态消费 */
  meta: PlatformMeta
  /** 创建适配器：可在此完成重依赖加载（require 第三方 API 包）、本地服务启动等初始化 */
  createAdapter: (ctx: AdapterContext) => PlatformAdapter | Promise<PlatformAdapter>
}
