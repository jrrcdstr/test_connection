# Kanta Tayo! 🎤 — Videoke party (test version)

Free videoke web app: open it on the TV, everyone adds YouTube karaoke songs from their phones.

## How it works
- **`/host.html`** (TV/laptop): creates a room, shows a 4-letter code + QR code, plays the queue with the official YouTube embedded player, shows a score after each song.
- **`/remote.html`** (phones): join by code/QR, paste a YouTube link, see the queue, move a song to next, remove, or skip.
- **`netlify/functions/api.mts`**: small API storing rooms and queues in Netlify Blobs (no extra accounts needed). Devices poll every 2–3 s; each room has a version, so a poll where nothing changed costs two small reads and about 80 bytes.
- **Design**: the blue idle screen of a videoke machine, with outlined lyric lettering (`.lyric` in `public/style.css`). Display font Baloo 2 is self-hosted in `public/fonts` (OFL licence); body text uses the system font.

Rooms expire after 24 hours.

## Song search
Phones can search for songs inside the app. This uses the official YouTube Data API and needs a free key:
set `YOUTUBE_API_KEY` in Netlify (Project configuration → Environment variables, scope Functions) and redeploy.
The free quota is about 100 new searches a day; results are cached for a week, so repeated songs don't count.
Without a key, or when the quota runs out, the phone opens YouTube's own search instead.

## Run locally
```bash
npm install
netlify dev
```

## Notes
- Songs play through YouTube's official embed, so YouTube ads may appear and some videos that block embedding can't be played (the app skips them).
- Scoring is for fun: with the microphone enabled it is based on how much of the song you sang; otherwise it's classic videoke-style random scoring.
