import { api, fetchRoom, store, toast, renderQueue, setLyric, setOffline } from "/common.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;

let code = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
let hostToken = code ? store(`host:${code}`) : null;
let hostSince = code ? Number(store(`hostSince:${code}`)) || 0 : 0;

let player = null;
let playerReady = false;
let started = false;
let phase = "idle"; // idle | playing | scoring | advancing | replaced
let currentId = null;
let currentItem = null;
let lastSkip = 0;
let paused = false;        // last pause state applied to the player
let serverPaused = false;  // last pause state seen on the server
let firstPoll = true;
let audioCtx = null;
let lastState = null;
let failures = 0;
let lastT = 0;            // last known position in the current song
let pauseHoldUntil = 0;   // ignore the server's pause state briefly after a local tap

// ---------- Room setup ----------
function saveHost(room) {
  code = room.code;
  hostToken = room.hostToken;
  hostSince = room.hostSince || 0;
  store(`host:${code}`, hostToken);
  store(`hostSince:${code}`, String(hostSince));
  history.replaceState(null, "", `?room=${code}`);
}

async function ensureRoom() {
  if (code && hostToken) return;
  if (code) {
    // Opened with a room code but not as its TV: take over that party.
    try {
      saveHost(await api(`rooms/${code}/takeover`, { method: "POST" }));
      return;
    } catch (err) {
      if (err.status !== 410 && err.status !== 400) throw err;
      toast("That party ended. Starting a new one.", 4000);
    }
  }
  saveHost(await api("rooms", { method: "POST" }));
}

async function takeBack() {
  saveHost(await api(`rooms/${code}/takeover`, { method: "POST" }));
  $("moved").classList.add("hidden");
  phase = "idle";
  firstPoll = true; // resume the current song where it stopped
  lastState = null;
}

function replaced() {
  if (phase === "replaced") return;
  phase = "replaced";
  clearTimeout(scoreTimer);
  currentId = null;
  if (playerReady) player.stopVideo();
  $("score").classList.add("hidden");
  $("moved").classList.remove("hidden");
}

async function showJoinInfo() {
  const joinUrl = `${location.origin}/remote.html?room=${code}`;
  setLyric($("code"), code);
  $("splashCode").textContent = code;
  $("splashHost").textContent = location.host;
  $("joinUrl").textContent = `Or go to ${location.host} and enter this code.`;
  const { default: qrcode } = await import("/qrcode.mjs"); // only needed once the party starts
  const qr = qrcode(0, "M");
  qr.addData(joinUrl);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// ---------- YouTube player ----------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1 },
    events: {
      onReady: () => { playerReady = true; },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.ENDED && phase === "playing") finishSong();
      },
      onError: (e) => {
        // With no internet the video isn't broken: keep the singer's turn and wait.
        if (!navigator.onLine || failures >= 2) return;
        const reason = { 2: "This link is not a valid video", 100: "This video was removed", 101: "This video can't be played outside YouTube", 150: "This video can't be played outside YouTube" }[e.data] || "This video can't be played";
        toast(`${reason}. Skipping to the next song.`, 5000);
        if (phase === "playing") advance();
      },
    },
  });
};
const ytScript = document.createElement("script");
ytScript.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytScript);

function applyPause(want) {
  paused = want;
  $("pausedBadge").classList.toggle("hidden", !want || phase !== "playing");
  $("pauseBtn").textContent = want ? "Resume" : "Pause";
  if (!playerReady || phase !== "playing") return;
  if (want) player.pauseVideo();
  else player.playVideo();
  setTimeout(saveProgress, 300); // tell watching phones right away
}

function playItem(item, startSeconds = 0) {
  currentId = item.id;
  currentItem = item;
  phase = "playing";
  $("splash").classList.add("hidden");
  $("score").classList.add("hidden");
  setLyric($("nowWho"), item.singer);
  $("nowSong").textContent = item.title;
  $("nowSong").title = item.title;
  $("pauseBtn").disabled = false;
  $("skipBtn").disabled = false;
  mic.reset();
  lastT = startSeconds;
  const load = () => player.loadVideoById({ videoId: item.videoId, startSeconds });
  if (playerReady) load();
  else {
    // Player not ready yet: retry shortly.
    const t = setInterval(() => {
      if (playerReady) { clearInterval(t); if (currentId === item.id) load(); }
    }, 300);
  }
  if (startSeconds > 0) toast(`Continuing from ${Math.floor(startSeconds / 60)}:${String(Math.floor(startSeconds % 60)).padStart(2, "0")}`);
}

