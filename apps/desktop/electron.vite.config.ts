import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// Ядро (`@kenshi-editor/core`) — исходники TypeScript в рабочей области: его не выносим во
// внешние зависимости, а собираем в main и renderer.
const workspace = { exclude: ['@kenshi-editor/core'] };

// В режиме разработки react-refresh вставляет встроенный скрипт — CSP для него ослабляется
// только на dev-сервере; собранное приложение остаётся со строгим `script-src 'self'`.
const devCsp: Plugin = {
  name: 'kedit-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
};

export default defineConfig({
  main: {
    build: { externalizeDeps: workspace },
  },
  preload: {
    // Окно в песочнице: preload должен быть CommonJS одним файлом.
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    plugins: [react(), devCsp],
    // Явный IPv4: по умолчанию Vite слушает только [::1], а подключение к нему в Windows бывает
    // запрещено — окно разработки тогда остаётся пустым.
    server: { host: '127.0.0.1' },
  },
});
