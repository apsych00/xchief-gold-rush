# Ticket: Self-host the mission videos (drop the YouTube embed)

## Why

The YouTube IFrame embed in the watch-to-earn mission keeps triggering YouTube's
"confirm you're not a robot" interstitial. It is IP-reputation based (worse at the booth,
where many plays come from one IP) and cannot be defeated client-side - the nocookie/origin
hardening and the "open on YouTube" fallback already shipped only reduce it. That interstitial
blocks playback and the reward.

## Decision

Self-host the mission videos and play them from a local `<video>` element, removing YouTube from
the watch path entirely. The three videos are xChief's own marketing content (their YouTube
channel), so xChief owns them and may host their own files - no third-party ToS issue.

Videos (xChief's own): `pA17iDq3Ppw`, `BjndfW6kQLU`, `EETzCqTaZGg`.

## What to build

1. **Get the files.** Download the three videos as web-optimized MP4 (H.264 video + AAC audio,
   ~720p, `-movflags +faststart` so they stream without a full download). Use `yt-dlp`
   (install locally if missing) e.g.:
   `yt-dlp -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]" --merge-output-format mp4 -o "<id>.mp4" "https://www.youtube.com/watch?v=<id>"`
   then remux with faststart if needed (`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`).
   If a tool is unavailable in the sandbox, document the exact commands and place a small
   placeholder so the wiring is testable, and flag that the real files must be dropped in.

2. **Serve them from an operator-swappable, git-ignored path** - mirror how ad banners are served
   outside `dist/` (see `ads/` + the Caddy `handle_path /ads*` + vite dev mirror). Put the files
   under `ads/videos/` (or a new `handle_path /videos*`); git-ignore the binaries, commit a
   `README`/`.gitkeep` and the ignore entry. Document the Caddy + vite serving so prod picks them
   up without a rebuild (same pattern as banners).

3. **Client: use the existing hosted-`<video>` path** in `src/Tasks.jsx` `VideoModal` (it already
   reports `currentTime` and reuses the watch-progress accumulator). Point the mission at the local
   file URL instead of a YouTube video id. Keep:
   - the single "Watch xChief videos" row cycling the 3 videos ("x of 3"), 3-minute unlock,
   - the 30-second watch requirement, the white "Watch for 30 seconds or more to get the reward"
     note, and a Skip/close,
   - non-seekable behavior: hide/disable native seeking (custom minimal controls or
     `controlsList="nofullscreen nodownload noremoteplayback"` + block the seek gesture) and keep
     the existing per-tick watch cap so a fast-forward cannot credit skipped time.
   Remove/retire the YouTube IFrame path and its bot-detection fallback for these missions once the
   local path works (keep the code clean; the generic `kind='video'` hosted path already exists).

4. **Seed:** switch the three mission rows to the hosted-video path (kind `video` with a local
   `url`, or keep the youtube grouping but point `url` at the local file - whichever keeps the
   one-row "x of 3" UI and per-video server-released rewards). Server-side reward release
   (`report_video_progress` at the 30s threshold, once per device/email) stays unchanged - the
   client still only reports observed watch time; the server decides.

5. **Fallback:** if a local file 404s or errors, show a clear message and do not brick the mission.

## Acceptance

- Opening a video mission plays the local MP4 with NO request to youtube.com and no bot
  interstitial.
- Watching 30s releases the reward server-side; skipping/seeking does not.
- The one-row 3-video rotation, 3-min unlock, and "x of 3" progress are intact.
- Files live in an operator-swappable, git-ignored path served like the ad banners; the serving is
  documented for prod (Caddy) and dev (vite).
- Lint + build clean; the missions E2E updated to the hosted path stays green.
