import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ads/banners.json (ticket B10+B11) is deliberately outside public/: in production Caddy
// mounts it straight from the repo (handle_path /ads*, Caddyfile) so it can be edited without a
// rebuild, the same way ops/index.html is. This middleware makes the dev server answer the same
// path the same way; the banner images themselves live under public/ads/ and Vite already
// serves those.
function adsBannersDev() {
  return {
    name: 'xchief-ads-banners-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/ads/banners.json', (req, res) => {
        try {
          res.setHeader('Content-Type', 'application/json');
          res.end(readFileSync(resolve(__dirname, 'ads', 'banners.json')));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile(), adsBannersDev()],
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
