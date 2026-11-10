import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Data layout in the "videoke" store (one key per thing, so different
// devices never overwrite each other's writes):
//   rooms/<CODE>/meta      { code, createdAt, hostToken }   written once
//   rooms/<CODE>/host      { token, since }                 current TV (changes on takeover)
//   rooms/<CODE>/now       { item, startedAt }              written by host only
//   rooms/<CODE>/pos       { id, t, at }                    playback position, written by host
//   rooms/<CODE>/skip      { at }                           written by remotes
//   rooms/<CODE>/v         version string, bumped after every change the room should redraw for
//   rooms/<CODE>/pause     { paused, at }                   written by remotes/TV, reset each song
//   rooms/<CODE>/q/<id>    queue item                       one key per song

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUE = 100;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

type QueueItem = {
  id: string;
  videoId: string;
  title: string;
  author: string;
  singer: string;
  order: number;
  addedAt: number;
};

type RoomMeta = { code: string; createdAt: number; hostToken: string };
type HostInfo = { token: string; since: number };

const newToken = () => randomString(24, "abcdefghijklmnopqrstuvwxyz0123456789");

const store = () => getStore({ name: "videoke", consistency: "strong" });

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status = 400) => json({ error: message }, status);

function randomString(len: number, alphabet = CODE_ALPHABET) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

async function lookupVideo(videoId: string) {
  const target = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`,
    );
    if (res.status === 401 || res.status === 403) {
      return { error: "This video doesn't allow playing on other sites. Try another karaoke version." };
    }
    if (!res.ok) return { error: "Video not found. Check the link." };
    const data = (await res.json()) as { title?: string; author_name?: string };
    return { title: data.title ?? "YouTube video", author: data.author_name ?? "" };
  } catch {
    // YouTube unreachable: still allow it, the player will report problems.
    return { title: "YouTube video", author: "" };
  }
}

// ---------- Song search ----------
// Results are kept for a week and shared by everyone who looks for the same song.
// With YOUTUBE_API_KEY set, the official Data API is used. Without it, results are
// read from YouTube's own search page. That page is not a supported interface: it
// can change or refuse us at any time, so every failure returns a code the phone
// turns into "open YouTube and paste the link".
const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type SearchResult = { videoId: string; title: string; channel: string; length?: string };
type SearchOutcome = { status: number; body: Record<string, unknown> };

const decodeEntities = (t: string) =>
  t.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const UPSTREAM: SearchOutcome = {
  status: 502,
  body: { error: "Search isn't working right now.", code: "upstream" },
};

async function searchWithApi(query: string, key: string): Promise<SearchResult[] | SearchOutcome> {
  const api = new URL("https://www.googleapis.com/youtube/v3/search");
  api.search = new URLSearchParams({
    part: "snippet", type: "video", videoEmbeddable: "true", maxResults: "10", safeSearch: "moderate", q: query, key,
  }).toString();
  const res = await fetch(api);
  if (!res.ok) {
    const text = await res.text();
    console.error("youtube api search failed", res.status, text.slice(0, 300));
    if (res.status === 403 && /quota/i.test(text)) {
      return { status: 429, body: { error: "Today's free searches are used up.", code: "quota" } };
    }
    return UPSTREAM;
  }
  const data = (await res.json()) as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }[];
  };
  return (data.items ?? [])
    .filter((i) => i.id?.videoId)
    .map((i) => ({
      videoId: i.id!.videoId!,
      title: decodeEntities(i.snippet?.title ?? "YouTube video").slice(0, 200),
      channel: decodeEntities(i.snippet?.channelTitle ?? "").slice(0, 100),
    }));
}

// Collect every "videoRenderer" object, wherever YouTube has nested it this month.
function collectVideos(node: unknown, found: Record<string, any>[], limit: number) {
  if (found.length >= limit || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectVideos(child, found, limit);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "videoRenderer" && value && typeof value === "object") found.push(value as Record<string, any>);
    else collectVideos(value, found, limit);
    if (found.length >= limit) return;
  }
}

const runsText = (v: any): string =>
  typeof v?.simpleText === "string" ? v.simpleText : Array.isArray(v?.runs) ? v.runs.map((r: any) => r?.text ?? "").join("") : "";

async function canEmbed(videoId: string): Promise<boolean> {
  try {
    const target = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${target}`);
    return res.ok;
  } catch {
    return true; // can't tell; the TV skips it if it really can't play
  }
}

