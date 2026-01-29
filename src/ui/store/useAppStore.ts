import { create } from 'zustand';
import type { ServerEvent, SessionStatus, StreamMessage, CreatedFile } from "../types";

export type CommandResult = {
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  createdAt: number;
};

export type PermissionRequest = {
  toolUseId: string;
  toolName: string;
  input: unknown;
};

export type SessionView = {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  messages: StreamMessage[];
  permissionRequests: PermissionRequest[];
  lastPrompt?: string;
  createdAt?: number;
  updatedAt?: number;
  hydrated: boolean;
  createdFiles: CreatedFile[];
};

interface AppState {
  sessions: Record<string, SessionView>;
  activeSessionId: string | null;
  prompt: string;
  cwd: string;
  pendingStart: boolean;
  globalError: string | null;
  sessionsLoaded: boolean;
  showStartModal: boolean;
  historyRequested: Set<string>;
  commandResult: CommandResult | null;

  // File sidebar state
  fileSidebarOpen: boolean;
  fileSidebarWidth: number;
  openedFile: CreatedFile | null;
  fileContent: string | null;
  fileType: 'text' | 'image' | 'pdf' | 'excel' | 'ppt' | 'binary' | 'unknown' | null;
  fileSheetNames: string[] | undefined;
  fileLoading: boolean;

  setPrompt: (prompt: string) => void;
  setCwd: (cwd: string) => void;
  setPendingStart: (pending: boolean) => void;
  setGlobalError: (error: string | null) => void;
  setShowStartModal: (show: boolean) => void;
  setActiveSessionId: (id: string | null) => void;
  markHistoryRequested: (sessionId: string) => void;
  resolvePermissionRequest: (sessionId: string, toolUseId: string) => void;
  setCommandResult: (result: CommandResult | null) => void;
  handleServerEvent: (event: ServerEvent) => void;

  // File sidebar actions
  setFileSidebarOpen: (open: boolean) => void;
  setFileSidebarWidth: (width: number) => void;
  setOpenedFile: (file: CreatedFile | null) => void;
  setFileContent: (content: string | null) => void;
  setFileType: (fileType: 'text' | 'image' | 'pdf' | 'excel' | 'ppt' | 'binary' | 'unknown' | null) => void;
  setFileSheetNames: (sheetNames: string[] | undefined) => void;
  setFileLoading: (loading: boolean) => void;
  addCreatedFile: (sessionId: string, file: CreatedFile) => void;
}

const toolKindMap = new Map<string, CreatedFile["kind"]>();

function getToolKey(sessionId: string, toolUseId: unknown): string | null {
  return typeof toolUseId === "string" ? `${sessionId}:${toolUseId}` : null;
}

function createSession(id: string): SessionView {
  return { id, title: "", status: "idle", messages: [], permissionRequests: [], hydrated: false, createdFiles: [] };
}

function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

function getFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function normalizeFilePath(filePath: string, cwd?: string): string {
  let normalized = filePath.trim();
  normalized = normalized.replace(/\\"/g, "").replace(/\\\\/g, "/").replace(/\\/g, "/");
  const hasProtocol = /^[a-zA-Z]+:\/\//.test(normalized);
  const hasDrive = /^[a-zA-Z]:/.test(normalized);

  if (!hasProtocol && !hasDrive && cwd && !normalized.startsWith("/")) {
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    normalized = `${base}/${normalized}`;
  }

  normalized = normalized.replace(/\/+/g, "/");

  const drivePrefix = hasDrive ? normalized.slice(0, 2) : "";
  const withoutDrive = hasDrive ? normalized.slice(2) : normalized;
  const isAbsolute = drivePrefix !== "" || withoutDrive.startsWith("/");
  const segments = withoutDrive.split("/");

  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(segment);
  }

  let collapsed = stack.join("/");
  if (drivePrefix) {
    collapsed = `${drivePrefix}${collapsed ? `/${collapsed}` : ""}`;
  } else if (isAbsolute) {
    collapsed = `/${collapsed}`;
  } else if (!collapsed) {
    collapsed = ".";
  }
  return collapsed;
}

const ACCESS_TOOL_NAMES = new Set([
  "read",
  "filesystem_read",
  "filesystem.read",
  "file_read",
  "file.read",
  "read_file",
  "readfile"
]);

function getFileKindForTool(toolName: unknown): CreatedFile["kind"] {
  if (typeof toolName !== "string") return "created";
  const normalized = toolName.toLowerCase();
  if (ACCESS_TOOL_NAMES.has(normalized)) return "accessed";
  if (normalized.includes("read") && !normalized.includes("spread")) return "accessed";
  if (normalized.includes("glob") || normalized.includes("grep")) return "accessed";
  return "created";
}

