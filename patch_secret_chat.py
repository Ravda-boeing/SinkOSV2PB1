import re, sys
if len(sys.argv) < 2:
    sys.exit('usage: python3 patch_secret_chats.py chat.html [out.html]')
SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else 'chat.secret.html'
t = open(SRC, encoding='utf-8').read()
def rep(old, new, count=1):
    global t
    assert t.count(old) == count, (old[:70], t.count(old))
    t = t.replace(old, new)
def sub(pat, new, flags=0, count=1):
    global t
    t, n = re.subn(pat, new, t, flags=flags)
    assert n == count, (pat[:70], n)
def cut(start, end, new=''):
    global t
    i = t.index(start); j = t.index(end, i)
    t = t[:i] + new + t[j:]

# ---------- HTML ----------
sub(r'^\s*<button class="themeToggle" id="devicesBtn".*\n', '', re.M)
cut('<!-- ENCRYPTION UNLOCK OVERLAY -->', '<!-- NEW GROUP MODAL -->')
rep('<div class="callBtns">', '<div class="callBtns">\n          <button class="callBtn" id="secretBtn" title="Start a secret chat (end-to-end encrypted)">🔒</button>')

# ---------- E2EE module -> secret chats only ----------
cut('/**\n * SinkOS Sink Chat — End-to-End Encryption module', '})();', r'''/**
 * Sink Chat - Secret chats (opt-in end-to-end encryption, 1:1 only)
 * The ECDH identity is generated on this device and stored NON-extractable in
 * IndexedDB, keyed by user id. No password wrapping, no server backup, no device
 * linking. Lose the device or its browser data and secret chats are gone for good.
 * Ordinary chats do not touch this module.
 */
const E2EE = (() => {
  const STORE = 'identity';
  const memConvKeys = new Map();
  let identity = null; // { userId, privateKey }

  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open('sinkos-secret', 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function idbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => { const q = db.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); });
  }
  async function idbPut(k, v) {
    const db = await idb();
    return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  }
  async function idbDel(k) {
    const db = await idb();
    return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  }
  const b64 = {
    enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b))),
    dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer,
  };
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const importPub = (raw) => crypto.subtle.importKey('raw', b64.dec(raw), ECDH, false, []);

  /** Loads this device's identity, or creates it if neither this device nor the account has one. */
  async function ensureIdentity(sb, userId) {
    if (identity && identity.userId === userId) return;
    const rec = await idbGet('identity:' + userId);
    if (rec) { identity = { userId, privateKey: rec.privateKey }; return; }

    const { data } = await sb.from('profiles').select('public_key').eq('id', userId).single();
    if (data?.public_key) {
      const err = new Error('This account\'s secret-chat key lives on another device.');
      err.code = 'IDENTITY_ELSEWHERE';
      throw err;
    }
    const kp = await crypto.subtle.generateKey(ECDH, false, ['deriveKey']);
    const rawPub = await crypto.subtle.exportKey('raw', kp.publicKey);
    await idbPut('identity:' + userId, { privateKey: kp.privateKey });
    const { error } = await sb.from('profiles').update({ public_key: b64.enc(rawPub) }).eq('id', userId);
    if (error) { await idbDel('identity:' + userId); throw error; }
    identity = { userId, privateKey: kp.privateKey };
  }

  function lock() { identity = null; memConvKeys.clear(); }

  async function fetchPeerKeys(sb, ids) {
    const { data, error } = await sb.from('profiles_public').select('id, public_key').in('id', ids);
    if (error) throw error;
    const missing = ids.filter((id) => !(data || []).some((p) => p.id === id && p.public_key));
    if (missing.length) {
      const e = new Error('They haven\'t opened Sink Chat since secret chats were added. Ask them to open it once, then try again.');
      e.code = 'PEER_NO_KEY';
      throw e;
    }
    return data;
  }

  async function wrapKeyFor(convKey, recipientPubB64) {
    const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
    const shared = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: await importPub(recipientPubB64) }, eph.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['wrapKey']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.wrapKey('raw', convKey, shared, { name: 'AES-GCM', iv });
    const ephPub = await crypto.subtle.exportKey('raw', eph.publicKey);
    return { wrapped_key: b64.enc(wrapped), ephemeral_public_key: b64.enc(ephPub), wrap_iv: b64.enc(iv) };
  }

  async function createConversationKey(sb, convId, participantIds) {
    const profiles = await fetchPeerKeys(sb, participantIds);
    const convKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rows = [];
    for (const p of profiles) rows.push({ conversation_id: convId, user_id: p.id, ...(await wrapKeyFor(convKey, p.public_key)) });
    const { error } = await sb.from('conversation_keys').upsert(rows, { onConflict: 'conversation_id,user_id', ignoreDuplicates: true });
    if (error) throw error;
    memConvKeys.set(convId, convKey);
    return convKey;
  }

  async function getConversationKey(sb, convId) {
    if (memConvKeys.has(convId)) return memConvKeys.get(convId);
    if (!identity) throw new Error('No secret-chat key on this device.');
    const { data: row, error } = await sb.from('conversation_keys').select('*').eq('conversation_id', convId).eq('user_id', identity.userId).single();
    if (error || !row) throw new Error('No key for this secret chat.');
    const shared = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: await importPub(row.ephemeral_public_key) }, identity.privateKey,
      { name: 'AES-GCM', length: 256 }, false, ['unwrapKey']);
    const key = await crypto.subtle.unwrapKey('raw', b64.dec(row.wrapped_key), shared,
      { name: 'AES-GCM', iv: new Uint8Array(b64.dec(row.wrap_iv)) },
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    memConvKeys.set(convId, key);
    return key;
  }

  async function encryptMessage(sb, convId, plaintext) {
    const key = await getConversationKey(sb, convId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return { content: b64.enc(ct), iv: b64.enc(iv) };
  }

  async function decryptMessage(sb, convId, contentB64, ivB64) {
    const key = await getConversationKey(sb, convId);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(b64.dec(ivB64)) }, key, b64.dec(contentB64));
    return new TextDecoder().decode(buf);
  }

  return { ensureIdentity, assertPeersReady: fetchPeerKeys, createConversationKey, getConversationKey, encryptMessage, decryptMessage, lock };
''')

