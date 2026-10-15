/// <reference types="vite/client" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { ProxyOptions } from 'vite'

/**
 * The AI proxy server (server/index.mjs) is optional. When it is not running the
 * dev server must not turn /api requests into 500s — the frontend handles the
 * failure gracefully and shows an honest "AI unavailable" state.
 */
const aiProxy: ProxyOptions = {
  target: 'http://127.0.0.1:8787',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('error', (_err, _req, res) => {
      if (res && 'writeHead' in res && !res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
      }
      if (res && 'end' in res) {
        res.end(JSON.stringify({ ok: false, configured: false, message: 'AI 服务端代理未运行（npm run server）' }))
      }
    })
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': aiProxy,
    },
  },
  build: {
    // The bank JSON is bundled with the app; raise the warning limit accordingly.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: true,
  },
})
