// ============================================================
//   helper-varnox-bot.js – the Varnox channel
//
//   Lets the bot be talked to from inside Varnox. Pressing Start
//   in the app opens a conversation and writes /start here; every
//   message after that arrives the same way, and the bot answers
//   through the same API.
//
//   It POLLS. Nothing connects in, so this works on a Pterodactyl
//   container with no allocated port, behind NAT, on any host that
//   can make an outbound HTTPS request.
//
//   Requires Node 18 or newer for the built-in fetch.
// ============================================================
'use strict';

/**
 * Configuration, all from the environment.
 *
 * VARNOX_BOT_TOKEN is the `vx_...` value shown once when the bot is created in Varnox. It is the
 * whole credential: it names the bot and it is what the account revokes to cut this off.
 *
 * VARNOX_URL is the deployment to talk to, because this bot may be pointed at a self-hosted Varnox
 * rather than the public one. No trailing slash is needed; one is tolerated.
 */
const TOKEN = String(process.env.VARNOX_BOT_TOKEN || '').trim();
const ROOT = String(process.env.VARNOX_URL || 'https://varnox-chat.vercel.app')
  .trim()
  .replace(/\/+$/, '');
const API = ROOT + '/api/v1';

/** How long each poll holds the connection open. The server caps this at 25s. */
const WAIT_SECONDS = 25;

/** Client-side timeout, a little longer than the server's cap so its answer wins the race. */
const REQUEST_TIMEOUT_MS = WAIT_SECONDS * 1000 + 10_000;

/** How long to wait after a failure that is probably temporary. */
const RETRY_MS = 5_000;

/** How long to wait when Varnox says the account is over its rate limit. */
const RATE_LIMIT_MS = 30_000;

/**
 * How many refusals in a row before giving up.
 *
 * A 401 means the token is not valid any more — most likely it was revoked from the Bots screen.
 * Retrying that forever fills the panel console with the same line and buries whatever else is
 * happening, so after a few the loop stops and says so once. The fix is a new token and a restart,
 * which is a thing the operator has to do anyway because the old token cannot be recovered.
 */
const MAX_REFUSALS = 3;

/** Varnox will not accept a body longer than this, so a long command output is cut with a marker. */
const REPLY_MAX = 3900;

/** The synthetic chat id. It never reaches WhatsApp — it exists so the dispatcher has a string. */
const CHAT_ID = 'varnox@vx';

const enabled = Boolean(TOKEN);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tell the operator, once, what is misconfigured. */
function announce() {
  if (!enabled) {
    console.warn(
      '[VARNOX] VARNOX_BOT_TOKEN not set - the Varnox channel is disabled. ' +
        'Create a bot in Varnox and paste its token into this server\'s startup variables.'
    );
    return;
  }
  if (typeof fetch !== 'function') {
    console.error(
      '[VARNOX] This needs Node 18 or newer for fetch(). ' +
        'Set the panel\'s Docker image to a Node 18+ egg and restart.'
    );
    return;
  }
  console.log(`[VARNOX] Channel started. Polling ${API} - press Start in Varnox to talk to the bot.`);
}

/* ── talking to Varnox ─────────────────────────────────────────────────────── */

