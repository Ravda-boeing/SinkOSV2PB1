/**
 * Core — SinkOS file system browser
 *
 * Includes integrated file sharing system (WebRTC peer-to-peer with recipient approval)
 *
 * Original Core functionality:
 * - File explorer with folder navigation
 * - Auth gate (sign in + OS password unlock)
 * - File/folder management (create, delete)
 *
 * Added File Sharing:
 * - 6-digit code-based discovery
 * - Recipient approval consent step
 * - WebRTC peer-to-peer transfer
 * - Chunked file protocol
 */

// ============================================================
// SUPABASE SETUP
// ============================================================

const SUPABASE_URL = "https://okknkixdbjsnqrwlfgzn.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ra25raXhkYmpzbnFyd2xmZ3puIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1NzgwNzQsImV4cCI6MjA5ODE1NDA3NH0.L2QDUnez8KjIM8yg9cB9cs-tTq6nedk3CCpuJBjWBEg";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const SINKOS_AUTH_BASE = "https://ravda-boeing.github.io/SinkOSAuth";

// ============================================================
// FILE SHARING CLASSES (Peer, FileSender, FileReceiver, ShareOrchestratorV2, ShareUI)
// ============================================================

class Peer {
  constructor(config) {
    this.config = config;
    this.pc = new RTCPeerConnection({
      iceServers: config.iceServers || [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      ],
    });
    this.channel = null;
    this.isChannelReady = false;
    this.pendingIceCandidates = [];
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.pc.addEventListener("icecandidate", (e) => {
      if (e.candidate && this.config.onIceCandidate) {
        this.config.onIceCandidate(e.candidate).catch((err) =>
          this.error("Failed to send ICE candidate", err)
        );
      }
    });

    this.pc.addEventListener("connectionstatechange", () => {
      this.config.onConnectionStateChange?.(this.pc.connectionState);
      if (this.pc.connectionState === "failed") {
        this.error(new Error("Peer connection failed"));
      }
    });

    if (this.config.role === "sender") {
      this.channel = this.pc.createDataChannel("file-transfer", { ordered: true });
      this.setupChannelHandlers();
    } else {
      this.pc.addEventListener("datachannel", (e) => {
        this.channel = e.channel;
        this.setupChannelHandlers();
      });
    }
  }

  setupChannelHandlers() {
    if (!this.channel) return;
    this.channel.addEventListener("open", () => {
      this.isChannelReady = true;
      this.config.onChannelOpen?.(this.channel);
    });
    this.channel.addEventListener("close", () => {
      this.isChannelReady = false;
      this.config.onChannelClose?.();
    });
    this.channel.addEventListener("error", (e) => {
      this.error(new Error("Data channel error: " + (e?.error || "unknown")));
    });
  }

  async createOffer() {
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      return JSON.stringify(offer);
    } catch (err) {
      throw new Error("Failed to create offer: " + err.message);
    }
  }

  async acceptOffer(offerSdp) {
    try {
      const offer = JSON.parse(offerSdp);
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await this.flushPendingIceCandidates();
      return JSON.stringify(answer);
    } catch (err) {
      throw new Error("Failed to accept offer: " + err.message);
    }
  }

  async setAnswer(answerSdp) {
    try {
      const answer = JSON.parse(answerSdp);
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.flushPendingIceCandidates();
    } catch (err) {
      throw new Error("Failed to set answer: " + err.message);
    }
  }

  async addIceCandidate(candidateJson) {
    try {
      const candidateData = JSON.parse(candidateJson);
      const candidate = new RTCIceCandidate(candidateData);
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        await this.pc.addIceCandidate(candidate);
      } else {
        this.pendingIceCandidates.push(candidate);
      }
    } catch (err) {
      console.warn("Failed to add ICE candidate:", err);
    }
  }

  async flushPendingIceCandidates() {
    while (this.pendingIceCandidates.length > 0) {
      const candidate = this.pendingIceCandidates.shift();
      if (candidate) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn("Failed to add pending ICE candidate:", err);
        }
      }
    }
  }

  send(data) {
    if (!this.isChannelReady || !this.channel) {
      throw new Error("Data channel not ready");
    }
    const MAX_CHUNK = 16 * 1024;
    if (typeof data === "string") {
      data = new TextEncoder().encode(data).buffer;
    }
    const buffer = data;
    if (buffer.byteLength <= MAX_CHUNK) {
      this.channel.send(buffer);
      return;
    }
    for (let i = 0; i < buffer.byteLength; i += MAX_CHUNK) {
      const chunk = buffer.slice(i, Math.min(i + MAX_CHUNK, buffer.byteLength));
      this.channel.send(chunk);
    }
  }

  isReady() {
    return this.isChannelReady;
  }

  close() {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.pc.close();
  }

  onMessage(callback) {
    if (!this.channel) {
      throw new Error("Data channel not initialized");
    }
    const handler = (e) => {
      callback(e.data);
    };
    this.channel.addEventListener("message", handler);
    return () => {
      if (this.channel) {
        this.channel.removeEventListener("message", handler);
      }
    };
  }

  error(message, err) {
    const error = new Error(message + (err ? ": " + err.message : ""));
    this.config.onError?.(error);
  }
}

