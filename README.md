# Kiro CLI Slack Bot

> Forked from [aws-samples/sample-kiro-assistant](https://github.com/aws-samples/sample-kiro-assistant) — the original Electron desktop app has been replaced with a headless Slack bot using the same `kiro-cli chat` backend.

A Slack bot that proxies messages to [Kiro CLI](https://kiro.dev) via `kiro-cli chat`. Each Slack thread maps to a persistent Kiro conversation keyed by working directory, with `--resume` for follow-ups.

## Features

- **Thread-based sessions** — each Slack thread maps to a persistent Kiro conversation
- **Real-time streaming** — responses stream via Slack's native `ChatStreamer` API (polled from Kiro's SQLite conversation log)
- **Verbose tool output** — tool calls and results shown inline
- **Model display** — shows the model from agent config in the thread header
- **Kiro CLI commands** — `/model`, `/compact`, `/clear`, `/agent`, `/cost`, `/context`, `/help` run directly via `kiro-cli`
- **Per-project support** — different agents, models, and working directories per Slack thread
- **DM support** — direct message the bot without @mentioning
- **Access control** — restrict usage to specific Slack user IDs
- **`--resume` for follow-ups** — follow-up messages in a thread resume the existing conversation
- **`--trust-all-tools`** — no permission prompts, matching the original project's approach

## How it works

```
@kiro in Slack  →  kiro-cli chat --trust-all-tools --agent X --model Y "prompt"
  ↓
kiro-cli writes to SQLite  →  poll every 750ms  →  Slack ChatStreamer
  ↓
Process exits  →  final sync  →  ✅ reaction
  ↓
Follow-up in thread  →  kiro-cli chat --resume "next prompt"
```

## Prerequisites

1. **Kiro CLI v1.25+** installed and authenticated (`kiro-cli login`)
2. **Node.js 18+**
3. A **Slack app** configured with Socket Mode (see below)

## Slack App Setup

### 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → choose **From scratch**
3. Enter a name (e.g. `Kiro`) and select your workspace
4. Click **Create App**

### 2. Enable Socket Mode

Socket Mode lets the bot connect via outbound WebSocket — no public URL needed.

1. In the left sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** to on
3. You'll be prompted to create an app-level token:
   - Token name: `socket-mode` (or anything)
   - Scope: `connections:write` (should be pre-selected)
   - Click **Generate**
4. **Copy the token** — it starts with `xapp-`. This is your `SLACK_APP_TOKEN`

### 3. Add bot token scopes

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll down to **Scopes** → **Bot Token Scopes**
3. Click **Add an OAuth Scope** and add each of these:

| Scope | Why |
|-------|-----|
| `app_mentions:read` | Receive @mention events |
| `chat:write` | Post and stream messages |
| `channels:history` | Read channel messages (for thread context) |
| `channels:read` | List channels the bot is in |
| `im:history` | Read DM messages |
| `im:write` | Send DMs |
| `reactions:write` | Add ⏳ and ✅ reaction indicators |
| `users:read` | Look up user info |

### 4. Subscribe to events

1. In the left sidebar, click **Event Subscriptions**
2. Toggle **Enable Events** to on
3. Expand **Subscribe to bot events**
4. Click **Add Bot User Event** and add:
   - `app_mention` — triggers when someone @mentions the bot in a channel
   - `message.im` — triggers on direct messages to the bot
5. Click **Save Changes** at the bottom

### 5. Install to workspace

1. In the left sidebar, click **Install App** (or **OAuth & Permissions** → scroll up)
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. **Copy the Bot User OAuth Token** — it starts with `xoxb-`. This is your `SLACK_BOT_TOKEN`

### 6. Invite the bot to a channel

The bot can only see @mentions in channels it's a member of:

1. Open a Slack channel where you want to use the bot
2. Type `/invite @Kiro` (or whatever you named it)

### 7. Find your Slack user ID (for ALLOWED_USER_IDS)

To restrict the bot to only respond to you:

1. In Slack, click your profile picture → **Profile**
2. Click the **⋮** (more) button → **Copy member ID**
3. Add it to your `.env` as `ALLOWED_USER_IDS=U0XXXXXXXX`

## Install & Run

```bash
npm install
cp .env.example .env
# Edit .env with your Slack tokens

npm run build
npm start
```

## Configuration (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-...`) |
| `ALLOWED_USER_IDS` | No | Comma-separated Slack user IDs to restrict access |
| `KIRO_AGENT` | No | Default Kiro agent name (default: `default`) |
| `WORKSPACE_ROOT` | No | Base dir for per-thread workspaces (default: `~/Documents/workspace-kiro-slack`) |
| `DEFAULT_CWD` | No | Default working directory for new sessions |
| `KIRO_CLI_PATH` | No | Custom path to kiro-cli binary |

## Kiro CLI Commands

Kiro CLI slash commands like `/model`, `/compact`, `/clear`, `/context`, `/cost`, and `/help` are sent as regular prompts to the agent via `kiro-cli chat --resume`. The agent handles them naturally within the conversation.

## Projects

Projects let you point the bot at a specific codebase and agent. Start a thread with `[project-name]` to use one:

```
@kiro-bot [sirius] what's the deployment status?
```

### Register via Slack

```
@kiro-bot /projects                              # list registered projects
@kiro-bot /register myapp /path/to/myapp myagent # register a project
@kiro-bot /unregister myapp                      # remove a project
```

### Register via file

Create a `projects.json` in the repo root (see `projects.example.json`):

```json
[
  {
    "name": "sirius",
    "cwd": "/Users/you/code/sirius",
    "agent": "findsirius"
  }
]
```

Each project needs:
- `name` — what you type in `[brackets]`
- `cwd` — absolute path to the project root
- `agent` — name of a Kiro agent (from `~/.kiro/agents/` or the project's `.kiro/agents/`)

Threads without a `[project]` prefix use a temporary workspace and the default agent.

## Deploy with PM2

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

## Security Notes

- The bot uses `--trust-all-tools` — all tool calls are auto-approved
- Set `ALLOWED_USER_IDS` to restrict who can interact with the bot
- Consider running as a dedicated macOS user with limited filesystem permissions

## Architecture

```
src/
├── index.ts                 # Bolt app, event handlers, serial queue
├── config.ts                # Env var config
├── logger.ts                # Pino structured logging
├── kiro/
│   ├── runner.ts            # Spawns kiro-cli chat, polls SQLite conversation log
│   ├── conversation.ts      # Reads Kiro's SQLite conversation DB
│   ├── cli-resolver.ts      # Find kiro-cli binary
│   ├── agent-config.ts      # Read model from agent config
│   └── workspace.ts         # Per-thread workspace directories
├── slack/
│   └── message-sender.ts    # ChatStreamer wrapper with overflow handling
└── store/
    ├── session-store.ts     # Thread→session mapping (JSON file)
    └── projects.ts          # Project registry
```

## License

MIT — forked from [aws-samples/sample-kiro-assistant](https://github.com/aws-samples/sample-kiro-assistant)