async function request(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Take any messages waiting for this bot. A long poll, so it returns as soon as one arrives. */
async function takeMessages() {
  const res = await request('GET', `/inbox?wait=${WAIT_SECONDS}`);
  if (!res.ok) return { ok: false, status: res.status, error: await errorText(res) };
  const data = await res.json().catch(() => ({}));
  return { ok: true, messages: Array.isArray(data.messages) ? data.messages : [] };
}

/**
 * Answer one message.
 *
 * The message must have been taken first — the reply endpoint only accepts something this bot
 * claimed. That is the server's rule and it is why the poll and the reply are one loop: taking and
 * answering are a pair, and there is no way to answer out of order.
 */
async function sendReply(messageId, body) {
  const res = await request('POST', `/inbox/${encodeURIComponent(messageId)}/reply`, { body });
  return { ok: res.ok, status: res.status, error: res.ok ? null : await errorText(res) };
}

async function errorText(res) {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch (_) {
    /* not JSON */
  }
  return `${res.status} ${res.statusText || ''}`.trim();
}

/* ── turning the dispatcher's output into one message ──────────────────────── */

/**
 * The text inside whatever the dispatcher handed to sendMessage.
 *
 * Commands reply in several shapes — a bare string, `{ text }`, `{ caption }`, or a media message
 * with a caption. The text ones are used as-is.
 *
 * A media-only reply becomes a sentence saying so, rather than nothing. The Varnox channel carries
 * text, so a command that returns a picture cannot deliver it here; saying that plainly is better
 * than a silent no-answer, which looks like the bot is broken rather than like the channel is
 * narrower than WhatsApp.
 */
function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  if (typeof content.caption === 'string' && content.caption.trim()) return content.caption;
  if (content.image || content.video || content.document || content.audio || content.sticker) {
    const kind = content.video ? 'a video' : content.audio ? 'audio' : content.document ? 'a file' : content.sticker ? 'a sticker' : 'an image';
    return `[this command returned ${kind}. The Varnox channel carries text, so it cannot be shown here - try it on WhatsApp.]`;
  }
  return '';
}

/**
 * Stand in for the Baileys socket the dispatcher expects.
 *
 * The dispatcher was written against a WhatsApp connection, and most of what it asks for it only
 * needs in order to *send*: every command ultimately goes through `sendMessage`. So this provides
 * that, collecting the text instead of transmitting it, and stubs the rest — presence updates are
 * dropped, and the two lookups only a real WhatsApp chat can answer throw, which the dispatcher
 * already handles because it wraps them in catch blocks.
 */
function makeSocket(collected) {
  return {
    user: { id: 'varnox-bot@vx', lid: '' },
    // Identity resolution: there are no jids to decode here, so the value passes through.
    decodeJid: (jid) => (jid == null ? '' : String(jid)),
    sendMessage: async (_chat, content) => {
      const text = textOf(content);
      if (text) collected.push(text);
      return { key: { id: `varnox-${Date.now()}` } };
    },
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
    // Only a real WhatsApp chat can answer these two, and only group commands ask.
    groupMetadata: async () => {
      throw new Error('Varnox conversations are not WhatsApp groups');
    },
    profilePictureUrl: async () => {
      throw new Error('no WhatsApp profile picture in the Varnox channel');
    },
  };
}

/**
 * Stand in for a Baileys message.
 *
 * `mtype: 'conversation'` is what makes the dispatcher read the text out of `message.conversation`,
 * and the rest is what it reads on the way: a key to take an id and a chat from, a sender, a flag
 * saying this is not a group.
 *
 * THE SENDER IS THE BOT'S OWNER
 *
 * The Varnox account that holds the token owns this bot, so the conversation is treated as the
 * owner talking — which is what makes owner-only commands work instead of answering every one of
 * them with "restricted to the bot owner". Anyone who can open this conversation already holds a
 * credential for the account; there is nobody else to distinguish them from.
 */
function makeMessage(text, ownerJid) {
  return {
    key: { remoteJid: CHAT_ID, fromMe: false, id: `varnox-${Date.now()}` },
    message: { conversation: text },
    mtype: 'conversation',
    text,
    chat: CHAT_ID,
    sender: ownerJid,
    isGroup: false,
    fromMe: false,
    pushName: 'Varnox',
  };
}

/** The owner's WhatsApp-style id, which is the identity the dispatcher checks commands against. */
function ownerJid() {
  const digits = String(global.ownernumber || '').replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : 'varnox@vx';
}

/* ── the greeting ──────────────────────────────────────────────────────────── */

/**
 * What /start answers with.
 *
 * Written out here rather than left to the dispatcher, for two reasons: `/start` is not one of the
 * bot's commands, so forwarding it would produce "unknown command" the first time anybody presses
 * the button; and this is the only message the Varnox channel is guaranteed to be able to send, so
 * it should not depend on anything else working.
 */
function greeting() {
  const prefix = global.prefix !== undefined ? global.prefix : '.';
  const name = global.botname || 'this bot';
  const commands = prefix === '' ? 'just type it' : `start with ${prefix}`;
  return [
    `Hi — ${name} here, answering from Varnox.`,
    '',
    `Commands ${commands}. Send ${prefix}menu to see them all.`,
    '',
    'Send /pair to connect a WhatsApp number to this bot, or /help for this again.',
    'Replies are text: anything that returns a photo, video or sticker has to be used on WhatsApp.',
  ].join('\n');
}

