/** ACP JSON-RPC types for kiro-cli acp over stdin/stdout */

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type AcpMessage = JsonRpcResponse | JsonRpcNotification;

// session/update types — the actual wire format from kiro-cli acp
export type SessionUpdate = {
  sessionUpdate: string; // "agent_message_chunk", "tool_use", "tool_result", etc.
  content?: { type: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
};
