# Kiro CLI Slack Bot

> Forked from [aws-samples/sample-kiro-assistant](https://github.com/aws-samples/sample-kiro-assistant) — the original Electron desktop app has been replaced with a headless Slack bot using the same `kiro-cli chat` backend.

A Slack bot that proxies messages to [Kiro CLI](https://kiro.dev) via `kiro-cli chat`. Each Slack thread maps to a persistent Kiro conversation keyed by working directory, with `--resume` for follow-ups.

## Features

- **Real-time streaming** — `kiro-cli chat` stdout is parsed and streamed to Slack as it happens
- **Formatted tool output** — file diffs in code blocks, shell output in code blocks, tool headers with 🔧
- **Thread-based sessions** — each Slack thread maps to a persistent Kiro conversation via `--resume`
- **Thread auto-reply** — reply in a thread without @mentioning the bot to continue the conversation
- **Per-project support** — different agents, models, and working directories per Slack thread
- **Agent discovery** — `/agents` lists all available agents from global and project directories
- **DM support** — direct message the bot without @mentioning
- **Access control** — restrict usage to specific Slack user IDs
- **Visual indicators** — ⏳ while streaming, ✅ when done
- **`--trust-all-tools`** — no permission prompts, matching the original project's approach
- **Auto-compaction** — Kiro CLI automatically compacts when context overflows
- **Stream timeout recovery** — long-running commands (10+ min) recover from Slack stream timeouts

## How it works

```
@kiro in Slack  →  kiro-cli chat --trust-all-tools --no-interactive --agent X --model Y -- "prompt"
  ↓
stdout streams in real-time  →  parse ANSI, detect tool output vs assistant text
  ↓
Tool calls: 🔧 header + code blocks  →  assistant text: buffered word-by-word
  ↓
Process exits  →  ✅ reaction
  ↓
Follow-up in thread  →  kiro-cli chat --resume -- "next prompt" (same cwd)
```

Each message spawns a new `kiro-cli chat` process. Threads share state via the conversation history on disk (keyed by working directory), not via persistent processes.

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
   - `message.channels` — triggers on all messages in channels the bot is in (for thread auto-reply)
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

## Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help with setup guide and examples |
| `/model` | Show current model, agent, and working directory |
| `/agents` | List available agents (global + per-project) |
| `/projects` | List registered projects |
| `/register <name> <path> [agent]` | Register a project |
| `/unregister <name>` | Remove a project |

## Agents

Agents are JSON configs that define the model, tools, and behavior. They live in:
- **Global:** `~/.kiro/agents/<name>.json`
- **Per-project:** `<repo>/.kiro/agents/<name>.json`

Example agent config (`~/.kiro/agents/myagent.json`):

```json
{
  "name": "myagent",
  "description": "Agent for my project",
  "model": "claude-sonnet-4-20250514",
  "tools": ["code", "execute_bash", "fs_read", "fs_write", "glob", "grep"],
  "allowedTools": ["@awslabs.aws-documentation-mcp-server/*"],
  "includeMcpJson": true
}
```

| Field | Description |
|-------|-------------|
| `name` | Agent identifier |
| `description` | What this agent is for |
| `model` | LLM model (e.g. `claude-sonnet-4-20250514`, `claude-opus-4.6`) |
| `tools` | Built-in tools to enable |
| `allowedTools` | MCP server tools to auto-approve |
| `includeMcpJson` | Load MCP servers from `~/.kiro/settings/mcp.json` |
| `systemPrompt` | Custom system instructions |

Run `/agents` in Slack to see all discovered agents.

## Projects

Projects connect the bot to a specific codebase. Start a thread with `[project-name]` to use one:

```
@kiro [sirius] what's the deployment status?
```

### Register via Slack

```
@kiro /register sirius /Users/you/code/sirius findsirius
@kiro /projects
@kiro /unregister sirius
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

## Thread Auto-Reply

Once a thread is started with `@kiro`, you can reply without @mentioning — the bot picks up all messages in threads it's part of. Requires `message.channels` event subscription (see Slack App Setup step 4).

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

## TODO

- [ ] Cancel with ❌ — react with ❌ on a streaming message to kill the running process
- [ ] `/status` — show if a prompt is running, which thread, how long
- [ ] `/cancel` — text-based kill of the current running process
- [ ] Per-thread prompt locks — allow parallel threads instead of global serial queue
- [ ] Thread header — show project, agent, model, cwd when starting a `[project]` thread

## Architecture

```
src/
├── index.ts                 # Bolt app, event handlers, serial queue, tool formatting
├── config.ts                # Env var config
├── logger.ts                # Pino structured logging
├── kiro/
│   ├── runner.ts            # Spawns kiro-cli chat, streams/parses stdout in real-time
│   ├── command.ts           # Runs kiro-cli subcommands
│   ├── cli-resolver.ts      # Find kiro-cli binary
│   ├── agent-config.ts      # Read model + list agents from agent configs
│   └── workspace.ts         # Per-thread workspace directories
├── slack/
│   └── message-sender.ts    # ChatStreamer wrapper with overflow and timeout recovery
└── store/
    ├── session-store.ts     # Thread→session mapping (JSON file)
    └── projects.ts          # Project registry
```

## License

MIT — forked from [aws-samples/sample-kiro-assistant](https://github.com/aws-samples/sample-kiro-assistant)