const isStart = (text) => /^\/?(start|help)$/i.test(text.trim());

/* ── /pair: connecting a WhatsApp number ───────────────────────────────────── */

/**
 * How long a request this bot creates stays claimable.
 *
 * A pairing code is only useful while somebody is at their phone entering it, so this is short —
 * the same window the website flow uses. A stale request that is still pending is one nobody
 * finished, and leaving it claimable means the next /pair is refused for being "busy" with an
 * attempt that ended twenty minutes ago.
 */
const PAIR_TTL_MINUTES = 15;

/** How long /pair waits for the code before answering without it. */
const PAIR_WAIT_MS = 45_000;

/** How often it looks while waiting. */
const PAIR_POLL_MS = 1_500;

/**
 * Whether the conversation is waiting for a number, and the owner's username once it is known.
 *
 * Module-level, which is right for this channel specifically: a bot has exactly one Varnox
 * conversation, so there is exactly one thing this state can be about. Under Telegram or WhatsApp
 * this would have to be keyed by chat.
 */
let awaitingPairNumber = false;
let cachedOwnerUsername = null;

/**
 * Turn what somebody typed into an international number, or say why not.
 *
 * Punctuation is stripped rather than rejected — people paste "+234 704 750 4860" and there is no
 * reason to make them clean it up. What is left has to be a real international number, and the two
 * mistakes worth naming are a leading zero (a national format that needs the country code instead)
 * and a length that cannot be one.
 */
function normaliseNumber(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
  if (!digits) {
    return { ok: false, why: 'Send the number in full international format, digits only — for example 2347047504860.' };
  }
  if (digits.startsWith('0')) {
    return { ok: false, why: 'Drop the leading 0 and use the country code instead — for example 2347047504860, not 07047504860.' };
  }
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, why: `That is ${digits.length} digits, which cannot be a phone number. Send it in full international format, digits only.` };
  }
  return { ok: true, number: digits };
}

/** The Varnox account's username, fetched once from /me so /pair can find its user id. */
async function ownerUsername() {
  if (cachedOwnerUsername) return cachedOwnerUsername;
  const res = await request('GET', '/me');
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  cachedOwnerUsername = (data.owner && data.owner.username) || null;
  return cachedOwnerUsername;
}

/**
 * Ask Varnox to pair the number, and wait for the code.
 *
 * This is the preferred route, and it is preferred for a reason: the request lands in the same
 * queue the website pairing bridge drains, so the number is paired by the same code path, recorded
 * against the same account, and shows up in Varnox afterwards. Doing the pairing here directly
 * would connect WhatsApp just as well and leave Varnox convinced nothing had happened — the number
 * would work and would not be listed.
 *
 * The insert is guarded by the same "one live request per account" rule the website applies, so
 * /pair twice in a row answers the second time with the thing already in flight rather than
 * starting a second session for the same number.
 */
async function pairThroughVarnox(number, query) {
  const username = await ownerUsername();
  if (!username) return { ok: false, why: 'Could not read the Varnox account for this bot. Check VARNOX_URL and try again.' };

  const users = await query('select id from vx_users where lower(username) = lower($1) limit 1', [username]);
  if (!users.rows.length) return { ok: false, why: `No Varnox account found for @${username}.` };
  const userId = users.rows[0].id;

  const live = await query(
    `select id, phone from varnox_pairing_requests
      where user_id = $1 and status in ('pending','processing') and expires_at > now()
      order by id desc limit 1`,
    [userId]
  );
  if (live.rows.length && String(live.rows[0].phone) !== number) {
    return { ok: false, why: `A pairing for +${live.rows[0].phone} is already in progress. Finish or wait for it to expire.` };
  }

  if (!live.rows.length) {
    await query(
      `insert into varnox_pairing_requests (user_id, phone, status, expires_at, created_at, updated_at)
       values ($1, $2, 'pending', now() + ($3 || ' minutes')::interval, now(), now())`,
      [userId, number, PAIR_TTL_MINUTES]
    );
  }

  const requestId = live.rows.length
    ? live.rows[0].id
    : (await query('select id from varnox_pairing_requests where user_id = $1 order by id desc limit 1', [userId])).rows[0].id;

  // The website bridge picks the request up within a few seconds and writes the code onto it.
  const deadline = Date.now() + PAIR_WAIT_MS;
  while (Date.now() < deadline) {
    const row = (await query('select status, pairing_code, error from varnox_pairing_requests where id = $1', [requestId])).rows[0];
    if (row) {
      if (row.error) return { ok: false, why: `Pairing failed: ${row.error}` };
      if (row.pairing_code) return { ok: true, number, code: String(row.pairing_code) };
    }
    await sleep(PAIR_POLL_MS);
  }
  return { ok: false, why: 'The pairing request was made but no code came back in 45 seconds. Send /pair again to check.' };
}

