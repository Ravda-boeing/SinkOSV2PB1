"use strict";

// ─── Supabase Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = "https://okknkixdbjsnqrwlfgzn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ra25raXhkYmpzbnFyd2xmZ3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzgwNzQsImV4cCI6MjA5ODE1NDA3NH0.L2QDUnez8KjIM8yg9cB9cs-tTq6nedk3CCpuJBjWBEg";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentAccessToken = null;

// ─── Config ───────────────────────────────────────────────────────────────────
let API_URL = "http://localhost:8000";

async function loadConfig() {
  try {
    const res = await fetch("config.json");
    const cfg = await res.json();
    API_URL = (cfg.apiUrl || API_URL).replace(/\/chat$/, "").replace(/\/$/, "");
  } catch (e) {
    console.warn("Could not load config.json, using default:", API_URL);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_URL = "https://ravda-boeing.github.io/SinkOSAuth/";

function goToLogin() {
  const returnTo = encodeURIComponent(window.location.href);
  window.location.href = `${AUTH_URL}?redirect_to=${returnTo}`;
}

async function requireAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    goToLogin();
    return false;
  }
  currentAccessToken = session.access_token;
  return true;
}

// Keep the token fresh if Supabase silently refreshes it, and bounce to login
// if the session ever disappears (e.g. sign-out in another tab).
sb.auth.onAuthStateChange((_event, session) => {
  if (session) {
    currentAccessToken = session.access_token;
  } else {
    currentAccessToken = null;
    goToLogin();
  }
});

function authHeaders(extra = {}) {
  return {
    ...extra,
    "Authorization": `Bearer ${currentAccessToken}`,
  };
}

// ─── State ────────────────────────────────────────────────────────────────────
let currentSessionId = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const chatLogs        = document.getElementById("chat-logs");
const typingIndicator = document.getElementById("typing-indicator");
const chatArea        = document.getElementById("chat-area");
const userInput       = document.getElementById("user-input");
const sendBtn         = document.getElementById("send-btn");
const newChatBtn      = document.getElementById("new-chat-btn");
const convList        = document.getElementById("conversation-list");

// ─── Rendering ────────────────────────────────────────────────────────────────
function addMessage(text, sender, attachments = []) {
  const row = document.createElement("div");
  row.className = `message-row ${sender}`;

  const avatar = document.createElement("div");
  avatar.className = `avatar ${sender}`;
  avatar.textContent = sender === "bot" ? "NX" : "YOU";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (attachments && attachments.length > 0) {
    const attWrap = document.createElement("div");
    attWrap.className = "bubble-attachments";
    attachments.forEach((att) => {
      if (att.mime_type && att.mime_type.startsWith("image/")) {
        const img = document.createElement("img");
        img.src = att.url;
        img.alt = att.name || "attachment";
        img.className = "attachment-thumb";
        img.addEventListener("click", () => window.open(att.url, "_blank", "noopener,noreferrer"));
        attWrap.appendChild(img);
      } else {
        const link = document.createElement("a");
        link.href = att.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "attachment-file";
        link.textContent = `📄 ${att.name || "file"}`;
        attWrap.appendChild(link);
      }
    });
    bubble.appendChild(attWrap);
  }

  if (text) {
    const textEl = document.createElement("div");
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  chatLogs.appendChild(row);
  scrollToBottom();
}

function scrollToBottom() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function showTyping() {
  typingIndicator.style.display = "flex";
  scrollToBottom();
}

function hideTyping() {
  typingIndicator.style.display = "none";
}

function clearChat() {
  chatLogs.innerHTML = "";
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
async function loadConversations() {
  try {
    const res = await fetch(`${API_URL}/conversations`, {
      headers: authHeaders(),
    });

    if (res.status === 401) { goToLogin(); return; }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }

    const convs = await res.json();
    if (!Array.isArray(convs)) {
      throw new Error("Unexpected response shape from /conversations");
    }
    renderSidebar(convs);
  } catch (e) {
    console.error("Failed to load conversations:", e);
  }
}

function renderSidebar(convs) {
  convList.innerHTML = "";
  convs.forEach(conv => {
    const item = document.createElement("div");
    item.className = "conv-item" + (conv.id === currentSessionId ? " active" : "");
    item.dataset.id = conv.id;

    const label = document.createElement("span");
    label.className = "conv-label";
    label.textContent = conv.title || "Untitled";

    const delBtn = document.createElement("button");
    delBtn.className = "conv-delete";
    delBtn.textContent = "✕";
    delBtn.title = "Delete";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteConversation(conv.id);
    });

    item.appendChild(label);
    item.appendChild(delBtn);
    item.addEventListener("click", () => loadConversation(conv.id));
    convList.appendChild(item);
  });
}

