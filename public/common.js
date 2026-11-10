// Shared helpers for the TV and remote pages.

export async function api(path, { method = "GET", body, hostToken } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (hostToken) headers["x-host-token"] = hostToken;
  const res = await fetch(`/api/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Fetch the room. If nothing changed since `prev`, the server sends only the
// playback position, and we return `prev` updated with it (changed: false).
export async function fetchRoom(code, prev) {
  const data = await api(`rooms/${code}${prev?.v ? `?v=${encodeURIComponent(prev.v)}` : ""}`);
  const receivedAt = Date.now();
  if (data.unchanged && prev) return { ...prev, pos: data.pos, serverNow: data.serverNow, receivedAt, changed: false };
  return { ...data, receivedAt, changed: true };
}

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
  return null;
}

let toastTimer;
export function toast(message, ms = 3000) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// Red bar at the top while the room can't be reached.
export function setOffline(isOffline, message = "No internet. Reconnecting…") {
  let el = document.querySelector(".offline");
  if (!isOffline) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.className = "offline";
    el.setAttribute("role", "alert");
    document.body.prepend(el);
  }
  el.textContent = message;
}

// A button that must be tapped twice: the first tap arms it for 3 seconds.
export function confirmTap(btn, armedLabel, action) {
  const label = btn.innerHTML;
  let timer;
  const disarm = () => { clearTimeout(timer); btn.classList.remove("btn-armed"); btn.innerHTML = label; };
  btn.addEventListener("click", async () => {
    if (!btn.classList.contains("btn-armed")) {
      btn.classList.add("btn-armed");
      btn.textContent = armedLabel;
      timer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    btn.disabled = true;
    try { await action(); } finally { btn.disabled = false; }
  });
}

const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
export const icons = {
  play: svg("M7 4v16l13-8z"),
  pause: svg("M6 4h4v16H6zM14 4h4v16h-4z"),
  skip: svg("M5 4v16l10-8zM16 4h3v16h-3z"),
  up: svg("M12 4l8 9h-5v7H9v-7H4z"),
  remove: svg("M6.4 4.6 12 10.2l5.6-5.6 1.8 1.8L13.8 12l5.6 5.6-1.8 1.8L12 13.8l-5.6 5.6-1.8-1.8L10.2 12 4.6 6.4z"),
};

export const thumb = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function renderQueue(listEl, queue, { actions = false, empty = "No songs waiting." } = {}) {
  if (!queue.length) {
    listEl.innerHTML = `<li class="empty">${escapeHtml(empty)}</li>`;
    return;
  }
  listEl.innerHTML = queue.map((item, i) => `
    <li data-id="${escapeHtml(item.id)}">
      <span class="num">${i + 1}</span>
      <img src="${thumb(item.videoId)}" alt="" width="72" height="40" loading="lazy" decoding="async">
      <div>
        <div class="singer">${escapeHtml(item.singer)}</div>
        <div class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
      </div>
      ${actions ? `<div class="actions">
        ${i > 0 ? `<button class="btn-plain" data-act="bump" aria-label="Sing ${escapeHtml(item.singer)}'s song next" title="Sing next">${icons.up}</button>` : ""}
        <button class="btn-plain" data-act="remove" aria-label="Remove ${escapeHtml(item.singer)}'s song" title="Remove">${icons.remove}</button>
      </div>` : "<span></span>"}
    </li>`).join("");
}

// Lyric-style text keeps a copy in data-text for its outline.
export function setLyric(el, text) {
  el.textContent = text;
  el.dataset.text = text;
}
