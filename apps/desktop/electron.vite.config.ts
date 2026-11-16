import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

// The core (`@kenshi-editor/core`) is TypeScript sources in the workspace: it is not made
// an external dependency, it is bundled into main and renderer.
const workspace = { exclude: ['@kenshi-editor/core'] };

// In dev mode react-refresh injects an inline script — CSP is relaxed for it
// only on the dev server; the built app keeps the strict `script-src 'self'`.
const devCsp: Plugin = {
  name: 'kedit-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
};

export default defineConfig({
  main: {
    build: {
      externalizeDeps: workspace,
      // Second entry: the Workshop uploader, run as a separate Node process (src/main/publish.ts).
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          uploader: resolve(import.meta.dirname, 'src/uploader/index.ts'),
        },
      },
    },
  },
  preload: {
    // Sandboxed window: preload must be a single CommonJS file.
    build: {
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    plugins: [react(), devCsp],
    // Explicit IPv4: by default Vite listens only on [::1], and connecting to it on Windows can be
    // blocked — the dev window then stays blank.
    server: { host: '127.0.0.1' },
  },
});
