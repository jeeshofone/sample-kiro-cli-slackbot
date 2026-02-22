import "dotenv/config";
import App from "@slack/bolt";
import { config } from "./config.js";
import { KiroRunner } from "./kiro/runner.js";
import { loadAgentInfo } from "./kiro/agent-config.js";
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

  if (trimmed === "/commands") {
    const botLines = [
      "• `/projects` — list registered projects",
      "• `/register <name> <path> [agent]` — register a project",
      "• `/unregister <name>` — remove a project",
      "• `/model` — show current model",
      "• `/commands` — show this list",
    ].join("\n");
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: `*Bot commands:*\n${botLines}\n\n_All other messages are sent as prompts to the agent. Auto-compaction runs when context overflows._` });
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
    let resumeSessionId: string | undefined;
    let projectName: string | undefined;

    if (existing) {
      cwd = existing.cwd;
      agent = existing.agent ?? config.kiroAgent;
      resumeSessionId = existing.sessionId;
      logger.info({ cwd, agent, resumeSessionId }, "resuming existing session");
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

    // Snapshot cursor before running so we only get new entries
    runner.snapshotCursor(cwd);

    // Wire up events for this run
    const onDelta = (text: string) => {
      sender.appendDelta(text).catch((e) => logger.error(e, "stream append failed"));
    };
    const onToolCall = (name: string, _args: any) => {
      sender.appendDelta(`\n🔧 _${name}_\n`).catch((e) => logger.error(e, "tool status failed"));
    };
    const onToolResult = (_id: string, result: any) => {
      const out = (result.stdout ?? "") + (result.stderr ?? "");
      if (out.trim()) {
        const preview = out.length > 1000 ? out.slice(0, 1000) + "\n..." : out;
        sender.appendDelta(`\n\`\`\`\n${preview.trim()}\n\`\`\`\n`).catch(() => {});
      }
    };
    const onDone = (conversationId: string | null, code: number | null) => {
      logger.info({ cwd, conversationId, code }, "kiro-cli done");
      // Store the conversation ID as sessionId for --resume
      if (conversationId || !existing) {
        setSession(channel, threadTs, {
          sessionId: conversationId ?? cwd,
          cwd,
          agent,
          createdAt: existing?.createdAt ?? Date.now(),
        });
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
      runner.off("tool_call", onToolCall);
      runner.off("tool_result", onToolResult);
      runner.off("done", onDone);
      runner.off("error", onError);
    }

    runner.on("delta", onDelta);
    runner.on("tool_call", onToolCall);
    runner.on("tool_result", onToolResult);
    runner.on("done", onDone);
    runner.on("error", onError);

    runner.run({
      prompt: userText,
      cwd,
      agent,
      model: agentInfo.model,
      resumeSessionId,
    });
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
  if ((event as any).channel_type !== "im") return;
  if ((event as any).subtype) return;
  const ev = event as any;
  const userId = ev.user as string;
  if (!userId) return;
  if (config.allowedUserIds.length > 0 && !config.allowedUserIds.includes(userId)) return;
  const userText = extractText(ev.text);
  if (!userText) return;
  const threadTs = ev.thread_ts ?? ev.ts;
  const channel = ev.channel as string;
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
