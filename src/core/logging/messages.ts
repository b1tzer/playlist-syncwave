/**
 * 日志消息目录：中文源消息 → 英文翻译。
 * Logger 按当前 locale（应用语言设置）渲染；缺省回退中文源消息。
 * 平台接口错误等动态消息不经翻译，原样输出。
 */
export const LOG_MESSAGE_EN: Record<string, string> = {
  // --- time() 通用 ---
  开始: 'started',
  完成: 'completed',
  失败: 'failed',

  // --- app 生命周期 ---
  应用启动: 'App started',
  应用即将退出: 'App quitting',
  创建主窗口: 'Main window created',
  未捕获异常: 'Uncaught exception',
  '未处理的 Promise 拒绝': 'Unhandled promise rejection',
  平台服务预热失败: 'Platform service warm-up failed',
  查询应用版本: 'Query app version',
  查询平台列表: 'Query platform list',
  加密数据: 'Encrypt data',

  // --- 平台注册 ---
  注册平台适配器: 'Platform adapter registered',
  未知平台: 'Unknown platform',

  // --- 凭证 ---
  凭证已加密保存: 'Credential encrypted and saved',
  凭证已清除: 'Credential cleared',
  凭证解密成功: 'Credential decrypted',
  凭证解密失败: 'Credential decryption failed',
  读取凭证文件失败: 'Failed to read credential file',
  无已保存凭证: 'No saved credential',
  '系统加密不可用，无法解密凭证': 'System encryption unavailable, cannot decrypt credential',

  // --- 扫码登录 ---
  发起扫码登录: 'QR login started',
  二维码票据生成成功: 'QR ticket generated',
  二维码已过期: 'QR code expired',
  扫码确认成功: 'QR scan confirmed',
  扫码登录成功: 'QR login succeeded',
  '扫码登录成功，凭证已保存': 'QR login succeeded, credential saved',
  关闭二维码弹窗: 'QR dialog closed',
  切换扫码通道: 'Login channel switched',
  查询登录状态: 'Query login status',
  退出登录: 'Logged out',
  获取二维码失败: 'Failed to obtain QR code',
  '轮询失败，继续等待': 'Poll failed, keep waiting',

  // --- QQ音乐本地服务 ---
  选择本地服务端口: 'Local service port selected',
  本地服务启动完成: 'Local service started',
  复用已有会话密钥: 'Reuse existing session secret',
  生成新的会话密钥: 'New session secret generated',
  QQ音乐请求成功: 'QQ Music request succeeded',
  QQ音乐请求失败: 'QQ Music request failed',

  // --- 解析 ---
  点击解析歌曲: 'Parse clicked',
  解析完成: 'Parse completed',
  输入格式探测结果: 'Format detected',
  清空输入: 'Input cleared',
  载入示例数据: 'Example data loaded',
  切换格式说明: 'Format help toggled',
  点选候选修正字段顺序: 'Candidate picked to fix field order',

  // --- 同步计划 ---
  开始匹配计划: 'Match plan started',
  匹配计划完成: 'Match plan completed',
  歌曲匹配成功: 'Song matched',
  歌曲匹配失败: 'Song match failed',
  未找到匹配歌曲: 'No matching song found',
  '同歌不同作者，进入手动选择': 'Same title, different artist: manual choice',
  '同歌不同作者，未选择版本': 'Same title, different artist: unresolved',
  '搜索失败，准备重试': 'Search failed, retrying',
  搜索请求失败: 'Search request failed',
  搜索结果: 'Search results',
  '映射缓存命中，跳过搜索': 'Mapping cache hit, search skipped',
  '组合关键词无精确命中，降级纯歌名搜索': 'Combined keyword missed, fallback to title-only search',

  // --- 同步执行 ---
  开始执行同步: 'Sync execution started',
  同步执行完成: 'Sync execution completed',
  目标歌单已创建: 'Target playlist created',
  批次写入成功: 'Batch write succeeded',
  批次写入失败: 'Batch write failed',
  '无可添加歌曲，跳过创建歌单': 'No songs to add, playlist creation skipped',
  同步等待用户确认: 'Sync awaiting user confirmation',
  同步完成: 'Sync completed',
  同步需要用户确认: 'Sync requires user confirmation',

  // --- 平台 IPC ---
  拉取歌单列表完成: 'Playlists fetched',
  拉取歌单歌曲完成: 'Playlist songs fetched',
  歌单重命名完成: 'Playlist renamed',
  歌单删除完成: 'Playlist deleted',
  添加歌曲完成: 'Songs added',
  移除歌曲完成: 'Songs removed',
  '用户确认选择，开始写入': 'User confirmed selections, writing',
  待确认同步会话已放弃: 'Pending sync session abandoned',

  // --- 平台通用操作 ---
  拉取歌单列表: 'Fetching playlists',
  拉取歌单歌曲: 'Fetching playlist songs',
  创建歌单成功: 'Playlist created',
  批量添加歌曲成功: 'Songs added in batch',
  重命名歌单成功: 'Playlist renamed',
  删除歌单成功: 'Playlist deleted',
  移除歌曲成功: 'Songs removed',
  重命名歌单: 'Renaming playlist',
  删除歌单: 'Deleting playlist',
  从歌单移除歌曲: 'Removing song from playlist',
  添加歌曲到歌单: 'Adding song to playlist',
  搜索歌曲: 'Searching songs',

  // --- 渲染层操作 ---
  侧边栏切换视图: 'View switched from sidebar',
  快捷键切换视图: 'View switched via shortcut',
  快捷键聚焦搜索框: 'Search box focused via shortcut',
  清空搜索: 'Search cleared',
  切换歌单平台: 'Playlist platform switched',
  手动刷新歌单列表: 'Playlist list refreshed manually',
  拉取歌单列表失败: 'Failed to fetch playlists',
  拉取歌曲失败: 'Failed to fetch songs',
  搜索歌曲失败: 'Song search failed',
  重命名失败: 'Rename failed',
  删除歌单失败: 'Delete playlist failed',
  移除歌曲失败: 'Remove song failed',
  添加歌曲失败: 'Add song failed',

  // --- 同步中心 ---
  开始同步: 'Sync started',
  同步结束: 'Sync finished',
  同步失败: 'Sync failed',
  同步需要手动选择: 'Sync requires manual selection',
  确认手动选择并继续同步: 'Manual selections confirmed, continuing sync',
  确认同步完成: 'Confirmed sync completed',
  确认同步失败: 'Confirmed sync failed',
  取消待确认同步: 'Pending sync cancelled',
  放弃同步会话失败: 'Failed to abandon sync session',
  新建同步任务: 'New sync task',
  删除同步任务: 'Remove sync task',
  同步任务已删除: 'Sync task removed',
  删除同步任务失败: 'Failed to remove sync task',
  确认清空同步历史: 'Confirm clear sync history',
  同步历史已清空: 'Sync history cleared',
  清空同步历史失败: 'Failed to clear sync history',
  前往确认待选歌曲: 'Go review pending songs',
  恢复同步历史: 'Sync history restored',
  恢复同步历史失败: 'Failed to restore sync history',
  同步历史落库失败: 'Failed to persist sync history',
  选择候选版本: 'Candidate version picked',
  回看上一首: 'Previous song reviewed',

  // --- 应用初始化/设置 ---
  初始化平台账号状态: 'Initializing platform accounts',
  初始化平台账号状态失败: 'Failed to initialize platform accounts',
  设置已恢复: 'Settings restored',
  设置恢复失败: 'Failed to restore settings',
  切换语言: 'Language switched',
  语言偏好已保存: 'Language preference saved',
  语言偏好保存失败: 'Failed to save language preference',
  恢复语言偏好失败: 'Failed to restore language preference',
  开机启动设置已保存: 'Auto-launch setting saved',
  开机启动设置保存失败: 'Failed to save auto-launch setting',
  日志上报设置已保存: 'Log report setting saved',
  日志上报设置保存失败: 'Failed to save log report setting',
  窗口运行时错误: 'Window runtime error',
}
