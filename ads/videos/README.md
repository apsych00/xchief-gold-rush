# Self-hosted mission videos

The three "Watch xChief videos" mission clips (`src/Tasks.jsx`, `db/seed.sql`), served the same
way the ad banners are: outside `dist/`, mounted read-only into the box, git-ignored so a file can
be dropped in without a rebuild.

Video ids (xChief's own YouTube channel): `pA17iDq3Ppw`, `BjndfW6kQLU`, `EETzCqTaZGg`.

## Files this folder needs

```
ads/videos/pA17iDq3Ppw.mp4
ads/videos/BjndfW6kQLU.mp4
ads/videos/EETzCqTaZGg.mp4
```

`*.mp4` under this folder is git-ignored (see `.gitignore`); only this README is committed. Drop
the real files in with these exact names and they are live immediately, no rebuild.

## Getting the files

Web-optimized MP4, H.264 video + AAC audio, capped at 720p, with `+faststart` so playback starts
before the whole file downloads. With `yt-dlp` installed (`pip install yt-dlp` if missing) and
`ffmpeg` on PATH:

```
yt-dlp -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]" --merge-output-format mp4 \
  -o "ads/videos/<id>.mp4" "https://www.youtube.com/watch?v=<id>"
```

Run once per id above. If the merged file was not already faststart (yt-dlp muxes with ffmpeg and
usually gets this right, but if the moov atom ends up at the end), remux without re-encoding:

```
ffmpeg -i ads/videos/<id>.mp4 -c copy -movflags +faststart ads/videos/<id>.fixed.mp4
mv ads/videos/<id>.fixed.mp4 ads/videos/<id>.mp4
```

At the time this ticket was built, `yt-dlp` hit YouTube's own "Sign in to confirm you're not a
bot" wall from this machine's IP when downloading (the same class of block this ticket exists to
route around on the *playback* side, just hitting the *download* side here instead). Three small
placeholder clips (a few seconds of solid color with a label, generated with `ffmpeg`'s `lavfi`
source, no external content) were dropped in locally so the serving path and the player wiring
could be tested end to end. Swap them for the real exports with the commands above from a network
`yt-dlp` can reach, or pull the files from wherever the marketing team already has them.

## How they are served

Same mechanism as `ads/banners.json` and `ads/banners/*.html`:

- **Production (Caddy):** `docker-compose.yml` mounts `./ads:/srv/ads:ro`, and the `Caddyfile`'s
  `handle_path /ads*` block already serves the whole `ads/` tree from `/srv/ads` with `file_server`
  - `ads/videos/<id>.mp4` is reachable at `/ads/videos/<id>.mp4` with no extra Caddy config.
- **Dev (Vite):** `vite.config.js`'s `adsVideosDev()` middleware answers `/ads/videos/<id>.mp4`
  straight from this folder on disk, with HTTP Range support (206 partial content) so the
  `<video>` element buffers the same way a static file server would.

The client (`src/Tasks.jsx`) points the three video mission rows at these paths via
`db/seed.sql`'s `url` column - swapping a file here never needs a code or schema change.