const CHUNK_SIZE = 64 * 1024;
const PROTOCOL_VERSION = 1;

class FileSender {
  constructor(peer, onEvent) {
    this.peer = peer;
    this.onEvent = onEvent;
    this.currentFile = null;
    this.currentChunkIndex = 0;
  }

  async sendFile(file) {
    if (!this.peer.isReady()) {
      throw new Error("Peer connection not ready");
    }

    this.currentFile = file;
    this.currentChunkIndex = 0;

    const fileInfo = {
      name: file.name,
      size: file.size,
      mime: file.type,
      lastModified: file.lastModified,
    };

    const infoMsg = {
      type: "file-info",
      version: PROTOCOL_VERSION,
      fileInfo,
    };
    this.peer.send(JSON.stringify(infoMsg));

    this.onEvent({ type: "started", file: fileInfo });

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const unsubscribe = this.peer.onMessage(async (data) => {
      if (typeof data === "string") {
        try {
          const msg = JSON.parse(data);
          if (msg.type === "ack") {
            this.currentChunkIndex = msg.chunkIndex + 1;
            await this.sendNextChunk(totalChunks);
          }
        } catch (err) {
          // ignore
        }
      }
    });

    await this.sendNextChunk(totalChunks);

    return new Promise((resolve, reject) => {
      const checkComplete = setInterval(() => {
        if (this.currentFile === null || this.currentChunkIndex >= totalChunks) {
          clearInterval(checkComplete);
          unsubscribe();
          this.onEvent({ type: "completed", file });
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkComplete);
        unsubscribe();
        reject(new Error("File transfer timeout"));
      }, 5 * 60 * 1000);
    });
  }

  async sendNextChunk(totalChunks) {
    if (!this.currentFile) return;
    if (this.currentChunkIndex >= totalChunks) return;

    const start = this.currentChunkIndex * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, this.currentFile.size);
    const blob = this.currentFile.slice(start, end);
    const arrayBuffer = await blob.arrayBuffer();

    this.sendChunkMessage({
      chunkIndex: this.currentChunkIndex,
      totalChunks,
      data: arrayBuffer,
    });

    this.onEvent({
      type: "progress",
      progress: {
        sentBytes: end,
        totalBytes: this.currentFile.size,
        percentComplete: Math.round((end / this.currentFile.size) * 100),
      },
    });
  }

  sendChunkMessage(msg) {
    const typeCode = 1;
    const headerSize = 14;
    const totalSize = headerSize + msg.data.byteLength;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    let offset = 0;

    view.setUint8(offset, typeCode);
    offset += 1;
    view.setUint8(offset, msg.version || PROTOCOL_VERSION);
    offset += 1;
    view.setUint32(offset, msg.chunkIndex, true);
    offset += 4;
    view.setUint32(offset, msg.totalChunks, true);
    offset += 4;
    view.setUint32(offset, msg.data.byteLength, true);
    offset += 4;

    const srcView = new Uint8Array(msg.data);
    const dstView = new Uint8Array(buffer, offset);
    dstView.set(srcView);

    this.peer.send(buffer);
  }
}

class FileReceiver {
  constructor(peer, onEvent) {
    this.peer = peer;
    this.onEvent = onEvent;
    this.fileInfo = null;
    this.chunks = new Map();
    this.totalChunks = 0;
    this.unsubscribe = null;
  }

  start() {
    this.unsubscribe = this.peer.onMessage((data) => {
      if (typeof data === "string") {
        this.handleTextMessage(data);
      } else {
        this.handleBinaryMessage(data);
      }
    });
  }

  stop() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  handleTextMessage(text) {
    try {
      const msg = JSON.parse(text);
      if (msg.type === "file-info") {
        this.fileInfo = msg.fileInfo;
        this.chunks.clear();
        this.totalChunks = 0;
        this.onEvent({ type: "started", file: this.fileInfo });
      }
    } catch (err) {
      console.warn("Failed to parse message:", text);
    }
  }

  handleBinaryMessage(buffer) {
    try {
      const view = new DataView(buffer);
      const typeCode = view.getUint8(0);

      if (typeCode !== 1) return;

      const version = view.getUint8(1);
      if (version !== PROTOCOL_VERSION) {
        throw new Error(`Protocol version mismatch: got ${version}, expected ${PROTOCOL_VERSION}`);
      }

      const chunkIndex = view.getUint32(2, true);
      const totalChunks = view.getUint32(6, true);
      const dataLength = view.getUint32(10, true);

      const headerSize = 14;
      if (buffer.byteLength < headerSize + dataLength) {
        throw new Error("Truncated chunk message");
      }

      const chunkData = buffer.slice(headerSize, headerSize + dataLength);
      this.chunks.set(chunkIndex, new Uint8Array(chunkData));
      this.totalChunks = totalChunks;

      const ackMsg = { type: "ack", version: PROTOCOL_VERSION, chunkIndex };
      this.peer.send(JSON.stringify(ackMsg));

      if (this.chunks.size === totalChunks) {
        this.completeTransfer();
      } else {
        const receivedBytes = Array.from(this.chunks.values()).reduce(
          (sum, chunk) => sum + chunk.byteLength,
          0
        );
        this.onEvent({
          type: "progress",
          progress: {
            sentBytes: receivedBytes,
            totalBytes: this.fileInfo?.size || 0,
            percentComplete: Math.round(
              (receivedBytes / (this.fileInfo?.size || 1)) * 100
            ),
          },
        });
      }
    } catch (err) {
      this.onEvent({ type: "error", error: err });
    }
  }