/**
 * Pair without the database: ask the session starter directly.
 *
 * The fallback for a bot running without NEON_DATABASE_URL. It connects WhatsApp exactly as well —
 * the starter is the same function the website route uses — but nothing is written to Varnox, so
 * the number works and is not listed there.
 */
async function pairDirectly(number, startSession) {
  const sessionId = `web_${number}`;
  let code = null;
  let failure = null;

  try {
    await startSession(sessionId, {
      pairPhone: number,
      source: 'varnox',
      onPairingCode: async (generated) => {
        code = String(generated);
      },
    });
  } catch (err) {
    failure = err && (err.message || String(err));
  }

  if (code) return { ok: true, number, code, unlisted: true };
  return { ok: false, why: failure ? `Pairing failed: ${failure}` : 'The session started but did not return a code. It may already be linked — check WhatsApp, or restart and try again.' };
}

/** What to say once there is a code. */
function codeReply(result) {
  const lines = [
    `Pairing code for +${result.number}:`,
    '',
    `    ${result.code}`,
    '',
    'On that phone: WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, then type the code.',
  ];
  if (result.unlisted) {
    lines.push(
      '',
      'Note: this bot has no database connection, so the number is connected here but will not appear in Varnox. Pair through the Varnox screen if you want it listed.'
    );
  }
  return lines.join('\n');
}

/** `/pair`, or a bare number once /pair has asked for one. */
async function handlePair(argument, pairing) {
  const typed = String(argument == null ? '' : argument).trim();

  if (!typed) {
    awaitingPairNumber = true;
    return 'Which number do you want to connect?\n\nSend it in full international format, digits only — for example 2347047504860. Send /cancel to stop.';
  }

  const parsed = normaliseNumber(typed);
  if (!parsed.ok) return parsed.why;

  awaitingPairNumber = false;

  const query = pairing && pairing.query;
  const startSession = pairing && pairing.startSession;

  // Null when the bot has no database. The database is not needed to make the connection - it is
  // needed for Varnox to know about it - so this is a choice between two working routes rather
  // than between working and broken.
  if (query) {
    try {
      const result = await pairThroughVarnox(parsed.number, query);
      return result.ok ? codeReply(result) : result.why;
    } catch (err) {
      // A database problem should not lose the pairing: fall through to the direct route, which
      // needs nothing but the session starter.
      console.error('[VARNOX] /pair through Varnox failed:', err && (err.message || err));
    }
  }

  if (!startSession) {
    return 'This bot has no pairing available — it was started without a session starter.';
  }

  try {
    const result = await pairDirectly(parsed.number, startSession);
    return result.ok ? codeReply(result) : result.why;
  } catch (err) {
    return `Pairing failed: ${err && (err.message || err)}`;
  }
}

/* ── running one message ───────────────────────────────────────────────────── */

/**
 * Produce the answer for one message.
 *
 * The handler is called and its output collected rather than streamed, because Varnox takes one
 * reply per message: a command that sends three separate WhatsApp messages becomes one Varnox
 * message with three paragraphs. That is a real difference between the two channels and the reason
 * this cannot simply forward.
 *
 * A command that throws is reported as a failed command, not swallowed. Silence would be
 * indistinguishable from a bot that is not running, which is exactly the confusion this whole
 * channel exists to avoid.
 */
