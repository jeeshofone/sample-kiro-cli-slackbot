import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { resolveKiroCliBinary, getEnhancedEnv } from "../kiro/cli-resolver.js";
import { config } from "../config.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  AcpMessage,
  SessionUpdate,
} from "./types.js";
import { logger } from "../logger.js";

export type AcpSessionInfo = { sessionId: string; cwd: string };

/**
 * ACP JSON-RPC client over stdin/stdout.
 * Emits: "update" (sessionId, update), "turn_end" (sessionId), "error" (err), "exit" (code)
 */
export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initialized = false;
  private promptRequestIds = new Map<number, string>();

  // Terminal support: track spawned terminal processes
  private terminals = new Map<string, { proc: ChildProcess; output: string; exitCode: number | null; cwd?: string }>();
  private terminalCounter = 0;

  constructor(private agentOverride?: string) { super(); }

  async start(): Promise<void> {
    const binary = resolveKiroCliBinary();
    if (!binary) throw new Error("kiro-cli not found");
    const agent = this.agentOverride ?? config.kiroAgent;
    const args = ["acp", "--agent", agent];
    logger.info({ binary, args }, "spawning kiro-cli acp");

    this.proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...getEnhancedEnv(), NO_COLOR: "1", CLICOLOR: "0" },
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString().trim();
      if (text) logger.info({ src: "acp-stderr" }, text);
    });

    const rl = createInterface({ input: this.proc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.on("error", (err) => this.emit("error", err));
    this.proc.on("close", (code) => {
      logger.warn({ code }, "acp process exited");
      this.rejectAll(new Error(`acp exited with code ${code}`));
      this.emit("exit", code);
    });

    await this.initialize();
  }

  async createSession(cwd: string): Promise<AcpSessionInfo> {
    const result = (await this.request("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
    return { sessionId: result.sessionId, cwd };
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const id = this.nextId++;
    this.promptRequestIds.set(id, sessionId);
    this.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } });
  }

  async cancel(sessionId: string): Promise<void> {
    try { await this.request("session/cancel", { sessionId }); } catch { /* best effort */ }
  }

  kill(): void { this.proc?.kill("SIGTERM"); this.proc = null; }
  get alive(): boolean { return this.proc !== null && this.proc.exitCode === null; }

  resolvePermission(requestId: string | number, optionId: string): void {
    this.respond(requestId, { outcome: { outcome: "selected", optionId } });
  }

  // --- internals ---

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientName: "kiro-slack-bot",
      clientVersion: "0.1.0",
      protocolVersion: "0.1",
      clientCapabilities: {
        terminal: true,
        fs: { readTextFile: false, writeTextFile: false },
      },
    });
    this.initialized = true;
    logger.info("ACP initialized");
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`ACP request ${method} timed out`)); }
      }, 60_000);
    });
  }

  private send(msg: JsonRpcRequest): void {
    if (!this.proc?.stdin?.writable) throw new Error("ACP process not writable");
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private respond(id: string | number, result: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private handleLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;

    let msg: AcpMessage;
    try { msg = JSON.parse(trimmed) as AcpMessage; } catch { return; }

    const method = (msg as any).method as string | undefined;
    const id = (msg as any).id;

    // --- Client methods (requests FROM agent TO us) ---

    // Permission requests
    if (method === "session/request_permission") {
      const params = (msg as any).params;
      logger.info({ id, tool: params?.toolCall?.title }, "permission requested");
      this.emit("permission", params.sessionId, id, params.toolCall, params.options);
      return;
    }

    // Terminal methods
    if (method === "terminal/create") {
      this.handleTerminalCreate(id, (msg as any).params);
      return;
    }
    if (method === "terminal/output") {
      this.handleTerminalOutput(id, (msg as any).params);
      return;
    }
    if (method === "terminal/wait_for_exit") {
      this.handleTerminalWaitForExit(id, (msg as any).params);
      return;
    }
    if (method === "terminal/kill") {
      this.handleTerminalKill(id, (msg as any).params);
      return;
    }
    if (method === "terminal/release") {
      this.handleTerminalRelease(id, (msg as any).params);
      return;
    }

    // --- Responses to our requests ---
    if (id != null && !method) {
      const promptSessionId = this.promptRequestIds.get(id);
      if (promptSessionId) {
        this.promptRequestIds.delete(id);
        this.emit("turn_end", promptSessionId);
      }
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        const resp = msg as JsonRpcResponse;
        if (resp.error) p.reject(new Error(resp.error.message));
        else p.resolve(resp.result);
      }
      return;
    }

    // --- Notifications ---
    const notif = msg as JsonRpcNotification;
    if (notif.method === "session/update" && notif.params) {
      const sessionId = notif.params.sessionId as string;
      const update = notif.params.update as SessionUpdate;
      if (sessionId && update) {
        this.emit("update", sessionId, update);
      }
    }
  }

  // --- Terminal implementation ---

  private handleTerminalCreate(id: string | number, params: any): void {
    const termId = `term_${++this.terminalCounter}`;
    const cmd = params.command;
    const args = params.args ?? [];
    const cwd = params.cwd ?? undefined;
    const env = params.env ? Object.fromEntries(params.env.map((e: any) => [e.name, e.value])) : {};

    logger.info({ termId, cmd, args, cwd }, "terminal/create");

    const child = spawn(cmd, args, {
      cwd,
      env: { ...getEnhancedEnv(), ...env },
      shell: true,
    });

    const entry = { proc: child, output: "", exitCode: null as number | null, cwd };
    this.terminals.set(termId, entry);

    child.stdout?.on("data", (d: Buffer) => { entry.output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { entry.output += d.toString(); });
    child.on("close", (code) => { entry.exitCode = code; });

    this.respond(id, { terminalId: termId });
  }

  private handleTerminalOutput(id: string | number, params: any): void {
    const entry = this.terminals.get(params.terminalId);
    if (!entry) {
      this.respond(id, { output: "", truncated: false });
      return;
    }
    this.respond(id, {
      output: entry.output,
      truncated: false,
      ...(entry.exitCode !== null ? { exitStatus: { exitCode: entry.exitCode } } : {}),
    });
  }

  private handleTerminalWaitForExit(id: string | number, params: any): void {
    const entry = this.terminals.get(params.terminalId);
    if (!entry) {
      this.respond(id, { exitCode: 1 });
      return;
    }
    if (entry.exitCode !== null) {
      this.respond(id, { exitCode: entry.exitCode });
      return;
    }
    entry.proc.on("close", (code) => {
      this.respond(id, { exitCode: code ?? 1 });
    });
  }

  private handleTerminalKill(id: string | number, params: any): void {
    const entry = this.terminals.get(params.terminalId);
    if (entry && entry.exitCode === null) entry.proc.kill("SIGTERM");
    this.respond(id, {});
  }

  private handleTerminalRelease(id: string | number, params: any): void {
    const entry = this.terminals.get(params.terminalId);
    if (entry && entry.exitCode === null) entry.proc.kill("SIGTERM");
    this.terminals.delete(params.terminalId);
    this.respond(id, {});
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