  completeTransfer() {
    if (!this.fileInfo) {
      throw new Error("No file info received");
    }

    const uint8Arrays = [];
    for (let i = 0; i < this.totalChunks; i++) {
      const chunk = this.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }
      uint8Arrays.push(chunk);
    }

    const blob = new Blob(uint8Arrays, { type: this.fileInfo.mime });
    const file = new File([blob], this.fileInfo.name, {
      type: this.fileInfo.mime,
      lastModified: this.fileInfo.lastModified,
    });

    this.onEvent({ type: "completed", file });

    this.chunks.clear();
    this.fileInfo = null;
  }
}

class ShareOrchestratorV2 {
  constructor(config) {
    this.config = config;
    this.sessionId = null;
    this.peer = null;
    this.fileSender = null;
    this.fileReceiver = null;
    this.recipientId = null;
    this.sessionChannel = null;
    this.matchedResolver = null;
    this.senderInfo = null;
    this.fileInfo = null;
  }

  async initiateCodeShare(file) {
    try {
      this.fileInfo = {
        name: file.name,
        size: file.size,
        mime: file.type,
      };

      const response = await this.config.supabase.functions.invoke("create-share-code", {
        body: {
          file_name: file.name,
          file_size: file.size,
          file_mime: file.type,
        },
      });

      if (response.error) {
        throw new Error("Failed to create share code: " + response.error.message);
      }

      const { session_id, code, expires_at } = response.data;
      this.sessionId = session_id;

      this.config.onEvent({
        type: "code-generated",
        code,
        expiresAt: expires_at,
      });

      this.config.onEvent({ type: "waiting-for-recipient" });
      this.setupSessionListener(session_id);

      return { sessionId: session_id, code, expiresAt: expires_at };
    } catch (err) {
      throw new Error("Failed to initiate code share: " + (err?.message || String(err)));
    }
  }

  async claimCodeShare(code) {
    try {
      const response = await this.config.supabase.functions.invoke("claim-share-code", {
        body: { code },
      });

      if (response.error) {
        throw new Error("Failed to claim code: " + response.error.message);
      }

      const { session_id } = response.data;
      this.sessionId = session_id;

      const { data: session, error: fetchError } = await this.config.supabase
        .from("share_sessions")
        .select("sender_id, file_name, file_size, file_mime")
        .eq("id", session_id)
        .single();

      if (fetchError) {
        throw fetchError;
      }

      const { data: senderProfile, error: profileError } = await this.config.supabase
        .from("profiles")
        .select("username, id")
        .eq("id", session.sender_id)
        .single();

      if (profileError) {
        throw profileError;
      }

      this.senderInfo = senderProfile;
      this.fileInfo = {
        name: session.file_name,
        size: session.file_size,
        mime: session.file_mime,
      };

      this.config.onEvent({
        type: "approval-needed",
        senderName: senderProfile.username,
        fileName: session.file_name,
        fileSize: session.file_size,
      });

      this.setupSessionListener(session_id);
      await this.setupAsReceiver(session_id);
    } catch (err) {
      throw new Error("Failed to claim share: " + (err?.message || String(err)));
    }
  }

  async respondToApproval(action, reason = null) {
    if (!this.sessionId) {
      throw new Error("No session active");
    }

    try {
      const response = await this.config.supabase.functions.invoke(
        "share-approval-response",
        {
          body: {
            session_id: this.sessionId,
            action,
            reason,
          },
        }
      );

      if (response.error) {
        throw new Error("Failed to respond to approval: " + response.error.message);
      }

      if (action === "accepted") {
        this.config.onEvent({
          type: "approval-granted",
        });
      } else {
        this.config.onEvent({
          type: "approval-denied",
          reason,
        });
      }

      return response.data;
    } catch (err) {
      throw new Error("Approval response failed: " + (err?.message || String(err)));
    }
  }