# ---------- main script ----------
sub(r'^const (unlock\w*|linkInsteadBtn|linkCodeBox|linkCodeDisplay|linkWaitingText|showResetBtn|reset\w+|devicesModal|devicesBtn|devicesListEl|approveCode\w+|devicesMsg|revokeOtherBtn|closeDevicesBtn)\s*=.*\n', '', re.M, count=25)
sub(r'^let pendingAuthPassword.*\n', '', re.M)
sub(r'^\s*pendingAuthPassword = password;.*\n', '', re.M)
sub(r'// NOTE — scope of this pass.*?already being covered\.\n', '// Attachments are NOT encrypted. They are disabled in secret chats.\n', re.S)
sub(r"(const videoCallBtn\s*=\s*document\.getElementById\('videoCallBtn'\);)", r"\1\nconst secretBtn = document.getElementById('secretBtn');")
rep("handleSignedIn(session.user, null)", "handleSignedIn(session.user)")
sub(r'\n\s*const pw = pendingAuthPassword;.*\n', '\n')
rep("handleSignedIn(session.user, pw)", "handleSignedIn(session.user)")
rep("  unlockScreen.classList.remove('active');\n  devicesModal.classList.remove('active');\n", "")

# sign-in flow: no unlock screen, no device linking
i = t.rfind('/**', 0, t.index('async function handleSignedIn(user, password)'))
j = t.index('async function enterMainScreen()')
t = t[:i] + r'''async function handleSignedIn(user) {
  if (currentUser && currentUser.id === user.id) return; // getSession + SIGNED_IN can both fire
  currentUser = user;
  const { data: profile } = await sb.from('profiles').select('id, username').eq('id', user.id).single();
  currentProfile = profile;
  meLabel.textContent = profile ? '@' + profile.username : user.email;
  authScreen.style.display = 'none';
  // Silent, no password: gives this device a secret-chat key (and publishes the public half)
  // so others can start secret chats with you. Fails harmlessly if the account's key is elsewhere.
  E2EE.ensureIdentity(sb, user.id).catch((err) => console.info('Secret chats unavailable on this device:', err.code || err.message));
  await enterMainScreen();
}

''' + t[j:]

# decrypt helper
cut('async function decryptMessageSafe(convId, msg) {', '// ---------- Init ----------', r'''async function decryptMessageSafe(convId, msg) {
  if (!msg.iv) return msg.content || '';
  if (!(activeConversation && activeConversation.is_secret)) return '🔒 Message from the old encryption system - unreadable.';
  try {
    return await E2EE.decryptMessage(sb, convId, msg.content, msg.iv);
  } catch (err) {
    console.error('Failed to decrypt message:', err);
    return '🔒 Unable to decrypt this message on this device.';
  }
}

''')