async function searchWithPage(query: string): Promise<SearchResult[] | SearchOutcome> {
  let html: string;
  try {
    // sp=EgIQAQ== asks for videos only (no channels, playlists or shorts shelves)
    const page = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D&hl=en`;
    const res = await fetch(page, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
        cookie: "SOCS=CAI; CONSENT=YES+1",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("youtube page search failed", res.status);
      return UPSTREAM;
    }
    html = await res.text();
  } catch (err) {
    console.error("youtube page search failed", err);
    return UPSTREAM;
  }

  const start = html.indexOf("var ytInitialData = ");
  const end = start < 0 ? -1 : html.indexOf(";</script>", start);
  if (start < 0 || end < 0) {
    console.error("youtube page search: no data block (page changed or we were refused)");
    return UPSTREAM;
  }
  let data: unknown;
  try {
    data = JSON.parse(html.slice(start + "var ytInitialData = ".length, end));
  } catch {
    console.error("youtube page search: data block did not parse");
    return UPSTREAM;
  }

  const raw: Record<string, any>[] = [];
  collectVideos(data, raw, 16);
  const candidates = raw
    .filter((v) => typeof v.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(v.videoId) && runsText(v.lengthText))
    .map((v) => ({
      videoId: v.videoId as string,
      title: (runsText(v.title) || "YouTube video").slice(0, 200),
      channel: (runsText(v.ownerText) || runsText(v.longBylineText)).slice(0, 100),
      length: runsText(v.lengthText).slice(0, 10),
    }));
  // Leave out videos that aren't allowed to play outside YouTube.
  const playable = await Promise.all(candidates.map((c) => canEmbed(c.videoId)));
  return candidates.filter((_, i) => playable[i]).slice(0, 10);
}

async function searchSongs(rawQuery: string): Promise<SearchOutcome> {
  const words = rawQuery.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  if (words.length < 2) return { status: 400, body: { error: "Type a song title or an artist." } };
  const query = /karaoke|videoke/.test(words) ? words : `${words} karaoke`;

  const s = store();
  const cacheKey = `search/${encodeURIComponent(query)}`;
  const cached = (await s.get(cacheKey, { type: "json" })) as { at: number; results: SearchResult[] } | null;
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return { status: 200, body: { results: cached.results } };

  const key = Netlify.env.get("YOUTUBE_API_KEY");
  const found = key ? await searchWithApi(query, key) : await searchWithPage(query);
  if (!Array.isArray(found)) return found;
  if (found.length) await s.setJSON(cacheKey, { at: Date.now(), results: found });
  return { status: 200, body: { results: found } };
}

async function getRoom(code: string): Promise<RoomMeta | null> {
  const meta = (await store().get(`rooms/${code}/meta`, { type: "json" })) as RoomMeta | null;
  if (!meta || Date.now() - meta.createdAt > ROOM_TTL_MS) return null;
  return meta;
}

async function getHost(room: RoomMeta): Promise<HostInfo> {
  const host = (await store().get(`rooms/${room.code}/host`, { type: "json" })) as HostInfo | null;
  return host ?? { token: room.hostToken, since: room.createdAt };
}

async function listQueue(code: string): Promise<QueueItem[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: `rooms/${code}/q/` });
  const items = await Promise.all(
    blobs.map((b) => s.get(b.key, { type: "json" }) as Promise<QueueItem | null>),
  );
  return items.filter((i): i is QueueItem => i !== null).sort((a, b) => a.order - b.order);
}

const getVersion = async (code: string): Promise<string> =>
  (await store().get(`rooms/${code}/v`, { type: "text" })) ?? "0";

// Call AFTER the data write, so a poller never pairs a new version with old data.
const bump = (code: string) =>
  store().set(`rooms/${code}/v`, `${Date.now().toString(36)}${randomString(3)}`);

async function roomState(room: RoomMeta) {
  const s = store();
  const code = room.code;
  const v = await getVersion(code); // read before the data, same reason as above
  const [queue, now, skip, pos, host, pause] = await Promise.all([
    listQueue(code),
    s.get(`rooms/${code}/now`, { type: "json" }),
    s.get(`rooms/${code}/skip`, { type: "json" }),
    s.get(`rooms/${code}/pos`, { type: "json" }),
    getHost(room),
    s.get(`rooms/${code}/pause`, { type: "json" }),
  ]);
  return {
    code,
    v,
    now: now ?? null,
    pos: pos ?? null,
    hostSince: host.since,
    skipAt: (skip as { at?: number } | null)?.at ?? 0,
    paused: Boolean((pause as { paused?: boolean } | null)?.paused),
    serverNow: Date.now(),
    queue,
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;
  const s = store();

  try {
    // POST /api/rooms  -> create a room
    if (parts.length === 1 && parts[0] === "rooms" && method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomString(4);
        const meta: RoomMeta = {
          code,
          createdAt: Date.now(),
          hostToken: newToken(),
        };
        const { modified } = await s.setJSON(`rooms/${code}/meta`, meta, { onlyIfNew: true });
        if (modified) {
          const host: HostInfo = { token: meta.hostToken, since: meta.createdAt };
          await s.setJSON(`rooms/${code}/host`, host);
          return json({ code, hostToken: host.token, hostSince: host.since }, 201);
        }
      }
      return fail("Couldn't create a room, please try again.", 500);
    }

    // GET /api/search?room=CODE&q=words   (only for people in a live party)
    if (parts.length === 1 && parts[0] === "search" && method === "GET") {
      const roomCode = (url.searchParams.get("room") ?? "").toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(roomCode) || !(await getRoom(roomCode))) {
        return fail("Room not found or expired. Ask the host for the new code.", 410);
      }
      const found = await searchSongs(url.searchParams.get("q") ?? "");
      return json(found.body, found.status);
    }

    if (parts[0] !== "rooms" || !parts[1]) return fail("Not found", 404);
    const code = parts[1].toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return fail("Invalid room code", 400);
    const room = await getRoom(code);
    if (!room) return fail("Room not found or expired. Ask the host for the new code.", 410);

    const action = parts[2];
    const isHost = async () => req.headers.get("x-host-token") === (await getHost(room)).token;

    // GET /api/rooms/:code[?v=<version the caller already has>]
    // When nothing changed, answer with two small reads instead of the whole room.
    if (!action && method === "GET") {
      const have = url.searchParams.get("v");
      if (have && have === (await getVersion(code))) {
        const pos = await s.get(`rooms/${code}/pos`, { type: "json" });
        return json({ unchanged: true, v: have, pos: pos ?? null, serverNow: Date.now() });
      }
      return json(await roomState(room));
    }

    // POST /api/rooms/:code/takeover  (this device becomes the TV; the old TV stops)
    if (action === "takeover" && method === "POST") {
      const next: HostInfo = { token: newToken(), since: Date.now() };
      await s.setJSON(`rooms/${code}/host`, next);
      await bump(code);
      return json({ code, hostToken: next.token, hostSince: next.since });
    }

    // POST /api/rooms/:code/progress { id, t }  (host only: remember playback position)
    if (action === "progress" && method === "POST") {
      if (!(await isHost())) return fail("This screen is no longer the TV.", 403);
      const body = await readBody(req);
      const id = String(body.id ?? "");
      const t = Number(body.t);
      if (!/^[a-z0-9]{1,40}$/.test(id) || !Number.isFinite(t) || t < 0) return fail("Invalid progress");
      await s.setJSON(`rooms/${code}/pos`, { id, t: Math.round(t * 10) / 10, at: Date.now() });
      return json({ ok: true });
    }

    // POST /api/rooms/:code/queue  { url, singer }
    if (action === "queue" && !parts[3] && method === "POST") {
      const body = await readBody(req);
      const videoId = parseVideoId(String(body.url ?? ""));
      if (!videoId) return fail("That doesn't look like a YouTube link.");
      const singer = String(body.singer ?? "").trim().slice(0, 30) || "Guest";
      const { blobs } = await s.list({ prefix: `rooms/${code}/q/` });
      if (blobs.length >= MAX_QUEUE) return fail("The queue is full (100 songs).");
      const info = await lookupVideo(videoId);
      if ("error" in info) return fail(info.error as string);
      const now = Date.now();
      const item: QueueItem = {
        id: `${now.toString(36)}${randomString(4, "abcdefghijklmnopqrstuvwxyz0123456789")}`,
        videoId,
        title: info.title.slice(0, 200),
        author: info.author.slice(0, 100),
        singer,
        order: now,
        addedAt: now,
      };
      await s.setJSON(`rooms/${code}/q/${item.id}`, item);
      await bump(code);
      return json(item, 201);
    }

    // DELETE /api/rooms/:code/queue/:id
    // POST   /api/rooms/:code/queue/:id/bump   (move to next in line)
    if (action === "queue" && parts[3]) {
      const id = parts[3];
      if (!/^[a-z0-9]{1,40}$/.test(id)) return fail("Invalid song id");
      const key = `rooms/${code}/q/${id}`;
      if (!parts[4] && method === "DELETE") {
        await s.delete(key);
        await bump(code);
        return json({ ok: true });
      }
      if (parts[4] === "bump" && method === "POST") {
        const entry = await s.getWithMetadata(key, { type: "json" });
        if (entry === null) return fail("That song is no longer in the queue.", 410);
        const queue = await listQueue(code);
        const minOrder = queue.length ? queue[0].order : Date.now();
        const item = { ...(entry.data as QueueItem), order: minOrder - 1 };
        // Only write if the host hasn't started playing (deleted) it meanwhile.
        const { modified } = await s.setJSON(key, item, { onlyIfMatch: entry.etag });
        if (!modified) return fail("That song just changed, try again.", 409);
        await bump(code);
        return json(item);
      }
    }

    // POST /api/rooms/:code/pause { paused }  (any remote or the TV)
    if (action === "pause" && method === "POST") {
      const body = await readBody(req);
      const paused = body.paused === true;
      await s.setJSON(`rooms/${code}/pause`, { paused, at: Date.now() });
      await bump(code);
      return json({ ok: true, paused });
    }

    // POST /api/rooms/:code/skip   (any remote can ask the TV to skip)
    if (action === "skip" && method === "POST") {
      await s.setJSON(`rooms/${code}/skip`, { at: Date.now() });
      await bump(code);
      return json({ ok: true });
    }

    // POST /api/rooms/:code/next   (host only: start the next song)
    if (action === "next" && method === "POST") {
      if (!(await isHost())) return fail("This screen is no longer the TV.", 403);
      const queue = await listQueue(code);
      const next = queue[0] ?? null;
      if (next) {
        await s.delete(`rooms/${code}/q/${next.id}`);
        await s.setJSON(`rooms/${code}/now`, { item: next, startedAt: Date.now() });
      } else {
        await s.delete(`rooms/${code}/now`);
      }
      await Promise.all([s.delete(`rooms/${code}/pos`), s.delete(`rooms/${code}/pause`)]);
      await bump(code);
      return json(await roomState(room));
    }

    return fail("Not found", 404);
  } catch (err) {
    console.error("api error", err);
    return fail("Server error, please try again.", 500);
  }
};

export const config: Config = {
  path: "/api/*",
};
