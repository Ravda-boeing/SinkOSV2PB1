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
// ─── VOICE MODE ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

const micBtn           = document.getElementById("nexus-mic-btn");
const voiceOverlay     = document.getElementById("voice-mode-overlay");
const voiceBackBtn     = document.getElementById("voice-back-btn");
const voiceOrb         = document.getElementById("voice-orb");
const voiceStatusText  = document.getElementById("voice-status-text");
const voiceTranscriptEl = document.getElementById("voice-transcript-text");
const voiceWaveformSvg = document.getElementById("voice-waveform");

const VOICE_STATE_LABELS = {
  idle:       "Tap to speak",
  listening:  "Nexus is listening…",
  processing: "Thinking…",
  speaking:   "Nexus is speaking…",
  error:      "Something went wrong — tap to retry",
};

// Web Speech API TTS by default (no backend/API key needed). Swap the body of
// speak() later if you move to a hosted TTS provider — everything else in
// this controller (state machine, barge-in, UI) stays the same.
const synth = window.speechSynthesis;

class VoiceModeController {
  constructor() {
    this.state = "idle";
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.audioCtx = null;
    this.analyser = null;
    this.rafId = null;
    this.utterance = null;
    this.bargeInArmed = false;
  }

  setState(state) {
    this.state = state;
    voiceOrb.dataset.state = state;
    voiceStatusText.textContent = VOICE_STATE_LABELS[state] || "";
  }

  async open() {
    voiceOverlay.classList.add("open");
    document.body.style.overflow = "hidden";
    voiceTranscriptEl.textContent = "";
    this.setState("idle");
  }

  close() {
    this.teardown();
    voiceOverlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  // ── Mic capture ──────────────────────────────────────────────────────────
  async startListening() {
    if (this.state === "listening") return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.error("Mic access failed:", err);
      voiceTranscriptEl.textContent = "Microphone access denied. Check your browser/site permissions.";
      this.setState("error");
      return;
    }

    this.chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.stream, { mimeType });
    this.recorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.start(250);

