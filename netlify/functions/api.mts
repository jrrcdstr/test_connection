import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

// Data layout in the "videoke" store (one key per thing, so different
// devices never overwrite each other's writes):
//   rooms/<CODE>/meta      { code, createdAt, hostToken }   written once
//   rooms/<CODE>/host      { token, since }                 current TV (changes on takeover)
//   rooms/<CODE>/now       { item, startedAt }              written by host only
//   rooms/<CODE>/pos       { id, t, at }                    playback position, written by host
//   rooms/<CODE>/skip      { at }                           written by remotes
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

async function roomState(room: RoomMeta) {
  const s = store();
  const code = room.code;
  const [queue, now, skip, pos, host] = await Promise.all([
    listQueue(code),
    s.get(`rooms/${code}/now`, { type: "json" }),
    s.get(`rooms/${code}/skip`, { type: "json" }),
    s.get(`rooms/${code}/pos`, { type: "json" }),
    getHost(room),
  ]);
  return {
    code,
    now: now ?? null,
    pos: pos ?? null,
    hostSince: host.since,
    skipAt: (skip as { at?: number } | null)?.at ?? 0,
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

    if (parts[0] !== "rooms" || !parts[1]) return fail("Not found", 404);
    const code = parts[1].toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) return fail("Invalid room code", 400);
    const room = await getRoom(code);
    if (!room) return fail("Room not found or expired. Ask the host for the new code.", 410);

    const action = parts[2];
    const host = await getHost(room);
    const isHost = req.headers.get("x-host-token") === host.token;

    // GET /api/rooms/:code
    if (!action && method === "GET") return json(await roomState(room));

    // POST /api/rooms/:code/takeover  (this device becomes the TV; the old TV stops)
    if (action === "takeover" && method === "POST") {
      const next: HostInfo = { token: newToken(), since: Date.now() };
      await s.setJSON(`rooms/${code}/host`, next);
      return json({ code, hostToken: next.token, hostSince: next.since });
    }

    // POST /api/rooms/:code/progress { id, t }  (host only: remember playback position)
    if (action === "progress" && method === "POST") {
      if (!isHost) return fail("This screen is no longer the TV.", 403);
      const body = await readBody(req);
      const id = String(body.id ?? "");
      const t = Number(body.t);
      if (!/^[a-z0-9]{1,40}$/.test(id) || !Number.isFinite(t) || t < 0) return fail("Invalid progress");
      await s.setJSON(`rooms/${code}/pos`, { id, t: Math.floor(t), at: Date.now() });
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
        return json(item);
      }
    }

    // POST /api/rooms/:code/skip   (any remote can ask the TV to skip)
    if (action === "skip" && method === "POST") {
      await s.setJSON(`rooms/${code}/skip`, { at: Date.now() });
      return json({ ok: true });
    }

    // POST /api/rooms/:code/next   (host only: start the next song)
    if (action === "next" && method === "POST") {
      if (!isHost) return fail("This screen is no longer the TV.", 403);
      const queue = await listQueue(code);
      const next = queue[0] ?? null;
      if (next) {
        await s.delete(`rooms/${code}/q/${next.id}`);
        await s.setJSON(`rooms/${code}/now`, { item: next, startedAt: Date.now() });
      } else {
        await s.delete(`rooms/${code}/now`);
      }
      await s.delete(`rooms/${code}/pos`);
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
