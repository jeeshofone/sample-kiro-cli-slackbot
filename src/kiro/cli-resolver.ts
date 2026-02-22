import { accessSync, constants, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const DARWIN_APP_BUNDLE = "/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli";
const DARWIN_DESKTOP_APP = "/Applications/Kiro.app/Contents/MacOS/kiro-cli";
const BIN_NAME = process.platform === "win32" ? "kiro-cli.exe" : "kiro-cli";

const isExec = (p?: string | null): p is string => {
  if (!p) return false;
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

const searchPath = (name: string): string | undefined => {
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const c = join(dir, name);
    if (isExec(c)) return c;
  }
  return undefined;
};

let cached: string | undefined;

export function resolveKiroCliBinary(): string | undefined {
  if (cached) return cached;
  const envOverride = process.env.KIRO_CLI_PATH;
  if (isExec(envOverride)) { cached = envOverride; return cached; }
  const candidates = [
    process.platform === "darwin" ? DARWIN_APP_BUNDLE : undefined,
    process.platform === "darwin" ? DARWIN_DESKTOP_APP : undefined,
    searchPath(BIN_NAME),
  ].filter(Boolean) as string[];
  cached = candidates.find(isExec);
  return cached;
}

export function getEnhancedEnv(): Record<string, string | undefined> {
  const home = homedir();
  const extra = [
    "/usr/local/bin", "/opt/homebrew/bin",
    `${home}/.bun/bin`, `${home}/.local/bin`, `${home}/.volta/bin`,
    "/usr/bin", "/bin",
  ];
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ""].join(":") };
}
