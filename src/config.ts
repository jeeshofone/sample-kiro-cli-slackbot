import { resolve } from "node:path";
import { homedir } from "node:os";

function env(key: string, fallback?: string): string {
  const val = process.env[key];
  if (val !== undefined && val !== "") return val;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
}

function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export const config = {
  slackBotToken: env("SLACK_BOT_TOKEN"),
  slackAppToken: env("SLACK_APP_TOKEN"),
  allowedUserIds: process.env.ALLOWED_USER_IDS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
  kiroAgent: env("KIRO_AGENT", "default"),
  workspaceRoot: expandHome(env("WORKSPACE_ROOT", "~/Documents/workspace-kiro-slack")),
  defaultCwd: process.env.DEFAULT_CWD ? expandHome(process.env.DEFAULT_CWD) : undefined,
  toolApproval: env("TOOL_APPROVAL", "auto") as "auto" | "interactive",
} as const;
