import { useCallback, useEffect, useRef, useState } from "react";
import type { CreatedFile } from "../types";
import MDContent from "../render/markdown";

type FileType = 'text' | 'image' | 'pdf' | 'excel' | 'ppt' | 'binary' | 'unknown';

interface FileSidebarProps {
  file: CreatedFile | null;
  content: string | null;
  fileType: FileType | null;
  sheetNames?: string[];
  loading: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onOpenExternal: (file: CreatedFile) => void;
}

// Get syntax highlighting language based on extension
function getLanguage(extension: string): string {
  const langMap: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    md: "markdown",
    markdown: "markdown",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    java: "java",
    go: "go",
    rs: "rust",
    rb: "ruby",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    r: "r",
    toml: "toml",
    ini: "ini",
    graphql: "graphql",
    vue: "vue",
    svelte: "svelte"
  };
  return langMap[extension.toLowerCase()] || "plaintext";
}

// Get file type display name
function getFileTypeName(extension: string): string {
  const typeNames: Record<string, string> = {
    pdf: "PDF Document",
    doc: "Word Document",
    docx: "Word Document",
    xls: "Excel Spreadsheet",
    xlsx: "Excel Spreadsheet",
    ppt: "PowerPoint Presentation",
    pptx: "PowerPoint Presentation",
    png: "PNG Image",
    jpg: "JPEG Image",
    jpeg: "JPEG Image",
    gif: "GIF Image",
    svg: "SVG Image",
    webp: "WebP Image"
  };
  return typeNames[extension.toLowerCase()] || `${extension.toUpperCase()} File`;
}

