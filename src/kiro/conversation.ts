import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cachedDb: Database.Database | undefined;
let cachedPath: string | undefined;

function resolveDataPath(): string | undefined {
  const supportDir = join(homedir(), "Library", "Application Support", "kiro-cli");
  const dbPath = join(supportDir, "data.sqlite3");
  return existsSync(dbPath) ? dbPath : undefined;
}

function getDb(): Database.Database | undefined {
  const path = resolveDataPath();
  if (!path) return undefined;
  if (cachedDb && cachedPath === path) return cachedDb;
  try { cachedDb?.close(); } catch {}
  cachedDb = new Database(path, { readonly: true, fileMustExist: true });
  cachedPath = path;
  return cachedDb;
}

export type KiroHistoryEntry = {
  user?: Record<string, unknown>;
  assistant?: Record<string, unknown>;
  request_metadata?: Record<string, unknown>;
};

export type KiroConversation = {
  key: string;
  conversationId: string;
  history: KiroHistoryEntry[];
};

type Row = { key: string; conversation_id: string; value: string };

export function loadConversation(key: string): KiroConversation | null {
  const db = getDb();
  if (!db) return null;
  const row = db
    .prepare("select key, conversation_id, value from conversations_v2 where key = ?")
    .get(key) as Row | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return {
      key: row.key,
      conversationId: row.conversation_id,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return null;
  }
}
