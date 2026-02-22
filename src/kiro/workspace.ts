import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const pad = (n: number, len = 2) => n.toString().padStart(len, "0");

export function ensureWorkspaceRoot(): string {
  if (!existsSync(config.workspaceRoot)) mkdirSync(config.workspaceRoot, { recursive: true });
  return config.workspaceRoot;
}

export function createWorkspaceDir(label?: string): string {
  const root = ensureWorkspaceRoot();
  const now = new Date();
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const base = label ? `${label}-${ts}` : `thread-${ts}`;
  let candidate = base;
  let i = 1;
  while (existsSync(join(root, candidate))) candidate = `${base}-${pad(i++)}`;
  const full = join(root, candidate);
  mkdirSync(full, { recursive: true });
  return full;
}
