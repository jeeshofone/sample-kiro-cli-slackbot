import "dotenv/config";
import App from "@slack/bolt";
import { config } from "./config.js";
import { KiroRunner } from "./kiro/runner.js";
import { loadAgentInfo, listAgents } from "./kiro/agent-config.js";
import { getSession, setSession } from "./store/session-store.js";
import { createWorkspaceDir } from "./kiro/workspace.js";
import { parseProject, listProjects, addProject, removeProject } from "./store/projects.js";
import { SlackSender } from "./slack/message-sender.js";
import { logger } from "./logger.js";

const { App: BoltApp } = App;

// --- State ---
const runner = new KiroRunner();
const activeSenders = new Map<string, SlackSender>(); // cwd → sender
let promptDone: (() => void) | null = null;
let promptLock: Promise<void> | null = null;

function acquirePromptLock(): Promise<void> {
  if (!promptLock) {
    promptLock = new Promise((resolve) => { promptDone = resolve; });
    return Promise.resolve();
  }
  return promptLock.then(() => {
    promptLock = new Promise((resolve) => { promptDone = resolve; });
  });
}

function releasePromptLock(): void {
  const done = promptDone;
  promptDone = null;
  promptLock = null;
  if (done) done();
}

// --- Extract user text from Slack message, stripping the bot mention ---
function extractText(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// --- Bot commands ---
async function handleBotCommand(text: string, channel: string, threadTs: string, client: any): Promise<boolean> {
  const trimmed = text.trim();

  if (trimmed === "/projects" || trimmed === "/list") {
    const projects = listProjects();
    if (projects.length === 0) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "No projects registered. Use `/register <name> <path> [agent]` to add one." });
    } else {
      const lines = projects.map((p: any) => `• *${p.name}* — \`${p.cwd}\` (agent: \`${p.agent}\`)`);
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: `📂 *Registered projects:*\n${lines.join("\n")}\n\n_Start a thread with \`[project-name] your message\` to use one._` });
    }
    return true;
  }

  const regMatch = trimmed.match(/^\/register\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/);
  if (regMatch) {
    const [, name, cwd, agent] = regMatch;
    addProject({ name, cwd, agent: agent ?? "kiro-assistant" });
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: `✅ Registered project *${name}*\n• Path: \`${cwd}\`\n• Agent: \`${agent ?? "kiro-assistant"}\`\n\n_Use \`[${name}] your message\` to start a thread._` });
    return true;
  }

  const unregMatch = trimmed.match(/^\/unregister\s+(\S+)$/);
  if (unregMatch) {
    const removed = removeProject(unregMatch[1]);
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: removed ? `🗑️ Removed project *${unregMatch[1]}*` : `❓ Project *${unregMatch[1]}* not found.` });
    return true;
  }

  if (trimmed === "/commands" || trimmed === "/help") {
    const lines = [
      "🤖 *Kiro Slack Bot — Help*",
      "",
      "*━━━ Commands ━━━*",
      "• `/help` — show this help",
      "• `/model` — show current model, agent, and working directory",
      "• `/projects` — list registered projects",
      "• `/agents` — list available agents (global + per-project)",
      "• `/register <name> <path> [agent]` — register a project",
      "• `/unregister <name>` — remove a registered project",
      "",
      "*━━━ How to Use ━━━*",
      "• *Start a conversation:* `@kiro tell me about this codebase`",
      "• *Use a project:* `@kiro [sirius] monitor the deploy`",
      "• *Follow up:* reply in the same thread (uses `--resume` for full context)",
      "• *Fresh start:* start a new thread to reset context",
      "",
      "*━━━ Setting Up a Project ━━━*",
      "A project connects the bot to a codebase. You need:",
      "1️⃣ An *agent config* — defines model, tools, and behavior",
      "2️⃣ A *registered project* — maps a name to a directory + agent",
      "",
      "*Step 1 — Create an agent:*",
      "Add a JSON file to `~/.kiro/agents/` (global) or `<repo>/.kiro/agents/` (project-local):",
      "```{",
      '  "name": "myagent",',
      '  "description": "Agent for my project",',
      '  "model": "claude-sonnet-4-20250514",',
      '  "tools": ["code", "execute_bash", "fs_read", "fs_write", "glob", "grep"],',
      '  "allowedTools": ["@awslabs.aws-documentation-mcp-server/*"]',
      "}```",
      "Save as `myagent.json`. Run `/agents` to verify it's detected.",
      "",
      "*Step 2 — Register the project:*",
      "```@kiro /register myapp /Users/you/code/myapp myagent```",
      "",
      "*Step 3 — Use it:*",
      "```@kiro [myapp] what does this codebase do?```",
      "",
      "*━━━ Agent Config Fields ━━━*",
      "• `name` — agent identifier",
      "• `description` — what this agent is for",
      "• `model` — LLM model (e.g. `claude-sonnet-4-20250514`, `claude-opus-4.6`)",
      "• `tools` — built-in tools: `code`, `execute_bash`, `fs_read`, `fs_write`, `glob`, `grep`, `use_aws`, `web_fetch`, `web_search`",
      "• `allowedTools` — MCP server tools to auto-approve (e.g. `@puppeteer/*`)",
      "• `includeMcpJson` — `true` to load MCP servers from `~/.kiro/settings/mcp.json`",
      "• `systemPrompt` — custom system instructions for the agent",
      "",
      "*━━━ Indicators ━━━*",
      "• ⏳ streaming  • ✅ done  • 🔧 tool call",
      "",
      "*━━━ Good to Know ━━━*",
      "• `--trust-all-tools` — all tool calls auto-approved",
      "• Auto-compaction when context gets too long",
      "• One prompt at a time (serial queue)",
      "• Long-running commands stream in real-time",
    ].join("\n");
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: lines });
    return true;
  }

  if (trimmed === "/agents") {
    const projectCwds = listProjects().map((p: any) => p.cwd);
    const agents = listAgents(projectCwds);
    if (!agents.length) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "No agents found. Add JSON configs to `~/.kiro/agents/` or `<project>/.kiro/agents/`. Run `/help` for setup guide." });
    } else {
      const lines = agents.map((a) => {
        const model = a.model ? ` · model: \`${a.model}\`` : "";
        const desc = a.description ? ` — ${a.description}` : "";
        return `• \`${a.name}\`${desc}${model}\n  _source: ${a.source}_`;
      });
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: `🤖 *Available Agents:*\n\n${lines.join("\n\n")}\n\n_Agents are loaded from \`~/.kiro/agents/\` and project \`.kiro/agents/\` directories._` });
    }
    return true;
  }

  if (trimmed === "/model") {
    const existing = getSession(channel, threadTs);
    const agent = existing?.agent ?? config.kiroAgent;
    const cwd = existing?.cwd;
    const info = loadAgentInfo(agent, cwd);
    const model = info.model ?? "default (not set in agent config)";
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: `🤖 *Model:* \`${model}\`\n*Agent:* \`${agent}\`${cwd ? `\n*CWD:* \`${cwd}\`` : ""}` });
    return true;
  }

  return false;
}

// --- Format tool output blocks for Slack ---
function formatToolBlock(lines: string[]): string {
  const parts: string[] = [];
  let diffLines: string[] = [];
  let cmdOutput: string[] = [];

  const flushDiff = () => {
    if (!diffLines.length) return;
    // Strip the "+    N: " prefix for cleaner display
    const code = diffLines.map((l) => l.replace(/^[+-]\s*\d+:\s?/, "")).join("\n");
    parts.push("```\n" + code + "\n```");
    diffLines = [];
  };

  const flushCmd = () => {
    if (!cmdOutput.length) return;
    parts.push("```\n" + cmdOutput.join("\n") + "\n```");
    cmdOutput = [];
  };

  for (const line of lines) {
    // Diff lines: +    1: code  or -    1: code
    if (/^[+-]\s+\d+:/.test(line)) {
      flushCmd();
      diffLines.push(line);
      continue;
    }

    flushDiff();

    // Tool header: "I'll create..." / "I will run..." / "Reading directory..."
    if (/^I'll |^I will |^Reading |^Purpose:/.test(line)) {
      flushCmd();
      parts.push(`\n🔧 _${line}_`);
      continue;
    }

    // Completion: "Creating: ..." / "Appending to: ..." / "- Completed in ..."
    if (/^Creating:|^Appending to:|^- Completed in|^✓ /.test(line)) {
      flushCmd();
      parts.push(`_${line}_`);
      continue;
    }

    // Everything else is command output
    cmdOutput.push(line);
  }

  flushDiff();
  flushCmd();

  return "\n" + parts.join("\n") + "\n";
}

// --- Handle a message ---
async function handleMessage(
  channel: string,
  threadTs: string,
  userText: string,
  teamId: string,
  userId: string,
  client: any,
): Promise<void> {
  logger.info({ channel, threadTs, userText: userText.slice(0, 80) }, "handling message");

  if (await handleBotCommand(userText, channel, threadTs, client)) return;

  await acquirePromptLock();
  logger.info("prompt lock acquired");

  try {
    const existing = getSession(channel, threadTs);

    let cwd: string;
    let agent: string;
    let resume = false;
    let projectName: string | undefined;

    if (existing) {
      cwd = existing.cwd;
      agent = existing.agent ?? config.kiroAgent;
      resume = true;
      logger.info({ cwd, agent }, "resuming existing session");
    } else {
      const { project, rest } = parseProject(userText);
      userText = rest || userText;

      if (project) {
        cwd = project.cwd;
        agent = project.agent;
        projectName = project.name;
        logger.info({ project: project.name, cwd, agent }, "using project");
      } else {
        cwd = config.defaultCwd ?? createWorkspaceDir();
        agent = config.kiroAgent;
      }
    }

    const agentInfo = loadAgentInfo(agent, cwd);
    const sender = new SlackSender(client, channel, threadTs, teamId, userId);
    activeSenders.set(cwd, sender);

    // Show header on new threads
    if (!existing) {
      const header = projectName ? `📂 _${projectName}_ · \`${cwd}\`` : `📂 \`${cwd}\``;
      const modelLine = agentInfo.model ? ` · 🤖 \`${agentInfo.model}\`` : "";
      sender.appendDelta(`${header}${modelLine}\n\n`).catch(() => {});
    }

    // Wire up events for this run
    const onDelta = (text: string) => {
      sender.appendDelta(text).catch((e) => logger.error(e, "stream append failed"));
    };
    const onTool = (lines: string[]) => {
      const formatted = formatToolBlock(lines);
      sender.appendDelta(formatted).catch((e) => logger.error(e, "tool output failed"));
    };
    const onDone = (code: number | null) => {
      logger.info({ cwd, code }, "kiro-cli done");
      if (!existing) {
        setSession(channel, threadTs, { sessionId: cwd, cwd, agent, createdAt: Date.now() });
      }
      sender.finish().catch((e) => logger.error(e, "finish failed"));
      activeSenders.delete(cwd);
      cleanup();
      releasePromptLock();
    };
    const onError = (msg: string) => {
      logger.error({ msg }, "runner error");
      sender.sendError(msg).catch(() => {});
      activeSenders.delete(cwd);
      cleanup();
      releasePromptLock();
    };

    function cleanup() {
      runner.off("delta", onDelta);
      runner.off("tool", onTool);
      runner.off("done", onDone);
      runner.off("error", onError);
    }

    runner.on("delta", onDelta);
    runner.on("tool", onTool);
    runner.on("done", onDone);
    runner.on("error", onError);

    runner.run({ prompt: userText, cwd, agent, model: agentInfo.model, resume });
  } catch (err) {
    logger.error(err, "handleMessage failed");
    releasePromptLock();
  }
}