function setActiveInSidebar(sessionId) {
  convList.querySelectorAll(".conv-item").forEach(el => {
    el.classList.toggle("active", el.dataset.id === sessionId);
  });
}

// ─── Load conversation ────────────────────────────────────────────────────────
async function loadConversation(sessionId) {
  try {
    const res = await fetch(`${API_URL}/conversations/${sessionId}`, {
      headers: authHeaders(),
    });

    if (res.status === 401) { goToLogin(); return; }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }

    const data = await res.json();
    currentSessionId = sessionId;
    clearChat();
    setActiveInSidebar(sessionId);
    (data.messages || []).forEach(msg => {
      addMessage(msg.content, msg.role === "user" ? "user" : "bot", msg.attachments || []);
    });
  } catch (e) {
    console.error("Failed to load conversation:", e);
  }
}

// ─── Delete conversation ──────────────────────────────────────────────────────
async function deleteConversation(sessionId) {
  try {
    const res = await fetch(`${API_URL}/conversations/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (res.status === 401) { goToLogin(); return; }
    if (currentSessionId === sessionId) startNewChat();
    await loadConversations();
  } catch (e) {
    console.error("Failed to delete:", e);
  }
}

// ─── New chat ─────────────────────────────────────────────────────────────────
function startNewChat() {
  currentSessionId = null;
  clearChat();
  setActiveInSidebar(null);
  userInput.focus();
}

// ─── Core "send text, get reply" — shared by typed input AND voice mode ───────
// Returns the reply text (or null on failure) so callers can decide what to do
// next (e.g. Voice Mode speaks it, the typed flow just renders it).
async function sendToNexus(message) {
  const body = { message };
  if (currentSessionId) body.session_id = currentSessionId;

  const res = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    goToLogin();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Server error ${res.status}`);
  }

  const data = await res.json();
  if (data.session_id) {
    const isNew = !currentSessionId;
    currentSessionId = data.session_id;
    await loadConversations();
    if (isNew) setActiveInSidebar(currentSessionId);
  }
  return data.reply;
}

// ════════════════════════════════════════════════════════════════════════════
// ─── FILE ATTACHMENTS ───────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const attachBtn      = document.getElementById("nexus-attach-btn");
const fileInput      = document.getElementById("nexus-file-input");
const pendingFilesEl = document.getElementById("pending-files");
const fileErrorEl    = document.getElementById("file-error-text");

const ALLOWED_FILE_TYPES = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
  "application/pdf",
];
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_FILES = 4;

let pendingFiles = []; // File[]

function showFileError(msg) {
  fileErrorEl.textContent = msg;
  setTimeout(() => { if (fileErrorEl.textContent === msg) fileErrorEl.textContent = ""; }, 4000);
}

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const incoming = Array.from(fileInput.files || []);
  fileInput.value = ""; // allow re-selecting the same file later

  for (const file of incoming) {
    const type = (file.type || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_FILE_TYPES.includes(type)) {
      showFileError(`Unsupported file type: ${file.name}`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      showFileError(`${file.name} is over the 8MB limit`);
      continue;
    }
    if (pendingFiles.length >= MAX_FILES) {
      showFileError(`You can attach up to ${MAX_FILES} files at once`);
      break;
    }
    pendingFiles.push(file);
  }
  renderFileChips();
});

