# Running this bot on Pterodactyl, with Start in Varnox working

This adds one thing to ELITE-PRO-V1: a **Varnox channel**. People can open your bot inside Varnox,
press **Start**, and talk to it — and the bot's own commands answer there, not just on WhatsApp.

## READ THIS FIRST: two credentials in this repository need rotating

The `.env` file shipped inside `98827c7_ELITE-PRO-V1-multipair.zip` contained live values, and that
zip is committed to this **public** repository. It is still in the git history, so deleting it from
the current tree does not undo the exposure:

| What | Where it is | What to do |
|---|---|---|
| `TELEGRAM_TOKEN` | a Telegram bot token | Message **@BotFather** → `/revoke` → pick the bot → `/token` for a new one. |
| `NEON_DATABASE_URL` | a Postgres connection string **including its password** | In Neon, reset the role's password, then update the connection string everywhere it is used — including Vercel's `DATABASE_URL`. |

Anyone who read this repository has both. The database one is the serious one: it is the same
database Varnox runs on, so it is read **and write** access to every account, every message and
every pairing request.

This commit stops the leak going forward — `.env` is now gitignored and the rebuilt zip excludes it
— but history keeps a copy, and only rotating the values makes it worthless.

**Where these belong instead:** Pterodactyl → your server → **Startup** → as variables. That is
what the panel is for, and it is what `app.json` and `.env.example` now document.

## Why this works on a panel

The bot **polls outwards**. It asks Varnox for new messages over HTTPS and posts its answers back.
Nothing connects *into* the container.

That is the whole reason it fits Pterodactyl: **no allocated port, no port forwarding, no public
address, no reverse proxy**. The container can sit behind NAT and it still works. Nothing in your
panel's network configuration needs to change.

## Requirements

- **Node 18 or newer.** The channel uses the built-in `fetch`. On Node 16 or older it logs a clear
  error and disables itself rather than crashing the boot — set the panel's Docker image to a
  Node 18+ egg and restart.
- A Varnox account.

## Set it up

### 1. Create the bot in Varnox

Open **https://varnox-chat.vercel.app/bots** and press **New bot**, or talk to the **Support bot**.
Give it a name and a username — the username must end in `-bot` or `_bot`, for example
`elite-pro-bot`.

### 2. Copy the token

After it is created, Varnox shows a `vx_…` value **once**, with a copy button.

> **This is the only time it is shown.** Varnox stores a hash, not the token, so it cannot be
> recovered or looked up later. If you lose it, delete the bot and create another.

### 3. Put it in the panel

Pterodactyl → your server → **Startup** → add these two variables:

| Variable | Value |
|---|---|
| `VARNOX_BOT_TOKEN` | the `vx_…` value you just copied |
| `VARNOX_URL` | `https://varnox-chat.vercel.app` (only change this if you self-host Varnox) |
| `VARNOX_PAIR_MODE` | optional — `direct` (default) or `queue`. See `/pair` below. |

### 4. Restart the server

You should see this in the console:

```
[VARNOX] Channel started. Polling https://varnox-chat.vercel.app/api/v1 - press Start in Varnox to talk to the bot.
```

If you instead see `VARNOX_BOT_TOKEN not set`, the variable did not reach the process — check step 3
and restart again.

### 5. Press Start in Varnox

Go to **/bots**, find your bot, press **Start**. Varnox opens the conversation and sends `/start`,
and the bot answers — usually within a second or two.

## `/pair` — connect a WhatsApp number from inside Varnox

You do not need the panel for this and you do not need to visit another site. In the Varnox
conversation:

```
you  /pair
bot  Which number do you want to connect?
     Send it in full international format, digits only — for example 2347047504860.

you  2347047504860
bot  Pairing code for +2347047504860:

         ABCD-EFGH

     On that phone: WhatsApp → Settings → Linked devices → Link a device → Link with
     phone number instead, then type the code.
```

`/pair 2347047504860` does it in one message, and `/cancel` backs out.

**On the phone:** WhatsApp → Settings → Linked devices → Link a device → **Link with phone number
instead**, then type the code. Punctuation in what you send is fine — `+234 704 750 4860` is read
the same as `2347047504860`. A leading `0` is not: that is a national number, and the bot says so
rather than failing later.

### Two modes, and why the default changed

`VARNOX_PAIR_MODE` decides who asks WhatsApp for the code:

| Mode | What happens | When to use it |
|---|---|---|
| **`direct`** *(default)* | The bot calls `requestPairingCode` itself and reports what it gets back. Needs nothing but the session itself. | Almost always. |
| **`queue`** | `/pair` writes a row into `varnox_pairing_requests` — the same queue the website "Link WhatsApp" screen uses — and the website pairing bridge claims it and generates the code. | If you want the number to **appear in Varnox** afterwards. Needs `NEON_DATABASE_URL` and the bridge running. |

`direct` is the default because it has the fewest things that can be absent. The queue route needs
`NEON_DATABASE_URL`, the bridge loop running, **and** the row reaching the bridge — three ways to do
nothing while looking like it tried.

**A note on what each mode leaves behind.** A number paired on the `direct` route connects and works
on WhatsApp exactly as well, but Varnox has no record of it, so it will not appear in your numbers
list. Pair on the `queue` route, or through the Varnox screen, if you want it listed.

Two further consequences:

- **One at a time (queue mode).** Varnox allows one live pairing request per account, so `/pair` for
  a second number while the first is in progress is refused by name. It expires after 15 minutes.
- **Already linked.** If the number is already connected to this bot, WhatsApp will not issue a
  second code and `/pair` says so directly, rather than waiting a minute and blaming the console.
