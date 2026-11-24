import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import {
  createRendererLogger,
  installRendererErrorHandlers,
  installRendererLogging,
} from './logging/rendererLogger'

// 先安装全局默认传输，再注册全局错误处理
installRendererLogging()
installRendererErrorHandlers(createRendererLogger('renderer'))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
