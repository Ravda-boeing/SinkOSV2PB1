/**
 * Core — SinkOS file system browser
 *
 * Talks directly to Supabase from the browser using the public "anon" key.
 * This is the normal, intended way to use Supabase's anon key — it's a
 * public/client-safe key by design, not a secret. What actually protects
 * the data is the Row Level Security (RLS) policy on the `nodes` table
 * (see schema.sql). Each row carries a `user_id` and RLS restricts
 * select/write to rows the signed-in user owns.
 *
 * Photos and Documents:
 * Items saved elsewhere in SinkOS (camera.html photos, Sink Writer
 * documents) automatically appear here under "Photos" / "Documents" —
 * that sync happens entirely in Postgres via triggers (see schema.sql),
 * so this file never writes to camera_photos/documents directly.
 *
 * Deleting a node is destructive: schema.sql wires an AFTER DELETE
 * trigger on `nodes` that also removes the storage object and the
 * source-table row for any synced item, and that trigger fires for
 * cascaded deletes too (e.g. deleting a folder full of synced photos).
 * So the client just deletes the `nodes` row — everything downstream is
 * handled by the database.
 */

// ---- Supabase connection -------------------------------------------------

const SUPABASE_URL = "https://okknkixdbjsnqrwlfgzn.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ra25raXhkYmpzbnFyd2xmZ3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzgwNzQsImV4cCI6MjA5ODE1NDA3NH0.L2QDUnez8KjIM8yg9cB9cs-tTq6nedk3CCpuJBjWBEg";

// Named `sb` (not `db`/`supabase`) to match SinkOS convention and avoid
// colliding with the `supabase` global the CDN script attaches to window.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Update this when the sinkos.net migration lands for this module.
const SINKOS_AUTH_BASE = "https://ravda-boeing.github.io/SinkOSAuth";

// ---- Icons (same as the design preview) ----------------------------------

const ICONS = {
  folder:
    '<svg viewBox="0 0 32 24" width="26" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 4 L10 4 L13 8 L30 8 L30 20 L2 20 Z" fill="currentColor" opacity="0.15"/>' +
    '<path d="M2 4 L10 4 L13 8 L30 8 L30 20 L2 20 Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<line x1="5" y1="13" x2="27" y2="13" stroke="currentColor" stroke-width="1" opacity="0.5"/>' +
    '<line x1="5" y1="16.5" x2="24" y2="16.5" stroke="currentColor" stroke-width="1" opacity="0.35"/>' +
    "</svg>",
  file:
    '<svg viewBox="0 0 24 28" width="20" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 2 H15 L20 7 V26 H4 Z" fill="currentColor" opacity="0.12"/>' +
    '<path d="M4 2 H15 L20 7 V26 H4 Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M15 2 V7 H20" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    "</svg>",
  empty:
    '<svg viewBox="0 0 64 48" width="52" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 34 L20 30 L28 36 L38 26 L48 32 L60 28" stroke="currentColor" stroke-width="1.6" opacity="0.55"/>' +
    '<path d="M4 40 L18 37 L27 42 L40 33 L50 39 L60 35" stroke="currentColor" stroke-width="1.6" opacity="0.3"/>' +
    "</svg>",
};

// ---- State ----------------------------------------------------------------

let currentPath = []; // [{ id, name }, ...] ancestor chain; [] means we're at root
let currentView = "grid";
let showHidden = false; // items whose name starts with "_" are tucked away by default

function currentParentId() {
  return currentPath.length === 0 ? null : currentPath[currentPath.length - 1].id;
}

// ---- Data access ------------------------------------------------------------
// No explicit user_id filtering is needed here — RLS on `nodes` already
// scopes every select/insert/delete to auth.uid(). These queries would
// return nothing (or fail) for rows belonging to another account.

async function fetchChildren(parentId) {
  let query = sb.from("nodes").select("*");
  query = parentId === null ? query.is("parent_id", null) : query.eq("parent_id", parentId);
  const { data, error } = await query.order("type", { ascending: false }).order("name");
  if (error) throw error;
  return showHidden ? data : data.filter((item) => !item.name.startsWith("_"));
}

async function fetchChildCount(folderId) {
  const { data, error } = await sb.from("nodes").select("name").eq("parent_id", folderId);
  if (error) return 0;
  const items = showHidden ? data : data.filter((item) => !item.name.startsWith("_"));
  return items.length;
}

async function createFolder(name, parentId) {
  // user_id defaults to auth.uid() at the database level, so it's not
  // set explicitly here.
  const { error } = await sb.from("nodes").insert({ name, parent_id: parentId, type: "folder" });
  if (error) throw error;
}

