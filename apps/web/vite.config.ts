import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_PORT = process.env.API_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // cloudflared выдаёт случайный поддомен *.trycloudflare.com — Vite обязан
    // его принять, иначе Mini App в Telegram упрётся в "Blocked request".
    allowedHosts: true,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
