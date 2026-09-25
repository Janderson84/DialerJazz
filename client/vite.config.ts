import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    // Allow the public preview tunnel hostname (Vite's dev-server host check
    // otherwise rejects it with 403, surfaced by the tunnel as 502).
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // InsForge backend bridge. The @insforge/sdk builds ABSOLUTE /api/* URLs,
      // and the public tunnel edge blocks the /api/auth path prefix, so the SDK
      // is anchored on a neutral /_bf prefix instead (see client/src/lib/insforge.ts).
      '/_bf': {
        target: 'http://localhost:7130',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/_bf/, ''),
        // InsForge sets the refresh-token cookie with Path=/api/auth; rewrite it
        // to match the /_bf bridge path so the browser sends it back on refresh.
        cookiePathRewrite: { '/api/auth': '/_bf/api/auth' },
      },
    },
  },
})
