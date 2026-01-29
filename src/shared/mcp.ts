export type McpServerConfig = {
  type?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: string | Record<string, unknown>;
  [key: string]: unknown;
};

export type McpServersMap = Record<string, McpServerConfig>;
