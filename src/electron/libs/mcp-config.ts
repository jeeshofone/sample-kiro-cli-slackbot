import { readFile, writeFile } from "fs/promises";
import { join, resolve as resolvePath } from "path";
import { homedir } from "os";
import type { McpServersMap } from "../../shared/mcp.js";

type ProjectConfig = {
  mcpServers?: McpServersMap;
  [key: string]: unknown;
};

type ClaudeConfig = {
  projects?: Record<string, ProjectConfig>;
  [key: string]: unknown;
};

const CLAUDE_CONFIG_PATH = join(homedir(), ".claude.json");
export function getClaudeSettingsPath(): string {
  return CLAUDE_CONFIG_PATH;
}

async function readClaudeConfig(): Promise<ClaudeConfig> {
  try {
    const raw = await readFile(CLAUDE_CONFIG_PATH, "utf8");
    return JSON.parse(raw) as ClaudeConfig;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new Error(`Failed to read Claude settings (${CLAUDE_CONFIG_PATH}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeClaudeConfig(data: ClaudeConfig): Promise<void> {
  const payload = JSON.stringify(data, null, 2) + "\n";
  await writeFile(CLAUDE_CONFIG_PATH, payload, "utf8");
}

function normalizeProjectPath(preferred?: string): string {
  const target = preferred && preferred.trim() ? preferred : process.cwd();
  return resolvePath(target);
}

function ensureProject(config: ClaudeConfig, preferredPath?: string): ProjectConfig {
  if (!config.projects || typeof config.projects !== "object") {
    config.projects = {};
  }
  const key = normalizeProjectPath(preferredPath);
  if (!config.projects[key] || typeof config.projects[key] !== "object") {
    config.projects[key] = {};
  }
  return config.projects[key];
}

export async function loadMcpServers(projectPath?: string): Promise<McpServersMap> {
  const config = await readClaudeConfig();
  const project = ensureProject(config, projectPath);
  if (!project.mcpServers || typeof project.mcpServers !== "object" || Array.isArray(project.mcpServers)) {
    return {};
  }
  return project.mcpServers as McpServersMap;
}

export async function saveMcpServers(projectPath: string | undefined, next: McpServersMap): Promise<McpServersMap> {
  const config = await readClaudeConfig();
  const project = ensureProject(config, projectPath);
  const ordered = Object.keys(next).sort().reduce<McpServersMap>((acc, key) => {
    acc[key] = next[key];
    return acc;
  }, {});
  project.mcpServers = ordered;
  await writeClaudeConfig(config);
  return ordered;
}
