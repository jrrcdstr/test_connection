import { api, store, toast, thumb, renderQueue } from "/common.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
let isPaused = false;

// ---------- Optional muted video that follows the TV ----------
const watch = {
  on: false,
  player: null,
  ready: false,
  videoId: null,
  apiLoading: null,
  loadApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (!this.apiLoading) {
      this.apiLoading = new Promise((resolve) => {
        window.onYouTubeIframeAPIReady = resolve;
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(s);
      });
    }
    return this.apiLoading;
  },
  async start() {
    this.on = true;
    store("watch", "1");
    $("phoneVid").classList.remove("hidden");
    $("watchBtn").textContent = "🙈 Hide video";
    await this.loadApi();
    if (!this.player) {
      this.player = new YT.Player("ytPhone", {
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0, controls: 0, disablekb: 1, modestbranding: 1 },
        events: {
          onReady: () => { this.ready = true; this.player.mute(); if (lastState) this.sync(lastState); },
        },
      });
    } else if (lastState) this.sync(lastState);
  },
  stop() {
    this.on = false;
    store("watch", null);
    $("phoneVid").classList.add("hidden");
    $("watchBtn").textContent = "👀 Watch video on my phone (muted)";
    if (this.ready) this.player.stopVideo();
    this.videoId = null;
  },
  // Where the TV is in the song right now (seconds), estimated from the last report.
  tvTime(state, receivedAt) {
    const item = state.now.item;
    const pos = state.pos && state.pos.id === item.id ? state.pos : null;
    const sinceResponse = (Date.now() - receivedAt) / 1000;
    if (pos) {
      if (state.paused) return pos.t;
      return pos.t + (state.serverNow - pos.at) / 1000 + sinceResponse;
    }
    return Math.max(0, (state.serverNow - state.now.startedAt) / 1000 - 2 + sinceResponse);
  },
  sync(state) {
    if (!this.on || !this.ready) return;
    const item = state.now?.item;
    if (!item) {
      if (this.videoId) { this.player.stopVideo(); this.videoId = null; }
      return;
    }
    const target = this.tvTime(state, state.receivedAt);
    if (item.videoId !== this.videoId) {
      this.videoId = item.videoId;
      this.player.loadVideoById({ videoId: item.videoId, startSeconds: target });
      this.player.mute();
      if (state.paused) setTimeout(() => this.player.pauseVideo(), 1200);
      return;
    }
    this.player.mute();
    const ps = this.player.getPlayerState?.();
    if (state.paused) {
      if (ps === YT.PlayerState.PLAYING) this.player.pauseVideo();
      if (Math.abs((this.player.getCurrentTime?.() || 0) - target) > 1.5) this.player.seekTo(target, true);
      return;
    }
    if (ps === YT.PlayerState.PAUSED || ps === YT.PlayerState.CUED) this.player.playVideo();
    const drift = Math.abs((this.player.getCurrentTime?.() || 0) - target);
    if (ps !== YT.PlayerState.BUFFERING && drift > 2.5) this.player.seekTo(target, true);
  },
};
let lastState = null;
let code = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
let pollTimer = null;

function showJoin(message) {
  $("app").classList.add("hidden");
  $("roomTag").classList.add("hidden");
  $("joinBox").classList.remove("hidden");
  if (message) toast(message, 4000);
}

function showApp() {
  $("joinBox").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("roomTag").textContent = code;
  $("roomTag").classList.remove("hidden");
}

function render(state) {
  const item = state.now?.item;
  $("nowWho").textContent = item ? `🎤 ${item.singer}` : "Nobody yet";
  $("nowSong").textContent = item ? item.title : "Add a song to start!";
  if (item) $("nowImg").src = thumb(item.videoId);
  else $("nowImg").removeAttribute("src");
  renderQueue($("queue"), state.queue, { actions: true });
  isPaused = Boolean(state.paused);
  $("pauseBtn").textContent = isPaused ? "▶ Resume" : "⏸ Pause";
  $("pauseBtn").disabled = !item;
  $("nowWho").textContent = item ? `${isPaused ? "⏸ " : "🎤 "}${item.singer}` : "Nobody yet";
  $("count").textContent = state.queue.length ? `(${state.queue.length})` : "";
}