  async waitForMatch() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Match timeout (5 minutes)"));
      }, 5 * 60 * 1000);

      this.matchedResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
  }

  async sendFile(file) {
    if (!this.peer) {
      throw new Error("No peer connection established");
    }

    if (!this.fileSender) {
      this.fileSender = new FileSender(this.peer, (event) => {
        this.config.onEvent(event);
      });
    }

    await this.fileSender.sendFile(file);
  }

  close() {
    if (this.fileReceiver) {
      this.fileReceiver.stop();
      this.fileReceiver = null;
    }

    if (this.peer) {
      this.peer.close();
      this.peer = null;
    }

    if (this.sessionChannel) {
      this.config.supabase.removeChannel(this.sessionChannel);
      this.sessionChannel = null;
    }
  }

  setupSessionListener(sessionId) {
    this.sessionChannel = this.config.supabase.channel("share-session-" + sessionId);

    this.sessionChannel
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "share_sessions",
          filter: `id=eq.${sessionId}`,
        },
        (payload) => {
          this.handleSessionUpdate(payload.new);
        }
      )
      .subscribe();
  }

  handleSessionUpdate(session) {
    if (session.status === "matched" && !this.peer && session.sender_id === this.config.userId) {
      this.setupAsSender(session.id, session.recipient_id).catch((err) => {
        this.config.onEvent({
          type: "connection-failed",
          error: err.message,
        });
      });
    }

    if (session.status === "connected") {
      if (this.matchedResolver) {
        this.matchedResolver();
        this.matchedResolver = null;
      }
    }

    if (session.status === "declined") {
      this.config.onEvent({
        type: "share-declined",
      });
      this.close();
    }
  }

  async setupAsSender(sessionId, recipientId) {
    this.recipientId = recipientId;

    this.peer = new Peer({
      sessionId,
      userId: this.config.userId,
      otherUserId: recipientId,
      role: "sender",
      onIceCandidate: async (candidate) => {
        await this.config.supabase.functions.invoke("share-write-ice", {
          body: { session_id: sessionId, candidate: candidate.toJSON() },
        });
      },
      onConnectionStateChange: (state) => {
        if (state === "connected") {
          this.config.onEvent({
            type: "connection-established",
            peerId: recipientId,
          });
        }
      },
      onError: (err) => {
        this.config.onEvent({
          type: "connection-failed",
          error: err.message,
        });
      },
    });

    const offerSdp = await this.peer.createOffer();
    await this.config.supabase.functions.invoke("share-write-offer", {
      body: { session_id: sessionId, offer_sdp: offerSdp },
    });

    this.listenForAnswerAndIce(sessionId);
  }

  async setupAsReceiver(sessionId) {
    const { data: session } = await this.config.supabase
      .from("share_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();

    if (!session) {
      throw new Error("Session not found");
    }

    this.recipientId = session.sender_id;

    this.peer = new Peer({
      sessionId,
      userId: this.config.userId,
      otherUserId: session.sender_id,
      role: "receiver",
      onIceCandidate: async (candidate) => {
        await this.config.supabase.functions.invoke("share-write-ice", {
          body: { session_id: sessionId, candidate: candidate.toJSON() },
        });
      },
      onConnectionStateChange: (state) => {
        if (state === "connected") {
          this.config.onEvent({
            type: "connection-established",
            peerId: session.sender_id,
          });
        }
      },
      onChannelOpen: () => {
        if (!this.fileReceiver) {
          this.fileReceiver = new FileReceiver(this.peer, (event) => {
            this.config.onEvent(event);
          });
          this.fileReceiver.start();
        }
      },
      onError: (err) => {
        this.config.onEvent({
          type: "connection-failed",
          error: err.message,
        });
      },
    });

    this.listenForOfferAndIce(sessionId);
  }

  listenForOfferAndIce(sessionId) {
    const channel = this.config.supabase.channel("share-signals-receiver-" + sessionId);

    channel
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "share_sessions",
          filter: `id=eq.${sessionId}`,
        },
        async (payload) => {
          const session = payload.new;

          if (session.offer_sdp && this.peer && !this.peer.isReady()) {
            try {
              const answerSdp = await this.peer.acceptOffer(session.offer_sdp);
              await this.config.supabase.functions.invoke("share-write-answer", {
                body: { session_id: sessionId, answer_sdp: answerSdp },
              });
            } catch (err) {
              console.error("Failed to accept offer:", err);
            }
          }

          if (session.ice_candidates_sender) {
            for (const candidate of session.ice_candidates_sender) {
              if (this.peer) {
                await this.peer.addIceCandidate(JSON.stringify(candidate));
              }
            }
          }
        }
      )
      .subscribe();
  }

  listenForAnswerAndIce(sessionId) {
    const channel = this.config.supabase.channel("share-signals-sender-" + sessionId);

    channel
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "share_sessions",
          filter: `id=eq.${sessionId}`,
        },
        async (payload) => {
          const session = payload.new;

          if (session.answer_sdp && this.peer) {
            try {
              await this.peer.setAnswer(session.answer_sdp);
            } catch (err) {
              console.error("Failed to set answer:", err);
            }
          }

          if (session.ice_candidates_recipient) {
            for (const candidate of session.ice_candidates_recipient) {
              if (this.peer) {
                await this.peer.addIceCandidate(JSON.stringify(candidate));
              }
            }
          }
        }
      )
      .subscribe();
  }
}

class ShareUI {
  constructor() {
    this.shareCodeModal = null;
    this.progressModal = null;
    this.approvalModal = null;
    this.injectStyles();
  }

