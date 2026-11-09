# Kanta Tayo! 🎤 — Videoke party (test version)

Free videoke web app: open it on the TV, everyone adds YouTube karaoke songs from their phones.

## How it works
- **`/host.html`** (TV/laptop): creates a room, shows a 4-letter code + QR code, plays the queue with the official YouTube embedded player, shows a score after each song.
- **`/remote.html`** (phones): join by code/QR, paste a YouTube link, see the queue, move a song to next, remove, or skip.
- **`netlify/functions/api.mts`**: small API storing rooms and queues in Netlify Blobs (no extra accounts needed). Devices poll every 2–3 s.

Rooms expire after 24 hours.

## Run locally
```bash
npm install
netlify dev
```

## Notes
- Songs play through YouTube's official embed, so YouTube ads may appear and some videos that block embedding can't be played (the app skips them).
- Scoring is for fun: with the microphone enabled it is based on how much of the song you sang; otherwise it's classic videoke-style random scoring.
