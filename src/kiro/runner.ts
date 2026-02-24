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

// Tool output patterns — lines that indicate tool activity (not assistant text)
const TOOL_RE = /^(I'll |I will |Reading directory:|Purpose:|Creating:|Appending to:|- Completed in|✓ Successfully|[+-]\s+\d+:)/;

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
 *
 * The CLI prefixes the first line of assistant text with "> ".
 * Continuation lines have no prefix. Tool output matches TOOL_RE patterns.
 * We track mode (assistant vs tool) to correctly classify continuation lines.
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
    if (opts.prompt.trim()) { args.push("--"); args.push(opts.prompt); }

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
    let inAssistant = false;  // are we in assistant text mode?
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

    const classifyLine = (clean: string): "assistant" | "tool" => {
      if (clean.startsWith("> ")) return "assistant";
      if (TOOL_RE.test(clean)) return "tool";
      // Continuation: stay in current mode
      return inAssistant ? "assistant" : "tool";
    };

    const processLines = () => {
      const idx = raw.lastIndexOf("\n");
      if (idx === -1) return;
      const complete = raw.slice(0, idx);
      raw = raw.slice(idx + 1);

      for (const line of complete.split("\n")) {
        const clean = stripAnsi(line);
        if (!clean.trim() && !inAssistant) {
          if (isBanner(clean)) continue;
          continue;
        }
        if (isBanner(clean)) continue;

        const kind = classifyLine(clean);

        if (kind === "assistant") {
          flushTool();
          inAssistant = true;
          const text = clean.startsWith("> ") ? clean.slice(2) : clean;
          pendingText += text + "\n";
          scheduleTextFlush();
        } else {
          flushText();
          inAssistant = false;
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
        inAssistant = true;
        pendingText += clean.slice(2);
        scheduleTextFlush();
      } else if (inAssistant) {
        // Continuation of assistant text (word-by-word)
        pendingText += clean;
        scheduleTextFlush();
      } else if (clean.trim()) {
        pendingTool.push(clean);
        scheduleToolFlush();
      }
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
          if (clean.startsWith("> ")) pendingText += clean.slice(2);
          else if (inAssistant) pendingText += clean;
          else pendingTool.push(clean);
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
