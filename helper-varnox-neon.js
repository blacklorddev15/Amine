// ============================================================
//   helper-varnox-neon.js – website pairing channel
//
//   Lets users pair through the WEBSITE (varnox_pairing_requests)
//   exactly like Telegram pairing. The bot polls Neon every 3s,
//   claims pending requests, starts a web_ session and writes the
//   real WhatsApp pairing code back to the website.
// ============================================================
'use strict';

// Force IPv4-first DNS (containers/VPS often have no IPv6 route).
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (_) { /* older node */ }

const { Pool } = require('pg');

const NEON_URL = String(process.env.NEON_DATABASE_URL || '').split('?')[0];

const pool = NEON_URL
  ? new Pool({
      connectionString: NEON_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5,
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('[WEBSITE-PAIR] idle client error:', err && (err.stack || err.message || err));
  });
}

async function query(text, params) {
  if (!pool) throw new Error('NEON_DATABASE_URL is not set');
  return pool.query(text, params);
}

// ── Claim one pending website request ───────────────────────
async function claimPairingRequest() {
  const { rows } = await query(
    `UPDATE varnox_pairing_requests
        SET status = 'processing', updated_at = now()
      WHERE id = (
        SELECT id FROM varnox_pairing_requests
         WHERE status = 'pending' AND expires_at > now()
         ORDER BY id ASC LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
      RETURNING id, phone`,
  );
  return rows[0] || null;
}

async function setPairingCode(id, code) {
  await query(
    `UPDATE varnox_pairing_requests SET status = 'code_generated', pairing_code = $2, error = NULL, updated_at = now() WHERE id = $1`,
    [id, String(code)]
  );
}

async function markPairingConnected(id) {
  await query(`UPDATE varnox_pairing_requests SET status = 'connected', updated_at = now() WHERE id = $1`, [id]);
}

async function markPairingFailed(id, msg) {
  await query(
    `UPDATE varnox_pairing_requests SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [id, msg]
  );
}

async function expireStaleRequests() {
  await query(`UPDATE varnox_pairing_requests SET status = 'expired', updated_at = now() WHERE status IN ('pending','processing') AND expires_at < now()`);
}

// ── Session registry (sessionId → socket) ───────────────────
const _sockets = new Map();
function registerWASocket(sessionId, sock) {
  if (sock) _sockets.set(String(sessionId), sock);
}
function getWASocket(sessionId) {
  return _sockets.get(String(sessionId)) || null;
}

// ── Record a session into varnox_sessions (portal stats) ────
async function recordSession(sessionId, phone, status) {
  try {
    await query(
      `INSERT INTO varnox_sessions (id, phone, status, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE SET phone = EXCLUDED.phone, status = EXCLUDED.status, updated_at = now()`,
      [String(sessionId), String(phone || ''), String(status || 'disconnected')]
    );
  } catch (e) {
    console.error('[WEBSITE-PAIR] recordSession error:', e && e.message);
  }
}

let _announced = false;
async function announceConnected() {
  if (_announced) return;
  try {
    await query('SELECT 1');
    console.log('[WEBSITE-PAIR] Neon channel online. Waiting for pairing requests...');
    _announced = true;
  } catch (e) {
    console.error('[WEBSITE-PAIR] Neon NOT reachable yet - ' + (e && (e.message || e)));
  }
}

// ── Main polling loop ────────────────────────────────────────
// starter: (sessionId, phone, pairingCodeCallback) => Promise<sock|void>
function startWebsitePairingLoop(starter) {
  if (!NEON_URL) {
    console.warn('[WEBSITE-PAIR] NEON_DATABASE_URL not set - website pairing loop disabled.');
    return;
  }

  setInterval(() => { expireStaleRequests().catch(() => {}); }, 60000);
  setInterval(() => { if (!_announced) announceConnected(); }, 60000);

  console.log('[WEBSITE-PAIR] Website pairing loop started (3s interval)');
  announceConnected();

  setInterval(async () => {
    try {
      const row = await claimPairingRequest();
      if (!row) return;
      const sessionId = `web_${row.phone}`;
      console.log(`[WEBSITE-PAIR] Request #${row.id} for +${row.phone} claimed from the website.`);
      _announced = true;

      const watchdog = setTimeout(async () => {
        try {
          const q = await query('SELECT status FROM varnox_pairing_requests WHERE id = $1', [row.id]);
          if (q.rows[0] && q.rows[0].status === 'processing') {
            await markPairingFailed(row.id, 'Timed out waiting for WhatsApp pairing code.');
          }
        } catch (_) { /* ignore */ }
      }, 90000);

      await starter(sessionId, row.phone, async (code) => {
        clearTimeout(watchdog);
        await setPairingCode(row.id, code);
      });

      // After the starter has created the socket, wire error + connection records
      const sock = getWASocket(sessionId);
      if (sock) {
        sock.__pairingRequestId = row.id;
        sock.__pairingError = (errMsg) => markPairingFailed(row.id, errMsg);
        sock.ev.on('connection.update', async ({ connection }) => {
          try {
            if (connection === 'open') {
              await markPairingConnected(row.id);
              await recordSession(sessionId, row.phone, 'connected');
            } else if (connection === 'close') {
              await recordSession(sessionId, row.phone, 'disconnected');
            }
          } catch (_) { /* ignore */ }
        });
      }
    } catch (e) {
      console.error('[WEBSITE-PAIR] poll error:', e && (e.stack || e.message || e));
    }
  }, 3000);
}

module.exports = {
  startWebsitePairingLoop,
  registerWASocket,
  getWASocket,
  recordSession,
  // Whether NEON_DATABASE_URL was set, as a value rather than as an exception. `query` throws when
  // there is no pool, so a caller checking `if (query)` learns nothing and finds out by failing.
  hasDatabase: Boolean(pool),
  // Exported so the Varnox channel can put a pairing request into the same queue this loop drains,
  // using the same pool rather than opening a second one against the same database.
  query,
};
