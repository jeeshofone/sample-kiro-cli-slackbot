type Statistics = {
    cpuUsage: number;
    ramUsage: number;
    storageData: number;
}

type StaticData = {
    totalStorage: number;
    cpuModel: string;
    totalMemoryGB: number;
}

type UnsubscribeFunction = () => void;

type FileReadResult = {
    success: boolean;
    content?: string;
    error?: string;
    isText: boolean;
    mimeType?: string;
    fileType?: 'text' | 'image' | 'pdf' | 'excel' | 'ppt' | 'binary' | 'unknown';
    sheetNames?: string[];
}

type McpServersMap = import("./src/shared/mcp").McpServersMap;

type McpServersResponse = {
    success: boolean;
    servers?: McpServersMap;
    error?: string;
    settingsPath: string;
    cwd?: string;
}

type SaveMcpServersResult = {
    success: boolean;
    servers?: McpServersMap;
    error?: string;
    settingsPath: string;
    cwd?: string;
}

type NpxInstallPayload = {
    cwd: string;
    command: string;
}

type NpxInstallResult = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
}

type FileSelectionResult = string[] | null;

type CopyFilesPayload = {
    cwd: string;
    files: string[];
};

type CopyFilesResult = {
    success: boolean;
    copied?: Array<{ source: string; destination: string; filename: string }>;
    failed?: Array<{ source: string; error: string }>;
    error?: string;
};

type ClaudeCommandPayload = {
    cwd: string;
    command: string;
}

type ClaudeCommandResult = {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
}

type EventPayloadMapping = {
    statistics: Statistics;
    getStaticData: StaticData;
    "generate-session-title": string;
    "get-recent-cwds": string[];
    "select-directory": string | null;
    "read-file": FileReadResult;
    "open-file-external": boolean;
    "open-external-url": boolean;
    "file-exists": boolean;
    "get-mcp-servers": McpServersResponse;
    "save-mcp-servers": SaveMcpServersResult;
    "run-npx-install": NpxInstallResult;
    "select-files": FileSelectionResult;
    "copy-files-to-cwd": CopyFilesResult;
    "run-claude-command": ClaudeCommandResult;
}

interface Window {
    electron: {
        subscribeStatistics: (callback: (statistics: Statistics) => void) => UnsubscribeFunction;
        getStaticData: () => Promise<StaticData>;
        // Claude Agent IPC APIs
        sendClientEvent: (event: any) => void;
        onServerEvent: (callback: (event: any) => void) => UnsubscribeFunction;
        generateSessionTitle: (userInput: string | null) => Promise<string>;
        getRecentCwds: (limit?: number) => Promise<string[]>;
        selectDirectory: () => Promise<string | null>;
        selectFiles: () => Promise<FileSelectionResult>;
        // File operations
        readFile: (filePath: string) => Promise<FileReadResult>;
        openFileExternal: (filePath: string) => Promise<boolean>;
        openExternalUrl: (url: string) => Promise<boolean>;
        fileExists: (filePath: string) => Promise<boolean>;
        getMcpServers: (cwd?: string) => Promise<McpServersResponse>;
        saveMcpServers: (payload: { cwd: string; servers: McpServersMap }) => Promise<SaveMcpServersResult>;
        runNpxInstall: (payload: NpxInstallPayload) => Promise<NpxInstallResult>;
        runClaudeCommand: (payload: ClaudeCommandPayload) => Promise<ClaudeCommandResult>;
        copyFilesToCwd: (payload: CopyFilesPayload) => Promise<CopyFilesResult>;
    }
}