// --- Slack app ---
const app = new BoltApp({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

app.event("app_mention", async ({ event, client, context }) => {
  if (!event.user) return;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(event.user)) {
    await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "no_entry" });
    return;
  }
  const userText = extractText(event.text);
  if (!userText) return;
  const threadTs = event.thread_ts ?? event.ts;
  await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "eyes" }).catch(() => {});
  const teamId = context.teamId ?? (event as any).team ?? "";
  handleMessage(event.channel, threadTs, userText, teamId, event.user!, client);
});

app.event("message", async ({ event, client, context }) => {
  const ev = event as any;
  if (ev.subtype) return;
  const userId = ev.user as string;
  if (!userId) return;
  // Ignore bot's own messages
  if (userId === context.botUserId) return;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;

  const channel = ev.channel as string;
  const isDm = ev.channel_type === "im";
  const isThreadReply = !!ev.thread_ts && ev.thread_ts !== ev.ts;

  // Thread auto-reply: respond to replies in threads with an existing session
  if (!isDm && isThreadReply) {
    const session = getSession(channel, ev.thread_ts);
    if (!session) return; // not a bot thread
    const userText = extractText(ev.text);
    if (!userText) return;
    const teamId = context.teamId ?? ev.team ?? "";
    await client.reactions.add({ channel, timestamp: ev.ts, name: "eyes" }).catch(() => {});
    handleMessage(channel, ev.thread_ts, userText, teamId, userId, client);
    return;
  }

  // DM handling
  if (!isDm) return;
  const userText = extractText(ev.text);
  if (!userText) return;
  const threadTs = ev.thread_ts ?? ev.ts;
  const teamId = context.teamId ?? ev.team ?? "";
  await client.reactions.add({ channel, timestamp: ev.ts, name: "eyes" }).catch(() => {});
  handleMessage(channel, threadTs, userText, teamId, userId, client);
});

// --- Graceful shutdown ---
process.on("SIGTERM", async () => { await app.stop(); process.exit(0); });
process.on("SIGINT", async () => { await app.stop(); process.exit(0); });

// --- Start ---
(async () => {
  await app.start();
  logger.info("⚡ Kiro Slack bot is running (Socket Mode)");
})();
