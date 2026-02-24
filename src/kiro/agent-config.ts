import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../logger.js";

export type AgentInfo = { model?: string };
export type AgentSummary = { name: string; description?: string; model?: string; source: string };

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

/** List all available agents from global + optional project dirs */
export function listAgents(projectCwds?: string[]): AgentSummary[] {
  const seen = new Set<string>();
  const agents: AgentSummary[] = [];

  const scanDir = (dir: string, source: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") || f.endsWith(".example")) continue;
      const config = readConfig(join(dir, f));
      if (!config) continue;
      const name = (typeof config.name === "string" ? config.name : f.replace(".json", ""));
      if (seen.has(name)) continue;
      seen.add(name);
      agents.push({
        name,
        description: typeof config.description === "string" ? config.description : undefined,
        model: typeof config.model === "string" ? config.model : undefined,
        source,
      });
    }
  };

  // Project agents first (higher priority)
  for (const cwd of projectCwds ?? []) scanDir(join(cwd, ".kiro", "agents"), cwd);
  scanDir(join(homedir(), ".kiro", "agents"), "~/.kiro/agents");

  return agents;
}