// Save the playback position every 5s so another device can continue the song
// and phones watching the video can stay in sync.
async function saveProgress() {
  if (phase !== "playing" || !playerReady || !currentId) return;
  const t = player.getCurrentTime?.() || 0;
  if (t < 1) return;
  lastT = t;
  try {
    await api(`rooms/${code}/progress`, { method: "POST", hostToken, body: { id: currentId, t } });
  } catch (err) {
    if (err.status === 403) replaced();
  }
}
setInterval(saveProgress, 5000);

function showIdle() {
  phase = "idle";
  currentId = null;
  currentItem = null;
  setLyric($("nowWho"), "");
  $("nowSong").textContent = "No one is singing yet";
  $("pauseBtn").disabled = true;
  $("skipBtn").disabled = true;
  $("splash").classList.remove("hidden");
  $("score").classList.add("hidden");
  if (playerReady) player.stopVideo();
}

async function advance() {
  if (phase === "advancing") return;
  phase = "advancing";
  try {
    const state = await api(`rooms/${code}/next`, { method: "POST", hostToken });
    lastState = { ...state, changed: true };
    render(state);
    serverPaused = false;
    applyPause(false);
    if (state.now?.item) playItem(state.now.item);
    else showIdle();
  } catch (err) {
    if (err.status === 403) { replaced(); return; }
    toast(err.message);
    phase = "idle";
  }
}

// ---------- Scoring ----------
const mic = {
  analyser: null,
  data: null,
  samples: 0,
  active: 0,
  timer: null,
  async enable() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = audioCtx.createMediaStreamSource(stream);
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Float32Array(this.analyser.fftSize);
    src.connect(this.analyser);
    this.timer = setInterval(() => this.sample(), 250);
  },
  sample() {
    if (phase !== "playing" || paused || !this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    const rms = Math.sqrt(sum / this.data.length);
    this.samples++;
    if (rms > 0.02) this.active++;
  },
  reset() { this.samples = 0; this.active = 0; },
  score() {
    if (!this.analyser || this.samples < 20) return null;
    const ratio = this.active / this.samples; // how much of the song you sang
    let s = 55 + Math.round(45 * Math.min(1, ratio / 0.55)) + Math.round(Math.random() * 6 - 3);
    if (ratio > 0.5 && Math.random() < 0.2) s = 100;
    return Math.max(40, Math.min(100, s));
  },
};

function randomScore() {
  // Classic videoke style: generous, sometimes a perfect 100.
  if (Math.random() < 0.12) return 100;
  return 70 + Math.floor(Math.pow(Math.random(), 0.6) * 30);
}

function scoreMessage(s) {
  if (s === 100) return "Perfect! Ang galing mo!";
  if (s >= 90) return "Pang-champion!";
  if (s >= 80) return "Galing! Palakpakan!";
  if (s >= 70) return "Puwede na. Practice pa!";
  return "Sige, isa pa!";
}

function beep(freq, dur, delay = 0, type = "square", vol = 0.05) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur);
}