### If no code comes back

The bot waits 45 seconds, then says so. The console is the place to look — the pairing bridge logs
what it claimed and any Baileys error. Common causes: the number is already linked to another
WhatsApp session, or the code was requested but never entered.

### If the connection drops before you finish pairing

A pairing code is only good while the socket that asked for it stays open. If the connection dies
between the code appearing and you entering it, the code is dead and the number cannot be linked.

Watch the console for two lines in a row like this:

```
[PAIR web_254xxxxxxxxx] Code :  EJ91-8WAF
[SESSION web_254xxxxxxxxx] connection closed (408) - ...
```

**408 is this fork's code for every network-layer failure.** A reset connection, a DNS miss, a
refused port and an idle drop all arrive as 408, which is why the line now prints the underlying
reason after the dash — `WebSocket Error (read ECONNRESET)`, `Connection was lost`, and so on. That
suffix is the part that identifies the cause; the number on its own does not.

The bot also probes its own connectivity at boot, before doing anything else:

```
[NET] web.whatsapp.com:443 reachable (57.144.153.32)
[NET] g.whatsapp.net:443 reachable (57.144.153.33)
[NET] WhatsApp web version 2.3000.1043857760 (latest)
```

If those lines say `CANNOT reach` or `DNS lookup FAILED`, the problem is the node's network, not
this code — several free panels block WhatsApp to stop people running bots on them. Move to a
different node or host and the pairing will start working with no code change.

Two notes about what the bot deliberately does **not** do:

- **It will not restart a session that has not finished pairing.** Restarting re-requests the code
  on a fresh socket, which invalidates the code you are typing, and repeated requests are what end
  in the `401` and `device logged out` that follows. A dropped pairing is reported instead, and
  reconnecting is your call. Once a number *is* paired, reconnection works exactly as before.
- **The code does not change on its own.** If you see a second code for the same number, the
  socket was torn down and rebuilt — check the lines immediately above it.

## What works, and what does not

Commands run through the same handler as WhatsApp, so they are driven by the same code. Two
differences are worth knowing before you go looking for a bug:

| | |
|---|---|
| **`/pair` and `/start` are the channel's own** | They are handled by the channel rather than by the command handler, so they work even if a command fails. Everything else goes to the dispatcher. |
| **Replies are text** | A command that returns a photo, video, sticker or file cannot deliver it here. Instead of going silent, the channel says so in the reply, so it is clear the command ran. Use WhatsApp for those. |
| **Several messages become one** | Some commands send two or three WhatsApp messages in a row. Varnox takes one reply per message, so they are joined into a single message with blank lines between them. |

Group-only commands obviously do nothing: a Varnox conversation is not a WhatsApp group.

**Who you are in there.** The Varnox account that holds the token owns this bot, so the conversation
is treated as the **owner** talking. That is what lets owner-only commands work instead of every one
of them answering "restricted to the bot owner". Anyone who can open that conversation already holds
a credential for the account.

## Revoking

Bots screen → your bot → **Revoke token**. The channel notices at its next poll — within about
25 seconds — logs three refusals, and stops:

```
[VARNOX] The bot token was refused (1/3). It has probably been revoked in Varnox - create a new bot and update VARNOX_BOT_TOKEN.
...
[VARNOX] Channel stopped. Update VARNOX_BOT_TOKEN and restart this server.
```

That is deliberate. Retrying a dead token forever would fill your console with the same line and
bury everything else. To reconnect: create a new bot, replace `VARNOX_BOT_TOKEN`, restart.

## Troubleshooting

| What you see | What it means |
|---|---|
| `VARNOX_BOT_TOKEN not set` | The startup variable is missing or misspelled. Restart after adding it. |
| `needs Node 18 or newer for fetch()` | Change the panel's Docker image to a Node 18+ egg. |
| `The bot token was refused` | The token is wrong, was revoked, or belongs to a bot that was deleted. Create a new bot. |
| `Rate limited` | More than 120 calls a minute from this bot. The channel backs off for 30 seconds by itself. |
| `Poll error: fetch failed` | No outbound internet, or DNS trouble on the node. It retries every 5 seconds. |
| `[NET] CANNOT reach web.whatsapp.com:443` | The node is blocking WhatsApp. Move to another node or host. |
| `[NET] DNS lookup FAILED` | The container has no working DNS. Usually a host fault. |
| `... connection closed (408) - WebSocket Error (read ECONNRESET)` | Something reset the connection mid-session — typically a host firewall or NAT. The number on its own says nothing; the text after the dash does. |
| `... connection closed (408) - Connection was lost` | The socket closed without a clean frame. Often the same host-side cause. |
| `pairing was still in progress - not restarting` | Expected after the fixes. The code shown above it is dead; send `/pair` again. |
| `device logged out - session removed` | WhatsApp invalidated the session. Usually the result of many failed attempts at one number — leave it a few minutes before trying again. |
| Nothing arrives in Varnox | Check the bot was **started** — a bot with no conversation has no queue. Press Start. |

## Where it sits in the code

- `helper-varnox-bot.js` — the channel. Polls, stands in for the WhatsApp socket and message the
  dispatcher expects, collects what a command replies with, sends it back. No dependencies beyond
  Node 18; the handler is passed in, so the file works on its own.
- `index.js` — `launch()` starts it alongside the Telegram pairing bot and the website pairing
  bridge.
- The **website pairing** channel (`helper-varnox-neon.js`) is separate and unchanged: it pairs
  WhatsApp numbers by talking to the database directly. This channel is about *talking to the bot
  from Varnox*, which is why it uses the token API rather than the database.