# conversations
cut('async function ensureConversationWith(otherUserId) {', '/**\n * Creates a group conversation via', r'''async function ensureConversationWith(otherUserId, secret = false) {
  const existing = conversations.find(c => !c.is_group && !!c.is_secret === secret && c.otherUser && c.otherUser.id === otherUserId);
  if (existing) return existing.id;
  if (secret) {
    await E2EE.ensureIdentity(sb, currentUser.id);
    await E2EE.assertPeersReady(sb, [currentUser.id, otherUserId]); // check BEFORE creating anything
  }
  const { data: newConvId, error: rpcError } = await sb.rpc('create_conversation_with_participants', {
    participant_ids: [otherUserId]
  });
  if (rpcError) { console.error('create conversation error:', rpcError); return null; }
  if (secret) {
    // Mark secret before any message exists; if the key step fails the chat stays unusable (fail closed).
    const { error } = await sb.rpc('mark_conversation_secret', { p_conversation_id: newConvId });
    if (error) throw error;
    await E2EE.createConversationKey(sb, newConvId, [currentUser.id, otherUserId]);
  }
  return newConvId;
}

''')
sub(r'\n \* Wraps the E2EE key.*?\n \*/', '\n * Group chats are never secret chats (no encryption layer in v1).\n */', re.S)
cut("\n  try {\n    await E2EE.createConversationKey(sb, newConvId, [currentUser.id, ...memberIds]);", "\n  return newConvId;\n}\n\nasync function loadConversations", '\n')
cut("\n  try {\n    await E2EE.shareKeyWith(sb, conversationId, userId);", "\n}\n\nasync function removeGroupMember", '\n')
cut('/**\n * Makes sure the current user can decrypt this conversation', 'async function openConversation(', '')
rep("const existing = conversations.find(c => !c.is_group && c.otherUser && c.otherUser.id === friend.id);", "const existing = conversations.find(c => !c.is_group && !c.is_secret && c.otherUser && c.otherUser.id === friend.id);")
rep("""${isGroup ? '<span class="groupTag">Group</span>' : ''}""", """${isGroup ? '<span class="groupTag">Group</span>' : ''}${conv.is_secret ? '<span class="groupTag">🔒 Secret</span>' : ''}""")

cut("  const otherIds = isGroup", "  subscribeToMessages(convId);", r'''  const secret = !!(conv && conv.is_secret);
  if (secret) chatTitle.textContent = '🔒 ' + chatTitle.textContent;
  attachBtn.disabled = secret;
  secretBtn.style.display = (isGroup || secret) ? 'none' : 'flex';
  let secretOk = true;
  if (secret) {
    try {
      await E2EE.ensureIdentity(sb, currentUser.id);
      await E2EE.getConversationKey(sb, convId);
    } catch (err) {
      secretOk = false;
      console.warn('Secret chat unavailable on this device:', err);
    }
    composer.style.display = secretOk ? 'flex' : 'none';
  }
  await loadMessages(convId);
  if (!secretOk) {
    const n = document.createElement('div');
    n.className = 'msg system';
    n.textContent = "This secret chat can't be read on this device. Its key only exists on the device where it was created.";
    messagesEl.appendChild(n);
  }
''')

rep("// ---------- Attachments (composer side) ----------", r'''secretBtn.addEventListener('click', async () => {
  if (!activeFriendId || !activeFriendName) return;
  const name = activeFriendName;
  if (!confirm('Start a secret chat with @' + name + '?\n\nMessages are encrypted with a key that only exists on this device. Lose this device or clear its browser data and the messages are gone for good: no recovery, no search, no attachments, and it will not work on your other devices.')) return;
  secretBtn.disabled = true;
  try {
    const convId = await ensureConversationWith(activeFriendId, true);
    if (!convId) throw new Error('Could not create the secret chat.');
    await loadConversations();
    openConversation(convId, { id: activeFriendId, username: name }, conversations.find(c => c.id === convId));
  } catch (err) {
    console.error('Secret chat failed:', err);
    alert(err.message || 'Could not start a secret chat.');
  } finally {
    secretBtn.disabled = false;
  }
});

// ---------- Attachments (composer side) ----------''')

# sendMessage
rep("  if (!activeConversationId) return;", "  if (!activeConversationId) return;\n  if (file && activeConversation && activeConversation.is_secret) return;")
sub(r"    const \{ content: encContent, iv \} = await E2EE\.encryptMessage.*?\.\.\.attachmentFields\n    \}\);", r'''    let body = { content: content || '' };
    if (activeConversation && activeConversation.is_secret) {
      const enc = await E2EE.encryptMessage(sb, activeConversationId, content);
      body = { content: enc.content, iv: enc.iv };
    }

    const { error } = await sb.from('messages').insert({
      conversation_id: activeConversationId,
      sender_id: currentUser.id,
      ...body,
      ...attachmentFields
    });''', re.S)
sub(r"(  \} finally \{\n    sendBtn\.disabled = false;\n)    attachBtn\.disabled = false;", r"\1    attachBtn.disabled = !!(activeConversation && activeConversation.is_secret);")
open(OUT, 'w', encoding='utf-8').write(t)
print('Patched OK ->', OUT, '(your original is untouched)')