    this.setState("listening");
    voiceTranscriptEl.textContent = "";
    this._attachAnalyser(this.stream, {
      onSilence: () => this.finishListening(),
      onNoSpeechTimeout: () => this.cancelListening("Didn't hear anything — tap to try again."),
      silenceMs: 900,
      silenceThreshold: 10,
      speechThreshold: 14,     // must exceed this at least once before the silence timer arms
      noSpeechTimeoutMs: 8000, // give up if the user never starts talking
      maxListenMs: 30000,
    });
  }

  cancelListening(message) {
    this._stopAnalyser();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.recorder && this.recorder.state !== "inactive") {
      try { this.recorder.stop(); } catch { /* already stopped */ }
    }
    voiceTranscriptEl.textContent = message || "";
    this.setState("idle");
  }

  async finishListening() {
    if (this.state !== "listening" || !this.recorder) return;

    const blob = await new Promise((resolve) => {
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.recorder.mimeType || "audio/webm" }));
      };
      this.recorder.stop();
    });
    this._stopAnalyser();
    this.stream?.getTracks().forEach((t) => t.stop());

    if (blob.size < 500) { // essentially silence, nothing worth sending
      this.setState("idle");
      return;
    }

    this.setState("processing");
    try {
      const transcript = await this._transcribe(blob);
      if (!transcript) {
        voiceTranscriptEl.textContent = "Didn't catch that — tap to try again.";
        this.setState("idle");
        return;
      }
      voiceTranscriptEl.textContent = transcript;
      addMessage(transcript, "user"); // keep Voice Mode turns in the same chat log

      const reply = await sendToNexus(transcript);
      addMessage(reply, "bot");
      await this.speak(reply);
    } catch (err) {
      console.error("Voice pipeline error:", err);
      voiceTranscriptEl.textContent = "Something went wrong. Tap to try again.";
      this.setState("error");
    }
  }

  async _transcribe(blob) {
    const form = new FormData();
    form.append("audio", blob, "utterance.webm");

    const res = await fetch(`${API_URL}/voice/stt`, {
      method: "POST",
      headers: authHeaders(), // do NOT set Content-Type manually; browser sets multipart boundary
      body: form,
    });

    if (res.status === 401) { goToLogin(); throw new Error("Unauthorized"); }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `STT failed: ${res.status}`);
    }

    const data = await res.json();
    return (data.transcript || "").trim();
  }

  // ── Speaking / TTS ───────────────────────────────────────────────────────
  async speak(text) {
    if (!text) { this.setState("idle"); return; }

    this.setState("speaking");
    voiceTranscriptEl.textContent = text;

    // Arm barge-in: listen for the user's mic level while Nexus talks, without
    // running STT on it. Any sustained voice activity interrupts playback.
    await this._armBargeIn();

    return new Promise((resolve) => {
      synth.cancel(); // clear any queued utterances
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.0;
      utter.pitch = 1.0;
      this.utterance = utter;

      utter.onend = () => {
        this._disarmBargeIn();
        if (this.state === "speaking") this.setState("idle");
        resolve();
      };
      utter.onerror = () => {
        this._disarmBargeIn();
        this.setState("idle");
        resolve();
      };

      synth.speak(utter);
    });
  }

  async _armBargeIn() {
    try {
      this.bargeInStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.bargeInArmed = true;
      this._attachAnalyser(this.bargeInStream, {
        onVoiceActivity: () => {
          if (this.bargeInArmed && this.state === "speaking") this.interrupt();
        },
        activityThreshold: 22, // higher than silence threshold — only real speech interrupts
      });
    } catch {
      // If mic isn't available for barge-in, just skip it — TTS still plays fine.
      this.bargeInArmed = false;
    }
  }

  _disarmBargeIn() {
    this.bargeInArmed = false;
    this._stopAnalyser();
    this.bargeInStream?.getTracks().forEach((t) => t.stop());
    this.bargeInStream = null;
  }

  interrupt() {
    synth.cancel();
    this._disarmBargeIn();
    this.startListening();
  }

  // ── Shared analyser: drives waveform + silence detection + barge-in ────────
  _attachAnalyser(stream, {
    onSilence,
    onVoiceActivity,
    onNoSpeechTimeout,
    silenceMs = 900,
    silenceThreshold = 10,
    speechThreshold = 14,
    activityThreshold = 22,
    noSpeechTimeoutMs = null,
    maxListenMs = null,
  } = {}) {
    this._stopAnalyser();
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    let silenceStart = null;
    let speechDetected = false;
    const startedAt = performance.now();

    const tick = () => {
      this.analyser.getByteTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length);
      this._drawWaveform(data);

      if (onSilence) {
        // Don't start the "user has gone quiet" countdown until we've actually
        // heard them start talking — otherwise the natural beat of silence
        // right after tapping the mic gets misread as "done speaking" and we
        // ship near-empty audio to the STT model, which then hallucinates.
        if (!speechDetected) {
          if (rms > speechThreshold) {
            speechDetected = true;
            silenceStart = null;
          } else if (onNoSpeechTimeout && noSpeechTimeoutMs && performance.now() - startedAt > noSpeechTimeoutMs) {
            onNoSpeechTimeout();
            return;
          }
        } else {
          if (rms < silenceThreshold) {
            if (silenceStart === null) silenceStart = performance.now();
            else if (performance.now() - silenceStart > silenceMs) { onSilence(); return; }
          } else {
            silenceStart = null;
          }
        }

        if (maxListenMs && performance.now() - startedAt > maxListenMs) {
          if (speechDetected) onSilence();
          else if (onNoSpeechTimeout) onNoSpeechTimeout();
          return;
        }
      }

      if (onVoiceActivity && rms > activityThreshold) {
        onVoiceActivity();
      }

      this.rafId = requestAnimationFrame(tick);
    };
    tick();
  }

  _stopAnalyser() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}); this.audioCtx = null; }
    this.analyser = null;
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

  teardown() {
    synth.cancel();
    this._stopAnalyser();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.bargeInStream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.bargeInStream = null;
    if (this.recorder && this.recorder.state !== "inactive") {
      try { this.recorder.stop(); } catch { /* already stopped */ }
    }
    this.setState("idle");
  }
}

const voiceMode = new VoiceModeController();

// ── Orb interactions ──────────────────────────────────────────────────────
voiceOrb.addEventListener("click", () => {
  if (voiceMode.state === "idle" || voiceMode.state === "error") {
    voiceMode.startListening();
  } else if (voiceMode.state === "listening") {
    voiceMode.finishListening();
  } else if (voiceMode.state === "speaking") {
    voiceMode.interrupt();
  }
  // "processing" state: ignore taps, nothing to do mid-flight
});

// ── Open / close ──────────────────────────────────────────────────────────
micBtn.addEventListener("click", () => voiceMode.open());
voiceBackBtn.addEventListener("click", () => voiceMode.close());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && voiceOverlay.classList.contains("open")) voiceMode.close();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
  await loadConfig();
  const ok = await requireAuth();
  if (!ok) return;
  await loadConversations();
  userInput.focus();
})();
