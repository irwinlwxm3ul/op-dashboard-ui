import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  worker: { format: 'es' },
  build: { outDir: 'dist', target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 2000 },
});
