import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT ?? 3000}`,
      '/ws': { target: `ws://localhost:${process.env.API_PORT ?? 3000}`, ws: true },
    },
  },
});