function extractFilesFromMessage(msg: StreamMessage, sessionId: string, cwd?: string): CreatedFile[] {
  const files: CreatedFile[] = [];
  const seenPaths = new Set<string>();

  const addFile = (rawPath: string, kind: CreatedFile["kind"], source: CreatedFile["source"]) => {
    const path = normalizeFilePath(rawPath, cwd);
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    files.push({
      path,
      name: getFileName(path),
      extension: getFileExtension(path),
      createdAt: Date.now(),
      sessionId,
      kind,
      source
    });
  };

  let matchedToolKey: string | null = null;
  try {
    if (!msg || typeof msg !== "object") return files;

    const anyMessage = msg as any;
    if (anyMessage?.type === "assistant" && Array.isArray(anyMessage.message?.content)) {
      for (const content of anyMessage.message.content) {
        if (content?.type !== "tool_use") continue;
        const input = content.input as Record<string, unknown> | undefined;
        const filePath = typeof input?.file_path === "string" ? input.file_path :
          typeof input?.path === "string" ? input.path : null;
        if (!filePath) continue;
        const kind = getFileKindForTool(content.name);
        const key = getToolKey(sessionId, content.id);
        if (key) toolKindMap.set(key, kind);
        addFile(filePath, kind, "tool");
      }
    }

    const msgStr = JSON.stringify(msg);
    const binaryFileExtensions = /(?:^|[\s"'(])([\/\w][\w\/\-\.]*\.(xlsx|xls|xlsm|xlsb|csv|pdf|docx|doc|pptx|ppt|png|jpg|jpeg|gif|svg|zip|tar|gz))(?:[\s"'),]|$)/gi;
    let binaryMatch;
    let regexKind: CreatedFile["kind"] = anyMessage?.type === "assistant" ? "created" : "accessed";
    if (anyMessage?.type === "user" && Array.isArray(anyMessage.message?.content)) {
      const resultContent = anyMessage.message.content.find(
        (item: any) => item?.type === "tool_result" && typeof item.tool_use_id === "string"
      );
      if (resultContent) {
        matchedToolKey = getToolKey(sessionId, resultContent.tool_use_id);
        regexKind = (matchedToolKey && toolKindMap.get(matchedToolKey)) || "accessed";
      } else {
        regexKind = "accessed";
      }
    }
    while ((binaryMatch = binaryFileExtensions.exec(msgStr)) !== null) {
      const rawPath = binaryMatch[1];
      const filePath = rawPath.replace(/\\"/g, "").replace(/\\\//g, "/");
      // Skip URLs, package paths, and very short matches
      if (filePath.includes('://') ||
          filePath.includes('node_modules') ||
          filePath.includes('site-packages') ||
          filePath.length < 3) {
        continue;
      }
      addFile(filePath, regexKind, "regex");
    }
  } catch (e) {
    console.error('Error extracting files from message:', e);
  } finally {
    if (matchedToolKey) {
      toolKindMap.delete(matchedToolKey);
    }
  }
  return files;
}

function shouldReplaceFile(existing: CreatedFile, incoming: CreatedFile): boolean {
  if (existing.kind === incoming.kind) {
    return existing.source === "regex" && incoming.source === "tool";
  }

  if (incoming.kind === "created") {
    return true;
  }

  if (existing.kind === "created" && incoming.kind === "accessed") {
    return existing.source === "regex" && incoming.source === "tool";
  }

  return false;
}

function extractAllFilesFromHistory(messages: StreamMessage[], sessionId: string, cwd?: string): CreatedFile[] {
  const byPath = new Map<string, CreatedFile>();

  for (const msg of messages) {
    const extractedFiles = extractFilesFromMessage(msg, sessionId, cwd);
    for (const file of extractedFiles) {
      const existing = byPath.get(file.path);
      if (!existing || shouldReplaceFile(existing, file)) {
        byPath.set(file.path, file);
      }
    }
  }

  return Array.from(byPath.values());
}

export const useAppStore = create<AppState>((set, get) => ({
  sessions: {},
  activeSessionId: null,
  prompt: "",
  cwd: "",
  pendingStart: false,
  globalError: null,
  sessionsLoaded: false,
  showStartModal: false,
  historyRequested: new Set(),
  commandResult: null,

  // File sidebar state
  fileSidebarOpen: false,
  fileSidebarWidth: 400,
  openedFile: null,
  fileContent: null,
  fileType: null,
  fileSheetNames: undefined,
  fileLoading: false,

  setPrompt: (prompt) => set({ prompt }),
  setCwd: (cwd) => set({ cwd }),
  setPendingStart: (pendingStart) => set({ pendingStart }),
  setGlobalError: (globalError) => set({ globalError }),
  setShowStartModal: (showStartModal) => set({ showStartModal }),
  setActiveSessionId: (id) => set({ activeSessionId: id }),

  // File sidebar actions
  setFileSidebarOpen: (fileSidebarOpen) => set({ fileSidebarOpen }),
  setFileSidebarWidth: (fileSidebarWidth) => set({ fileSidebarWidth }),
  setOpenedFile: (openedFile) => set({ openedFile }),
  setFileContent: (fileContent) => set({ fileContent }),
  setFileType: (fileType) => set({ fileType }),
  setFileSheetNames: (fileSheetNames) => set({ fileSheetNames }),
  setFileLoading: (fileLoading) => set({ fileLoading }),
  addCreatedFile: (sessionId, file) => {
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return {};
      const files = [...existing.createdFiles];
      const existingIndex = files.findIndex(f => f.path === file.path);
      if (existingIndex >= 0) {
        const current = files[existingIndex];
        if (current.kind === "accessed" && file.kind === "created") {
          files[existingIndex] = file;
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                createdFiles: files
              }
            }
          };
        }
        return {};
      }
      files.push(file);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            createdFiles: files
          }
        }
      };
    });
  },

  markHistoryRequested: (sessionId) => {
    set((state) => {
      const next = new Set(state.historyRequested);
      next.add(sessionId);
      return { historyRequested: next };
    });
  },

  resolvePermissionRequest: (sessionId, toolUseId) => {
    set((state) => {
      const existing = state.sessions[sessionId];
      if (!existing) return {};
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existing,
            permissionRequests: existing.permissionRequests.filter(req => req.toolUseId !== toolUseId)
          }
        }
      };
    });
  },

  setCommandResult: (result) => set({ commandResult: result }),


  handleServerEvent: (event) => {
    const state = get();

    switch (event.type) {
      case "session.list": {
        const nextSessions: Record<string, SessionView> = {};
        for (const session of event.payload.sessions) {
          const existing = state.sessions[session.id] ?? createSession(session.id);
          nextSessions[session.id] = {
            ...existing,
            status: session.status,
            title: session.title,
            cwd: session.cwd,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
          };
        }

        set({ sessions: nextSessions, sessionsLoaded: true });

        const hasSessions = event.payload.sessions.length > 0;
        set({ showStartModal: !hasSessions });

        if (!hasSessions) {
          get().setActiveSessionId(null);
        }

        if (!state.activeSessionId && event.payload.sessions.length > 0) {
          const sorted = [...event.payload.sessions].sort((a, b) => {
            const aTime = a.updatedAt ?? a.createdAt ?? 0;
            const bTime = b.updatedAt ?? b.createdAt ?? 0;
            return aTime - bTime;
          });
          const latestSession = sorted[sorted.length - 1];
          if (latestSession) {
            get().setActiveSessionId(latestSession.id);
          }
        } else if (state.activeSessionId) {
          const stillExists = event.payload.sessions.some(
            (session) => session.id === state.activeSessionId
          );
          if (!stillExists) {
            get().setActiveSessionId(null);
          }
        }
        break;
      }

      case "session.history": {
        const { sessionId, messages, status } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          const createdFiles = extractAllFilesFromHistory(messages, sessionId, existing.cwd);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...existing, status, messages, hydrated: true, createdFiles }
            }
          };
        });
        break;
      }

      case "session.status": {
        const { sessionId, status, title, cwd } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          const shouldResetFiles = status !== "running";
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                status,
                title: title ?? existing.title,
                cwd: cwd ?? existing.cwd,
                updatedAt: Date.now(),
                createdFiles: shouldResetFiles ? [] : existing.createdFiles
              }
            }
          };
        });

        if (state.pendingStart) {
          get().setActiveSessionId(sessionId);
          set({ pendingStart: false, showStartModal: false });
        }
        break;
      }

      case "session.deleted": {
        const { sessionId } = event.payload;
        const state = get();
        if (!state.sessions[sessionId]) break;
        const nextSessions = { ...state.sessions };
        delete nextSessions[sessionId];
        set({
          sessions: nextSessions,
          showStartModal: Object.keys(nextSessions).length === 0
        });
        if (state.activeSessionId === sessionId) {
          const remaining = Object.values(nextSessions).sort(
            (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
          );
          get().setActiveSessionId(remaining[0]?.id ?? null);
        }
        break;
      }

      case "stream.message": {
        const { sessionId, message } = event.payload;
        const currentState = get();
        const existingSession = currentState.sessions[sessionId];
        const cwdForDetection = existingSession?.cwd;

        const newFiles = extractFilesFromMessage(message, sessionId, cwdForDetection);

        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          const updatedFiles = [...existing.createdFiles];

          for (const newFile of newFiles) {
            const index = updatedFiles.findIndex(f => f.path === newFile.path);
            if (index === -1) {
              updatedFiles.push(newFile);
              continue;
            }
            if (shouldReplaceFile(updatedFiles[index], newFile)) {
              updatedFiles[index] = newFile;
            }
          }

          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                messages: [...existing.messages, message],
                createdFiles: updatedFiles
              }
            }
          };
        });
        break;
      }

      case "stream.user_prompt": {
        const { sessionId, prompt } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                messages: [...existing.messages, { type: "user_prompt", prompt }]
              }
            }
          };
        });
        break;
      }

      case "permission.request": {
        const { sessionId, toolUseId, toolName, input } = event.payload;
        set((state) => {
          const existing = state.sessions[sessionId] ?? createSession(sessionId);
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...existing,
                permissionRequests: [...existing.permissionRequests, { toolUseId, toolName, input }]
              }
            }
          };
        });
        break;
      }

      case "runner.error": {
        set({ globalError: event.payload.message });
        break;
      }
    }
  }
}));
