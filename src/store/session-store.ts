import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { ensureWorkspaceRoot } from "../kiro/workspace.js";

type SessionEntry = {
  sessionId: string;
  cwd: string;
  createdAt: number;
};

type StoreData = Record<string, SessionEntry>; // key = "channel:threadTs"

const STORE_FILE = join(ensureWorkspaceRoot(), "sessions.json");

function load(): StoreData {
  if (!existsSync(STORE_FILE)) return {};
  try { return JSON.parse(readFileSync(STORE_FILE, "utf8")) as StoreData; } catch { return {}; }
}

function save(data: StoreData): void {
  writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function getSession(channel: string, threadTs: string): SessionEntry | undefined {
  return load()[threadKey(channel, threadTs)];
}

export function setSession(channel: string, threadTs: string, entry: SessionEntry): void {
  const data = load();
  data[threadKey(channel, threadTs)] = entry;
  save(data);
}
