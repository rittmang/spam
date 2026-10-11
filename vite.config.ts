import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (
              ['http://127.0.0.1:5173', 'http://localhost:5173'].includes(
                request.headers.origin || '',
              )
            )
              proxyRequest.setHeader('Origin', 'http://127.0.0.1:8787');
          });
        },
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
