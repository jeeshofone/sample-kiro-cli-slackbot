import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolveKiroCliBinary, getEnhancedEnv } from "./cli-resolver.js";
import { logger } from "../logger.js";

const execAsync = promisify(exec);

/** Run a kiro-cli subcommand (e.g. "model", "compact") in the given cwd. */
export async function runKiroCommand(cwd: string, command: string): Promise<{ stdout: string; stderr: string; error?: string }> {
  const binary = resolveKiroCliBinary();
  if (!binary) return { stdout: "", stderr: "", error: "kiro-cli not found" };

  const quoted = binary.includes(" ") ? `"${binary}"` : binary;
  const full = `${quoted} ${command}`;
  logger.info({ cwd, command: full }, "running kiro command");

  try {
    const { stdout, stderr } = await execAsync(full, {
      cwd,
      env: { ...getEnhancedEnv(), NO_COLOR: "1", CLICOLOR: "0", KIRO_CLI_DISABLE_PAGER: "1" },
    });
    return { stdout, stderr };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      error: err.message ?? "Command failed",
    };
  }
}
