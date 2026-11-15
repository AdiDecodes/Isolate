# Isolate — Vocal / BGM Splitter (Chrome Extension)

Three-way audio toggle for YouTube and YouTube Music: **Vocals / Whole / BGM**, powered by cloud-hosted Demucs stem separation.

- Separation runs entirely in the cloud via a **private** Hugging Face Space (`adityasingh18/Demucs-api`, htdemucs on ZeroGPU) — an HF token is required (stored locally, prompted on first use). No on-device model; nothing runs locally except playback.
- The mix is sent in **10-second segments**, one queued cloud request each; each finished segment starts playing immediately. Until then (and wherever stems aren't ready yet), the video's original audio plays untouched.

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open any YouTube / YT Music video. Three ways to control it:
   - the extension **popup** (toolbar icon): video info, three-way toggle, AI switch with live progress
   - an "ISOLATE" pill near the bottom-left of the player, or
   - a headphone button in the player's native control bar (next to fullscreen on YouTube; in the right controls on YT Music) — click to cycle **Vocals → Whole → BGM**, with an on-player toast showing the active mode.
5. Click **AI** to enable separation — the first click asks for your Hugging Face token (the Space is private). Vocals/BGM only apply where Demucs stems exist.

## How it works

1. `background.js` resolves the video's audio stream **without calling any YouTube API**, in order: a local **yt-dlp sidecar** (`pip install -U yt-dlp`, then `python sidecar/audio_server.py` — recommended, most reliable), public Invidious instances, and finally the stream URL the page's own player is already fetching. YouTube is only used for the videoId.
2. `offscreen.js` downloads the stream, decodes it, then for each **10-second segment** encodes a WAV, uploads it to the Demucs Space, waits for the four stems, and delivers **vocals/BGM** (BGM = mix − vocals) to the tab.
3. `injected.js` schedules the stem segments against the video element: while stems cover the current position, native audio is muted (restored exactly as the user left it when stems stop) and stem buffers play in sync, honoring seek, playback rate, and pause.

## Limitations

- Per-segment cloud round trips mean hard cuts at 10s boundaries and stems trailing playback by a couple of segments; the original mix plays until a segment's stems land.
- Relies on a free public Hugging Face Space — it can sleep, queue, or rate-limit under load.
- DRM-protected streams (EME, e.g. some rented/premium content) cannot be extracted and are left untouched.

## Files

- `manifest.json` — MV3 manifest, content script scoped to youtube.com / music.youtube.com
- `index.html` / `popup.js` — toolbar popup: video info, mode toggle, AI switch with progress
- `background.js` — service worker: extracts the video's audio stream URL, manages the offscreen document, routes results to the tab
- `offscreen.html` / `offscreen.js` — offscreen document: sends 10s WAV segments to the Demucs Space, decodes the returned vocals stem, delivers 10s stem segments
- `injected.js` — MAIN world: stem playback synced to the video element (SPA-safe)
- `content.js` — floating toggle UI, mode persistence, HF-token prompt and AI status display
- `content.css` — pill styling
