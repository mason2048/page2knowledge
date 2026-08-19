import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const LOCAL_API_ORIGIN = 'http://127.0.0.1:4315';

export function rewriteLocalDevelopmentOrigin(origin: string | undefined): string | undefined {
  return origin === 'http://127.0.0.1:4314' || origin === 'http://localhost:4314'
    ? LOCAL_API_ORIGIN
    : origin;
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4314,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4315',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            // Preserve the strict backend same-origin policy while supporting
            // only the two exact loopback Vite origins in local development.
            const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
            const rewritten = rewriteLocalDevelopmentOrigin(origin);
            if (rewritten !== origin && rewritten) {
              proxyRequest.setHeader('origin', rewritten);
            }
          });
        }
      }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4314
  }
});