  injectStyles() {
    if (document.getElementById("share-ui-styles")) return;
    const style = document.createElement("style");
    style.id = "share-ui-styles";
    style.textContent = `
      .share-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        animation: share-fade-in 0.2s ease-out;
      }

      @keyframes share-fade-in {
        from {
          opacity: 0;
          transform: scale(0.95);
        }
        to {
          opacity: 1;
          transform: scale(1);
        }
      }

      .share-modal {
        background: var(--stone, #131a2c);
        border: 1px solid var(--border, rgba(143, 180, 255, 0.14));
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
        max-width: 400px;
        width: 90%;
        overflow: hidden;
      }

      .share-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 22px;
        border-bottom: 1px solid var(--border, rgba(143, 180, 255, 0.14));
      }

      .share-title {
        font-size: 15px;
        font-weight: 600;
        color: #dce6ff;
      }

      .share-close {
        background: none;
        border: none;
        color: #6e7ba6;
        font-size: 18px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.2s;
      }

      .share-close:hover {
        color: #dce6ff;
      }

      .share-body {
        padding: 22px;
      }

      .share-label {
        font-size: 10.5px;
        color: #6e7ba6;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-weight: 600;
        margin-bottom: 8px;
      }

      .share-code-display {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(143, 180, 255, 0.14);
        border-radius: 8px;
        padding: 12px 14px;
        font-family: "IBM Plex Mono", monospace;
        font-size: 16px;
        font-weight: 600;
        color: #a9c1ff;
        text-align: center;
        letter-spacing: 2px;
        margin-bottom: 10px;
        user-select: all;
      }

      .share-btn {
        background: linear-gradient(160deg, #4f7feb, #9b7cf5);
        border: none;
        color: #fff;
        font-weight: 600;
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 12px;
        font-family: "IBM Plex Sans", sans-serif;
        cursor: pointer;
        transition: filter 0.2s;
        width: 100%;
      }

      .share-btn:hover {
        filter: brightness(1.08);
      }

      .share-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .share-progress-bar {
        width: 100%;
        height: 6px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
        overflow: hidden;
      }

      .share-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #4f7feb, #9b7cf5);
        transition: width 0.3s ease;
      }

      .share-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: var(--stone, #131a2c);
        border: 1px solid var(--border, rgba(143, 180, 255, 0.14));
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 13px;
        color: #dce6ff;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        z-index: 9999;
        animation: share-slide-up 0.3s ease-out;
        transition: opacity 0.3s ease;
      }

      .share-toast-success {
        border-color: #4ade80;
        color: #4ade80;
      }

      .share-toast-error {
        border-color: #ff6b6b;
        color: #ff6b6b;
      }

      @keyframes share-slide-up {
        from {
          transform: translateY(20px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }

  showShareCodeModal(code, onClose) {
    const html = `
      <div class="share-overlay" id="share-code-overlay">
        <div class="share-modal">
          <div class="share-header">
            <div class="share-title">Share File</div>
            <button class="share-close" id="share-close-btn">✕</button>
          </div>
          <div class="share-body">
            <div class="share-label">Share Code</div>
            <div class="share-code-display" id="share-code-text">${code}</div>
            <button class="share-btn" id="share-code-copy-btn">Copy Code</button>
            <div id="share-copy-status" style="font-size:11px;color:#4ade80;margin-top:6px;display:none;">✓ Copied!</div>
            <div id="share-waiting-status" style="margin-top:12px;text-align:center;">
              <div style="font-size:12px;color:#6e7ba6;">Waiting for recipient...</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);