function renderFileChips() {
  pendingFilesEl.innerHTML = "";
  pendingFiles.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "file-chip";

    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      chip.appendChild(img);
    } else {
      const icon = document.createElement("div");
      icon.className = "file-chip-icon";
      icon.textContent = "📄";
      chip.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = file.name;
    chip.appendChild(name);

    const removeBtn = document.createElement("button");
    removeBtn.className = "file-chip-remove";
    removeBtn.textContent = "✕";
    removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
    removeBtn.addEventListener("click", () => {
      pendingFiles.splice(index, 1);
      renderFileChips();
    });
    chip.appendChild(removeBtn);

    pendingFilesEl.appendChild(chip);
  });
}

async function sendMessageWithFiles() {
  const message = userInput.value.trim();
  const files = [...pendingFiles];
  if (!message && files.length === 0) return;

  userInput.value = "";
  pendingFiles = [];
  renderFileChips();
  sendBtn.disabled = true;
  userInput.disabled = true;
  attachBtn.disabled = true;

  addMessage(
    message,
    "user",
    files.map((f) => ({ url: URL.createObjectURL(f), mime_type: f.type, name: f.name }))
  );
  showTyping();

  try {
    const form = new FormData();
    form.append("message", message);
    if (currentSessionId) form.append("session_id", currentSessionId);
    files.forEach((f) => form.append("files", f, f.name));

    const res = await fetch(`${API_URL}/chat/upload`, {
      method: "POST",
      headers: authHeaders(), // don't set Content-Type manually — browser sets the multipart boundary
      body: form,
    });

    if (res.status === 401) { hideTyping(); goToLogin(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Server error ${res.status}`);
    }

    const data = await res.json();
    hideTyping();
    addMessage(data.reply, "bot");

    if (data.session_id) {
      const isNew = !currentSessionId;
      currentSessionId = data.session_id;
      await loadConversations();
      if (isNew) setActiveInSidebar(currentSessionId);
    }
  } catch (e) {
    hideTyping();
    addMessage(`Error: ${e.message}`, "bot");
    console.error("Send with files error:", e);
  } finally {
    sendBtn.disabled = false;
    userInput.disabled = false;
    attachBtn.disabled = false;
    userInput.focus();
  }
}

// ─── Send message (typed input, branches to file upload if any are pending) ───
async function sendMessage() {
  if (pendingFiles.length > 0) {
    await sendMessageWithFiles();
    return;
  }

  const message = userInput.value.trim();
  if (!message) return;

  userInput.value = "";
  sendBtn.disabled = true;
  userInput.disabled = true;

  addMessage(message, "user");
  showTyping();

  try {
    const reply = await sendToNexus(message);
    hideTyping();
    addMessage(reply, "bot");
  } catch (e) {
    hideTyping();
    addMessage(`Error: ${e.message}`, "bot");
    console.error("Send error:", e);
  } finally {
    sendBtn.disabled = false;
    userInput.disabled = false;
    userInput.focus();
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
sendBtn.addEventListener("click", sendMessage);
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) sendMessage();
});
newChatBtn.addEventListener("click", startNewChat);

// ════════════════════════════════════════════════════════════════════════════
// ─── VOICE MODE (Gemini 3.8 Live) ───────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
// How it works: the browser asks our backend for a one-use token
// (/voice/live-token), then streams mic audio straight to Gemini over a
// websocket and plays back the audio it returns. The personality + memory
// prompt lives inside the token, so it never reaches the browser. Finished
// turns are POSTed to /voice/transcript so they show up in chat history and
// feed Nexus memory exactly like typed messages.

const micBtn            = document.getElementById("nexus-mic-btn");
const voiceOverlay      = document.getElementById("voice-mode-overlay");
const voiceBackBtn      = document.getElementById("voice-back-btn");
const voiceOrb          = document.getElementById("voice-orb");
const voiceStatusText   = document.getElementById("voice-status-text");
const voiceTranscriptEl = document.getElementById("voice-transcript-text");
const voiceWaveformSvg  = document.getElementById("voice-waveform");

const VOICE_STATE_LABELS = {
  idle:       "Tap to start talking",
  listening:  "Listening… tap to end",
  processing: "Connecting…",
  speaking:   "Nexus is speaking… tap to interrupt",
  error:      "Something went wrong — tap to retry",
};

// Pinned SDK version, loaded on first use so the rest of Nexus never waits on it.
const LIVE_SDK_URL = "https://cdn.jsdelivr.net/npm/@google/genai@2.29.1/+esm";
let liveSdkPromise = null;
function loadLiveSdk() {
  if (!liveSdkPromise) liveSdkPromise = import(LIVE_SDK_URL).catch((e) => { liveSdkPromise = null; throw e; });
  return liveSdkPromise;
}

// Runs on the audio thread: downsamples whatever the mic gives us (usually
// 44.1/48 kHz) to 16 kHz mono 16-bit PCM and ships it in ~100 ms chunks.
const MIC_WORKLET_SRC = `
class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0; this.acc = 0; this.cnt = 0;
    this.buf = new Int16Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0; this.cnt = 0;
        this.buf[this.n++] = Math.round(v * 32767);
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.buffer.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm16-capture", Pcm16Capture);
`;

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class VoiceModeController {
  constructor() {
    this.state = "idle";
    this.session = null;
    this.stream = null;
    this.micCtx = null;
    this.outCtx = null;
    this.micAnalyser = null;
    this.outAnalyser = null;
    this.workletNode = null;
    this.sources = new Set();
    this.nextTime = 0;
    this.rafId = null;
    this.userText = "";
    this.modelText = "";
    this.turnDone = false;
    this.skipAudio = false;   // true after a manual interrupt, until the model's turn ends
    this.saveChain = Promise.resolve();
    this.startToken = 0;
  }

  setState(state, label) {
    this.state = state;
    voiceOrb.dataset.state = state;
    voiceStatusText.textContent = label || VOICE_STATE_LABELS[state] || "";
  }

  open() {
    voiceOverlay.classList.add("open");
    document.body.style.overflow = "hidden";
    voiceTranscriptEl.textContent = "";
    this.setState("idle");
  }

  close() {
    this.stop();
    voiceOverlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  // ── Start a live session ─────────────────────────────────────────────────
  async start() {
    if (this.state !== "idle" && this.state !== "error") return;
    const myStart = ++this.startToken;
    this.setState("processing");
    voiceTranscriptEl.textContent = "";

    // Create the audio contexts right away, inside the tap, so the browser's
    // autoplay rules count it as a user gesture.
    const AC = window.AudioContext || window.webkitAudioContext;
    this.outCtx = new AC();
    this.micCtx = new AC();
    this.outCtx.resume().catch(() => {});
    this.micCtx.resume().catch(() => {});

    try {
      // 1. Mic first: the token is only valid for ~2 minutes after it's minted.
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        console.error("Mic access failed:", err);
        throw new Error("Microphone access denied. Check your browser/site permissions.");
      }
      if (myStart !== this.startToken) return this._cleanup();

      // 2. One-use token (carries the personality + memory prompt).
      // To audition a voice, run localStorage.nexusVoice = "Puck" in the console, then start a new session.
      let wantedVoice = null;
      try { wantedVoice = localStorage.getItem("nexusVoice"); } catch {}
      const res = await fetch(`${API_URL}/voice/live-token`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ session_id: currentSessionId, voice: wantedVoice }),
      });
      if (res.status === 401) { goToLogin(); throw new Error("Unauthorized"); }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Voice setup failed (${res.status})`);
      }
      const { token, model, voice } = await res.json();
      if (myStart !== this.startToken) return this._cleanup();

      // 3. Connect straight to Gemini Live.
      const { GoogleGenAI } = await loadLiveSdk();
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
      this.userText = "";
      this.modelText = "";
      this.turnDone = false;
      this.skipAudio = false;

      let session = null;
      let closedEarly = null;   // set if the socket dies before we finish wiring up
      session = await ai.live.connect({
        model,
        // The real config is locked into the token; this just has to agree with it.
        config: {
          responseModalities: ["AUDIO"],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
        },
        callbacks: {
          onmessage: (msg) => this._onMessage(msg),
          onerror: (e) => console.error("Live error:", e),
          onclose: (e) => {
            if (this.session !== session) { closedEarly = e || {}; return; } // not live yet, or we closed it ourselves
            console.warn("Live session closed:", e && (e.reason || e.code));
            const reason = e && e.reason ? `: ${e.reason}` : "";
            this.stop();
            voiceTranscriptEl.textContent = `Voice session ended${reason}. Tap to start again.`;
          },
        },
      });
      if (myStart !== this.startToken) { try { session.close(); } catch {} return this._cleanup(); }
      if (closedEarly) {
        throw new Error(`Gemini closed the connection${closedEarly.reason ? ": " + closedEarly.reason : ""}`);
      }
      this.session = session;

      // 4. Mic → 16 kHz PCM → Gemini.
      await this.micCtx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([MIC_WORKLET_SRC], { type: "application/javascript" }))
      );
      const micSource = this.micCtx.createMediaStreamSource(this.stream);
      this.micAnalyser = this.micCtx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      this.workletNode = new AudioWorkletNode(this.micCtx, "pcm16-capture");
      const mute = this.micCtx.createGain();
      mute.gain.value = 0; // keeps the worklet pulled without echoing the mic
      micSource.connect(this.micAnalyser);
      micSource.connect(this.workletNode);
      this.workletNode.connect(mute).connect(this.micCtx.destination);
      this.workletNode.port.onmessage = (e) => {
        if (!this.session) return;
        try {
          this.session.sendRealtimeInput({
            audio: { data: bytesToBase64(new Uint8Array(e.data)), mimeType: "audio/pcm;rate=16000" },
          });
        } catch (err) { /* socket closing */ }
      };

      // 5. Playback chain (for the speaking waveform).
      this.outAnalyser = this.outCtx.createAnalyser();
      this.outAnalyser.fftSize = 512;
      this.outAnalyser.connect(this.outCtx.destination);

      this.setState("listening");
      this._startWaveform();
    } catch (err) {
      console.error("Voice start failed:", err);
      this._cleanup();
      voiceTranscriptEl.textContent = err.message || "Couldn't start voice mode.";
      this.setState("error");
    }
  }

  // ── Incoming messages from Gemini ────────────────────────────────────────
  _onMessage(msg) {
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {            // the user talked over Nexus
      this._flushPlayback();
      this.skipAudio = false;
      this._finishTurn();
      this._setListening();
    }

    const inText = sc.inputTranscription && sc.inputTranscription.text;
    if (inText) {
      if (this.modelText) this._finishTurn(); // Nexus already answered, so this is a new turn
      this.userText += inText;
      if (this.state !== "speaking") voiceTranscriptEl.textContent = this.userText;
    }

    const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
    for (const p of parts) {
      if (p.inlineData && p.inlineData.data) this._enqueueAudio(p.inlineData);
    }

    const outText = sc.outputTranscription && sc.outputTranscription.text;
    if (outText) {
      this.modelText += outText;
      if (this.state === "speaking") voiceTranscriptEl.textContent = this.modelText;
    }

    if (sc.turnComplete) {
      this.turnDone = true;
      this.skipAudio = false;
      this._finishTurn();
      if (this.sources.size === 0) this._setListening();
    }
  }

  _enqueueAudio(inlineData) {
    if (this.skipAudio || !this.outCtx) return;
    if (this.state !== "speaking") {
      this.setState("speaking");
      voiceTranscriptEl.textContent = this.modelText;
    }
    this.turnDone = false;

    const m = /rate=(\d+)/.exec(inlineData.mimeType || "");
    const rate = m ? parseInt(m[1], 10) : 24000;
    const bytes = base64ToBytes(inlineData.data);
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

    const buf = this.outCtx.createBuffer(1, f32.length, rate); // browser resamples to the output rate
    buf.copyToChannel(f32, 0);
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outAnalyser);

    this.nextTime = Math.max(this.nextTime, this.outCtx.currentTime + 0.02);
    src.start(this.nextTime);
    this.nextTime += buf.duration;

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0 && this.turnDone) this._setListening();
    };
  }

  _flushPlayback() {
    this.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch {} });
    this.sources.clear();
    this.nextTime = 0;
  }

  _setListening() {
    if (this.session && this.state !== "listening") {
      this.setState("listening");
      voiceTranscriptEl.textContent = "";
    }
  }

  // ── Turn bookkeeping: show it in the chat log and save it server-side ───
  _finishTurn() {
    const u = this.userText.trim();
    const a = this.modelText.trim();
    this.userText = "";
    this.modelText = "";
    const turns = [];
    if (u) { addMessage(u, "user"); turns.push({ role: "user", content: u }); }
    if (a) { addMessage(a, "bot");  turns.push({ role: "assistant", content: a }); }
    if (turns.length) this._saveTurns(turns);
  }

  _saveTurns(turns) {
    // Chained so turns are saved in order and each one sees the latest session id.
    this.saveChain = this.saveChain.then(async () => {
      try {
        const res = await fetch(`${API_URL}/voice/transcript`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ session_id: currentSessionId, turns }),
        });
        if (res.status === 401) { goToLogin(); return; }
        if (!res.ok) throw new Error(`Save failed: ${res.status}`);
        const data = await res.json();
        if (data.session_id) {
          const isNew = !currentSessionId;
          currentSessionId = data.session_id;
          await loadConversations();
          if (isNew) setActiveInSidebar(currentSessionId);
        }
      } catch (err) {
        console.error("Could not save voice transcript:", err);
      }
    });
  }

  // ── Orb tap ──────────────────────────────────────────────────────────────
  onOrbTap() {
    if (this.state === "idle" || this.state === "error") {
      this.start();
    } else if (this.state === "speaking") {
      // Stop talking now and drop the rest of this answer. (Talking over Nexus does the same.)
      this._flushPlayback();
      this.skipAudio = true;
      this._setListening();
    } else if (this.state === "listening") {
      this.stop();
    }
    // "processing" (connecting): ignore taps
  }

  // ── Waveform ─────────────────────────────────────────────────────────────
  _startWaveform() {
    const data = new Uint8Array(256);
    const tick = () => {
      const analyser = this.state === "speaking" ? this.outAnalyser : this.micAnalyser;
      if (analyser) {
        analyser.getByteTimeDomainData(data);
        this._drawWaveform(data);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.rafId);
    tick();
  }

  _drawWaveform(timeDomainData) {
    const bars = 24;
    const step = Math.floor(timeDomainData.length / bars);
    let path = "";
    for (let i = 0; i < bars; i++) {
      const v = Math.abs(timeDomainData[i * step] - 128) / 128; // 0..1
      const barHeight = 6 + v * 60;
      const x = 8 + i * 6.2;
      const y = 80 - barHeight / 2;
      path += `<rect x="${x}" y="${y}" width="3" height="${barHeight}" rx="1.5" fill="currentColor"/>`;
    }
    voiceWaveformSvg.innerHTML = path;
  }

  // ── Shutdown ─────────────────────────────────────────────────────────────
  stop() {
    this.startToken++;               // cancels any start() still in flight
    this._finishTurn();              // keep whatever was said so far
    const s = this.session;
    this.session = null;             // set first so onclose knows we did this
    if (s) { try { s.close(); } catch {} }
    this._cleanup();
    this.setState("idle");
  }

  _cleanup() {
    this._flushPlayback();
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.workletNode) { this.workletNode.port.onmessage = null; try { this.workletNode.disconnect(); } catch {} }
    this.workletNode = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.micCtx) { this.micCtx.close().catch(() => {}); this.micCtx = null; }
    if (this.outCtx) { this.outCtx.close().catch(() => {}); this.outCtx = null; }
    this.micAnalyser = null;
    this.outAnalyser = null;
    voiceWaveformSvg.innerHTML = "";
  }
}

const voiceMode = new VoiceModeController();

// ── Orb interactions ──────────────────────────────────────────────────────
voiceOrb.addEventListener("click", () => voiceMode.onOrbTap());

// ── Open / close ──────────────────────────────────────────────────────────
micBtn.addEventListener("click", () => voiceMode.open());
voiceBackBtn.addEventListener("click", () => voiceMode.close());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && voiceOverlay.classList.contains("open")) voiceMode.close();
});
window.addEventListener("pagehide", () => voiceMode.stop());

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadConfig();
  const ok = await requireAuth();
  if (!ok) return;
  await loadConversations();
  userInput.focus();
})();