// Excel table viewer component
function ExcelViewer({ content, sheetNames }: { content: string | Record<string, any[][]>; sheetNames?: string[] }) {
  const [activeSheet, setActiveSheet] = useState(0);

  let sheets: Record<string, any[][]> = {};
  try {
    sheets = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    return <div className="p-4 text-sm text-error">Failed to parse Excel data</div>;
  }

  const sheetNamesList = sheetNames || Object.keys(sheets);
  const currentSheetName = sheetNamesList[activeSheet] ?? sheetNamesList[0];
  if (!currentSheetName) {
    return <div className="p-4 text-sm text-muted">No sheets available</div>;
  }
  const data = sheets[currentSheetName] || [];

  if (data.length === 0) {
    return <div className="p-4 text-sm text-muted">This sheet is empty</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sheet tabs */}
      {sheetNamesList.length > 1 && (
        <div className="flex border-b border-ink-900/10 bg-surface px-2 py-1 gap-1 overflow-x-auto">
          {sheetNamesList.map((name, idx) => (
            <button
              key={name}
              onClick={() => setActiveSheet(idx)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors whitespace-nowrap ${
                idx === activeSheet
                  ? "bg-white text-ink-800 border-t border-l border-r border-ink-900/10"
                  : "text-muted hover:text-ink-700 hover:bg-ink-900/5"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto p-2">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {data.map((row, rowIdx) => (
              <tr key={rowIdx} className={rowIdx === 0 ? "bg-surface font-medium" : rowIdx % 2 === 0 ? "bg-white" : "bg-surface/50"}>
                {/* Row number */}
                <td className="px-2 py-1.5 border border-ink-900/10 text-muted text-center w-10 bg-surface">
                  {rowIdx + 1}
                </td>
                {/* Cells */}
                {(row as any[]).map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    className="px-2 py-1.5 border border-ink-900/10 max-w-[200px] truncate"
                    title={String(cell ?? '')}
                  >
                    {cell !== null && cell !== undefined ? String(cell) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type PptSlide = {
  slideNumber: number;
  paragraphs: string[];
};

function PptViewer({ content }: { content: string | PptSlide[] }) {
  let slides: PptSlide[] = [];
  try {
    slides = typeof content === "string" ? JSON.parse(content) : content;
  } catch {
    return <div className="p-4 text-sm text-error">Failed to load presentation preview</div>;
  }

  if (!Array.isArray(slides) || slides.length === 0) {
    return <div className="p-4 text-sm text-muted">No slides found in this presentation.</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {slides.map((slide) => (
        <div key={slide.slideNumber} className="rounded-2xl border border-ink-900/10 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between text-sm font-semibold text-ink-800">
            <span>Slide {slide.slideNumber}</span>
          </div>
          <div className="mt-3 flex flex-col gap-2 text-sm text-ink-700">
            {slide.paragraphs.length > 0 ? (
              slide.paragraphs.map((paragraph, idx) => (
                <p key={idx} className="whitespace-pre-wrap leading-relaxed">
                  {paragraph}
                </p>
              ))
            ) : (
              <p className="text-muted text-xs">No text content detected on this slide.</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function FileSidebar({
  file,
  content,
  fileType,
  sheetNames,
  loading,
  width,
  onWidthChange,
  onClose,
  onOpenExternal
}: FileSidebarProps) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Handle resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      const clampedWidth = Math.min(Math.max(newWidth, 300), window.innerWidth - 400);
      onWidthChange(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onWidthChange]);

  if (!file) return null;

  const language = getLanguage(file.extension);
  const isMarkdown = file.extension === "md" || file.extension === "markdown";

  return (
    <div
      ref={sidebarRef}
      className="fixed inset-y-0 right-0 flex flex-col bg-white border-l border-ink-900/10 shadow-xl z-40"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        ref={resizeHandleRef}
        className={`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/50 transition-colors ${isResizing ? "bg-accent" : ""}`}
        onMouseDown={handleMouseDown}
      />

      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-ink-900/10 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">📄</span>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-ink-800 truncate">{file.name}</h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="truncate">{file.path}</span>
              <span className="rounded-full bg-surface-tertiary px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                {file.kind === "accessed" ? "Accessed" : "Created"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="rounded-lg p-2 text-ink-500 hover:bg-ink-900/10 hover:text-ink-700 transition-colors"
            onClick={() => onOpenExternal(file)}
            title="Open in default app"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
          <button
            className="rounded-lg p-2 text-ink-500 hover:bg-ink-900/10 hover:text-ink-700 transition-colors"
            onClick={onClose}
            title="Close"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <span className="text-sm text-muted">Loading file...</span>
            </div>
          </div>
        ) : fileType === 'text' && content !== null ? (
          <div className="p-4">
            {isMarkdown ? (
              <div className="prose prose-sm max-w-none">
                <MDContent text={content} />
              </div>
            ) : (
              <pre className="text-xs font-mono text-ink-700 whitespace-pre-wrap break-words bg-surface rounded-lg p-4 overflow-x-auto">
                <code className={`language-${language}`}>{content}</code>
              </pre>
            )}
          </div>
        ) : fileType === 'image' && content !== null ? (
          <div className="flex items-center justify-center p-4 h-full bg-[#f5f5f5]">
            <img
              src={content}
              alt={file.name}
              className="max-w-full max-h-full object-contain rounded-lg shadow-sm"
              onError={(e) => console.error('Image load error:', e, 'src length:', content?.length)}
            />
          </div>
        ) : fileType === 'pdf' && content !== null ? (
          <div className="h-full w-full">
            <embed
              src={`file://${content}`}
              type="application/pdf"
              className="w-full h-full"
            />
          </div>
        ) : fileType === 'excel' && content !== null ? (
          <ExcelViewer content={content} sheetNames={sheetNames} />
        ) : fileType === 'ppt' && content !== null ? (
          <PptViewer content={content} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-surface">
              <span className="text-4xl">
                {file.extension === "pdf" ? "📄" :
                 file.extension === "doc" || file.extension === "docx" ? "📝" :
                 file.extension === "xls" || file.extension === "xlsx" ? "📊" :
                 file.extension === "ppt" || file.extension === "pptx" ? "📽️" :
                 file.extension.match(/^(png|jpg|jpeg|gif|svg|webp)$/) ? "🖼️" : "📄"}
              </span>
            </div>
            <div>
              <h3 className="text-lg font-medium text-ink-800">{getFileTypeName(file.extension)}</h3>
              <p className="text-sm text-muted mt-1">
                This file type cannot be previewed inline.
              </p>
            </div>
            <button
              className="mt-2 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
              onClick={() => onOpenExternal(file)}
            >
              Open with Default App
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
