import { spawn, type ChildProcess } from "node:child_process";
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
// Lines to suppress from the CLI banner
const BANNER_RE = /^(Picking up|Did you know|Model:|Plan:|All tools are now trusted|Agents can sometimes|Learn more at|WARNING:|understand the risks|╭|│|╰|✓ \d+ of|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Thinking\.\.\.|▸ Credits)/;
const MCP_INIT_RE = /^\d+ of \d+ mcp servers|^✓ .+ loaded in|ctrl-c to start/;

/**
 * Spawns `kiro-cli chat` per prompt, streams stdout in real-time.
 * Emits: "delta" (text), "tool" (text), "done" (code), "error" (msg)
 */
export class KiroRunner extends EventEmitter {
  run(opts: RunnerOptions): RunnerHandle {
    const binary = resolveKiroCliBinary();
    if (!binary) {
      this.emit("error", "kiro-cli not found");
      return { abort: () => {} };
    }

    const args = ["chat", "--trust-all-tools", "--wrap", "never"];
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
    let buf = "";

    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      // Process complete lines + trailing partial
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // keep incomplete line in buffer
      for (const raw of lines) this.processLine(raw);
      // Also process trailing partial if it looks complete (word-by-word streaming)
      if (buf.trim()) {
        this.processLine(buf);
        buf = "";
      }
    });

    child.stderr?.on("data", (d: Buffer) => {
      const t = d.toString().trim();
      if (t) logger.debug({ src: "kiro-stderr" }, t);
    });

    child.on("error", (err) => {
      if (closed) return;
      closed = true;
      this.emit("error", err.message);
    });

    child.on("close", (code) => {
      if (closed) return;
      closed = true;
      // Flush remaining buffer
      if (buf.trim()) this.processLine(buf);
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

  private processLine(raw: string): void {
    const clean = raw.replace(ANSI_RE, "").replace(/\r/g, "");
    if (!clean.trim()) return;
    if (BANNER_RE.test(clean.trim())) return;
    if (MCP_INIT_RE.test(clean.trim())) return;

    if (clean.startsWith("> ")) {
      // Assistant response text
      this.emit("delta", clean.slice(2));
    } else {
      // Tool output
      this.emit("tool", clean);
    }
  }
}
