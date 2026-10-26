# Telegram Multi-Tool Bot (LLM-routed)

A Telegram bot that uses an LLM (any OpenAI-compatible endpoint — NVIDIA NIM,
local Ollama, etc) as a function-calling router to decide between four
capabilities:

1. **Download video** via a self-hosted yt-dlp FastAPI backend
2. **Extract audio as MP3** via the same backend
3. **Add a song to a Spotify playlist**
4. **Search Gelbooru images** (sent as a photo album)

Anything that doesn't match a tool falls back to normal conversational chat.

## Requirements

- Node.js 20+
- An OpenAI-compatible LLM endpoint with tool calling:
  - **NVIDIA NIM** (default): free dev credits at [build.nvidia.com](https://build.nvidia.com) —
    open a model page and "Get API Key" for an `nvapi-` key
  - **Local Ollama**: `ollama pull llama3.1` (or qwen2.5, mistral-nemo) and
    point `LLM_BASE_URL` at `http://localhost:11434/v1`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- (Optional, per tool) yt-dlp backend credentials, Spotify app credentials, Gelbooru API credentials

## Install

```sh
npm install
```

## Configure

```sh
cp .env.example .env
```

Then fill in `.env`:

- **TELEGRAM_BOT_TOKEN** — from @BotFather
- **TELEGRAM_ALLOWED_USER_IDS** — comma-separated Telegram user IDs; everyone
  else is silently ignored
- **LLM_BASE_URL / LLM_MODEL / LLM_API_KEY** — the OpenAI-compatible endpoint,
  model name, and API key to route with (see `.env.example` for the NVIDIA
  and local-Ollama presets)
- **YTDLP_*** — base URL + credentials for the yt-dlp FastAPI backend
- **SPOTIFY_*** — client ID/secret, a refresh token, and the default playlist ID:
  1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
     and add `http://127.0.0.1:8888/callback` as a Redirect URI
  2. Put the client ID/secret in `.env`, then run `npm run spotify-auth` —
     it opens the consent flow with the right scopes (`playlist-modify-public`,
     `playlist-modify-private`, `playlist-read-private`) and prints the
     `SPOTIFY_REFRESH_TOKEN` to paste into `.env`
  3. For the playlist ID: Share → "Copy link to playlist" in the Spotify app;
     the ID is the segment after `/playlist/` in the URL
- **GELBOORU_API_KEY / GELBOORU_USER_ID** — required for the image tool
  (anonymous API access gets a 401): register at gelbooru.com, then
  My Account → Options → API Access Credentials. `GELBOORU_RATING` filters
  results (`general` by default; `all` disables the filter).
- **DATA_DIR** — folder where the bot stores memory, transcripts and the people
  registry. Default `./data`. In Docker it is `/app/data`, backed by the
  `bot-data` volume.
- **AGENT_PROMPT_DIR** — folder with `soul.md` (personality) and `system.md`
  (operating rules). Default `./agent`. The bot refuses to start when either file
  is missing or larger than 200 KB.
- **AGENT_MAX_LLM_CALLS** — model calls per message, from 1 to 5. Default `5`.
  Any other value falls back to 5 and logs a warning. The last call goes out
  without tools.
- **AGENT_TIMEZONE** — IANA time zone for the timestamps the model sees, for
  example `America/Argentina/Buenos_Aires`. Default `UTC`.

Tool credentials are optional at startup — a missing group just disables that
tool (you'll get a warning in the logs and a friendly error in chat if it's
invoked anyway).

## Run

```sh
node src/index.js
```

## Docker

```sh
docker build -t telegram-multitool-bot .
docker run -d --restart unless-stopped --env-file .env -v bot-data:/app/data --name telegram-bot telegram-multitool-bot
```

The image runs as the non-root `node` user, exposes no ports (the bot uses
long polling), and takes all configuration from environment variables — in
Kubernetes, inject them via a Secret (`envFrom.secretRef`) instead of
`--env-file`. The bot writes only to `/app/data`. Mount the `bot-data` volume
there (`docker-compose.yml` already does), or the bot forgets everything when
the container is replaced. Run exactly one replica: the files have no
cross-process locking.

Bot commands: `/start` (greeting), `/reset` (clear this chat's conversation
history; long-term memory stays).

## Notes

- `DATA_DIR` holds all state, one file per concern:
  - `people.json`: everyone who has sent the bot a directed message, keyed by
    Telegram id.
  - `memory/memory.md`, `memory/chats/<chatId>.md` and `memory/users/<userId>.md`:
    long-term memory the model writes with `memory_save`, one line per entry. Each
    line records its id, date, where it was written and who wrote it (`by:<id>`).
  - `chats/<chatId>/transcript.jsonl`: the recent turns of one chat.
  - `chats/<chatId>/summary.md`: the model's summary of older turns. The bot
    writes it when a transcript passes 64 KB.
  - The yt-dlp auth token stays in memory and renews after a restart.
- Every file the bot reads or writes (`soul.md`, `system.md`, memory files,
  `people.json`, transcripts, summaries) stops at 200 KB. A full memory file
  refuses new entries until the model forgets some. A full transcript drops its
  oldest turns.
- The bot stores only directed messages: those that open with a trigger word or
  reply to one of its own messages. It ignores the rest of a group, and
  `people.json` lists only people who sent a directed message. The author of a
  quoted message and anyone mentioned by a `text_mention` exist only during that
  turn.
- `/reset` deletes the transcript and summary of the chat where you send it.
  Memory and `people.json` stay.
- Visibility: what the bot learns in a group is visible in every whitelisted
  chat. What someone says in a private chat stays in that private chat.
- To forget a person, stop the bot and then:
  1. Delete `memory/users/<id>.md` and the person's record in `people.json`.
  2. Remove the lines with `by:<id>` from `memory/memory.md` and
     `memory/chats/*.md`.
  3. Check `transcript.jsonl` and `summary.md` of every chat where the person
     spoke.
- The budgets in `src/harness/limits.js` assume a model with a context window
  of 32k tokens or more. If `LLM_MODEL` points to a smaller model, lower them.
- To back up the bot, copy the `bot-data` volume. Each rewrite the LLM drives,
  such as a summary or a memory cleanup, leaves one `.prev` copy of the file as
  it was before.
- Long downloads show a "Working on it..." placeholder that gets edited in
  place when the result arrives.
- Video downloads under ~49 MB are streamed from the backend (`POST
  /api/stream`) and sent as a native Telegram video; larger files fall back
  to a Chibisafe link via `POST /api/download` (which re-downloads
  server-side, since the streamed copy is deleted after the stream ends).
