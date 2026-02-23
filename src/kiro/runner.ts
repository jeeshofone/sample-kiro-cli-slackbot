import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolveKiroCliBinary, getEnhancedEnv } from "./cli-resolver.js";
import { logger } from "../logger.js";

export type RunnerHandle = { abort: () => void };

export type RunnerOptions = {
  prompt: string;
  cwd: string;
  agent: string;
  model?: string;
  resume?: boolean;
};

const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const BANNER_RE = /^(Picking up|Did you know|Model:|Plan:|All tools are now trusted|Agents can sometimes|Learn more at|WARNING:|understand the risks|╭|│|╰|✓ \d+ of|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Thinking\.\.\.|▸ Credits)/;
const MCP_INIT_RE = /^\d+ of \d+ mcp servers|^✓ .+ loaded in|ctrl-c to start/;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r/g, "");
}

function isBanner(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return BANNER_RE.test(t) || MCP_INIT_RE.test(t);
}

/**
 * Spawns `kiro-cli chat --no-interactive` per prompt, streams stdout in real-time.
 * Emits: "delta" (text), "tool" (lines[]), "done" (code), "error" (msg)
 */
export class KiroRunner extends EventEmitter {
  run(opts: RunnerOptions): RunnerHandle {
    const binary = resolveKiroCliBinary();
    if (!binary) {
      this.emit("error", "kiro-cli not found");
      return { abort: () => {} };
    }

    const args = ["chat", "--trust-all-tools", "--wrap", "never", "--no-interactive"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.agent) args.push("--agent", opts.agent);
    if (opts.resume) args.push("--resume");
    if (opts.prompt.trim()) args.push(opts.prompt);

    logger.info({ binary, args: args.join(" ").slice(0, 120), cwd: opts.cwd }, "spawning kiro-cli chat");

    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: { ...getEnhancedEnv(), NO_COLOR: "1", CLICOLOR: "0", KIRO_CLI_DISABLE_PAGER: "1" },
    });

    let closed = false;
    let aborted = false;
    let raw = "";
    let pendingText = "";
    let pendingTool: string[] = [];
    let textTimer: NodeJS.Timeout | null = null;
    let toolTimer: NodeJS.Timeout | null = null;

    const flushText = () => {
      if (textTimer) { clearTimeout(textTimer); textTimer = null; }
      if (pendingText) {
        this.emit("delta", pendingText);
        pendingText = "";
      }
    };

    const flushTool = () => {
      if (toolTimer) { clearTimeout(toolTimer); toolTimer = null; }
      if (pendingTool.length) {
        this.emit("tool", pendingTool);
        pendingTool = [];
      }
    };

    const scheduleTextFlush = () => {
      if (textTimer) clearTimeout(textTimer);
      textTimer = setTimeout(flushText, 500);
    };

    const scheduleToolFlush = () => {
      if (toolTimer) clearTimeout(toolTimer);
      toolTimer = setTimeout(flushTool, 200);
    };

    const processLines = () => {
      const idx = raw.lastIndexOf("\n");
      if (idx === -1) return;
      const complete = raw.slice(0, idx);
      raw = raw.slice(idx + 1);

      for (const line of complete.split("\n")) {
        const clean = stripAnsi(line);
        if (!clean.trim() || isBanner(clean)) continue;

        if (clean.startsWith("> ")) {
          flushTool();
          pendingText += clean.slice(2) + "\n";
          scheduleTextFlush();
        } else {
          flushText();
          pendingTool.push(clean);
          scheduleToolFlush();
        }
      }
    };

    const processTrailing = () => {
      if (!raw) return;
      const clean = stripAnsi(raw);
      raw = "";
      if (isBanner(clean)) return;

      if (clean.startsWith("> ")) {
        flushTool();
        pendingText += clean.slice(2);
      } else {
        // Word-by-word assistant text (no > prefix on continuation)
        // If we're in tool mode, this is tool text; otherwise assistant
        if (pendingTool.length) {
          pendingTool.push(clean);
          scheduleToolFlush();
        } else {
          pendingText += clean;
        }
      }
      scheduleTextFlush();
    };

    child.stdout?.on("data", (d: Buffer) => {
      raw += d.toString();
      processLines();
      processTrailing();
    });

    child.stderr?.on("data", (d: Buffer) => {
      const t = d.toString().trim();
      if (t) logger.debug({ src: "kiro-stderr" }, t);
    });

    child.on("error", (err) => {
      if (closed) return;
      closed = true;
      flushTool();
      flushText();
      this.emit("error", err.message);
    });

    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      if (raw) {
        const clean = stripAnsi(raw);
        if (!isBanner(clean)) {
          pendingText += clean.startsWith("> ") ? clean.slice(2) : clean;
        }
        raw = "";
      }
      flushTool();
      flushText();
      if (!aborted) this.emit("done", code);
    });

    return {
      abort: () => {
        if (closed) return;
        aborted = true;
        child.kill("SIGINT");
      },
    };
  }
}
