/* ==========================================================================
   Sink Charts — auth.js
   Implements the SinkOS inline auth-gate pattern used across modules:

     1. An active Supabase session already exists (user came from another
        SinkOS module / didn't fully log out)
          -> show the OS password (lock) prompt, checked against
             profiles.os_password_hash. No redirect needed.

     2. No Supabase session at all
          -> show an inline email/password form (signInWithPassword).

     3. The signed-in user has no `username` yet in `profiles`
        (brand-new account that never finished SinkOSAuth onboarding)
          -> redirect to SinkOSAuth's onboarding step with a
             ?redirect_to= back to this page, exactly like Nexus AI
             and Sink Writer do.

   NOTE ON NAMING: the Supabase CDN script exposes a global called
   `supabase`. To avoid the collision that bit earlier modules, the
   client instance here is called `sb`.
   ========================================================================== */

// ---------------------------------------------------------------------------
// CONFIG — fill these in before deploying. Hardcode locally during dev per
// your usual workflow; swap to the Render/GH env-var equivalent before any
// public commit that includes real keys.
// ---------------------------------------------------------------------------
const SUPABASE_URL = "https://okknkixdbjsnqrwlfgzn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ra25raXhkYmpzbnFyd2xmZ3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzgwNzQsImV4cCI6MjA5ODE1NDA3NH0.L2QDUnez8KjIM8yg9cB9cs-tTq6nedk3CCpuJBjWBEg";

// Same-project assumption: Sink Charts reuses the shared SinkOS Supabase
// project (the one with `profiles.username` / `profiles.os_password_hash`)
// rather than standing up a separate auth system. Adjust if that's wrong.
const PROFILES_TABLE = "profiles";

// Where SinkOSAuth lives, for the redirect_to round trip on brand-new accounts.
const SINKOS_AUTH_URL = "https://ravda-boeing.github.io/SinkOSAuth/";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function sha256Hex(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function currentUrlWithoutHash() {
  return window.location.origin + window.location.pathname;
}

function unlockedFlagKey(userId) {
  return `sinkcharts_unlocked_${userId}`;
}

function $(id) { return document.getElementById(id); }

function showEl(id) { $(id).classList.remove("hidden"); }
function hideEl(id) { $(id).classList.add("hidden"); }

// ---------------------------------------------------------------------------
// SinkAuth — the public surface app.js relies on
// ---------------------------------------------------------------------------
window.SinkAuth = {
  sb,
  user: null,        // Supabase auth user object once unlocked
  profile: null,      // row from `profiles` (username, os_password_hash, ...)
  ready: null,        // Promise, resolves once the gate has been passed
};

function resolveReady(fn) { window.SinkAuth._resolveReady = fn; }

window.SinkAuth.ready = new Promise((resolve) => resolveReady(resolve));

function enterApp() {
  hideEl("splash");
  hideEl("auth-gate");
  window.SinkAuth._resolveReady({
    user: window.SinkAuth.user,
    profile: window.SinkAuth.profile,
  });
}

async function fetchProfile(userId) {
  const { data, error } = await sb
    .from(PROFILES_TABLE)
    .select("username, os_password_hash")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("Sink Charts: failed to load profile", error);
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Lock screen (existing session)
// ---------------------------------------------------------------------------

function initials(name) {
  if (!name) return "?";
  return name.trim().slice(0, 1).toUpperCase();
}

function showLockScreen(user, profile) {
  showEl("auth-gate");
  showEl("lock-card");
  hideEl("login-card");

  $("lock-initial").textContent = initials(profile?.username);
  $("lock-username").textContent = profile?.username
    ? `Welcome back, ${profile.username}`
    : "Welcome back";
  $("lock-error").textContent = "";
  $("lock-password").value = "";
  $("lock-password").focus();
}

async function attemptUnlock() {
  const pw = $("lock-password").value;
  $("lock-error").textContent = "";
  if (!pw) return;

  const btn = $("lock-unlock-btn");
  btn.disabled = true;

  try {
    const hash = await sha256Hex(pw);
    if (hash !== window.SinkAuth.profile?.os_password_hash) {
      $("lock-error").textContent = "That password didn't match. Try again.";
      return;
    }
    sessionStorage.setItem(unlockedFlagKey(window.SinkAuth.user.id), "1");
    enterApp();
  } finally {
    btn.disabled = false;
  }
}

async function signOutAndShowLogin() {
  sessionStorage.clear();
  await sb.auth.signOut();
  showEl("auth-gate");
  hideEl("lock-card");
  showEl("login-card");
  $("login-email").focus();
}

// ---------------------------------------------------------------------------
// Inline login (fresh session)
// ---------------------------------------------------------------------------

function showLoginScreen() {
  showEl("auth-gate");
  hideEl("lock-card");
  showEl("login-card");
  $("login-error").textContent = "";
}

async function attemptLogin() {
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  $("login-error").textContent = "";

  if (!email || !password) {
    $("login-error").textContent = "Enter your email and password.";
    return;
  }

  const btn = $("login-btn");
  btn.disabled = true;

  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      $("login-error").textContent = error.message || "Couldn't sign you in.";
      return;
    }

    const user = data.user;
    const profile = await fetchProfile(user.id);

    if (!profile || !profile.username) {
      // Brand-new / never finished onboarding — hand off to SinkOSAuth,
      // and it will bounce back here once setup is complete.
      const redirect = encodeURIComponent(currentUrlWithoutHash());
      window.location.href = `${SINKOS_AUTH_URL}?step=onboarding&redirect_to=${redirect}`;
      return;
    }

    window.SinkAuth.user = user;
    window.SinkAuth.profile = profile;
    sessionStorage.setItem(unlockedFlagKey(user.id), "1");
    enterApp();
  } finally {
    btn.disabled = false;
  }
}

function goToOnboarding() {
  const redirect = encodeURIComponent(currentUrlWithoutHash());
  window.location.href = `${SINKOS_AUTH_URL}?redirect_to=${redirect}`;
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function bootAuth() {
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    hideEl("splash");
    showLoginScreen();
    return;
  }

  const user = session.user;
  const profile = await fetchProfile(user.id);
  window.SinkAuth.user = user;
  window.SinkAuth.profile = profile;

  if (!profile || !profile.username) {
    const redirect = encodeURIComponent(currentUrlWithoutHash());
    window.location.href = `${SINKOS_AUTH_URL}?step=onboarding&redirect_to=${redirect}`;
    return;
  }

  const alreadyUnlocked = sessionStorage.getItem(unlockedFlagKey(user.id)) === "1";
  hideEl("splash");

  if (alreadyUnlocked) {
    enterApp();
  } else {
    showLockScreen(user, profile);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bootAuth();

  $("lock-unlock-btn").addEventListener("click", attemptUnlock);
  $("lock-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") attemptUnlock();
  });
  $("lock-signout-btn").addEventListener("click", signOutAndShowLogin);

  $("login-btn").addEventListener("click", attemptLogin);
  $("login-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") attemptLogin();
  });
  $("go-onboarding-btn").addEventListener("click", goToOnboarding);
});