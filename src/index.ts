import "dotenv/config";
import App from "@slack/bolt";
import { config } from "./config.js";
import { AcpClient } from "./acp/client.js";
import type { SessionUpdate } from "./acp/types.js";
import { getSession, setSession } from "./store/session-store.js";
import { createWorkspaceDir } from "./kiro/workspace.js";
import { SlackSender } from "./slack/message-sender.js";
import { logger } from "./logger.js";

const { App: BoltApp } = App;

// --- State ---
let acp: AcpClient;
const activeSenders = new Map<string, SlackSender>(); // sessionId → sender
const pendingPermissions = new Map<string, { acpRequestId: string | number; sessionId: string }>(); // actionId → permission info

// We use a simple lock: only one prompt at a time.
// When a prompt is active, new messages wait. turn_end releases the lock.
let promptDone: (() => void) | null = null;
let promptLock: Promise<void> | null = null;

function acquirePromptLock(): Promise<void> {
  if (!promptLock) {
    promptLock = new Promise((resolve) => { promptDone = resolve; });
    return Promise.resolve();
  }
  // Wait for current prompt to finish, then acquire
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

// --- ACP lifecycle ---
async function ensureAcp(): Promise<AcpClient> {
  if (acp?.alive) return acp;
  acp = new AcpClient();

  acp.on("permission", (sessionId: string, acpRequestId: string | number, toolCall: any, options: any[]) => {
    if (config.toolApproval === "auto") {
      acp.resolvePermission(acpRequestId, "allow_always");
      return;
    }
    // Interactive: post buttons to Slack
    const sender = activeSenders.get(sessionId);
    if (!sender) {
      acp.resolvePermission(acpRequestId, "allow_always");
      return;
    }
    const actionId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingPermissions.set(actionId, { acpRequestId, sessionId });
    const title = toolCall?.title ?? "Tool call";
    sender.postPermissionPrompt(title, actionId, options).catch((e) => {
      logger.error(e, "failed to post permission prompt");
      acp.resolvePermission(acpRequestId, "allow_always"); // fallback
      pendingPermissions.delete(actionId);
    });
  });

  acp.on("update", (sessionId: string, update: SessionUpdate) => {
    const sender = activeSenders.get(sessionId);
    if (!sender) {
      logger.warn({ sessionId, type: update.sessionUpdate }, "update for unknown sender");
      return;
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content?.text) {
          sender.appendDelta(update.content.text).catch((e) => logger.error(e, "stream append failed"));
        }
        break;
      case "tool_call": {
        const u = update as any;
        const title = u.title ?? "tool";
        const kind = u.kind ?? "";
        // Skip generic "shell"/"write" titles — wait for the descriptive one
        if (u.status === "in_progress" && title === kind) break;
        // Show tool start with descriptive title
        if (title !== kind) {
          sender.appendDelta(`\n🔧 _${title}_\n`).catch((e) => logger.error(e, "tool status failed"));
        }
        // Show diff content for file edits
        if (u.content) {
          for (const c of u.content) {
            if (c.type === "diff" && c.newText != null) {
              const label = c.oldText == null ? `📄 Created \`${c.path}\`` : `✏️ Edited \`${c.path}\``;
              const preview = c.newText.length > 500 ? c.newText.slice(0, 500) + "\n..." : c.newText;
              sender.appendDelta(`\n${label}\n\`\`\`\n${preview}\n\`\`\`\n`).catch((e) => logger.error(e, "diff render failed"));
            }
          }
        }
        break;
      }
      case "tool_call_update": {
        const u = update as any;
        const title = u.title ?? "tool";
        const status = u.status ?? "";
        // Show command output on completion
        if (status === "completed" && u.rawOutput?.items) {
          for (const item of u.rawOutput.items) {
            if (item.Json) {
              const out = (item.Json.stdout ?? "") + (item.Json.stderr ?? "");
              if (out.trim()) {
                const preview = out.length > 1000 ? out.slice(0, 1000) + "\n..." : out;
                sender.appendDelta(`\n\`\`\`\n${preview.trim()}\n\`\`\`\n`).catch((e) => logger.error(e, "output render failed"));
              }
              sender.appendDelta(`\n✅ _${title}_ (exit ${item.Json.exit_status ?? "0"})\n`).catch((e) => logger.error(e, "tool done failed"));
            } else {
              sender.appendDelta(`\n✅ _${title}_\n`).catch((e) => logger.error(e, "tool done failed"));
            }
          }
        } else if (status === "completed") {
          sender.appendDelta(`\n✅ _${title}_\n`).catch((e) => logger.error(e, "tool done failed"));
        } else if (status === "failed") {
          sender.appendDelta(`\n❌ _${title}_\n`).catch((e) => logger.error(e, "tool fail failed"));
        }
        break;
      }
    }
  });

  acp.on("turn_end", (sessionId: string) => {
    logger.info({ sessionId }, "turn_end");
    const sender = activeSenders.get(sessionId);
    if (sender) {
      sender.finish().catch((e) => logger.error(e, "stream finish failed"));
      activeSenders.delete(sessionId);
    }
    releasePromptLock();
  });

  acp.on("error", (err: Error) => logger.error(err, "ACP error"));
  acp.on("exit", () => {
    logger.warn("ACP exited, will restart on next message");
    releasePromptLock(); // unblock queue if stuck
  });

  await acp.start();
  return acp;
}

