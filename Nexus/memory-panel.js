"use strict";

// ════════════════════════════════════════════════════════════════════════════
// Nexus memory panel
// Load AFTER app.js (both deferred, in this order). It reuses the globals
// API_URL, authHeaders() and goToLogin() defined in app.js and builds all of
// its own markup + CSS, so nexus.html only needs one extra <script> tag.
// ════════════════════════════════════════════════════════════════════════════
(() => {
  const MAX_NOTES = 100;
  const MAX_CHARS = 300;

  // ── Styles (match the existing Nexus theme) ───────────────────────────────
  const STYLE = `
    .mem-sidebar-footer { padding: 10px 12px; border-top: 1px solid rgba(79,140,255,0.2); }
    .mem-open-btn {
      width: 100%; padding: 9px 12px; border-radius: 6px; cursor: pointer;
      background: rgba(79,140,255,0.1); border: 1px solid rgba(79,140,255,0.3);
      color: #4f8cff; font-family: 'Share Tech Mono', monospace; font-size: 12px;
      letter-spacing: 0.08em; text-align: left; transition: background 0.2s;
    }
    .mem-open-btn:hover { background: rgba(79,140,255,0.22); }

    .mem-overlay {
      position: fixed; inset: 0; z-index: 900; display: flex; justify-content: flex-end;
      background: rgba(5,8,25,0.6); backdrop-filter: blur(4px);
      opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
    }
    .mem-overlay.open { opacity: 1; pointer-events: all; }
    .mem-panel {
      width: 420px; max-width: 100vw; height: 100%; display: flex; flex-direction: column;
      background: #0d1438; border-left: 1px solid rgba(79,140,255,0.4);
      transform: translateX(24px); transition: transform 0.2s ease;
    }
    .mem-overlay.open .mem-panel { transform: translateX(0); }
    @media (prefers-reduced-motion: reduce) {
      .mem-overlay, .mem-panel { transition: none; transform: none; }
    }

    .mem-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid rgba(79,140,255,0.25);
    }
    .mem-title { font-family: 'Share Tech Mono', monospace; font-size: 15px; letter-spacing: 0.12em; color: #a0c4ff; }
    .mem-close {
      background: none; border: none; color: rgba(255,255,255,0.5); font-size: 18px;
      cursor: pointer; padding: 4px 8px; border-radius: 4px;
    }
    .mem-close:hover { color: #fff; }

    .mem-toggle-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 20px; border-bottom: 1px solid rgba(79,140,255,0.15);
    }
    .mem-toggle-label { font-size: 15px; font-weight: 600; color: #e8f0ff; }
    .mem-toggle-sub { font-size: 12px; color: rgba(255,255,255,0.45); margin-top: 2px; }
    .mem-switch {
      position: relative; flex-shrink: 0; width: 42px; height: 23px; border-radius: 12px; cursor: pointer;
      background: rgba(255,255,255,0.12); border: 1px solid rgba(79,140,255,0.3); transition: background 0.2s;
    }
    .mem-switch::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 17px; height: 17px;
      border-radius: 50%; background: #c8d8ff; transition: transform 0.2s;
    }
    .mem-switch[aria-checked="true"] { background: #4f8cff; }
    .mem-switch[aria-checked="true"]::after { transform: translateX(19px); background: #fff; }
    .mem-switch:disabled { opacity: 0.5; cursor: default; }

    .mem-count {
      padding: 10px 20px 4px; font-family: 'Share Tech Mono', monospace;
      font-size: 11px; color: rgba(79,140,255,0.7); letter-spacing: 0.08em;
    }
    .mem-list { flex: 1; overflow-y: auto; padding: 6px 12px 12px; }
    .mem-list::-webkit-scrollbar { width: 4px; }
    .mem-list::-webkit-scrollbar-thumb { background: rgba(79,140,255,0.3); border-radius: 2px; }
    .mem-empty { padding: 28px 12px; text-align: center; font-size: 14px; line-height: 1.5; color: rgba(255,255,255,0.4); }

    .mem-row {
      display: flex; align-items: center; gap: 8px; padding: 10px 10px; margin-bottom: 6px;
      border-radius: 6px; background: rgba(79,140,255,0.07); border: 1px solid rgba(79,140,255,0.2);
    }
    .mem-text { flex: 1; font-size: 14px; line-height: 1.45; color: #c8d8ff; word-break: break-word; }
    .mem-actions { display: flex; gap: 2px; flex-shrink: 0; }
    .mem-mini {
      background: none; border: none; cursor: pointer; border-radius: 4px; padding: 4px 7px;
      font-family: 'Share Tech Mono', monospace; font-size: 11px; color: rgba(255,255,255,0.4);
    }
    .mem-mini:hover { color: #fff; background: rgba(79,140,255,0.2); }
    .mem-mini.danger:hover { color: #ff8080; background: rgba(255,79,79,0.12); }
    .mem-edit-input {
      flex: 1; min-width: 0; background: rgba(255,255,255,0.06); color: #fdfdfd;
      border: 1px solid rgba(79,140,255,0.5); border-radius: 4px; padding: 6px 8px;
      font-family: 'Rajdhani', sans-serif; font-size: 14px; outline: none;
    }

    .mem-add {
      display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid rgba(79,140,255,0.2);
    }
    .mem-add input {
      flex: 1; min-width: 0; background: rgba(255,255,255,0.05); color: #fdfdfd;
      border: 1px solid rgba(79,140,255,0.3); border-radius: 6px; padding: 8px 10px;
      font-family: 'Rajdhani', sans-serif; font-size: 14px; outline: none;
    }
    .mem-add input:focus { border-color: rgba(79,140,255,0.7); }
    .mem-btn {
      background: linear-gradient(135deg, #4f8cff, #0d1438); border: none; border-radius: 6px; cursor: pointer;
      padding: 8px 14px; color: #fff; font-family: 'Rajdhani', sans-serif; font-weight: 700;
      font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;
    }
    .mem-btn:hover { opacity: 0.85; }
    .mem-btn:disabled { opacity: 0.4; cursor: default; }

    .mem-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 20px 16px; min-height: 48px;
    }
    .mem-status { font-family: 'Share Tech Mono', monospace; font-size: 11px; color: rgba(255,255,255,0.45); }
    .mem-status.error { color: #ff8080; }
    .mem-clear {
      background: none; border: 1px solid rgba(255,79,79,0.4); color: #ff8080; border-radius: 6px;
      padding: 6px 10px; cursor: pointer; font-family: 'Share Tech Mono', monospace; font-size: 11px; flex-shrink: 0;
    }
    .mem-clear:hover { background: rgba(255,79,79,0.12); }
  `;
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  // ── Tiny DOM helper (always textContent, never innerHTML) ─────────────────
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ── API ───────────────────────────────────────────────────────────────────
  async function memApi(path, opts = {}) {
    const res = await fetch(`${API_URL}${path}`, {
      ...opts,
      headers: authHeaders(opts.body ? { "Content-Type": "application/json" } : {}),
    });
    if (res.status === 401) { goToLogin(); throw new Error("Unauthorized"); }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(typeof err.detail === "string" ? err.detail : `Server error ${res.status}`);
    }
    return res.json();
  }

  // ── Build the UI ──────────────────────────────────────────────────────────
  const sidebar = document.querySelector(".sidebar");
  const footer = el("div", "mem-sidebar-footer");
  const openBtn = el("button", "mem-open-btn", "\u25C8 MEMORY");
  openBtn.type = "button";
  footer.appendChild(openBtn);
  sidebar.appendChild(footer);

  const overlay = el("div", "mem-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Nexus memory");

  const panel = el("div", "mem-panel");

  const head = el("div", "mem-head");
  head.appendChild(el("div", "mem-title", "NEXUS MEMORY"));
  const closeBtn = el("button", "mem-close", "\u2715");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close memory panel");
  head.appendChild(closeBtn);

  const toggleRow = el("div", "mem-toggle-row");
  const toggleText = el("div");
  toggleText.appendChild(el("div", "mem-toggle-label", "Remember things across chats"));
  toggleText.appendChild(el("div", "mem-toggle-sub", "Nexus saves short notes from what you tell it. Turning this off stops saving and using notes; it does not delete them."));
  const toggle = el("button", "mem-switch");
  toggle.type = "button";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "Remember things across chats");
  toggle.setAttribute("aria-checked", "true");
  toggleRow.append(toggleText, toggle);

  const countEl = el("div", "mem-count");
  const listEl = el("div", "mem-list");

  const addRow = el("div", "mem-add");
  const addInput = el("input");
  addInput.type = "text";
  addInput.maxLength = MAX_CHARS;
  addInput.placeholder = "Add a note, e.g. I prefer short answers";
  addInput.setAttribute("aria-label", "New memory note");
  const addBtn = el("button", "mem-btn", "Add");
  addBtn.type = "button";
  addRow.append(addInput, addBtn);

  const foot = el("div", "mem-foot");
  const statusEl = el("div", "mem-status");
  const clearBtn = el("button", "mem-clear", "DELETE ALL");
  clearBtn.type = "button";
  foot.append(statusEl, clearBtn);

  panel.append(head, toggleRow, countEl, listEl, addRow, foot);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // ── State ─────────────────────────────────────────────────────────────────
  let memories = [];
  let enabled = true;
  let lastFocus = null;
  let clearTimer = null;

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("error", !!isError);
  }

  function render() {
    toggle.setAttribute("aria-checked", String(enabled));
    countEl.textContent = `${memories.length} / ${MAX_NOTES} NOTES`;
    clearBtn.style.visibility = memories.length ? "visible" : "hidden";
    listEl.replaceChildren();

    if (!memories.length) {
      listEl.appendChild(el(
        "div", "mem-empty",
        "Nothing saved yet. Tell Nexus about yourself in a chat and durable facts will show up here a few seconds later (reopen this panel to refresh)."
      ));
      return;
    }
    memories.forEach((m) => listEl.appendChild(renderRow(m)));
  }

  function renderRow(m) {
    const row = el("div", "mem-row");
    row.appendChild(el("span", "mem-text", m.content));

    const actions = el("div", "mem-actions");
    const editBtn = el("button", "mem-mini", "EDIT");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => startEdit(m, row));

    const delBtn = el("button", "mem-mini danger", "\u2715");
    delBtn.type = "button";
    delBtn.setAttribute("aria-label", "Delete note");
    delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      try {
        await memApi(`/memories/${m.id}`, { method: "DELETE" });
        memories = memories.filter((x) => x.id !== m.id);
        setStatus("");
        render();
      } catch (e) {
        delBtn.disabled = false;
        setStatus(e.message, true);
      }
    });

    actions.append(editBtn, delBtn);
    row.appendChild(actions);
    return row;
  }

  function startEdit(m, row) {
    const input = el("input", "mem-edit-input");
    input.type = "text";
    input.maxLength = MAX_CHARS;
    input.value = m.content;

    const actions = el("div", "mem-actions");
    const saveBtn = el("button", "mem-mini", "SAVE");
    saveBtn.type = "button";
    const cancelBtn = el("button", "mem-mini", "CANCEL");
    cancelBtn.type = "button";
    actions.append(saveBtn, cancelBtn);

    async function save() {
      const content = input.value.trim();
      if (!content || content === m.content) { render(); return; }
      saveBtn.disabled = true;
      try {
        const updated = await memApi(`/memories/${m.id}`, {
          method: "PATCH",
          body: JSON.stringify({ content }),
        });
        memories = memories.map((x) => (x.id === m.id ? updated : x));
        setStatus("");
        render();
      } catch (e) {
        saveBtn.disabled = false;
        setStatus(e.message, true);
      }
    }

    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.stopPropagation(); render(); }
    });

    row.replaceChildren(input, actions);
    input.focus();
    input.select();
  }

  async function load() {
    setStatus("Loading\u2026");
    try {
      const [mems, settings] = await Promise.all([memApi("/memories"), memApi("/memory-settings")]);
      memories = Array.isArray(mems) ? mems : [];
      enabled = !!settings.enabled;
      setStatus("");
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function openPanel() {
    lastFocus = document.activeElement;
    overlay.classList.add("open");
    closeBtn.focus();
    load();
  }

  function closePanel() {
    overlay.classList.remove("open");
    clearBtn.textContent = "DELETE ALL";
    clearTimeout(clearTimer);
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  openBtn.addEventListener("click", openPanel);
  closeBtn.addEventListener("click", closePanel);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePanel(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closePanel();
  });

  // ── Toggle ────────────────────────────────────────────────────────────────
  toggle.addEventListener("click", async () => {
    const next = !enabled;
    toggle.disabled = true;
    try {
      const res = await memApi("/memory-settings", {
        method: "PUT",
        body: JSON.stringify({ enabled: next }),
      });
      enabled = !!res.enabled;
      setStatus(enabled ? "Memory on" : "Memory off");
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      toggle.disabled = false;
      render();
    }
  });

  // ── Add ───────────────────────────────────────────────────────────────────
  async function addNote() {
    const content = addInput.value.trim();
    if (!content) return;
    addBtn.disabled = true;
    try {
      const created = await memApi("/memories", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      memories.unshift(created);
      addInput.value = "";
      setStatus("");
      render();
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      addBtn.disabled = false;
      addInput.focus();
    }
  }
  addBtn.addEventListener("click", addNote);
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addNote(); }
  });

  // ── Delete all (two clicks to confirm) ────────────────────────────────────
  clearBtn.addEventListener("click", async () => {
    if (clearBtn.textContent === "DELETE ALL") {
      clearBtn.textContent = "CLICK AGAIN TO CONFIRM";
      clearTimer = setTimeout(() => { clearBtn.textContent = "DELETE ALL"; }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    clearBtn.textContent = "DELETE ALL";
    try {
      await memApi("/memories", { method: "DELETE" });
      memories = [];
      setStatus("All notes deleted");
      render();
    } catch (e) {
      setStatus(e.message, true);
    }
  });
})();