async function deleteNode(id) {
  // ON DELETE CASCADE takes care of descendants at the nodes level, and
  // a trigger on nodes (see schema.sql) takes care of the rest: any
  // synced item (this row or a descendant of a deleted folder) has its
  // storage object and its camera_photos/documents row deleted too.
  // Nothing is left behind.
  const { error } = await sb.from("nodes").delete().eq("id", id);
  if (error) throw error;
}

async function getSignedUrl(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 60);
  if (error) throw error;
  return data.signedUrl;
}

// ---- Formatting -------------------------------------------------------------

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatModified(isoString) {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) === 1 ? "" : "s"} ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

function getCategory(item) {
  if (item.type === "folder") return "folder";
  const ext = item.ext;
  if (["js", "ts", "py"].includes(ext)) return "code";
  if (["md", "txt"].includes(ext)) return "doc";
  if (["png", "svg", "jpg", "jpeg"].includes(ext)) return "image";
  if (["mp4", "mp3", "mov", "wav"].includes(ext)) return "media";
  if (["xlsx", "csv"].includes(ext)) return "sheet";
  if (["zip", "rar"].includes(ext)) return "archive";
  return "file";
}

// ---- Rendering --------------------------------------------------------------

function renderCore() {
  const coreEl = document.getElementById("core-core");
  coreEl.innerHTML = "";
  const bands = [{ id: null, name: "Root" }, ...currentPath];

  bands.forEach((b, i) => {
    const isCurrent = i === bands.length - 1;
    const div = document.createElement("div");
    div.className = "core-band" + (isCurrent ? " core-band-current" : "");
    div.tabIndex = 0;
    div.setAttribute("role", "button");
    div.innerHTML = `<span class="core-band-label" title="${b.name}">${b.name}</span>`;
    div.addEventListener("click", () => {
      currentPath = bands.slice(1, i + 1).map((x) => ({ id: x.id, name: x.name }));
      refresh();
    });
    coreEl.appendChild(div);
  });
}

async function renderStage() {
  const stage = document.getElementById("core-stage");
  document.getElementById("core-path").textContent = ["Root", ...currentPath.map((p) => p.name)].join(" / ");

  let items;
  try {
    items = await fetchChildren(currentParentId());
  } catch (err) {
    stage.innerHTML = `<div class="core-loading">Couldn't load: ${err.message}</div>`;
    console.error("Core: fetch error", err);
    return;
  }

  const query = document.getElementById("core-search").value.trim().toLowerCase();
  if (query) items = items.filter((i) => i.name.toLowerCase().includes(query));

  stage.className = "core-stage " + (currentView === "list" ? "core-list-view" : "core-grid-view");
  stage.innerHTML = "";

  if (items.length === 0) {
    stage.innerHTML = `
      <div class="core-empty">
        ${ICONS.empty}
        <p class="core-empty-title">Nothing down here yet.</p>
        <p class="core-empty-sub">Bring something into the light.</p>
      </div>`;
    return;
  }

  for (const item of items) {
    const cat = getCategory(item);
    const isWellKnown = !!item.well_known; // e.g. the auto-created "Photos" / "Documents" root
    const isSynced = !!item.source_table; // mirrors a row in camera_photos / documents

    const card = document.createElement("div");
    card.className = `core-card core-cat-${cat}`;
    card.tabIndex = 0;

    if (item.type === "folder") {
      const count = await fetchChildCount(item.id);
      card.innerHTML = `
        <div class="core-card-icon">${ICONS.folder}</div>
        <div class="core-card-meta">
          <div class="core-card-name">${item.name}</div>
          <div class="core-card-sub">${count} item${count === 1 ? "" : "s"}</div>
        </div>
        ${isWellKnown ? "" : '<button class="core-card-delete" title="Delete folder">✕</button>'}`;

      card.addEventListener("click", (e) => {
        if (e.target.closest(".core-card-delete")) return;
        currentPath = [...currentPath, { id: item.id, name: item.name }];
        document.getElementById("core-search").value = "";
        refresh();
      });
    } else {
      card.innerHTML = `
        <div class="core-card-icon">${ICONS.file}</div>
        <div class="core-card-meta">
          <div class="core-card-name">${item.name}</div>
          <div class="core-card-sub">${formatSize(item.size_bytes)} · ${formatModified(item.modified)}</div>
        </div>
        <button class="core-card-delete" title="Delete file">✕</button>`;

      if (isSynced) {
        card.addEventListener("click", async (e) => {
          if (e.target.closest(".core-card-delete")) return;
          try {
            const url = await getSignedUrl(item.storage_bucket, item.storage_path);
            window.open(url, "_blank", "noopener");
          } catch (err) {
            alert(`Couldn't open file: ${err.message}`);
          }
        });
      }
    }

    const deleteBtn = card.querySelector(".core-card-delete");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const warning = isSynced
          ? `Delete "${item.name}"? This permanently deletes the original file too — not just this listing. This can't be undone.`
          : item.type === "folder"
          ? `Delete "${item.name}" and everything inside it? This can't be undone.`
          : `Delete "${item.name}"? This can't be undone.`;
        if (!confirm(warning)) return;
        try {
          await deleteNode(item.id);
          refresh();
        } catch (err) {
          alert(`Couldn't delete: ${err.message}`);
        }
      });
    }

    stage.appendChild(card);
  }
}

