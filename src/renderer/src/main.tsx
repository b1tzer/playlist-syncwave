import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { I18nProvider } from './i18n'
import {
  createRendererLogger,
  installRendererErrorHandlers,
  installRendererLogging,
} from './logging/rendererLogger'
import { restoreTheme } from './theme'

// 先安装全局默认传输，再注册全局错误处理
installRendererLogging()
installRendererErrorHandlers(createRendererLogger('renderer'))

// 用 preload 同步快照恢复主题：首帧即为持久化配色，避免浅色用户看到深色闪烁
restoreTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
)
