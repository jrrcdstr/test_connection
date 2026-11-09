// Shared helpers for host and remote pages.

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

export const thumb = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function renderQueue(listEl, queue, { actions = false } = {}) {
  if (!queue.length) {
    listEl.innerHTML = `<li class="empty" style="display:block">No songs yet. Paste a YouTube karaoke link to add one!</li>`;
    return;
  }
  listEl.innerHTML = queue.map((item, i) => `
    <li data-id="${escapeHtml(item.id)}">
      <span class="num">${i + 1}</span>
      <img src="${thumb(item.videoId)}" alt="" loading="lazy">
      <div class="info">
        <div class="title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="singer">🎤 ${escapeHtml(item.singer)}</div>
      </div>
      ${actions ? `<div class="actions">
        ${i > 0 ? `<button class="btn-icon btn-small" data-act="bump" title="Sing next" aria-label="Move to next">⬆</button>` : ""}
        <button class="btn-icon btn-small" data-act="remove" title="Remove" aria-label="Remove song">✕</button>
      </div>` : "<span></span>"}
    </li>`).join("");
}
