// ============================================================
//   helper/pairing.js – multi-session registry
//
//   Tracks every paired WhatsApp session (Telegram-paired and
//   website-paired), where its auth files live and which Telegram
//   user owns it.
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const SESSIONS_ROOT = path.join(ROOT, 'sessions');
const LEGACY_DIR    = path.join(ROOT, 'session');          // SESSION_ID / owner session
const PAIRS_FILE    = path.join(ROOT, 'database', 'pairs.json');
const LEGACY_ID     = 'main';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Session directories ──────────────────────────────────────
function sessionDir(sessionId) {
  return sessionId === LEGACY_ID ? LEGACY_DIR : path.join(SESSIONS_ROOT, sessionId);
}
function ensureSessionDir(sessionId) { ensureDir(sessionDir(sessionId)); }
function sessionExists(sessionId)   { return fs.existsSync(path.join(sessionDir(sessionId), 'creds.json')); }

function listSessions() {
  const ids = [];
  if (sessionExists(LEGACY_ID)) ids.push(LEGACY_ID);
  try {
    if (fs.existsSync(SESSIONS_ROOT)) {
      for (const d of fs.readdirSync(SESSIONS_ROOT)) {
        if (d !== LEGACY_ID && fs.existsSync(path.join(SESSIONS_ROOT, d, 'creds.json'))) ids.push(d);
      }
    }
  } catch { /* ignore */ }
  return ids;
}

function deleteSessionDir(sessionId) {
  const dir = sessionDir(sessionId);
  try {
    if (sessionId === LEGACY_ID) return false;    // never delete the owner's legacy session
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

// ── Live socket registry ─────────────────────────────────────
const registry = new Map();   // sessionId → { sock, status, phone, tgChatId, tgUserId, source, startedAt, waNum }

function register(sessionId, sock, meta = {}) {
  const prev = registry.get(sessionId) || {};
  registry.set(sessionId, {
    sock,
    status: 'connecting',
    phone: meta.phone || prev.phone || null,
    tgChatId: meta.tgChatId || prev.tgChatId || null,
    tgUserId: meta.tgUserId || prev.tgUserId || null,
    source: meta.source || prev.source || 'telegram',
    startedAt: Date.now(),
    waNum: prev.waNum || null,
  });
  return registry.get(sessionId);
}

function unregister(sessionId) { registry.delete(sessionId); }

function get(sessionId)        { return registry.get(sessionId) || null; }
function getSocket(sessionId)  { const e = registry.get(sessionId); return e ? e.sock : null; }
function isLive(sessionId)     { const e = registry.get(sessionId); return !!(e && e.sock); }
function isConnected(sessionId){ const e = registry.get(sessionId); return !!(e && e.status === 'connected'); }

function markConnected(sessionId, waNum) {
  const e = registry.get(sessionId);
  if (!e) return;
  e.status = 'connected';
  e.waNum = waNum || e.waNum || null;
}

function markDisconnected(sessionId) {
  const e = registry.get(sessionId);
  if (!e) return;
  e.status = 'disconnected';
}

// Stop a live session: close the socket and drop its timers.
async function stopSession(sessionId) {
  const e = registry.get(sessionId);
  if (!e || !e.sock) return false;
  try { (e.sock.__timers || []).forEach(t => clearInterval(t)); } catch { /* ignore */ }
  try { await e.sock.logout(); } catch { /* ignore */ }
  try { e.sock.ws?.close(); } catch { /* ignore */ }
  unregister(sessionId);
  return true;
}

function activeCount() { return registry.size; }
function statusList()  { return [...registry.entries()].map(([id, e]) => ({ id, status: e.status, waNum: e.waNum, source: e.source })); }

// ── Telegram user → sessions map (persisted) ─────────────────
function getAllPairs() {
  try { return JSON.parse(fs.readFileSync(PAIRS_FILE, 'utf8')); } catch { return {}; }
}
function savePairs(all) {
  try {
    ensureDir(path.dirname(PAIRS_FILE));
    fs.writeFileSync(PAIRS_FILE, JSON.stringify(all, null, 2));
  } catch { /* ignore */ }
}
function getUserPairs(tgId) { return getAllPairs()[String(tgId)] || []; }

function addPair(tgId, sessionId, phone) {
  const all = getAllPairs();
  const uid = String(tgId);
  if (!all[uid]) all[uid] = [];
  const existing = all[uid].find(p => p.sessionId === sessionId);
  if (existing) {
    existing.phone = phone || existing.phone;
    existing.addedAt = existing.addedAt || Date.now();
  } else {
    all[uid].push({ sessionId, phone, addedAt: Date.now() });
  }
  savePairs(all);
}

function removePair(tgId, sessionId) {
  const all = getAllPairs();
  const uid = String(tgId);
  if (!all[uid]) return;
  all[uid] = all[uid].filter(p => p.sessionId !== sessionId);
  savePairs(all);
}

// Which Telegram user owns this session (used when reloading on boot)?
function ownerOf(sessionId) {
  for (const [uid, pairs] of Object.entries(getAllPairs())) {
    const hit = pairs.find(p => p.sessionId === sessionId);
    if (hit) return { tgUserId: uid, phone: hit.phone || null };
  }
  return null;
}

module.exports = {
  LEGACY_ID,
  sessionDir, ensureSessionDir, sessionExists, listSessions, deleteSessionDir,
  register, unregister, get, getSocket, isLive, isConnected,
  markConnected, markDisconnected, stopSession, activeCount, statusList,
  getAllPairs, getUserPairs, addPair, removePair, ownerOf,
};