    const overlay = document.getElementById("share-code-overlay");
    const closeBtn = document.getElementById("share-close-btn");
    const copyBtn = document.getElementById("share-code-copy-btn");
    const copyStatus = document.getElementById("share-copy-status");

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(code).then(() => {
        copyStatus.style.display = "block";
        setTimeout(() => (copyStatus.style.display = "none"), 2000);
      });
    });

    closeBtn.addEventListener("click", () => {
      overlay.remove();
      onClose?.();
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.remove();
        onClose?.();
      }
    });

    return overlay;
  }

  showApprovalModal(senderName, fileName, fileSize, onApprove, onDecline) {
    const html = `
      <div class="share-overlay" id="share-approval-overlay">
        <div class="share-modal">
          <div class="share-header">
            <div class="share-title">Incoming File</div>
          </div>
          <div class="share-body">
            <div style="text-align:center;margin-bottom:16px;">
              <div style="font-size:13px;color:#dce6ff;">
                <strong>@${(senderName || "User").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</strong> wants to share
              </div>
              <div style="font-size:14px;font-weight:600;color:#dce6ff;margin-top:8px;">
                ${(fileName || "File").replace(/</g, "&lt;").replace(/>/g, "&gt;")}
              </div>
              <div style="font-size:11px;color:#6e7ba6;margin-top:4px;">
                ${this.formatBytes(fileSize || 0)}
              </div>
            </div>
            <div class="share-actions">
              <button class="share-btn" id="share-approve-btn" style="background:#4ade80;">Accept</button>
              <button class="share-btn" id="share-decline-btn" style="background:#1a2338;border:1px solid rgba(143,180,255,0.14);color:#6e7ba6;">Decline</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);

    const overlay = document.getElementById("share-approval-overlay");
    const approveBtn = document.getElementById("share-approve-btn");
    const declineBtn = document.getElementById("share-decline-btn");

    const cleanup = () => {
      overlay.remove();
    };

    approveBtn.addEventListener("click", () => {
      cleanup();
      onApprove?.();
    });

    declineBtn.addEventListener("click", () => {
      cleanup();
      onDecline?.();
    });

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        onDecline?.();
      }
    });

    return overlay;
  }

  showProgressModal(fileName, isReceiving, onCancel) {
    const html = `
      <div class="share-overlay" id="share-progress-overlay">
        <div class="share-modal">
          <div class="share-header">
            <div class="share-title">${isReceiving ? "Receiving" : "Sending"}</div>
          </div>
          <div class="share-body">
            <div style="margin-bottom:12px;">
              <div style="font-size:12px;color:#6e7ba6;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">File</div>
              <div style="font-size:13px;color:#dce6ff;word-break:break-word;">${(fileName || "File").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
            </div>
            <div style="margin-bottom:12px;">
              <div style="font-size:11px;color:#6e7ba6;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Progress</div>
              <div class="share-progress-bar">
                <div class="share-progress-fill" id="share-progress-fill" style="width:0%"></div>
              </div>
              <div style="font-size:11px;color:#6e7ba6;margin-top:4px;">
                <span id="share-progress-text">0%</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);

    const overlay = document.getElementById("share-progress-overlay");

    const updateProgress = (percent) => {
      const fill = document.getElementById("share-progress-fill");
      const text = document.getElementById("share-progress-text");
      if (fill && text) {
        fill.style.width = percent + "%";
        text.textContent = percent + "%";
      }
    };

    const close = () => {
      overlay.remove();
    };

    return { overlay, updateProgress, close };
  }

  showToast(message, type = "info", duration = 3000) {
    const typeClass = type === "error" ? "share-toast-error" : type === "success" ? "share-toast-success" : "";
    const html = `
      <div class="share-toast ${typeClass}">
        ${(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}
      </div>
    `;
    document.body.insertAdjacentHTML("beforeend", html);

    const toast = document.body.lastElementChild;
    setTimeout(() => {
      toast.style.opacity = "0";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
}

// ============================================================
// SHARE INTEGRATION FUNCTIONS
// ============================================================

let shareUI = null;
let shareOrch = null;
let activeShareProgress = null;
let currentUser = null;
let currentFolderId = null;

function initShare() {
  shareUI = new ShareUI();
  console.log("✓ File sharing initialized");
}

async function shareFileFromCore(file) {
  if (!file || file.type === "folder") {
    shareUI.showToast("Can only share files, not folders");
    return;
  }

  try {
    shareOrch = new ShareOrchestratorV2({
      supabase: sb,
      userId: currentUser.id,
      onEvent: (event) => handleShareEvent(event, file),
    });

    const { code, expiresAt } = await shareOrch.initiateCodeShare(file);

    shareUI.showShareCodeModal(code, () => {
      shareOrch.close();
      shareUI.showToast("Share cancelled");
    });

    shareUI.showToast("Share code generated! Waiting for recipient...");

    await shareOrch.waitForMatch();

    const progress = shareUI.showProgressModal(file.name, false, () => {
      shareOrch.close();
    });

    activeShareProgress = progress;

    await shareOrch.sendFile(file);

    progress.close();
    shareUI.showToast(`✓ File sent: ${file.name}`, "success");
  } catch (error) {
    console.error("Share error:", error);
    shareUI.showToast("✗ Share failed: " + error.message, "error");
    shareOrch?.close();
  } finally {
    activeShareProgress = null;
  }
}

async function claimShareCode(code) {
  try {
    shareOrch = new ShareOrchestratorV2({
      supabase: sb,
      userId: currentUser.id,
      onEvent: (event) => handleShareEventReceiver(event),
    });

    await shareOrch.claimCodeShare(code);
  } catch (error) {
    console.error("Claim error:", error);
    shareUI.showToast("✗ Failed to claim code: " + error.message, "error");
    shareOrch?.close();
  }
}

async function respondToShareApproval(action, reason = null) {
  if (!shareOrch) {
    console.error("No active share session");
    return;
  }

  try {
    await shareOrch.respondToApproval(action, reason);

    if (action === "accepted") {
      shareUI.showToast("Connecting to sender...");
    } else {
      shareUI.showToast("Share declined");
      shareOrch.close();
    }
  } catch (error) {
    console.error("Approval error:", error);
    shareUI.showToast("✗ Approval failed: " + error.message, "error");
  }
}

function handleShareEvent(event, originalFile) {
  if (event.type === "code-generated") {
    // Code shown in modal already
  } else if (event.type === "waiting-for-recipient") {
    // Already shown in modal
  } else if (event.type === "connection-established") {
    // Connected
  } else if (event.type === "progress") {
    if (activeShareProgress) {
      activeShareProgress.updateProgress(event.progress.percentComplete);
    }
  } else if (event.type === "completed") {
    shareUI.showToast("✓ File transfer complete!", "success");
  } else if (event.type === "error") {
    shareUI.showToast("✗ Transfer error: " + event.error, "error");
  } else if (event.type === "connection-failed") {
    shareUI.showToast("✗ Connection failed: " + event.error, "error");
  }
}

function handleShareEventReceiver(event) {
  if (event.type === "approval-needed") {
    shareUI.showApprovalModal(
      event.senderName,
      event.fileName,
      event.fileSize,
      () => respondToShareApproval("accepted"),
      () => respondToShareApproval("declined", "User declined")
    );
  } else if (event.type === "approval-granted") {
    // Transfer starting
  } else if (event.type === "approval-denied") {
    shareUI.showToast("✗ File share was declined");
    shareOrch?.close();
  } else if (event.type === "connection-established") {
    shareUI.showToast("✓ Connected to sender...");
  } else if (event.type === "started") {
    const progress = shareUI.showProgressModal(
      event.file.name,
      true,
      () => {
        shareOrch.close();
      }
    );
    activeShareProgress = progress;
  } else if (event.type === "progress") {
    if (activeShareProgress) {
      activeShareProgress.updateProgress(event.progress.percentComplete);
    }
  } else if (event.type === "completed") {
    if (activeShareProgress) {
      activeShareProgress.close();
    }
    saveReceivedFile(event.file);
    shareUI.showToast(`✓ File received: ${event.file.name}`, "success");
    shareOrch?.close();
  } else if (event.type === "error") {
    shareUI.showToast(
      "✗ Receive error: " + (event.error?.message || String(event.error)),
      "error"
    );
    shareOrch?.close();
  } else if (event.type === "connection-failed") {
    shareUI.showToast("✗ Connection failed: " + event.error, "error");
  } else if (event.type === "share-declined") {
    shareUI.showToast("✗ Share was declined");
    shareOrch?.close();
  }
}

async function saveReceivedFile(file) {
  if (!currentFolderId) {
    console.error("No current folder");
    shareUI.showToast("✗ Cannot save: no folder selected", "error");
    return;
  }

  try {
    const timestamp = Date.now();
    const storagePath = `files/${currentUser.id}/${timestamp}_${file.name}`;

    const { error: uploadError } = await sb.storage.from("file-uploads").upload(storagePath, file);

    if (uploadError) {
      throw uploadError;
    }

    const { error: insertError } = await sb.from("nodes").insert({
      parent_id: currentFolderId,
      name: file.name,
      type: "file",
      storage_bucket: "file-uploads",
      storage_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
    });

    if (insertError) {
      throw insertError;
    }

    await refresh();
  } catch (error) {
    console.error("Failed to save received file:", error);
    shareUI.showToast("✗ Failed to save file: " + error.message, "error");
    throw error;
  }
}

function showReceiveShareModal() {
  const html = `
    <div class="share-overlay" id="receive-share-overlay">
      <div class="share-modal">
        <div class="share-header">
          <div class="share-title">Receive File</div>
          <button class="share-close" id="receive-share-close">✕</button>
        </div>
        <div class="share-body">
          <div class="share-label">Enter Share Code</div>
          <input type="text" id="receive-share-code" placeholder="6-digit code" maxlength="6" 
                 style="width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(143,180,255,0.14);border-radius:8px;color:#dce6ff;font-family:monospace;font-size:16px;text-align:center;letter-spacing:2px;margin-bottom:12px;" />
          <button class="share-btn" id="receive-share-btn">Receive</button>
          <div id="receive-share-error" style="font-size:11px;color:#ff6b6b;margin-top:8px;display:none;"></div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML("beforeend", html);

  const overlay = document.getElementById("receive-share-overlay");
  const closeBtn = document.getElementById("receive-share-close");
  const codeInput = document.getElementById("receive-share-code");
  const receiveBtn = document.getElementById("receive-share-btn");
  const errorDiv = document.getElementById("receive-share-error");

  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  receiveBtn.addEventListener("click", async () => {
    const code = codeInput.value.trim();
    if (!code || code.length !== 6) {
      errorDiv.textContent = "Enter a 6-digit code";
      errorDiv.style.display = "block";
      return;
    }

    receiveBtn.disabled = true;
    try {
      overlay.remove();
      await claimShareCode(code);
    } catch (error) {
      errorDiv.textContent = error.message;
      errorDiv.style.display = "block";
      receiveBtn.disabled = false;
    }
  });

  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") receiveBtn.click();
  });

  codeInput.focus();
}

// ============================================================
// CORE APP (Original code)
// ============================================================

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

let currentPath = [];
let currentView = "grid";
let showHidden = false;

function currentParentId() {
  return currentPath.length === 0 ? null : currentPath[currentPath.length - 1].id;
}

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
  const { error } = await sb.from("nodes").insert({ name, parent_id: parentId, type: "folder" });
  if (error) throw error;
}

async function deleteNode(id) {
  const { error } = await sb.from("nodes").delete().eq("id", id);
  if (error) throw error;
}

async function getSignedUrl(bucket, path) {
  const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, 60);
  if (error) throw error;
  return data.signedUrl;
}

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
        <div>${ICONS.empty}</div>
        <h2 class="core-empty-title">Empty</h2>
        <p class="core-empty-sub">Nothing here yet</p>
      </div>`;
    return;
  }

  for (const item of items) {
    const cat = getCategory(item);
    const isWellKnown = !!item.well_known;
    const isSynced = !!item.source_table;

    const card = document.createElement("div");
    card.className = `core-card core-cat-${cat}`;
    card.tabIndex = 0;
    card.setAttribute("data-file-id", item.id);
    card.setAttribute("data-file-name", item.name);
    card.setAttribute("data-file-type", item.type);
    card.setAttribute("data-file-size", item.size_bytes || 0);

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
        currentFolderId = item.id;
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

      // Add right-click context menu for files
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();

        const menu = document.createElement("div");
        menu.style.cssText = `
          position: fixed;
          top: ${e.clientY}px;
          left: ${e.clientX}px;
          background: #131a2c;
          border: 1px solid rgba(143,180,255,0.2);
          border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
          z-index: 10001;
          padding: 4px 0;
          min-width: 120px;
        `;

        const shareBtn = document.createElement("div");
        shareBtn.style.cssText = `
          padding: 8px 14px;
          color: #dce6ff;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.15s;
          border-left: 3px solid transparent;
        `;
        shareBtn.textContent = "📤 Share";
        shareBtn.addEventListener("mouseover", () => {
          shareBtn.style.background = "rgba(79,127,235,0.2)";
          shareBtn.style.borderLeftColor = "#4f7feb";
        });
        shareBtn.addEventListener("mouseout", () => {
          shareBtn.style.background = "transparent";
          shareBtn.style.borderLeftColor = "transparent";
        });
        shareBtn.addEventListener("click", () => {
          const fileObj = {
            id: item.id,
            name: item.name,
            type: item.type,
            size: item.size_bytes,
          };
          shareFileFromCore(fileObj);
          document.body.removeChild(menu);
        });

        menu.appendChild(shareBtn);
        document.body.appendChild(menu);

        document.addEventListener(
          "click",
          () => {
            if (document.body.contains(menu)) {
              document.body.removeChild(menu);
            }
          },
          { once: true }
        );
      });
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
    localStorage.removeItem("sinkos_unlocked");
    await sb.auth.signOut();
    location.reload();
  });
}

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
  try {
    console.log("📍 enterApp: hiding auth gate");
    document.getElementById("core-auth-gate").style.display = "none";
    
    console.log("📍 enterApp: showing app");
    document.getElementById("core-app").style.display = "flex";
    
    console.log("📍 enterApp: initializing share");
    initShare();
    
    console.log("📍 enterApp: binding app events");
    bindAppEvents();
    
    console.log("📍 enterApp: setting currentFolderId");
    currentFolderId = currentParentId();
    
    console.log("📍 enterApp: calling refresh");
    await refresh();
    
    console.log("✓ enterApp: all steps completed");
  } catch (err) {
    console.error("✗ enterApp failed at some step:", err);
    throw err;
  }
}