function confetti() {
  const colors = ["#ffd60a", "#ef2b41", "#ffffff"];
  for (let i = 0; i < 60; i++) {
    const c = document.createElement("div");
    c.className = "confetti";
    c.style.left = `${Math.random() * 100}%`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${1.8 + Math.random() * 2}s`;
    c.style.animationDelay = `${Math.random() * 0.6}s`;
    $("screen").appendChild(c);
    setTimeout(() => c.remove(), 4500);
  }
}

let scoreTimer = null;
function finishSong() {
  phase = "scoring";
  const final = mic.score() ?? randomScore();
  setLyric($("scoreWho"), currentItem ? currentItem.singer : "");
  setLyric($("scoreMsg"), "");
  setLyric($("scoreNum"), "0");
  $("pausedBadge").classList.add("hidden");
  $("score").classList.remove("hidden");

  const steps = 30;
  for (let i = 0; i < steps; i++) beep(220 + i * 12, 0.05, i * 0.08, "square", 0.03);
  let i = 0;
  const counter = setInterval(() => {
    i++;
    setLyric($("scoreNum"), String(Math.round((final * i) / steps)));
    if (i >= steps) {
      clearInterval(counter);
      setLyric($("scoreMsg"), scoreMessage(final));
      [523, 659, 784, 1047].forEach((f, k) => beep(f, 0.25, k * 0.12, "triangle", 0.08));
      if (final >= 90) confetti();
      clearTimeout(scoreTimer);
      scoreTimer = setTimeout(() => { if (phase === "scoring") advance(); }, 6000);
    }
  }, 80);
}

// ---------- Polling ----------
function render(state) {
  renderQueue($("queue"), state.queue, { empty: "No songs waiting. Scan the code to add one." });
  $("count").textContent = state.queue.length ? `(${state.queue.length})` : "";
}

async function poll() {
  try {
    const state = await fetchRoom(code, lastState);
    lastState = state;
    const wasOffline = failures >= 2;
    failures = 0;
    setOffline(false);
    if (state.changed) render(state);

    // Internet is back: if the video gave up while offline, pick the song up again.
    if (wasOffline && phase === "playing" && !paused && playerReady && currentItem) {
      const st = player.getPlayerState?.();
      if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING) {
        player.loadVideoById({ videoId: currentItem.videoId, startSeconds: Math.max(0, lastT - 3) });
      }
    }

    if (phase === "replaced") return;
    if (hostSince && state.hostSince && state.hostSince !== hostSince) { replaced(); return; }

    if (firstPoll) {
      firstPoll = false;
      lastSkip = state.skipAt;
      const item = state.now?.item;
      if (item) {
        const start = state.pos?.id === item.id ? Math.max(0, state.pos.t - 3) : 0;
        playItem(item, start);
        serverPaused = state.paused;
        if (state.paused) setTimeout(() => applyPause(true), 1500); // let the video load first
        return;
      }
    }

    if (Date.now() > pauseHoldUntil && state.paused !== serverPaused) {
      serverPaused = state.paused;
      if (phase === "playing" && state.paused !== paused) {
        toast(state.paused ? "Paused from a phone" : "Resumed from a phone");
        applyPause(state.paused);
      }
    }

    if (state.skipAt > lastSkip) {
      lastSkip = state.skipAt;
      if (phase === "playing" || phase === "scoring") {
        toast("Skipped from a phone");
        clearTimeout(scoreTimer);
        advance();
        return;
      }
    }

    if (phase === "idle" && state.queue.length) advance();
  } catch (err) {
    if (err.status === 410) {
      store(`host:${code}`, null);
      toast("This party ended. Starting a new one.", 4000);
      code = "";
      hostToken = null;
      firstPoll = true;
      lastState = null;
      await ensureRoom();
      showJoinInfo();
      showIdle();
    } else if (++failures >= 2) {
      setOffline(true, "No internet. The song continues when it's back.");
    }
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

// ---------- UI events ----------
$("startBtn").addEventListener("click", async () => {
  $("startBtn").disabled = true;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if ($("useMic").checked) {
      try { await mic.enable(); }
      catch { toast("The microphone is blocked, so scores will be random.", 4000); }
    }
    await ensureRoom();
    showJoinInfo();
    $("start").classList.add("hidden");
    started = true;
    poll();
  } catch (err) {
    $("startMsg").textContent = `Couldn't start: ${err.message}`;
    $("startBtn").disabled = false;
  }
});

$("takeBackBtn").addEventListener("click", async () => {
  $("takeBackBtn").disabled = true;
  try { await takeBack(); }
  catch (err) { toast(err.message); }
  finally { $("takeBackBtn").disabled = false; }
});

if (code) {
  $("startBtn").textContent = `Continue party ${code} here`;
  if (!hostToken) $("startMsg").textContent = "This device becomes the TV, and the current TV stops playing.";
}

$("pauseBtn").addEventListener("click", async () => {
  if (!started || phase !== "playing") return;
  const want = !paused;
  applyPause(want);
  serverPaused = want;
  pauseHoldUntil = Date.now() + 4000;
  if (lastState) lastState.paused = want;
  try { await api(`rooms/${code}/pause`, { method: "POST", body: { paused: want } }); }
  catch (err) { toast(err.message); }
});

$("skipBtn").addEventListener("click", () => {
  if (!started) return;
  clearTimeout(scoreTimer);
  if (phase === "playing" || phase === "scoring") advance();
});

$("nextBtn").addEventListener("click", () => {
  clearTimeout(scoreTimer);
  advance();
});

$("fsBtn").addEventListener("click", () => {
  const el = $("screen");
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
});

$("singer").value = store("singer") || "";
$("addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!started) return;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const singer = $("singer").value.trim();
    store("singer", singer);
    const item = await api(`rooms/${code}/queue`, { method: "POST", body: { url: $("url").value, singer } });
    $("url").value = "";
    toast(`Added to queue: ${item.title}`);
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
  }
});
