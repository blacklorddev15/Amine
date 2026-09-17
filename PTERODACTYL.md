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

## What works, and what does not

Commands run through the same handler as WhatsApp, so they are driven by the same code. Two
differences are worth knowing before you go looking for a bug:

| | |
|---|---|
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
