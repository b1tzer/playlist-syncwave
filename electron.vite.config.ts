import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@core': resolve(root, 'src/core') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@core': resolve(root, 'src/core') },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(root, 'src/renderer/src'),
        '@core': resolve(root, 'src/core'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
})
