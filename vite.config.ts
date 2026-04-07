import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies /api to Express so the browser never needs a second origin in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
