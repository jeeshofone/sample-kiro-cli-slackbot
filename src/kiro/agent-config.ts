import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../logger.js";

export type AgentInfo = { model?: string };

function findAgentConfig(agent: string, projectCwd?: string): string | undefined {
  const paths = [
    projectCwd ? join(projectCwd, ".kiro", "agents", `${agent}.json`) : "",
    join(homedir(), ".kiro", "agents", `${agent}.json`),
  ].filter(Boolean);
  return paths.find((p) => existsSync(p));
}

function readConfig(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

/** Load model name from agent config */
export function loadAgentInfo(agent: string, projectCwd?: string): AgentInfo {
  const p = findAgentConfig(agent, projectCwd);
  if (!p) return {};
  const config = readConfig(p);
  if (!config) return {};
  return { model: typeof config.model === "string" ? config.model : undefined };
}
