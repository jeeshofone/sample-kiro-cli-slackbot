import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolveKiroCliBinary, getEnhancedEnv } from "./cli-resolver.js";
import { loadConversation, type KiroHistoryEntry } from "./conversation.js";
import { logger } from "../logger.js";

export type RunnerHandle = {
  abort: () => void;
};

export type RunnerOptions = {
  prompt: string;
  cwd: string;
  agent: string;
  model?: string;
  resumeSessionId?: string;
};

/**
 * Spawns `kiro-cli chat` per prompt, polls the SQLite conversation log.
 * Emits: "delta" (text), "done" (conversationId), "error" (message)
 */
export class KiroRunner extends EventEmitter {
  private historyCursors = new Map<string, number>(); // cwd → cursor

  run(opts: RunnerOptions): RunnerHandle {
    const binary = resolveKiroCliBinary();
    if (!binary) {
      this.emit("error", "kiro-cli not found");
      return { abort: () => {} };
    }

    const args = ["chat", "--trust-all-tools", "--wrap", "never", "--no-interactive"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.agent) args.push("--agent", opts.agent);
    if (opts.resumeSessionId) args.push("--resume");
    if (opts.prompt.trim()) args.push(opts.prompt);

    logger.info({ binary, args: args.slice(0, 6), cwd: opts.cwd }, "spawning kiro-cli chat");

    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: { ...getEnhancedEnv(), NO_COLOR: "1", CLICOLOR: "0", KIRO_CLI_DISABLE_PAGER: "1" },
    });

    let closed = false;
    let aborted = false;

    child.stdout?.on("data", (d: Buffer) => {
      const t = d.toString().trim();
      if (t) logger.debug({ src: "kiro-stdout" }, t);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const t = d.toString().trim();
      if (t) logger.debug({ src: "kiro-stderr" }, t);
    });

    child.on("error", (err) => {
      if (closed) return;
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      this.emit("error", err.message);
    });

    const syncConversation = (throwOnMissing = true): boolean => {
      const record = loadConversation(opts.cwd);
      if (!record) {
        if (throwOnMissing) throw new Error("No conversation history written by kiro-cli");
        return false;
      }

      const total = record.history.length;
      const cursor = Math.min(this.historyCursors.get(opts.cwd) ?? 0, total);
      const newEntries = record.history.slice(cursor);

      if (newEntries.length === 0) return false;

      for (const entry of newEntries) {
        this.emitEntry(entry);
      }

      this.historyCursors.set(opts.cwd, total);
      return true;
    };

    let pollTimer: NodeJS.Timeout | null = setInterval(() => {
      try { syncConversation(false); } catch (e) {
        logger.warn({ err: e }, "poll sync failed");
      }
    }, 750);

    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      try {
        syncConversation(true);
        if (!aborted) {
          const record = loadConversation(opts.cwd);
          this.emit("done", record?.conversationId ?? null, code);
        }
      } catch (err) {
        this.emit("error", err instanceof Error ? err.message : "Failed to read conversation log");
      }
    });

    return {
      abort: () => {
        if (closed) return;
        aborted = true;
        child.kill("SIGINT");
      },
    };
  }

  /** Reset cursor for a cwd so next run picks up from current position */
  snapshotCursor(cwd: string): void {
    const record = loadConversation(cwd);
    if (record) this.historyCursors.set(cwd, record.history.length);
  }

  private emitEntry(entry: KiroHistoryEntry): void {
    // Assistant response text
    const assistant = entry.assistant;
    if (assistant && typeof assistant === "object") {
      const response = (assistant as any).Response;
      if (response?.content) {
        const text = this.extractText(response.content);
        if (text) this.emit("delta", text);
      }

      // Tool use
      const toolUse = (assistant as any).ToolUse;
      if (toolUse?.tool_uses && Array.isArray(toolUse.tool_uses)) {
        for (const tool of toolUse.tool_uses) {
          const name = tool.name ?? tool.orig_name ?? "tool";
          this.emit("tool_call", name, tool.args ?? tool.orig_args ?? {});
        }
      }
    }

    // Tool results from user content
    const user = entry.user;
    if (user && typeof user === "object") {
      const content = (user as any).content;
      if (content && typeof content === "object") {
        const results = content.ToolUseResults?.tool_use_results;
        if (Array.isArray(results)) {
          for (const r of results) {
            const stdout = r.stdout ?? "";
            const stderr = r.stderr ?? "";
            const status = r.status ?? "success";
            this.emit("tool_result", r.tool_use_id, { stdout, stderr, status, content: r.content });
          }
        }
      }
    }
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => {
          if (typeof c === "string") return c;
          if (c?.text) return c.text;
          if (c?.Text) return c.Text;
          return "";
        })
        .join("");
    }
    if (content && typeof content === "object" && "text" in content) return (content as any).text;
    return "";
  }
}
