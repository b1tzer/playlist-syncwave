import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: { '@core': resolve(root, 'src/core') },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
