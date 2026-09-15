import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// The dashboard server hosts the built bundle from dashboard/static, so the build
// writes there directly. emptyOutDir is false because that folder is also the
// server's static root and may hold files we do not want wiped mid-build.
export default defineConfig({
  plugins: [react()],
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, '..', 'static'),
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          antd: ['antd', '@ant-design/icons'],
          table: ['@tanstack/react-table'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3247',
      '/health': 'http://127.0.0.1:3247',
    },
  },
});
