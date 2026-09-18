import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One id per build. It is baked into the bundle (__BUILD_ID__) and written to
// dist/version.json so the running app can detect that a newer deploy exists
// (see src/UpdateBanner.jsx). Vercel exposes the commit SHA; fall back to time.
const BUILD_ID = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12) || String(Date.now());

// When the dev Vite server and the box game server run on different ports, proxy /api so that
// client-side fetches to /api/* (ticket C9 claim page, ticket B8 Instagram reward) reach the
// game server instead of the Vite dev server itself. WebSocket traffic still uses VITE_GAME_WS.
const gameApiTarget =
  process.env.VITE_GAME_WS && process.env.VITE_GAME_WS !== 'auto'
    ? process.env.VITE_GAME_WS.replace(/^ws/, 'http').replace(/\/ws$/, '')
    : null;

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

// ads/banners.json (ticket B10+B11) and the animated banners (ticket U3) are deliberately
// outside public/: in production Caddy mounts the whole ads/ directory straight from the repo
// (handle_path /ads*, Caddyfile) so a banner can be added or edited without a rebuild, the same
// way ops/index.html is. This middleware makes the dev server answer the same paths the same
// way; the banner images themselves live under public/ads/ and Vite already serves those.
function adsBannersDev() {
  const bannersDir = resolve(__dirname, 'ads', 'banners');
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
      // The self-contained banner HTML under ads/banners/, embedded by src/ads.jsx as an iframe
      // with a ?embed=1 (and, for the concepts file, ?concept=N) query the file itself reads.
      // Traversal is refused by the prefix check; the query never reaches the filesystem.
      server.middlewares.use('/ads/banners/', (req, res) => {
        // connect strips the mount path, so req.url is the remainder ('/file.html?embed=1').
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^[/\\]+/, '');
        const file = resolve(bannersDir, rel);
        if (!file.startsWith(bannersDir + sep)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(readFileSync(file));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

// The self-hosted mission videos (ticket: self-host the mission videos, docs/tickets/
// self-host-mission-videos.md) live under ads/videos/, git-ignored, same pattern as the banner
// assets above - an operator drops an MP4 in and it is live with no rebuild. In production Caddy
// already serves the whole ads/ tree at /ads* (handle_path, Caddyfile); this middleware answers
// the same /ads/videos/<file> paths from disk in dev, including HTTP Range so the <video> element
// buffers the same way a real static file server would.
function adsVideosDev() {
  const videosDir = resolve(__dirname, 'ads', 'videos');
  return {
    name: 'xchief-ads-videos-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/ads/videos/', (req, res) => {
        const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^[/\\]+/, '');
        const file = resolve(videosDir, rel);
        if (!file.startsWith(videosDir + sep) || !existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const { size } = statSync(file);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        const range = req.headers.range;
        if (!range) {
          res.setHeader('Content-Length', size);
          createReadStream(file).pipe(res);
          return;
        }
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
        const end = match?.[2] ? Number.parseInt(match[2], 10) : size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${size}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile(), adsBannersDev(), adsVideosDev()],
  base: './',
  server: gameApiTarget
    ? {
        proxy: {
          '/api': { target: gameApiTarget, changeOrigin: true },
        },
      }
    : undefined,
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
