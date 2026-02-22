import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../logger.js";

type AcpMcpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };

/**
 * Load an agent's mcpServers config and convert to ACP format.
 * Searches project-local .kiro/agents/ first, then global ~/.kiro/agents/.
 */
export function loadAgentMcpServers(agent: string, projectCwd?: string): AcpMcpServer[] {
  const paths = [
    projectCwd ? join(projectCwd, ".kiro", "agents", `${agent}.json`) : "",
    join(homedir(), ".kiro", "agents", `${agent}.json`),
  ].filter(Boolean);

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const config = JSON.parse(readFileSync(p, "utf-8"));
      const servers = config.mcpServers;
      if (!servers || typeof servers !== "object") continue;

      const result: AcpMcpServer[] = [];
      for (const [name, def] of Object.entries(servers) as [string, any][]) {
        if (!def.command) continue;
        const env: { name: string; value: string }[] = [];
        if (def.env && typeof def.env === "object") {
          for (const [k, v] of Object.entries(def.env)) {
            env.push({ name: k, value: String(v) });
          }
        }
        result.push({ name, command: def.command, args: def.args ?? [], env });
      }
      logger.info({ agent, path: p, servers: result.map((s) => s.name) }, "loaded agent MCP servers");
      return result;
    } catch (e) {
      logger.warn({ agent, path: p, err: e }, "failed to load agent config");
    }
  }
  return [];
}
