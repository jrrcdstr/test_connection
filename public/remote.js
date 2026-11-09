import { api, store, toast, thumb, renderQueue } from "/common.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;
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
  $("count").textContent = state.queue.length ? `(${state.queue.length})` : "";
}

async function refresh() {
  try {
    render(await api(`rooms/${code}`));
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

if (code) join(code);
else showJoin();