// --- Extract user text from Slack message, stripping the bot mention ---
function extractText(text: string | undefined): string {
  if (!text) return "";
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

// --- Handle a message (shared by app_mention and DM) ---
async function handleMessage(
  channel: string,
  threadTs: string,
  userText: string,
  teamId: string,
  userId: string,
  client: any,
): Promise<void> {
  logger.info({ channel, threadTs, userText: userText.slice(0, 80) }, "handling message");

  // Wait for any active prompt to finish
  await acquirePromptLock();
  logger.info("prompt lock acquired");

  try {
    const acpClient = await ensureAcp();
    const existing = getSession(channel, threadTs);

    let sessionId: string;
    let cwd: string;

    if (existing) {
      sessionId = existing.sessionId;
      cwd = existing.cwd;
      logger.info({ sessionId }, "loading existing session");
      try {
        await acpClient.loadSession(sessionId, cwd);
        // Wait a tick for any history replay notifications to flush
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        logger.warn({ err }, "session/load failed, creating new");
        const ws = createWorkspaceDir();
        const info = await acpClient.createSession(ws);
        sessionId = info.sessionId;
        cwd = ws;
        setSession(channel, threadTs, { sessionId, cwd, createdAt: Date.now() });
      }
    } else {
      cwd = config.defaultCwd ?? createWorkspaceDir();
      const info = await acpClient.createSession(cwd);
      sessionId = info.sessionId;
      logger.info({ sessionId, cwd }, "created new session");
      setSession(channel, threadTs, { sessionId, cwd, createdAt: Date.now() });
    }

    const sender = new SlackSender(client, channel, threadTs, teamId, userId);
    activeSenders.set(sessionId, sender);

    logger.info({ sessionId }, "sending prompt");
    await acpClient.prompt(sessionId, userText);
    // prompt is fire-and-forget; turn_end will release the lock
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

// Handle @mentions
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

// Handle DMs
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

// Handle permission button clicks
app.action(/^perm_/, async ({ action, ack, body }) => {
  await ack();
  const act = action as any;
  const actionId = act.action_id?.replace(/_trust$|_approve$|_reject$/, "");
  const pending = pendingPermissions.get(actionId);
  if (!pending) return;
  pendingPermissions.delete(actionId);

  let optionId: string;
  let label: string;
  if (act.action_id?.endsWith("_trust")) {
    optionId = "allow_always";
    label = "✅ Trusted for session";
  } else if (act.action_id?.endsWith("_approve")) {
    optionId = "allow_once";
    label = "✅ Approved";
  } else {
    optionId = "reject_once";
    label = "🚫 Rejected";
  }

  acp.resolvePermission(pending.acpRequestId, optionId);
  try {
    await app.client.chat.update({
      channel: (body as any).channel?.id ?? (body as any).container?.channel_id,
      ts: (body as any).message?.ts,
      text: label,
      blocks: [],
    });
  } catch {}
});

// --- Graceful shutdown ---
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  if (acp?.alive) {
    for (const sessionId of activeSenders.keys()) {
      await acp.cancel(sessionId).catch(() => {});
    }
    acp.kill();
  }
  await app.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- Start ---
(async () => {
  await app.start();
  logger.info("⚡ Kiro Slack bot is running (Socket Mode)");
})();