async function initAuthGate() {
  console.log("🚀 initAuthGate() CALLED - script loaded");
  
  // Listen for any auth state changes
  sb.auth.onAuthStateChange((event, session) => {
    console.log("🔔 AUTH STATE CHANGED:", event, session?.user?.id);
  });
  
  document.getElementById("core-auth-gate").style.display = "flex";
  showGateStep("checking");

  // DEBUG: Log auth values
  console.log("📋 About to call getSession()");
  const sess = await sb.auth.getSession();
  const userId = sess.data?.session?.user?.id;
  const stored = localStorage.getItem("sinkos_unlocked");
  console.log("🔍 AUTH DEBUG:", { userId, stored, match: userId === stored });
  
  // Delay 10 seconds so you can read console
  console.log("⏱️ Starting 10-second delay...");
  await new Promise(r => setTimeout(r, 10000));
  
  console.log("⏱️ Delay complete, continuing auth flow...");
  console.log("⏱️ About to fetch session again");

  const {
    data: { session },
  } = await sb.auth.getSession();
  
  console.log("📍 Got session:", session?.user?.id);

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

  currentUser = session.user;

  console.log("📋 Querying profile for user:", session.user.id);
  console.log("📋 Using Supabase URL:", SUPABASE_URL);
  console.log("📋 Query: SELECT os_password_hash FROM profiles WHERE id =", session.user.id);
  
  const { data: profile, error: profileError, status, statusText } = await sb
    .from("profiles")
    .select("os_password_hash")
    .eq("id", session.user.id)
    .single();

  console.log("📋 Query returned:", { status, statusText, profile, profileError });
  
  if (profileError) {
    console.error("❌ Profile query ERROR:", profileError);
    console.error("❌ Error code:", profileError.code);
    console.error("❌ Error message:", profileError.message);
  }

  if (!profile) {
    console.log("⚠️ No profile found. Redirecting to onboarding.");
    console.log("⚠️ profile is:", profile);
    console.log("⚠️ profileError is:", profileError);
    location.href = `${SINKOS_AUTH_BASE}/onboarding.html?redirect_to=${encodeURIComponent(location.href)}`;
    return;
  }
  console.log("✓ Profile loaded, os_password_hash exists");

  if (localStorage.getItem("sinkos_unlocked") === session.user.id) {
    console.log("✓ Auth match passed, entering app");
    await enterApp();
    return;
  }

  // Auth not unlocked, show password prompt
  console.log("🔐 Auth unlock needed, showing password prompt");
  showGateStep("unlock");
  document.getElementById("core-auth-unlock-btn").addEventListener("click", async () => {
    const pw = document.getElementById("core-auth-pw").value;
    const errEl = document.getElementById("core-auth-error");
    errEl.textContent = "";
    const hash = await sha256Hex(pw);
    if (hash === profile.os_password_hash) {
      localStorage.setItem("sinkos_unlocked", session.user.id);
      currentUser = session.user;
      await enterApp();
    } else {
      errEl.textContent = "Incorrect password.";
    }
  });
}

console.log("📄 core.js fully loaded, calling initAuthGate()...");
initAuthGate();
