import { api, store, toast, renderQueue } from "/common.js";
import qrcode from "/qrcode.mjs";

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
let firstPoll = true;
let audioCtx = null;

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
      toast("That party has ended. Starting a new one…", 4000);
    }
  }
  saveHost(await api("rooms", { method: "POST" }));
}

async function takeBack() {
  saveHost(await api(`rooms/${code}/takeover`, { method: "POST" }));
  $("moved").classList.add("hidden");
  phase = "idle";
  firstPoll = true; // resume the current song where it stopped
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

function showJoinInfo() {
  const joinUrl = `${location.origin}/remote.html?room=${code}`;
  $("code").textContent = code;
  $("splashCode").textContent = code;
  $("joinUrl").textContent = `${location.host}/remote.html?room=${code}`;
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
        const reason = { 2: "Invalid video", 5: "Player error", 100: "Video was removed", 101: "Embedding not allowed", 150: "Embedding not allowed" }[e.data] || "Can't play";
        toast(`⚠️ ${reason}. Skipping…`, 4000);
        if (phase === "playing") advance();
      },
    },
  });
};
const ytScript = document.createElement("script");
ytScript.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytScript);

function playItem(item, startSeconds = 0) {
  currentId = item.id;
  currentItem = item;
  phase = "playing";
  $("splash").classList.add("hidden");
  $("score").classList.add("hidden");
  $("nowWho").textContent = `🎤 ${item.singer}`;
  $("nowSong").textContent = item.title;
  $("nowSong").title = item.title;
  mic.reset();
  const load = () => player.loadVideoById({ videoId: item.videoId, startSeconds });
  if (playerReady) load();
  else {
    // Player not ready yet: retry shortly.
    const t = setInterval(() => {
      if (playerReady) { clearInterval(t); if (currentId === item.id) load(); }
    }, 300);
  }
  if (startSeconds > 0) toast(`▶ Continuing from ${Math.floor(startSeconds / 60)}:${String(Math.floor(startSeconds % 60)).padStart(2, "0")}`);
}

// Save the playback position every 5s so another device can continue the song.
setInterval(async () => {
  if (phase !== "playing" || !playerReady || !currentId) return;
  const t = player.getCurrentTime?.() || 0;
  if (t < 1) return;
  try {
    await api(`rooms/${code}/progress`, { method: "POST", hostToken, body: { id: currentId, t } });
  } catch (err) {
    if (err.status === 403) replaced();
  }
}, 5000);

function showIdle() {
  phase = "idle";
  currentId = null;
  currentItem = null;
  $("nowWho").textContent = "Waiting for songs…";
  $("nowSong").textContent = "";
  $("splash").classList.remove("hidden");
  $("score").classList.add("hidden");
  if (playerReady) player.stopVideo();
}

async function advance() {
  if (phase === "advancing") return;
  phase = "advancing";
  try {
    const state = await api(`rooms/${code}/next`, { method: "POST", hostToken });
    render(state);
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
    if (phase !== "playing" || !this.analyser) return;
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
  if (s === 100) return "PERFECT! 🏆 Ang galing mo!";
  if (s >= 90) return "Superstar! 🌟";
  if (s >= 80) return "Galing! 👏 Great job!";
  if (s >= 70) return "Not bad! 🎶 Practice pa!";
  return "Sige, isa pa! 😄 Try again!";
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
  const colors = ["#ffd23f", "#ff3d8b", "#2de2e6", "#ffffff"];
  for (let i = 0; i < 80; i++) {
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
  $("scoreWho").textContent = currentItem ? `🎤 ${currentItem.singer}` : "";
  $("scoreMsg").textContent = "";
  $("scoreNum").textContent = "0";
  $("score").classList.remove("hidden");

  const steps = 30;
  for (let i = 0; i < steps; i++) beep(220 + i * 12, 0.05, i * 0.08, "square", 0.03);
  let i = 0;
  const counter = setInterval(() => {
    i++;
    $("scoreNum").textContent = String(Math.round((final * i) / steps));
    if (i >= steps) {
      clearInterval(counter);
      $("scoreMsg").textContent = scoreMessage(final);
      [523, 659, 784, 1047].forEach((f, k) => beep(f, 0.25, k * 0.12, "triangle", 0.08));
      if (final >= 90) confetti();
      clearTimeout(scoreTimer);
      scoreTimer = setTimeout(() => { if (phase === "scoring") advance(); }, 6000);
    }
  }, 80);
}

// ---------- Polling ----------
function render(state) {
  renderQueue($("queue"), state.queue);
  $("count").textContent = state.queue.length ? `(${state.queue.length})` : "";
}

async function poll() {
  try {
    const state = await api(`rooms/${code}`);
    render(state);

    if (phase === "replaced") return;
    if (hostSince && state.hostSince && state.hostSince !== hostSince) { replaced(); return; }

    if (firstPoll) {
      firstPoll = false;
      lastSkip = state.skipAt;
      const item = state.now?.item;
      if (item) {
        const start = state.pos?.id === item.id ? Math.max(0, state.pos.t - 3) : 0;
        playItem(item, start);
        return;
      }
    }

    if (state.skipAt > lastSkip) {
      lastSkip = state.skipAt;
      if (phase === "playing" || phase === "scoring") {
        toast("⏭ Skipped from a phone");
        clearTimeout(scoreTimer);
        advance();
        return;
      }
    }

    if (phase === "idle" && state.queue.length) advance();
  } catch (err) {
    if (err.status === 410) {
      store(`host:${code}`, null);
      toast("This room expired. Starting a new one…", 4000);
      code = "";
      hostToken = null;
      firstPoll = true;
      await ensureRoom();
      showJoinInfo();
      showIdle();
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
      catch { toast("Microphone not allowed. Using classic scoring.", 4000); }
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
  $("startBtn").textContent = `▶ Continue party ${code} on this screen`;
  if (!hostToken) $("startMsg").textContent = "This screen will become the TV. The current TV will stop playing.";
}

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
    toast(`Added: ${item.title}`);
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    btn.disabled = false;
  }
});
