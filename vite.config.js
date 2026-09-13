import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One id per build. It is baked into the bundle (__BUILD_ID__) and written to
// dist/version.json so the running app can detect that a newer deploy exists
// (see src/UpdateBanner.jsx). Vercel exposes the commit SHA; fall back to time.
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12) || String(Date.now());

function versionFile() {
  return {
    name: 'xchief-version-file',
    apply: 'build',
    closeBundle() {
      const dir = resolve(__dirname, 'dist');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'version.json'), JSON.stringify({ build: BUILD_ID, at: new Date().toISOString() }));
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile()],
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // Afghanistan welcome-bonus landing, served at /af/
        af: resolve(__dirname, 'af/index.html'),
      },
    },
  },
});
