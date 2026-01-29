import electron from "electron";
import type { McpServersMap } from "../shared/mcp.js";

electron.contextBridge.exposeInMainWorld("electron", {
    subscribeStatistics: (callback) =>
        ipcOn("statistics", stats => {
            callback(stats);
        }),
    getStaticData: () => ipcInvoke("getStaticData"),
    
    // Claude Agent IPC APIs
    sendClientEvent: (event: any) => {
        electron.ipcRenderer.send("client-event", event);
    },
    onServerEvent: (callback: (event: any) => void) => {
        const cb = (_: Electron.IpcRendererEvent, payload: string) => {
            try {
                const event = JSON.parse(payload);
                callback(event);
            } catch (error) {
                console.error("Failed to parse server event:", error);
            }
        };
        electron.ipcRenderer.on("server-event", cb);
        return () => electron.ipcRenderer.off("server-event", cb);
    },
    generateSessionTitle: (userInput: string | null) =>
        ipcInvoke("generate-session-title", userInput),
    getRecentCwds: (limit?: number) =>
        ipcInvoke("get-recent-cwds", limit),
    selectDirectory: () =>
        ipcInvoke("select-directory"),
    selectFiles: () =>
        ipcInvoke("select-files"),
    // File operations
    readFile: (filePath: string) =>
        ipcInvoke("read-file", filePath),
    openFileExternal: (filePath: string) =>
        ipcInvoke("open-file-external", filePath),
    openExternalUrl: (url: string) =>
        ipcInvoke("open-external-url", url),
    fileExists: (filePath: string) =>
        ipcInvoke("file-exists", filePath),
    getMcpServers: (cwd?: string) =>
        ipcInvoke("get-mcp-servers", cwd),
    saveMcpServers: (payload: { cwd: string; servers: McpServersMap }) =>
        ipcInvoke("save-mcp-servers", payload),
    runNpxInstall: (payload: NpxInstallPayload) =>
        ipcInvoke("run-npx-install", payload),
    runClaudeCommand: (payload: ClaudeCommandPayload) =>
        ipcInvoke("run-claude-command", payload),
    copyFilesToCwd: (payload: CopyFilesPayload) =>
        ipcInvoke("copy-files-to-cwd", payload)
} satisfies Window['electron'])

function ipcInvoke<Key extends keyof EventPayloadMapping>(key: Key, ...args: any[]): Promise<EventPayloadMapping[Key]> {
    return electron.ipcRenderer.invoke(key, ...args);
}

function ipcOn<Key extends keyof EventPayloadMapping>(key: Key, callback: (payload: EventPayloadMapping[Key]) => void) {
    const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload)
    electron.ipcRenderer.on(key, cb);
    return () => electron.ipcRenderer.off(key, cb)
}