async function refresh() {
  renderCore();
  await renderStage();
}

// ---- Events -----------------------------------------------------------------
// (Attached once, after the auth gate clears — see initAuthGate/bindAppEvents.)

function bindAppEvents() {
  document.getElementById("core-search").addEventListener("input", renderStage);

  document.getElementById("core-hidden-toggle").addEventListener("click", () => {
    showHidden = !showHidden;
    const btn = document.getElementById("core-hidden-toggle");
    btn.textContent = showHidden ? "Hide hidden" : "Show hidden";
    btn.classList.toggle("core-toggle-active", showHidden);
    renderStage();
  });

  document.getElementById("core-view-toggle").addEventListener("click", () => {
    currentView = currentView === "grid" ? "list" : "grid";
    document.getElementById("core-view-toggle").textContent = currentView === "grid" ? "⊞" : "☰";
    renderStage();
  });

  document.getElementById("core-new-folder-btn").addEventListener("click", async () => {
    const name = prompt("Folder name:");
    if (!name || !name.trim()) return;
    try {
      await createFolder(name.trim(), currentParentId());
      refresh();
    } catch (err) {
      alert(`Couldn't create folder: ${err.message}`);
    }
  });

  document.getElementById("core-signout-btn").addEventListener("click", async () => {
    sessionStorage.removeItem("sinkos_unlocked");
    await sb.auth.signOut();
    location.reload();
  });
}

// ---- Auth gate --------------------------------------------------------------
// Same inline-gate pattern used across SinkOS modules: an existing session
// prompts for the OS password (checked against profiles.os_password_hash);
// no session shows an inline sign-in form; only accounts with no profile
// row yet get redirected out to onboarding.

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function showGateStep(step) {
  document.getElementById("core-auth-checking").style.display = step === "checking" ? "block" : "none";
  document.getElementById("core-auth-unlock").style.display = step === "unlock" ? "block" : "none";
  document.getElementById("core-auth-signin").style.display = step === "signin" ? "block" : "none";
}

async function enterApp() {
  document.getElementById("core-auth-gate").style.display = "none";
  document.getElementById("core-app").style.display = "flex";
  bindAppEvents();
  await refresh();
}

async function initAuthGate() {
  document.getElementById("core-auth-gate").style.display = "flex";
  showGateStep("checking");

  const {
    data: { session },
  } = await sb.auth.getSession();

  if (!session) {
    showGateStep("signin");
    document.getElementById("core-auth-signin-btn").addEventListener("click", async () => {
      const email = document.getElementById("core-auth-email").value.trim();
      const password = document.getElementById("core-auth-password").value;
      const errEl = document.getElementById("core-auth-error2");
      errEl.textContent = "";
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        errEl.textContent = error.message;
        return;
      }
      location.reload();
    });
    return;
  }

  const { data: profile } = await sb
    .from("profiles")
    .select("os_password_hash")
    .eq("id", session.user.id)
    .single();

  if (!profile) {
    location.href = `${SINKOS_AUTH_BASE}/onboarding.html?redirect_to=${encodeURIComponent(location.href)}`;
    return;
  }

  if (sessionStorage.getItem("sinkos_unlocked") === session.user.id) {
    await enterApp();
    return;
  }

  showGateStep("unlock");
  document.getElementById("core-auth-unlock-btn").addEventListener("click", async () => {
    const pw = document.getElementById("core-auth-pw").value;
    const errEl = document.getElementById("core-auth-error");
    errEl.textContent = "";
    const hash = await sha256Hex(pw);
    if (hash === profile.os_password_hash) {
      sessionStorage.setItem("sinkos_unlocked", session.user.id);
      await enterApp();
    } else {
      errEl.textContent = "Incorrect password.";
    }
  });
}

initAuthGate();