async function refresh() {
  try {
    const state = await api(`rooms/${code}`);
    state.receivedAt = Date.now();
    lastState = state;
    render(state);
    watch.sync(state);
    return true;
  } catch (err) {
    if (err.status === 410 || err.status === 400) {
      clearTimeout(pollTimer);
      showJoin(err.message);
      return false;
    }
    return true; // transient error, keep polling
  }
}

async function loop() {
  const ok = await refresh();
  if (ok) pollTimer = setTimeout(loop, POLL_MS);
}

async function join(newCode) {
  code = newCode.trim().toUpperCase();
  history.replaceState(null, "", `?room=${code}`);
  clearTimeout(pollTimer);
  if (await refresh()) {
    showApp();
    pollTimer = setTimeout(loop, POLL_MS);
  }
}

// ---------- Events ----------
$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  join($("codeInput").value);
});

$("singer").value = store("singer") || "";

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("addBtn");
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const singer = $("singer").value.trim();
    store("singer", singer);
    const item = await api(`rooms/${code}/queue`, { method: "POST", body: { url: $("url").value, singer } });
    $("url").value = "";
    toast(`✅ Added: ${item.title}`);
    refresh();
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Add to queue";
  }
});

$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $("url").value = text.trim();
    else toast("Clipboard is empty. Copy a YouTube link first.");
  } catch {
    toast("Can't read clipboard. Long-press the box and choose Paste.");
    $("url").focus();
  }
});

$("findForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  const query = /karaoke|videoke/i.test(q) ? q : `${q} karaoke`;
  window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, "_blank", "noopener");
});

$("queue").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest("li").dataset.id;
  btn.disabled = true;
  try {
    if (btn.dataset.act === "remove") {
      await api(`rooms/${code}/queue/${id}`, { method: "DELETE" });
      toast("Removed from queue");
    } else {
      await api(`rooms/${code}/queue/${id}/bump`, { method: "POST" });
      toast("⬆ Moved to next");
    }
    refresh();
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

$("watchBtn").addEventListener("click", () => {
  if (watch.on) watch.stop();
  else watch.start();
});

$("pauseBtn").addEventListener("click", async () => {
  const want = !isPaused;
  const btn = $("pauseBtn");
  btn.disabled = true;
  try {
    await api(`rooms/${code}/pause`, { method: "POST", body: { paused: want } });
    isPaused = want;
    btn.textContent = want ? "▶ Resume" : "⏸ Pause";
    toast(want ? "⏸ Pause sent to the TV" : "▶ Resume sent to the TV");
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("skipBtn").addEventListener("click", async () => {
  if (!confirm("Skip the song that's playing now?")) return;
  try {
    await api(`rooms/${code}/skip`, { method: "POST" });
    toast("⏭ Skip sent to the TV");
  } catch (err) {
    toast(err.message);
  }
});

$("takeoverBtn").addEventListener("click", async () => {
  if (!confirm("Make this device the TV? Songs will play here and the current TV will stop.")) return;
  const btn = $("takeoverBtn");
  btn.disabled = true;
  try {
    const room = await api(`rooms/${code}/takeover`, { method: "POST" });
    store(`host:${room.code}`, room.hostToken);
    store(`hostSince:${room.code}`, String(room.hostSince));
    location.href = `/host.html?room=${room.code}`;
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
});

// Refresh right away when the phone comes back from the YouTube app.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && code && !$("app").classList.contains("hidden")) refresh();
});

if (code) join(code).then(() => { if (store("watch") === "1" && !$("app").classList.contains("hidden")) watch.start(); });
else showJoin();
