import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { McpServerConfig, McpServersMap } from "../types";
import { useEffectiveCwd } from "../hooks/useEffectiveCwd";

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

type EnvEntry = {
  key: string;
  value: string;
};

type NewServerForm = {
  name: string;
  command: string;
  argsText: string;
  envEntries: EnvEntry[];
};

function createEmptyEnvEntries(): EnvEntry[] {
  return [{ key: "", value: "" }];
}

function createEmptyForm(): NewServerForm {
  return {
    name: "",
    command: "",
    argsText: "",
    envEntries: createEmptyEnvEntries(),
  };
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [servers, setServers] = useState<McpServersMap>({});
  const [newServer, setNewServer] = useState<NewServerForm>(() => createEmptyForm());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updatingServer, setUpdatingServer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [settingsPath, setSettingsPath] = useState<string | null>(null);
  const [installCommand, setInstallCommand] = useState<string>("claude mcp add ");
  const [installing, setInstalling] = useState(false);
  const [installOutput, setInstallOutput] = useState<string | null>(null);

  const orderedServers = useMemo(() => {
    return Object.entries(servers).sort(([a], [b]) => a.localeCompare(b));
  }, [servers]);

  const cwd = useEffectiveCwd();
  const displayCwd = cwd || "not set";

  const resetForm = useCallback(() => {
    setNewServer(createEmptyForm());
    setFormError(null);
    setSuccessMessage(null);
  }, []);

  const fetchServers = useCallback(async () => {
    const targetCwd = cwd.trim();
    if (!targetCwd) {
      setServers({});
      setError("Set a working directory to manage MCP servers.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await window.electron.getMcpServers(targetCwd);
      setSettingsPath(response.settingsPath ?? null);
      if (!response.success) {
        throw new Error(response.error || "Failed to load MCP tools");
      }
      setServers(response.servers ?? {});
    } catch (err) {
      console.error("Failed to load MCP servers:", err);
      setServers({});
      setError(err instanceof Error ? err.message : "Unable to load MCP tools");
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (open) {
      fetchServers();
    } else {
      resetForm();
      setError(null);
    }
  }, [open, fetchServers, resetForm, cwd]);

  const handleEnvChange = (index: number, field: keyof EnvEntry, value: string) => {
    setNewServer((prev) => {
      const updated = prev.envEntries.map((entry, idx) => (idx === index ? { ...entry, [field]: value } : entry));
      return { ...prev, envEntries: updated };
    });
  };

  const addEnvRow = () => {
    setNewServer((prev) => ({ ...prev, envEntries: [...prev.envEntries, { key: "", value: "" }] }));
  };

  const removeEnvRow = (index: number) => {
    setNewServer((prev) => {
      const filtered = prev.envEntries.filter((_, idx) => idx !== index);
      return { ...prev, envEntries: filtered.length ? filtered : createEmptyEnvEntries() };
    });
  };

  const handleAddServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    const trimmedName = newServer.name.trim();
    const trimmedCommand = newServer.command.trim();

    if (!trimmedName) {
      setFormError("Server name is required");
      return;
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedName)) {
      setFormError("Server name may only contain letters, numbers, dashes, underscores, and periods");
      return;
    }

    if (servers[trimmedName]) {
      setFormError(`An MCP server named "${trimmedName}" already exists`);
      return;
    }

    if (!trimmedCommand) {
      setFormError("Command is required");
      return;
    }

    const args = newServer.argsText
      .split("\n")
      .map((arg) => arg.trim())
      .filter(Boolean);

    const env: Record<string, string> = {};
    for (const entry of newServer.envEntries) {
      const key = entry.key.trim();
      if (key) {
        env[key] = entry.value;
      }
    }

    const nextConfig: McpServerConfig = {
      command: trimmedCommand,
    };
    if (args.length) nextConfig.args = args;
    if (Object.keys(env).length) nextConfig.env = env;

    const nextServers: McpServersMap = { ...servers, [trimmedName]: nextConfig };

    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) {
      setFormError("Set a working directory before saving MCP servers.");
      return;
    }

    setSaving(true);
    try {
      const response = await window.electron.saveMcpServers({ cwd: trimmedCwd, servers: nextServers });
      if (!response.success || !response.servers) {
        throw new Error(response.error || "Unable to save MCP server");
      }
      setServers(response.servers);
      setSuccessMessage(`Added "${trimmedName}"`);
      resetForm();
    } catch (err) {
      console.error("Failed to add MCP server:", err);
      setFormError(err instanceof Error ? err.message : "Unable to save MCP server");
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveServer = async (name: string) => {
    if (!window.confirm(`Remove MCP server "${name}"?`)) return;
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) {
      setFormError("Set a working directory before modifying MCP servers.");
      return;
    }

    const nextServers = { ...servers };
    delete nextServers[name];

    setSaving(true);
    setFormError(null);
    setSuccessMessage(null);
    try {
      const response = await window.electron.saveMcpServers({ cwd: trimmedCwd, servers: nextServers });
      if (!response.success || !response.servers) {
        throw new Error(response.error || "Unable to remove MCP server");
      }
      setServers(response.servers);
    } catch (err) {
      console.error("Failed to remove MCP server:", err);
      setFormError(err instanceof Error ? err.message : "Unable to remove MCP server");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleServer = async (name: string, enabled: boolean) => {
    const existing = servers[name];
    if (!existing) return;
    const trimmedCwd = cwd.trim();
    if (!trimmedCwd) {
      setFormError("Set a working directory before modifying MCP servers.");
      return;
    }
    const nextServers: McpServersMap = {
      ...servers,
      [name]: { ...existing, disabled: !enabled }
    };

    setUpdatingServer(name);
    setFormError(null);
    setSuccessMessage(null);
    try {
      const response = await window.electron.saveMcpServers({ cwd: trimmedCwd, servers: nextServers });
      if (!response.success || !response.servers) {
        throw new Error(response.error || "Unable to update MCP server");
      }
      setServers(response.servers);
    } catch (err) {
      console.error("Failed to toggle MCP server:", err);
      setFormError(err instanceof Error ? err.message : "Unable to update MCP server");
    } finally {
      setUpdatingServer(null);
    }
  };

  const renderToggle = (name: string, config: McpServerConfig) => {
    const isEnabled = config.disabled !== true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={isEnabled}
        onClick={() => handleToggleServer(name, !isEnabled)}
        disabled={updatingServer === name}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          isEnabled ? "bg-success" : "bg-ink-200"
        } ${updatingServer === name ? "opacity-60 cursor-not-allowed" : ""}`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
            isEnabled ? "translate-x-5" : "translate-x-1"
          }`}
        />
        <span className="sr-only">Toggle {name}</span>
      </button>
    );
  };

  const handleRunInstall = async () => {
    const trimmedCommand = installCommand.trim();
    const trimmedCwd = cwd.trim();
    setFormError(null);
    setSuccessMessage(null);
    setInstallOutput(null);

    if (!trimmedCommand) {
      setFormError("Enter a command to run.");
      return;
    }
    if (!trimmedCwd) {
      setFormError("Set a working directory before running the command.");
      return;
    }

    setInstalling(true);
    try {
      const result = await window.electron.runNpxInstall({
        cwd: trimmedCwd,
        command: trimmedCommand
      });
      if (!result.success) {
        throw new Error(result.error || "Failed to run command");
      }
      setSuccessMessage("Command completed successfully.");
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      setInstallOutput(output || "Command finished with no output.");
      fetchServers();
    } catch (err) {
      console.error("Failed to run command:", err);
      setFormError(err instanceof Error ? err.message : "Unable to run command");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink-900/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-xl font-semibold text-ink-900">Settings</Dialog.Title>
              <p className="text-sm text-muted">Manage Claude Code MCP tools</p>
            </div>
            <Dialog.Close asChild>
              <button className="rounded-full p-1.5 text-ink-500 hover:bg-ink-900/10" aria-label="Close settings" onClick={onClose}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 6l12 12M18 6l-12 12" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {settingsPath && (
            <div className="mt-3 rounded-xl border border-ink-900/10 bg-surface px-3 py-2 text-xs text-muted">
              Editing: <span className="font-mono text-ink-700">{settingsPath}</span>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-xl border border-error/20 bg-error/5 px-3 py-2 text-sm text-error">
              {error}
            </div>
          )}

          <div className="mt-4 rounded-2xl border border-ink-900/10 bg-white p-4">
            <h3 className="text-sm font-semibold text-ink-800">Install MCP via claude CLI</h3>
            <p className="mt-1 text-xs text-muted">
              Run the full command (e.g. <code>claude mcp add playwright npx @playwright/mcp@latest</code>) in your selected working directory ({displayCwd}).
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <input
                type="text"
                className="rounded-lg border border-ink-900/20 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                value={installCommand}
                onChange={(e) => setInstallCommand(e.target.value)}
                placeholder="claude mcp add my-server npx @package/mcp@latest"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                  onClick={handleRunInstall}
                  disabled={installing}
                >
                  {installing ? "Running…" : "Run command in Working Directory"}
                </button>
                {!cwd && (
                  <span className="text-xs text-error">Set a working directory (or select a session) before running the command.</span>
                )}
              </div>
              {installOutput && (
                <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface px-2 py-2 text-xs text-ink-700">
                  {installOutput}
                </pre>
              )}
            </div>
          </div>

          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink-800">Configured MCP Servers</h3>
            <button
              className="text-xs font-medium text-ink-500 hover:text-ink-800"
              onClick={fetchServers}
              disabled={loading}
            >
              Refresh
            </button>
          </div>
              <div className="rounded-2xl border border-ink-900/10 bg-surface p-3 max-h-[360px] overflow-y-auto">
                {loading ? (
                  <div className="flex items-center justify-center py-10 text-sm text-muted">Loading…</div>
                ) : orderedServers.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted">No MCP servers configured yet.</div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {orderedServers.map(([name, config]) => {
                      const isHttp = (config.type ?? "stdio") === "http";
                      const secondary = isHttp ? (config.url || "HTTP server") : (config.command || "Unknown command");
                      return (
                        <div key={name} className="rounded-xl border border-ink-900/10 bg-white p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <div className="text-sm font-semibold text-ink-900">{name}</div>
                                <span className={`text-xs font-semibold ${config.disabled ? "text-error" : "text-success"}`}>
                                  {config.disabled ? "Disabled" : "Enabled"}
                                </span>
                                <span className="rounded-full bg-surface-tertiary px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                                  {isHttp ? "HTTP" : "STDIO"}
                                </span>
                              </div>
                              <div className="text-xs text-muted break-all">
                                {secondary}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {renderToggle(name, config)}
                              <button
                                className="rounded-lg px-2 py-1 text-xs text-error hover:bg-error/10"
                                onClick={() => handleRemoveServer(name)}
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        {config.args && config.args.length > 0 && (
                          <div className="mt-2 text-xs text-muted">
                            Args:{" "}
                            <span className="font-mono text-ink-800">
                              {config.args.join(" ")}
                            </span>
                          </div>
                        )}
                        {config.env && Object.keys(config.env).length > 0 && (
                          <div className="mt-2 text-xs text-muted">
                            Env:
                            <div className="mt-1 flex flex-wrap gap-1">
                              {Object.entries(config.env).map(([envKey, value]) => (
                                <span key={envKey} className="rounded-full bg-surface-tertiary px-2 py-0.5 font-mono text-[11px] text-ink-700">
                                  {envKey}={<span className="text-ink-900">{value}</span>}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-ink-900/10 bg-white p-4">
              <h3 className="text-sm font-semibold text-ink-800">Add MCP Server</h3>
              <form className="mt-4 flex flex-col gap-4" onSubmit={handleAddServer}>
                <label className="text-xs font-medium text-muted">
                  Server name
                  <input
                    type="text"
                    className="mt-1 w-full rounded-lg border border-ink-900/20 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                    value={newServer.name}
                    onChange={(e) => setNewServer((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="filesystem"
                  />
                </label>
                <label className="text-xs font-medium text-muted">
                  Command
                  <input
                    type="text"
                    className="mt-1 w-full rounded-lg border border-ink-900/20 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                    value={newServer.command}
                    onChange={(e) => setNewServer((prev) => ({ ...prev, command: e.target.value }))}
                    placeholder="npx"
                  />
                </label>
                <label className="text-xs font-medium text-muted">
                  Arguments <span className="text-[11px] text-muted">(one per line)</span>
                  <textarea
                    className="mt-1 h-20 w-full rounded-lg border border-ink-900/20 px-3 py-2 text-sm focus:border-accent focus:outline-none"
                    value={newServer.argsText}
                    onChange={(e) => setNewServer((prev) => ({ ...prev, argsText: e.target.value }))}
                    placeholder={`@modelcontextprotocol/server-browser\n--no-sandbox`}
                  />
                </label>
                <div>
                  <div className="text-xs font-medium text-muted">Environment variables</div>
                  <div className="mt-2 flex flex-col gap-2">
                    {newServer.envEntries.map((entry, index) => (
                      <div key={index} className="flex gap-2">
                        <input
                          type="text"
                          className="flex-1 rounded-lg border border-ink-900/20 px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
                          placeholder="KEY"
                          value={entry.key}
                          onChange={(e) => handleEnvChange(index, "key", e.target.value)}
                        />
                        <input
                          type="text"
                          className="flex-1 rounded-lg border border-ink-900/20 px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
                          placeholder="value"
                          value={entry.value}
                          onChange={(e) => handleEnvChange(index, "value", e.target.value)}
                        />
                        <button
                          type="button"
                          className="rounded-lg px-2 text-xs text-muted hover:text-error"
                          onClick={() => removeEnvRow(index)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button type="button" className="text-xs font-medium text-accent" onClick={addEnvRow}>
                      + Add variable
                    </button>
                  </div>
                </div>

                {formError && (
                  <div className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs text-error">{formError}</div>
                )}
                {successMessage && (
                  <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-xs text-success">{successMessage}</div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <button type="button" className="text-xs font-medium text-muted hover:text-ink-800" onClick={resetForm}>
                    Clear
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save MCP Server"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
