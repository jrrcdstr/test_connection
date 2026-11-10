import { api, fetchRoom, store, toast, thumb, renderQueue, setLyric, setOffline, confirmTap } from "/common.js";

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
    $("watchBtn").textContent = "Hide the video";
    $("watchBtn").setAttribute("aria-pressed", "true");
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
    $("watchBtn").textContent = "Show the video here, muted";
    $("watchBtn").setAttribute("aria-pressed", "false");
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
let failures = 0;

const inApp = () => !$("app").classList.contains("hidden");
const looksLikeLink = (text) => /youtu\.?be|^[A-Za-z0-9_-]{11}$/.test(text.trim());

function showJoin(message) {
  $("app").classList.add("hidden");
  $("roomTag").classList.add("hidden");
  $("joinBox").classList.remove("hidden");
  setOffline(false);
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
  isPaused = Boolean(state.paused);
  setLyric($("nowWho"), item ? item.singer : "");
  $("nowSong").textContent = item ? (isPaused ? `Paused. ${item.title}` : item.title) : "No one is singing yet";
  if (item) $("nowImg").src = thumb(item.videoId);
  else $("nowImg").removeAttribute("src");
  $("pauseBtn").textContent = isPaused ? "Resume" : "Pause";
  $("pauseBtn").disabled = !item;
  if (!$("skipBtn").classList.contains("btn-armed")) $("skipBtn").disabled = !item;
  renderQueue($("queue"), state.queue, { actions: true, empty: "No songs waiting. Pick one above." });
  $("count").textContent = state.queue.length ? `(${state.queue.length})` : "";
}

async function refresh() {
  try {
    const state = await fetchRoom(code, lastState);
    lastState = state;
    failures = 0;
    setOffline(false);
    if (state.changed) render(state);
    watch.sync(state);
    return true;
  } catch (err) {
    if (err.status === 410 || err.status === 400) {
      clearTimeout(pollTimer);
      lastState = null;
      showJoin(err.message);
      return false;
    }
    if (++failures >= 2 && inApp()) setOffline(true);
    return true; // keep trying
  }
}

async function loop() {
  clearTimeout(pollTimer);
  if (document.hidden) return; // resumes on visibilitychange
  if (await refresh()) pollTimer = setTimeout(loop, POLL_MS);
}

async function join(newCode) {
  code = newCode.trim().toUpperCase();
  history.replaceState(null, "", `?room=${code}`);
  lastState = null;
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

// One field: a YouTube link gets added, anything else is searched on YouTube.
function updateAddButton() {
  $("addBtn").textContent = looksLikeLink($("url").value) ? "Add to queue" : "Find on YouTube";
}
$("url").addEventListener("input", updateAddButton);

$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("url").value.trim();
  const singer = $("singer").value.trim();
  store("singer", singer);

  if (!looksLikeLink(text)) {
    const query = /karaoke|videoke/i.test(text) ? text : `${text} karaoke`;
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, "_blank", "noopener");
    $("url").value = "";
    $("addHint").textContent = "In YouTube, tap Share, then Copy link. Come back and tap Paste.";
    return;
  }

  const btn = $("addBtn");
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const item = await api(`rooms/${code}/queue`, { method: "POST", body: { url: text, singer } });
    $("url").value = "";
    toast(`Added to queue: ${item.title}`);
    refresh();
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
    updateAddButton();
  }
});

$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { $("url").value = text.trim(); updateAddButton(); }
    else toast("Nothing copied yet. Copy a YouTube link first.");
  } catch {
    toast("Press and hold the box, then choose Paste.");
    $("url").focus();
  }
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
      toast("Moved to next");
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
    toast(want ? "Paused" : "Resumed");
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = !lastState?.now?.item;
  }
});

confirmTap($("skipBtn"), "Tap again to skip", async () => {
  try {
    await api(`rooms/${code}/skip`, { method: "POST" });
    toast("Skipped");
  } catch (err) {
    toast(err.message);
  }
});

confirmTap($("takeoverBtn"), "Tap again. The TV will stop.", async () => {
  try {
    const room = await api(`rooms/${code}/takeover`, { method: "POST" });
    store(`host:${room.code}`, room.hostToken);
    store(`hostSince:${room.code}`, String(room.hostSince));
    location.href = `/host.html?room=${room.code}`;
  } catch (err) {
    toast(err.message);
  }
});

// Stop polling while the phone is locked or in another app; catch up on return.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && code && inApp()) loop();
});
window.addEventListener("online", () => { if (code && inApp()) loop(); });

if (code) join(code).then(() => { if (store("watch") === "1" && inApp()) watch.start(); });
else showJoin();