async function answer(text, handler, pairing) {
  const trimmed = String(text == null ? '' : text).trim();

  if (isStart(trimmed)) {
    awaitingPairNumber = false;
    return greeting();
  }
  if (/^\/?(pair)\b/i.test(trimmed)) {
    return handlePair(trimmed.replace(/^\/?pair\b/i, '').trim(), pairing);
  }
  if (/^\/?(cancel|stop)\b/i.test(trimmed)) {
    awaitingPairNumber = false;
    return 'Cancelled.';
  }
  // A bare number is the answer to /pair's question, and nothing else is: a command still means a
  // command, so somebody who changes their mind mid-pairing is not stuck.
  if (awaitingPairNumber && !trimmed.startsWith('/') && !/^\S+\s/.test(trimmed)) {
    return handlePair(trimmed, pairing);
  }
  if (!trimmed) return 'Send a command. Send /start to see what this bot can do.';
  if (!handler) return 'This bot has no command handler loaded, so it can only greet.';

  const collected = [];
  const sock = makeSocket(collected);
  const m = makeMessage(trimmed, ownerJid());

  try {
    await handler(sock, m, {}, undefined);
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    console.error('[VARNOX] command failed:', detail);
    if (collected.length) {
      collected.push(`\n(failed part-way: ${detail})`);
    } else {
      return `That command failed: ${detail}`;
    }
  }

  const joined = collected.join('\n\n').trim();
  if (!joined) {
    return `No output. If that was a command, it may not work here — send ${global.prefix || '.'}menu for the list.`;
  }
  return joined.length > REPLY_MAX ? `${joined.slice(0, REPLY_MAX)}\n\n[truncated]` : joined;
}

/* ── the loop ──────────────────────────────────────────────────────────────── */

/**
 * Start the Varnox channel.
 *
 * `handler` is injected rather than required here so this file has no opinion about which command
 * handler it drives — and so it can be exercised on its own, without a WhatsApp connection or the
 * libraries one needs.
 *
 * The loop is a chain of awaited steps rather than an interval, so a slow command cannot overlap
 * the next poll and two runs can never be in flight at once.
 */
function startVarnoxBotLoop(options) {
  const handler = (options && options.handler) || null;
  // What /pair needs: the session starter that creates a Baileys session, and (optionally) the
  // database pool, so the request can be registered in Varnox rather than only in this process.
  const pairing = (options && options.pairing) || null;
  announce();
  if (!enabled || typeof fetch !== 'function') return;

  let refusals = 0;

  (async function loop() {
    for (;;) {
      try {
        const taken = await takeMessages();

        if (!taken.ok) {
          if (taken.status === 401) {
            refusals += 1;
            console.error(
              `[VARNOX] The bot token was refused (${refusals}/${MAX_REFUSALS}). ` +
                'It has probably been revoked in Varnox - create a new bot and update VARNOX_BOT_TOKEN.'
            );
            if (refusals >= MAX_REFUSALS) {
              console.error('[VARNOX] Channel stopped. Update VARNOX_BOT_TOKEN and restart this server.');
              return;
            }
            await sleep(RETRY_MS);
            continue;
          }
          if (taken.status === 429) {
            console.warn(`[VARNOX] Rate limited: ${taken.error}. Waiting ${RATE_LIMIT_MS / 1000}s.`);
            await sleep(RATE_LIMIT_MS);
            continue;
          }
          console.error(`[VARNOX] Poll failed: ${taken.error}`);
          await sleep(RETRY_MS);
          continue;
        }

        refusals = 0;

        for (const message of taken.messages) {
          const body = await answer(message.body, handler, pairing);
          const sent = await sendReply(message.id, body);
          if (!sent.ok) console.error(`[VARNOX] Could not reply to ${message.id}: ${sent.error}`);
        }
      } catch (err) {
        // A network blip, a DNS failure, a timeout. Nothing to act on beyond trying again, and the
        // message is not lost: an unanswered message stays pending in Varnox and is offered again.
        console.error('[VARNOX] Poll error:', err && (err.message || err));
        await sleep(RETRY_MS);
      }
    }
  })();
}

module.exports = { startVarnoxBotLoop, answer, textOf, greeting, normaliseNumber, handlePair };
