import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const API_PORT = process.env.API_PORT ?? '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
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
  build: {
    outDir: 'dist',
    // Карты кода наружу не отдаём: это исходники приложения. Для отладки
    // сборки — VITE_SOURCEMAP=1.
    sourcemap: process.env.VITE_SOURCEMAP === '1',
    rollupOptions: {
      output: {
        // Библиотеки меняются реже кода приложения — отдельный чанк живёт
        // в кеше браузера между выкладками.
        manualChunks: {
          react: ['react', 'react-dom'],
          ui: ['radix-ui', 'vaul', 'lucide-react', 'i18next', 'react-i18next'],
        },
      },
    },
  },
});
