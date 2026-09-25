# Copilot Bridge

A small local service that exposes your **GitHub Copilot** subscription behind an
**OpenAI-compatible HTTP API**, protected by a locally generated **API key**, with
**streaming** responses and **per-conversation memory**.

> **Use responsibly.** This bridges to *your own* authorized Copilot subscription for
> personal use. Follow GitHub Copilot's terms — do not resell, share, or redistribute
> access, and don't use it to build a competing service. The bridge talks to Copilot
> using the same device-login flow the official editors use.

---

## How it works

```
your app / curl / OpenAI SDK
        │  Authorization: Bearer <bridge API key>
        ▼
  Copilot Bridge (this service, localhost)
        │  Authorization: Bearer <short-lived Copilot token>
        ▼
     GitHub Copilot API  ──►  Claude Sonnet / GPT-4o / ...
```

- You log in once via GitHub's **device flow**; the bridge stores your GitHub token in
  `.bridge/auth.json` and automatically exchanges it for a short-lived Copilot token
  (auto-refreshed before expiry).
- Incoming requests are authenticated with a **bridge API key** (generated on first run,
  stored in `.bridge/apikey.json`).
- Conversations are stored as flat JSON files under `.bridge/conversations/`.

---

## Setup

Requires **Node.js >= 18.17**.

```powershell
cd copilot-bridge
npm install
Copy-Item .env.example .env   # optional – defaults work out of the box
npm run login                 # one-time GitHub device login
npm start                     # starts the bridge (prints your API key)
```

Grab your API key any time:

```powershell
npm run key        # show current key
npm run key:new    # regenerate (invalidates the old one)
```

---

## Usage

### curl (streaming)

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-bridge-XXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{
        "model": "auto",
        "stream": true,
        "messages": [{ "role": "user", "content": "Explain event loops in one paragraph." }]
      }'
```

### OpenAI SDK (JS)

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'sk-bridge-XXXXXXXX',
});

const stream = await client.chat.completions.create({
  model: 'auto',
  stream: true,
  messages: [{ role: 'user', content: 'Hello!' }],
});
for await (const part of stream) process.stdout.write(part.choices[0]?.delta?.content ?? '');
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-bridge-XXXXXXXX")
resp = client.chat.completions.create(
    model="auto",
    stream=True,
    messages=[{"role": "user", "content": "Hello!"}],
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

---

## Conversation memory

Add a `conversation_id` to any chat request. The bridge prepends stored history, then
saves the new turn + assistant reply. **When using `conversation_id`, only send the new
message** — the bridge supplies the rest.

```bash
# 1) create a conversation id (or make up your own [A-Za-z0-9_-])
curl -X POST http://127.0.0.1:8787/v1/conversations \
  -H "Authorization: Bearer sk-bridge-XXXXXXXX"
# → { "id": "conv_ab12..." }

# 2) chat within it – memory persists across calls
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-bridge-XXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{ "conversation_id": "conv_ab12...",
        "messages": [{ "role": "user", "content": "My name is Sam." }] }'

curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-bridge-XXXXXXXX" \
  -H "Content-Type: application/json" \
  -d '{ "conversation_id": "conv_ab12...",
        "messages": [{ "role": "user", "content": "What is my name?" }] }'
# → knows it is "Sam"
```

---

## Endpoints

| Method | Path                       | Description                                   |
| ------ | -------------------------- | --------------------------------------------- |
| GET    | `/health`                  | Liveness check (no auth).                     |
| GET    | `/v1/models`               | List models available on your Copilot plan.   |
| POST   | `/v1/chat/completions`     | OpenAI-compatible chat (streaming supported). |
| POST   | `/v1/conversations`        | Create a new conversation id.                 |
| GET    | `/v1/conversations`        | List stored conversations.                    |
| GET    | `/v1/conversations/:id`    | Fetch a conversation's messages.              |
| DELETE | `/v1/conversations/:id`    | Delete a conversation.                        |

All `/v1/*` routes require `Authorization: Bearer <bridge API key>`.

---

## Configuration (`.env`)

| Variable               | Default                 | Purpose                                              |
| ---------------------- | ----------------------- | ---------------------------------------------------- |
| `BRIDGE_HOST`          | `127.0.0.1`             | Bind address (keep local unless intentionally not).  |
| `BRIDGE_PORT`          | `8787`                  | Listen port.                                         |
| `DEFAULT_MODEL`        | `auto`                  | `auto` = newest Claude Sonnet available, or an ID.   |
| `MAX_HISTORY_MESSAGES` | `40`                    | Messages retained per conversation.                  |
| `GITHUB_TOKEN`         | *(unset)*               | Skip `npm run login` by supplying a token directly.  |

`model` values: use `auto`, or set an explicit ID such as `claude-sonnet-4.5`,
`claude-sonnet-4`, `claude-3.5-sonnet`, or `gpt-4o`. Call `GET /v1/models` to see exactly
what your plan exposes. (Note: there is no `claude-sonnet-5` yet — `auto` always picks the
newest Sonnet your account can use.)

---

## Notes & limits

- The bridge binds to `127.0.0.1` by default. If you expose it on a network, put it behind
  a reverse proxy with TLS and keep the API key secret.
- `.bridge/` (tokens, API key, conversations) is git-ignored — never commit it.
- Model availability, rate limits, and headers are governed by GitHub Copilot; the bridge
  simply forwards requests using your credentials.
