import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  DEFAULT_SETTINGS,
  isTauriRuntime,
  listenForOpenFiles,
  loadSession,
  normalizeSettings,
  openWorkspace,
  readFile,
  saveSession,
  searchWorkspace,
  takePendingOpenFiles,
  startupFiles,
  validateAndFormatJson,
  validateAndFormatJsonl,
  writeFile,
} from "./api";
import type {
  AppAppearance,
  AppSettings,
  EditorViewState,
  FileTab,
  FormatResult,
  SearchHit,
  SessionState,
  WorkspaceEntry,
  WorkspaceNode,
} from "./types";
import "./App.css";

type ToastTone = "info" | "success" | "error";

type Toast = {
  id: number;
  message: string;
  tone: ToastTone;
};

type MarkdownViewMode = "editor" | "split" | "preview";
type QuickJumpCandidate = {
  path: string;
  name: string;
  workspacePath: string | null;
  source: "open" | "workspace" | "current";
  line: number | null;
  column?: number | null;
  score: number;
};
type EditorSnapshot = NonNullable<
  ReturnType<Parameters<OnMount>[0]["saveViewState"]>
>;
type CreatableFileExtension =
  | "txt"
  | "md"
  | "json"
  | "jsonl"
  | "yaml"
  | "yml"
  | "toml"
  | "log";

const SUPPORTED_TEXT_EXTENSIONS: readonly CreatableFileExtension[] = [
  "txt",
  "md",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "log",
];
const CREATABLE_FILE_EXTENSIONS: CreatableFileExtension[] = [...SUPPORTED_TEXT_EXTENSIONS];
const SEARCHABLE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "log",
]);
const DEFAULT_SEARCH_FEEDBACK = "Choose a workspace and click Run.";
const QUICK_JUMP_SHIFT_WINDOW = 320;
const QUICK_JUMP_RESULT_LIMIT = 12;

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

function inferLanguage(extension: string) {
  if (extension === "json") {
    return "json";
  }
  if (extension === "md" || extension === "markdown") {
    return "markdown";
  }
  if (extension === "jsonl") {
    return "jsonl";
  }
  if (extension === "yaml" || extension === "yml") {
    return "yaml";
  }
  if (extension === "toml") {
    return "ini";
  }
  return "plaintext";
}

function isMarkdownFile(extension: string) {
  return extension === "md" || extension === "markdown";
}

function supportsFormatting(extension: string) {
  return extension === "json" || extension === "jsonl";
}

function supportsTextZoom(extension: string) {
  return extension === "txt" || extension === "md" || extension === "markdown";
}

function isSearchableExtension(extension: string) {
  return SEARCHABLE_EXTENSIONS.has(extension.toLowerCase());
}

function shortenPath(filePath: string) {
  const parts = filePath.split(/[/\\]+/);
  return parts.slice(-3).join("/");
}

function fileNameFromPath(filePath: string) {
  const parts = normalizePath(filePath).split("/");
  return parts[parts.length - 1] ?? filePath;
}

function mergeRecentFiles(previous: string[], nextPath: string) {
  return [nextPath, ...previous.filter((item) => item !== nextPath)].slice(0, 10);
}

function uniquePaths(paths: string[]) {
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

function collectWorkspaceFilePaths(node: WorkspaceNode): string[] {
  if (!node.isDir) {
    return [node.path];
  }

  return node.children.flatMap((child) => collectWorkspaceFilePaths(child));
}

function parseQuickJumpInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      query: "",
      line: null as number | null,
      lineOnly: false,
    };
  }

  if (/^\d+$/.test(trimmed)) {
    return {
      query: "",
      line: Math.max(1, Number(trimmed)),
      lineOnly: true,
    };
  }

  const matched = trimmed.match(/^(.*?)(?:[:#](\d+))$/);
  if (!matched) {
    return {
      query: trimmed,
      line: null as number | null,
      lineOnly: false,
    };
  }

  return {
    query: matched[1].trim(),
    line: Math.max(1, Number(matched[2])),
    lineOnly: false,
  };
}

function scoreQuickJumpCandidate(path: string, name: string, query: string) {
  if (!query) {
    return 0;
  }

  const normalizedQuery = query.toLowerCase();
  const normalizedName = name.toLowerCase();
  const normalizedPath = normalizePath(path).toLowerCase();

  if (normalizedName === normalizedQuery) {
    return 0;
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 1;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 2;
  }

  if (normalizedPath.endsWith(`/${normalizedQuery}`)) {
    return 3;
  }

  if (normalizedPath.includes(normalizedQuery)) {
    return 4;
  }

  return 10;
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "true");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
}

function groupHits(hits: SearchHit[]) {
  const grouped = new Map<string, SearchHit[]>();

  for (const hit of hits) {
    const bucket = grouped.get(hit.filePath) ?? [];
    bucket.push(hit);
    grouped.set(hit.filePath, bucket);
  }

  return Array.from(grouped.entries());
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function getEditorModelPath(editor: Parameters<OnMount>[0]) {
  const uri = editor.getModel()?.uri;
  if (!uri) {
    return null;
  }

  if (uri.scheme && uri.scheme !== "file" && uri.scheme !== "untitled") {
    return null;
  }

  const rawPath = uri.path ? decodeURIComponent(uri.path) : "";
  return rawPath ? normalizePath(rawPath) : null;
}

function fileDirectory(filePath: string) {
  const normalized = normalizePath(filePath).replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return normalized;
  }
  return normalized.slice(0, separatorIndex);
}

function joinPath(parent: string, name: string) {
  return `${normalizePath(parent).replace(/\/+$/, "")}/${name}`;
}

function isInsideWorkspace(filePath: string, workspacePath: string) {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedWorkspacePath = normalizePath(workspacePath).replace(/\/+$/, "");
  return (
    normalizedFilePath === normalizedWorkspacePath ||
    normalizedFilePath.startsWith(`${normalizedWorkspacePath}/`)
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchContent(
  filePath: string,
  content: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  const hits: SearchHit[] = [];
  const matcher = wholeWord
    ? new RegExp(`\\b${escapeRegExp(query)}\\b`, caseSensitive ? "g" : "gi")
    : null;

  content.split("\n").forEach((line, lineIndex) => {
    if (matcher) {
      for (const matched of line.matchAll(matcher)) {
        const start = (matched.index ?? 0) + 1;
        hits.push({
          filePath,
          lineNumber: lineIndex + 1,
          columnStart: start,
          columnEnd: start + query.length,
          lineText: line,
        });
      }
      return;
    }

    const source = caseSensitive ? line : line.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    let offset = 0;

    while (needle && offset <= source.length) {
      const found = source.indexOf(needle, offset);
      if (found === -1) {
        break;
      }

      hits.push({
        filePath,
        lineNumber: lineIndex + 1,
        columnStart: found + 1,
        columnEnd: found + query.length + 1,
        lineText: line,
      });
      offset = found + Math.max(query.length, 1);
    }
  });

  return hits;
}

function clampTextZoom(value: number) {
  return Math.min(1.8, Math.max(0.8, Number(value.toFixed(2))));
}

function stripKnownExtension(value: string) {
  return value.trim().replace(/\.(txt|md|markdown|json|jsonl|yaml|yml|toml|log)$/i, "");
}

function countEditableFiles(node: WorkspaceNode): number {
  if (!node.isDir) {
    const extension = node.name.split(".").pop()?.toLowerCase() ?? "txt";
    return isSearchableExtension(extension) ? 1 : 0;
  }

  return node.children.reduce((total, child) => total + countEditableFiles(child), 0);
}

function workspaceContainsPath(node: WorkspaceNode | null, targetPath: string): boolean {
  if (!node) {
    return false;
  }

  if (normalizePath(node.path) === normalizePath(targetPath)) {
    return true;
  }

  return node.children.some((child) => workspaceContainsPath(child, targetPath));
}

function findWorkspacePathForFile(filePath: string, workspacePaths: string[]) {
  const matches = workspacePaths
    .filter((workspacePath) => isInsideWorkspace(filePath, workspacePath))
    .sort((left, right) => right.length - left.length);

  return matches[0] ?? null;
}

function replaceWorkspaceEntry(
  previous: WorkspaceEntry[],
  nextEntry: WorkspaceEntry,
  activate = true,
) {
  const existingIndex = previous.findIndex((item) => item.path === nextEntry.path);
  if (existingIndex === -1) {
    return activate ? [nextEntry, ...previous] : [...previous, nextEntry];
  }

  const next = [...previous];
  next.splice(existingIndex, 1, nextEntry);
  if (!activate) {
    return next;
  }

  return [nextEntry, ...next.filter((item) => item.path !== nextEntry.path)];
}

function defineEditorTheme(monaco: Monaco) {
  if (
    !monaco.languages
      .getLanguages()
      .some((item: { id: string }) => item.id === "jsonl")
  ) {
    monaco.languages.register({ id: "jsonl" });
    monaco.languages.setMonarchTokensProvider("jsonl", {
      tokenizer: {
        root: [
          [/[{}[\]]/, "delimiter.bracket"],
          [/"([^"\\]|\\.)*"(?=\s*:)/, "key"],
          [/"([^"\\]|\\.)*"/, "string"],
          [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
          [/\b(true|false|null)\b/, "keyword"],
        ],
      },
    });
  }

  monaco.editor.defineTheme("studio-sand", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "key", foreground: "8d4b25" },
      { token: "string", foreground: "255c72" },
      { token: "number", foreground: "8e3b46" },
      { token: "keyword", foreground: "965d00", fontStyle: "bold" },
    ],
    colors: {
      "editor.background": "#fffdf7",
      "editorLineNumber.foreground": "#9d8f7f",
      "editorLineNumber.activeForeground": "#5f5147",
      "editor.selectionBackground": "#ead9c5",
      "editor.inactiveSelectionBackground": "#f1e7db",
      "editorCursor.foreground": "#9c3d2d",
    },
  });

  monaco.editor.defineTheme("studio-paper", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "key", foreground: "2f5b74" },
      { token: "string", foreground: "2d7b52" },
      { token: "number", foreground: "8a4a2f" },
      { token: "keyword", foreground: "355f90", fontStyle: "bold" },
    ],
    colors: {
      "editor.background": "#fcfdff",
      "editorLineNumber.foreground": "#9aa6b3",
      "editorLineNumber.activeForeground": "#3f5368",
      "editor.selectionBackground": "#dfe8f3",
      "editor.inactiveSelectionBackground": "#ebf1f7",
      "editorCursor.foreground": "#355f90",
    },
  });

  monaco.editor.defineTheme("studio-midnight", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "key", foreground: "f3b269" },
      { token: "string", foreground: "88c8a7" },
      { token: "number", foreground: "d29bff" },
      { token: "keyword", foreground: "7ec8ff", fontStyle: "bold" },
    ],
    colors: {
      "editor.background": "#101720",
      "editorLineNumber.foreground": "#5f7388",
      "editorLineNumber.activeForeground": "#c8d9ea",
      "editor.selectionBackground": "#27435b",
      "editor.inactiveSelectionBackground": "#1a2b3b",
      "editorCursor.foreground": "#f2c078",
    },
  });
}

function TreeNode({
  node,
  level,
  activePath,
  collapsedPaths,
  onToggle,
  onOpen,
}: {
  node: WorkspaceNode;
  level: number;
  activePath: string | null;
  collapsedPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const collapsed = collapsedPaths.has(node.path);
  const style = { paddingLeft: `${level * 14 + 10}px` };

  if (node.isDir) {
    return (
      <div className="tree-node">
        <button className="tree-row tree-folder" style={style} onClick={() => onToggle(node.path)}>
          <span className="tree-caret">{collapsed ? ">" : "v"}</span>
          <span>{node.name}</span>
        </button>
        {!collapsed &&
          node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              level={level + 1}
              activePath={activePath}
              collapsedPaths={collapsedPaths}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      className={`tree-row tree-file ${activePath === node.path ? "active" : ""}`}
      style={style}
      onClick={() => onOpen(node.path)}
    >
      <span className="tree-caret"> </span>
      <span>{node.name}</span>
    </button>
  );
}

function App() {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [searchText, setSearchText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const [searchFeedback, setSearchFeedback] = useState(DEFAULT_SEARCH_FEEDBACK);
  const [searching, setSearching] = useState(false);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>("split");
  const [markdownSplitRatio, setMarkdownSplitRatio] = useState(0.58);
  const [jsonlStatus, setJsonlStatus] = useState<FormatResult | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createFileOpen, setCreateFileOpen] = useState(false);
  const [createFileName, setCreateFileName] = useState("");
  const [createFileExtension, setCreateFileExtension] = useState<CreatableFileExtension>("md");
  const [creatingFile, setCreatingFile] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [quickJumpOpen, setQuickJumpOpen] = useState(false);
  const [quickJumpQuery, setQuickJumpQuery] = useState("");
  const [quickJumpIndex, setQuickJumpIndex] = useState(0);

  const appShellRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const quickJumpInputRef = useRef<HTMLInputElement | null>(null);
  const editorLayoutRef = useRef<HTMLDivElement | null>(null);
  const workspacesRef = useRef<WorkspaceEntry[]>([]);
  const tabsRef = useRef<FileTab[]>([]);
  const activeTabPathRef = useRef<string | null>(null);
  const viewStateRef = useRef<Record<string, EditorViewState>>({});
  const editorViewSnapshotsRef = useRef<Record<string, EditorSnapshot>>({});
  const restoringViewPathRef = useRef<string | null>(null);
  const pendingViewStateRef = useRef<EditorViewState | null>(null);
  const sessionReadyRef = useRef(false);
  const pendingExternalOpenFilesRef = useRef<string[]>([]);
  const toastIdRef = useRef(0);
  const shiftPressedAtRef = useRef(0);
  const resizeStateRef = useRef<{ pointerId: number; type: "markdown" | "sidebar" } | null>(null);

  useEffect(() => {
    workspacesRef.current = workspaces;
    tabsRef.current = tabs;
    activeTabPathRef.current = activeTabPath;
  }, [workspaces, tabs, activeTabPath]);

  const activeTab = tabs.find((tab) => tab.path === activeTabPath) ?? null;
  const activeWorkspace =
    workspaces.find((item) => item.path === workspacePath) ?? workspaces[0] ?? null;
  const markdownActive = activeTab ? isMarkdownFile(activeTab.extension) : false;
  const zoomEnabled = activeTab ? supportsTextZoom(activeTab.extension) : false;
  const showEditorPanel = !markdownActive || markdownViewMode !== "preview";
  const showPreviewPanel = markdownActive && markdownViewMode !== "editor";
  const groupedResults = useMemo(() => groupHits(searchResults), [searchResults]);
  const totalWorkspaceFiles = useMemo(
    () => workspaces.reduce((total, item) => total + countEditableFiles(item.tree), 0),
    [workspaces],
  );
  const workspaceFileCount = useMemo(
    () => (activeWorkspace ? countEditableFiles(activeWorkspace.tree) : 0),
    [activeWorkspace],
  );
  const createFileDirectory = useMemo(() => {
    const activeFileWorkspacePath = activeTab?.workspacePath ?? null;
    if (activeFileWorkspacePath && activeTabPath && isInsideWorkspace(activeTabPath, activeFileWorkspacePath)) {
      return fileDirectory(activeTabPath);
    }

    if (!activeWorkspace?.path) {
      return null;
    }

    return activeWorkspace.path;
  }, [activeTab, activeTabPath, activeWorkspace]);
  const createFileTargetPath =
    createFileDirectory && stripKnownExtension(createFileName)
      ? joinPath(
          createFileDirectory,
          `${stripKnownExtension(createFileName)}.${createFileExtension}`,
        )
      : null;
  const editorTheme =
    settings.appearance === "night"
      ? "studio-midnight"
      : settings.appearance === "paper"
        ? "studio-paper"
        : "studio-sand";
  const editorFontSize = zoomEnabled ? Math.round(14 * settings.textZoom) : 14;
  const editorLineHeight = zoomEnabled ? Math.round(22 * settings.textZoom) : 22;
  const previewHtml = markdownActive && activeTab
    ? DOMPurify.sanitize(markdown.render(activeTab.content))
    : "";
  const previewBodyStyle = markdownActive
    ? ({ fontSize: `${settings.textZoom}rem` } as CSSProperties)
    : undefined;
  const shellLayoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
  } as CSSProperties;
  const quickJumpTarget = useMemo(() => parseQuickJumpInput(quickJumpQuery), [quickJumpQuery]);
  const quickJumpCandidates = useMemo<QuickJumpCandidate[]>(() => {
    const candidates: QuickJumpCandidate[] = [];
    const seenPaths = new Set<string>();
    const query = quickJumpTarget.query.trim();
    const line = quickJumpTarget.line;

    if (quickJumpTarget.lineOnly && activeTab) {
      return [
        {
          path: activeTab.path,
          name: activeTab.name,
          workspacePath: activeTab.workspacePath,
          source: "current",
          line,
          score: 0,
        },
      ];
    }

    for (const tab of tabs) {
      const score = scoreQuickJumpCandidate(tab.path, tab.name, query);
      if (query && score > 4) {
        continue;
      }

      const normalizedPath = normalizePath(tab.path);
      if (seenPaths.has(normalizedPath)) {
        continue;
      }
      seenPaths.add(normalizedPath);
      candidates.push({
        path: tab.path,
        name: tab.name,
        workspacePath: tab.workspacePath,
        source: "open",
        line,
        score,
      });
    }

    if (activeWorkspace) {
      for (const filePath of collectWorkspaceFilePaths(activeWorkspace.tree)) {
        const normalizedPath = normalizePath(filePath);
        if (seenPaths.has(normalizedPath)) {
          continue;
        }

        const name = fileNameFromPath(filePath);
        const score = scoreQuickJumpCandidate(filePath, name, query);
        if (query && score > 4) {
          continue;
        }

        seenPaths.add(normalizedPath);
        candidates.push({
          path: filePath,
          name,
          workspacePath: activeWorkspace.path,
          source: "workspace",
          line,
          score,
        });
      }
    }

    const sourceRank = {
      current: 0,
      open: 1,
      workspace: 2,
    } as const;

    return candidates
      .sort((left, right) => {
        const sourceCompare = sourceRank[left.source] - sourceRank[right.source];
        if (sourceCompare !== 0) {
          return sourceCompare;
        }

        if (left.score !== right.score) {
          return left.score - right.score;
        }

        const nameCompare = left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        });
        if (nameCompare !== 0) {
          return nameCompare;
        }

        return left.path.localeCompare(right.path, undefined, {
          sensitivity: "base",
        });
      })
      .slice(0, QUICK_JUMP_RESULT_LIMIT);
  }, [quickJumpTarget, tabs, activeWorkspace, activeTab]);

  function pushToast(message: string, tone: ToastTone = "info") {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((previous) => [...previous, { id, message, tone }].slice(-4));
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((item) => item.id !== id));
    }, 3200);
  }

  function openQuickJump(initialQuery = "") {
    setQuickJumpQuery(initialQuery);
    setQuickJumpIndex(0);
    setQuickJumpOpen(true);
  }

  function closeQuickJump() {
    setQuickJumpOpen(false);
    setQuickJumpQuery("");
    setQuickJumpIndex(0);
  }

  function recordActiveViewState() {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const currentPath = getEditorModelPath(editor) ?? activeTabPathRef.current;
    if (!currentPath) {
      return;
    }

    if (restoringViewPathRef.current === normalizePath(currentPath)) {
      return;
    }

    const position = editor.getPosition();
    if (!position) {
      return;
    }

    const snapshot = editor.saveViewState();
    if (snapshot) {
      editorViewSnapshotsRef.current[currentPath] = snapshot;
    }

    viewStateRef.current[currentPath] = {
      filePath: currentPath,
      line: position.lineNumber,
      column: position.column,
      scrollTop: Math.round(editor.getScrollTop()),
      scrollLeft: Math.round(editor.getScrollLeft()),
    };
  }

  function restoreEditorView(targetPath: string) {
    const editor = editorRef.current;
    const normalizedTargetPath = normalizePath(targetPath);
    const currentModelPath = editor ? getEditorModelPath(editor) : null;
    if (!editor) {
      return;
    }

    if (currentModelPath && normalizePath(currentModelPath) !== normalizedTargetPath) {
      return;
    }

    const explicitTarget =
      pendingViewStateRef.current?.filePath === targetPath ? pendingViewStateRef.current : null;
    const savedSnapshot = explicitTarget ? null : editorViewSnapshotsRef.current[targetPath];
    const fallbackViewState = explicitTarget ? null : viewStateRef.current[targetPath];

    if (!explicitTarget && !savedSnapshot && !fallbackViewState) {
      return;
    }

    restoringViewPathRef.current = normalizedTargetPath;
    let settleFrame = 0;

    const frame = window.requestAnimationFrame(() => {
      if (explicitTarget) {
        const line = explicitTarget.line || 1;
        const column = explicitTarget.column || 1;
        editor.setPosition({ lineNumber: line, column });
        editor.setScrollTop(explicitTarget.scrollTop || 0);
        editor.setScrollLeft(explicitTarget.scrollLeft || 0);
        editor.revealLineInCenter(line);
        pendingViewStateRef.current = null;
      } else if (savedSnapshot) {
        editor.restoreViewState(savedSnapshot);
      } else if (fallbackViewState) {
        editor.setPosition({
          lineNumber: fallbackViewState.line || 1,
          column: fallbackViewState.column || 1,
        });
        editor.setScrollTop(fallbackViewState.scrollTop || 0);
        editor.setScrollLeft(fallbackViewState.scrollLeft || 0);
      }

      editor.focus();
      syncPreviewScrollFromEditor();

      settleFrame = window.requestAnimationFrame(() => {
        if (restoringViewPathRef.current === normalizedTargetPath) {
          restoringViewPathRef.current = null;
        }
        recordActiveViewState();
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
      if (restoringViewPathRef.current === normalizedTargetPath) {
        restoringViewPathRef.current = null;
      }
    };
  }

  async function jumpToFileLocation(candidate: QuickJumpCandidate | null) {
    if (!candidate) {
      return;
    }

    recordActiveViewState();
    const targetAlreadyActive = activeTabPathRef.current === candidate.path;
    closeQuickJump();

    const nextViewState = candidate.line
      ? {
          filePath: candidate.path,
          line: candidate.line,
          column: candidate.column ?? 1,
          scrollTop: 0,
          scrollLeft: 0,
        }
      : null;

    await openFilePath(
      candidate.path,
      nextViewState,
      candidate.workspacePath,
      candidate.source !== "current",
    );

    if (nextViewState && targetAlreadyActive) {
      restoreEditorView(candidate.path);
    }
  }

  async function handleCopyLineReference() {
    if (!activeTab) {
      return;
    }

    const line =
      editorRef.current?.getPosition()?.lineNumber ?? viewStateRef.current[activeTab.path]?.line ?? 1;
    const reference = `${activeTab.path}:${line}`;

    try {
      await copyToClipboard(reference);
      pushToast(`Copied ${shortenPath(activeTab.path)}:${line}`, "success");
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  function updateSettings(nextSettings: Partial<AppSettings>) {
    setSettings((previous) => normalizeSettings({ ...previous, ...nextSettings }));
  }

  function setAppearance(appearance: AppAppearance) {
    updateSettings({ appearance });
  }

  function adjustTextZoom(delta: number) {
    updateSettings({ textZoom: clampTextZoom(settings.textZoom + delta) });
  }

  function resetTextZoom() {
    updateSettings({ textZoom: DEFAULT_SETTINGS.textZoom });
  }

  function syncPreviewScrollFromEditor() {
    const editor = editorRef.current;
    const preview = previewBodyRef.current;

    if (!editor || !preview || !activeTabPathRef.current) {
      return;
    }

    const currentTab = tabsRef.current.find((tab) => tab.path === activeTabPathRef.current);
    if (!currentTab || !isMarkdownFile(currentTab.extension) || markdownViewMode !== "split") {
      return;
    }

    const maxEditorScroll = Math.max(
      editor.getScrollHeight() - editor.getLayoutInfo().height,
      1,
    );
    const editorProgress = editor.getScrollTop() / maxEditorScroll;
    const maxPreviewScroll = Math.max(preview.scrollHeight - preview.clientHeight, 0);

    preview.scrollTop = maxPreviewScroll * editorProgress;
  }

  async function loadWorkspacePath(path: string, activate = true) {
    const nextTree = await openWorkspace(path);
    const nextEntry: WorkspaceEntry = {
      name: nextTree.name,
      path,
      tree: nextTree,
    };

    setWorkspaces((previous) => replaceWorkspaceEntry(previous, nextEntry, false));
    if (activate || !workspacePath) {
      setWorkspacePath(path);
    }
  }

  async function refreshWorkspacePath(path: string) {
    const nextTree = await openWorkspace(path);
    const nextEntry: WorkspaceEntry = {
      name: nextTree.name,
      path,
      tree: nextTree,
    };

    setWorkspaces((previous) => replaceWorkspaceEntry(previous, nextEntry, false));
  }

  async function openFilePath(
    filePath: string,
    viewState?: EditorViewState | null,
    preferredWorkspacePath?: string | null,
    attachToWorkspace = true,
  ) {
    const existing = tabsRef.current.find(
      (tab) => normalizePath(tab.path) === normalizePath(filePath),
    );
    if (existing) {
      if (viewState) {
        const nextViewState = { ...viewState, filePath: existing.path };
        viewStateRef.current[existing.path] = nextViewState;
        pendingViewStateRef.current = nextViewState;
      }
      setActiveTabPath(existing.path);
      if (existing.workspacePath) {
        setWorkspacePath(existing.workspacePath);
      }
      setRecentFiles((previous) => mergeRecentFiles(previous, existing.path));
      return;
    }

    try {
      const file = await readFile(filePath);
      const resolvedWorkspacePath = attachToWorkspace
        ? preferredWorkspacePath ??
          findWorkspacePathForFile(
            file.path,
            workspacesRef.current.map((item) => item.path),
          )
        : null;
      const existingTab = tabsRef.current.find(
        (tab) => normalizePath(tab.path) === normalizePath(file.path),
      );
      if (existingTab) {
        if (viewState) {
          const nextViewState = { ...viewState, filePath: existingTab.path };
          viewStateRef.current[existingTab.path] = nextViewState;
          pendingViewStateRef.current = nextViewState;
        }
        setActiveTabPath(existingTab.path);
        if (existingTab.workspacePath) {
          setWorkspacePath(existingTab.workspacePath);
        }
        setRecentFiles((previous) => mergeRecentFiles(previous, existingTab.path));
        return;
      }

      const nextTab: FileTab = {
        path: file.path,
        workspacePath: resolvedWorkspacePath,
        name: file.name,
        extension: file.extension,
        content: file.content,
        savedContent: file.content,
        dirty: false,
      };

      if (viewState) {
        const nextViewState = { ...viewState, filePath: file.path };
        viewStateRef.current[file.path] = nextViewState;
        pendingViewStateRef.current = nextViewState;
      }

      startTransition(() => {
        setTabs((previous) =>
          previous.some((tab) => normalizePath(tab.path) === normalizePath(file.path))
            ? previous
            : [...previous, nextTab],
        );
        setActiveTabPath(file.path);
      });
      if (resolvedWorkspacePath) {
        setWorkspacePath(resolvedWorkspacePath);
      }
      setRecentFiles((previous) => mergeRecentFiles(previous, file.path));
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  async function handleOpenWorkspace() {
    if (!isTauriRuntime) {
      try {
        const nextPath =
          workspacesRef.current.some((item) => item.path === "/demo") ? "/notes-lab" : "/demo";
        await loadWorkspacePath(nextPath, true);
        setSearchResults([]);
        setSearchFeedback(DEFAULT_SEARCH_FEEDBACK);
        setCreateFileOpen(false);
        pushToast(`Loaded mock workspace: ${shortenPath(nextPath)}`, "success");
      } catch (error) {
        pushToast(String(error), "error");
      }
      return;
    }

    const selected = await open({
      directory: true,
      multiple: true,
      title: "Open workspace folders",
    });

    if (!selected) {
      return;
    }

    try {
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const [index, path] of paths.entries()) {
        await loadWorkspacePath(path, index === paths.length - 1);
      }
      setSearchResults([]);
      setSearchFeedback(DEFAULT_SEARCH_FEEDBACK);
      setCreateFileOpen(false);
      pushToast(
        `Loaded ${paths.length} workspace${paths.length > 1 ? "s" : ""}`,
        "success",
      );
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  function handleRemoveWorkspace(path: string) {
    setWorkspaces((previous) => previous.filter((item) => item.path !== path));
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      for (const value of previous) {
        if (value === path || value.startsWith(`${path}/`)) {
          next.delete(value);
        }
      }
      return next;
    });
    setSearchResults([]);
    setSearchFeedback(DEFAULT_SEARCH_FEEDBACK);
    setCreateFileOpen(false);

    if (workspacePath === path) {
      const fallback = workspacesRef.current.find((item) => item.path !== path)?.path ?? null;
      setWorkspacePath(fallback);
    }
  }

  async function handleOpenFiles() {
    if (!isTauriRuntime) {
      await openFilePath("/demo/notes.txt", null, "/demo");
      return;
    }

    const selected = await open({
      multiple: true,
      title: "Open files",
      filters: [
        {
          name: "Text formats",
          extensions: [...SEARCHABLE_EXTENSIONS],
        },
      ],
    });

    if (!selected) {
      return;
    }

    const paths = Array.isArray(selected) ? selected : [selected];
    for (const filePath of paths) {
      await openFilePath(filePath);
    }
  }

  async function handleExternalOpenFiles(filePaths: string[]) {
    const nextPaths = uniquePaths(filePaths);
    if (nextPaths.length === 0) {
      return;
    }

    for (const filePath of nextPaths) {
      await openFilePath(filePath, null, null, false);
    }
  }

  async function handleSaveActiveTab() {
    if (!activeTab) {
      return;
    }

    try {
      await writeFile(activeTab.path, activeTab.content);
      setTabs((previous) =>
        previous.map((tab) =>
          tab.path === activeTab.path
            ? { ...tab, savedContent: tab.content, dirty: false }
            : tab,
        ),
      );
      pushToast(`Saved ${activeTab.name}`, "success");
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  async function handleFormatActiveTab() {
    if (!activeTab || !supportsFormatting(activeTab.extension)) {
      return;
    }

    try {
      const result =
        activeTab.extension === "json"
          ? await validateAndFormatJson(activeTab.content)
          : await validateAndFormatJsonl(activeTab.content);

      if (!result.valid || !result.formatted) {
        pushToast(result.error ?? "Format failed", "error");
        return;
      }

      setTabs((previous) =>
        previous.map((tab) =>
          tab.path === activeTab.path
            ? {
                ...tab,
                content: result.formatted ?? tab.content,
                dirty: (result.formatted ?? tab.content) !== tab.savedContent,
              }
            : tab,
        ),
      );
      pushToast(`Formatted ${activeTab.name}`, "success");
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  async function handleCloseTab(filePath: string) {
    const currentTabs = tabsRef.current;
    const index = currentTabs.findIndex((tab) => tab.path === filePath);
    if (index === -1) {
      return;
    }

    const target = currentTabs[index];
    if (target.dirty) {
      const shouldClose = isTauriRuntime
        ? await confirm(`${target.name} has unsaved changes. Close anyway?`, {
            title: "Unsaved changes",
            kind: "warning",
          })
        : window.confirm(`${target.name} has unsaved changes. Close anyway?`);

      if (!shouldClose) {
        return;
      }
    }

    recordActiveViewState();
    delete viewStateRef.current[filePath];
    delete editorViewSnapshotsRef.current[filePath];

    const nextTabs = currentTabs.filter((tab) => tab.path !== filePath);
    setTabs(nextTabs);

    if (activeTabPathRef.current === filePath) {
      const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? null;
      setActiveTabPath(fallback?.path ?? null);
      if (fallback?.workspacePath) {
        setWorkspacePath(fallback.workspacePath);
      }
    }
  }

  async function handleCreateFile(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!activeWorkspace?.path || !createFileDirectory) {
      pushToast("Open a workspace before creating files.", "error");
      return;
    }

    const baseName = stripKnownExtension(createFileName);
    if (!baseName || baseName === "." || baseName === "..") {
      pushToast("Enter a valid file name.", "error");
      return;
    }

    if (/[/\\]/.test(baseName)) {
      pushToast("File name cannot include folder separators.", "error");
      return;
    }

    const nextPath = joinPath(createFileDirectory, `${baseName}.${createFileExtension}`);
    if (workspaceContainsPath(activeWorkspace.tree, nextPath)) {
      pushToast("A file with the same name already exists.", "error");
      return;
    }

    setCreatingFile(true);
    try {
      await writeFile(nextPath, "");
      await refreshWorkspacePath(activeWorkspace.path);
      setCreateFileName("");
      setCreateFileOpen(false);
      await openFilePath(nextPath, null, activeWorkspace.path);
      pushToast(`Created ${baseName}.${createFileExtension}`, "success");
    } catch (error) {
      pushToast(String(error), "error");
    } finally {
      setCreatingFile(false);
    }
  }

  async function handleSearch() {
    if (!activeWorkspace?.path || !searchText.trim()) {
      setSearchResults([]);
      setSearchFeedback(
        activeWorkspace?.path ? "Enter text and click Run to search." : "Open a workspace to search.",
      );
      return;
    }

    setSearching(true);
    setSearchFeedback(`Searching ${activeWorkspace.name}...`);
    try {
      const startedAt = performance.now();
      const trimmedQuery = searchText.trim();
      const backendResults = await searchWorkspace(
        activeWorkspace.path,
        trimmedQuery,
        caseSensitive,
        wholeWord,
      );
      const openedWorkspaceTabs = tabsRef.current.filter((tab) =>
        tab.workspacePath === activeWorkspace.path && isSearchableExtension(tab.extension),
      );
      const openedPaths = new Set(openedWorkspaceTabs.map((tab) => tab.path));
      const inMemoryResults = openedWorkspaceTabs.flatMap((tab) =>
        searchContent(tab.path, tab.content, trimmedQuery, caseSensitive, wholeWord),
      );
      const nextResults = [
        ...backendResults.filter((hit) => !openedPaths.has(hit.filePath)),
        ...inMemoryResults,
      ].sort((left, right) => {
        const fileCompare = left.filePath.localeCompare(right.filePath);
        if (fileCompare !== 0) {
          return fileCompare;
        }
        if (left.lineNumber !== right.lineNumber) {
          return left.lineNumber - right.lineNumber;
        }
        return left.columnStart - right.columnStart;
      });

      const elapsed = Math.round(performance.now() - startedAt);
      startTransition(() => {
        setSearchResults(nextResults);
      });
      setSearchFeedback(
        nextResults.length === 0
          ? `No matches in ${activeWorkspace.name} · ${elapsed}ms`
          : `Found ${nextResults.length} matches in ${new Set(nextResults.map((item) => item.filePath)).size} files inside ${activeWorkspace.name} · ${elapsed}ms`,
      );
    } catch (error) {
      setSearchFeedback("Search failed.");
      pushToast(String(error), "error");
    } finally {
      setSearching(false);
    }
  }

  function handleEditorChange(value: string | undefined) {
    if (!activeTabPath) {
      return;
    }

    const nextValue = value ?? "";
    setTabs((previous) =>
      previous.map((tab) =>
        tab.path === activeTabPath
          ? {
              ...tab,
              content: nextValue,
              dirty: nextValue !== tab.savedContent,
            }
          : tab,
      ),
    );
  }

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.onDidChangeCursorPosition(() => {
      recordActiveViewState();
    });
    editor.onDidScrollChange(() => {
      recordActiveViewState();
      syncPreviewScrollFromEditor();
    });
    editor.onDidChangeModel(() => {
      const currentPath = getEditorModelPath(editor);
      if (!currentPath) {
        return;
      }
      restoreEditorView(currentPath);
    });
  };

  useEffect(() => {
    if (!isTauriRuntime) {
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;

    async function bindOpenFilesListener() {
      unlisten = await listenForOpenFiles((paths) => {
        const nextPaths = uniquePaths(paths);
        if (nextPaths.length === 0) {
          return;
        }

        if (!sessionReadyRef.current) {
          pendingExternalOpenFilesRef.current = uniquePaths([
            ...pendingExternalOpenFilesRef.current,
            ...nextPaths,
          ]);
          return;
        }

        void handleExternalOpenFiles(nextPaths);
      });

      const pendingPaths = await takePendingOpenFiles();
      if (cancelled || pendingPaths.length === 0) {
        return;
      }

      pendingExternalOpenFilesRef.current = uniquePaths([
        ...pendingExternalOpenFilesRef.current,
        ...pendingPaths,
      ]);
      if (sessionReadyRef.current) {
        const queuedPaths = [...pendingExternalOpenFilesRef.current];
        pendingExternalOpenFilesRef.current = [];
        void handleExternalOpenFiles(queuedPaths);
      }
    }

    void bindOpenFilesListener();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const [session, launchFiles] = await Promise.all([loadSession(), startupFiles()]);
        if (cancelled) {
          return;
        }

        const nextRecentFiles = session.recentFiles ?? [];
        const nextViews = Object.fromEntries(
          (session.views ?? []).map((item) => [item.filePath, item]),
        ) as Record<string, EditorViewState>;
        viewStateRef.current = nextViews;
        setRecentFiles(nextRecentFiles);
        setSettings(normalizeSettings(session.settings));

        const restoredWorkspaces: WorkspaceEntry[] = [];
        const missingWorkspaces: string[] = [];
        const sessionWorkspacePaths = session.workspacePaths?.length
          ? session.workspacePaths
          : session.workspacePath
            ? [session.workspacePath]
            : [];

        for (const path of sessionWorkspacePaths) {
          try {
            const tree = await openWorkspace(path);
            restoredWorkspaces.push({ name: tree.name, path, tree });
          } catch {
            missingWorkspaces.push(path);
          }
        }

        const restoredTabs: FileTab[] = [];
        const missingTabs: string[] = [];

        const allWorkspacePaths = [
          ...restoredWorkspaces.map((item) => item.path),
          ...launchFiles.map((filePath) => fileDirectory(filePath)),
        ].filter((value, index, array) => array.indexOf(value) === index);

        for (const path of allWorkspacePaths) {
          if (restoredWorkspaces.some((item) => item.path === path)) {
            continue;
          }

          try {
            const tree = await openWorkspace(path);
            restoredWorkspaces.push({ name: tree.name, path, tree });
          } catch {
            missingWorkspaces.push(path);
          }
        }

        for (const filePath of session.openTabs ?? []) {
          try {
            const file = await readFile(filePath);
            restoredTabs.push({
              path: file.path,
              workspacePath: findWorkspacePathForFile(
                file.path,
                restoredWorkspaces.map((item) => item.path),
              ),
              name: file.name,
              extension: file.extension,
              content: file.content,
              savedContent: file.content,
              dirty: false,
            });
          } catch {
            missingTabs.push(filePath);
          }
        }

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setWorkspaces(restoredWorkspaces);
          setWorkspacePath(
            restoredWorkspaces.some((item) => item.path === session.activeWorkspacePath)
              ? session.activeWorkspacePath
              : restoredWorkspaces.some((item) => item.path === session.workspacePath)
                ? session.workspacePath
                : restoredTabs.find((tab) => tab.workspacePath)?.workspacePath ??
                  restoredWorkspaces[0]?.path ??
                  null,
          );
          setTabs(restoredTabs);
          setActiveTabPath(
            restoredTabs.some((tab) => tab.path === session.activeTab)
              ? session.activeTab
              : restoredTabs[0]?.path ?? null,
          );
        });

        for (const filePath of launchFiles) {
          if (restoredTabs.some((tab) => tab.path === filePath)) {
            continue;
          }
          await openFilePath(
            filePath,
            null,
            findWorkspacePathForFile(
              filePath,
              restoredWorkspaces.map((item) => item.path),
            ),
          );
        }

        if (missingTabs.length > 0) {
          pushToast("Some previous tabs were removed because the files no longer exist.", "error");
        }
        if (missingWorkspaces.length > 0) {
          pushToast("Some previous workspaces were removed because the folders no longer exist.", "error");
        }
        setSearchFeedback(DEFAULT_SEARCH_FEEDBACK);
      } catch (error) {
        pushToast(String(error), "error");
      } finally {
        sessionReadyRef.current = true;
        const queuedPaths = [...pendingExternalOpenFilesRef.current];
        pendingExternalOpenFilesRef.current = [];
        if (!cancelled && queuedPaths.length > 0) {
          void handleExternalOpenFiles(queuedPaths);
        }
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionReadyRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      const activeViews = tabs
        .map((tab) => viewStateRef.current[tab.path])
        .filter((item): item is EditorViewState => Boolean(item));

      const state: SessionState = {
        workspacePath,
        workspacePaths: workspaces.map((item) => item.path),
        activeWorkspacePath: workspacePath,
        openTabs: tabs.map((tab) => tab.path),
        activeTab: activeTabPath,
        views: activeViews,
        recentFiles,
        settings,
      };

      void saveSession(state);
    }, 450);

    return () => {
      window.clearTimeout(timer);
    };
  }, [workspacePath, workspaces, tabs, activeTabPath, recentFiles, settings]);

  useEffect(() => {
    if (activeTab?.workspacePath && activeTab.workspacePath !== workspacePath) {
      setWorkspacePath(activeTab.workspacePath);
    }
  }, [activeTab?.path, activeTab?.workspacePath, workspacePath]);

  useEffect(() => {
    if (!quickJumpOpen) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      quickJumpInputRef.current?.focus();
      quickJumpInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [quickJumpOpen]);

  useEffect(() => {
    setQuickJumpIndex((previous) => {
      if (quickJumpCandidates.length === 0) {
        return 0;
      }

      return Math.min(previous, quickJumpCandidates.length - 1);
    });
  }, [quickJumpCandidates.length]);

  useEffect(() => {
    const workspacePaths = workspaces.map((item) => item.path);
    if (workspacePaths.length === 0) {
      return;
    }

    setTabs((previous) =>
      previous.map((tab) => {
        const nextWorkspacePath = findWorkspacePathForFile(tab.path, workspacePaths);
        return nextWorkspacePath === tab.workspacePath
          ? tab
          : { ...tab, workspacePath: nextWorkspacePath };
      }),
    );
  }, [workspaces]);

  useEffect(() => {
    if (!sessionReadyRef.current) {
      return;
    }

    setSearchResults([]);
    setSearchFeedback(
      activeWorkspace?.path
        ? `Ready to search inside ${activeWorkspace.name}.`
        : DEFAULT_SEARCH_FEEDBACK,
    );
  }, [activeWorkspace?.path, activeWorkspace?.name]);

  useEffect(() => {
    if (!activeTab) {
      setJsonlStatus(null);
      return;
    }
  }, [activeTab?.path]);

  useEffect(() => {
    if (!activeTab || activeTab.extension !== "jsonl" || !editorRef.current || !monacoRef.current) {
      setJsonlStatus(null);
      const currentModel = editorRef.current?.getModel();
      if (currentModel && monacoRef.current) {
        monacoRef.current.editor.setModelMarkers(currentModel, "jsonl", []);
      }
      return;
    }

    const timer = window.setTimeout(async () => {
      const result = await validateAndFormatJsonl(activeTab.content);
      setJsonlStatus(result);

      const currentModel = editorRef.current?.getModel();
      if (!currentModel || !monacoRef.current) {
        return;
      }

      if (result.valid) {
        monacoRef.current.editor.setModelMarkers(currentModel, "jsonl", []);
        return;
      }

      monacoRef.current.editor.setModelMarkers(currentModel, "jsonl", [
        {
          message: result.error ?? "Invalid JSONL",
          severity: monacoRef.current.MarkerSeverity.Error,
          startLineNumber: result.errorLine ?? 1,
          endLineNumber: result.errorLine ?? 1,
          startColumn: result.errorColumn ?? 1,
          endColumn: (result.errorColumn ?? 1) + 1,
        },
      ]);
    }, 250);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeTab?.path, activeTab?.content, activeTab?.extension]);

  useEffect(() => {
    if (!activeTabPath) {
      return;
    }

    return restoreEditorView(activeTabPath);
  }, [activeTabPath, activeTab?.path]);

  useEffect(() => {
    if (!markdownActive || markdownViewMode !== "split") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      syncPreviewScrollFromEditor();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [markdownActive, markdownViewMode, activeTab?.content]);

  useEffect(() => {
    function updateMarkdownSplitRatio(clientX: number) {
      const layout = editorLayoutRef.current;
      if (!layout) {
        return;
      }

      const bounds = layout.getBoundingClientRect();
      if (bounds.width <= 0) {
        return;
      }

      const nextRatio = (clientX - bounds.left) / bounds.width;
      setMarkdownSplitRatio(Math.min(0.75, Math.max(0.25, nextRatio)));
    }

    function updateSidebarWidth(clientX: number) {
      const shell = appShellRef.current;
      if (!shell) {
        return;
      }

      const bounds = shell.getBoundingClientRect();
      const maxWidth = Math.min(bounds.width * 0.42, 520);
      const minWidth = Math.min(440, Math.max(290, bounds.width * 0.22));
      const nextWidth = Math.min(maxWidth, Math.max(minWidth, clientX - bounds.left));
      setSidebarWidth(Math.round(nextWidth));
    }

    function onPointerMove(event: PointerEvent) {
      if (!resizeStateRef.current) {
        return;
      }

      event.preventDefault();
      if (resizeStateRef.current.type === "markdown") {
        updateMarkdownSplitRatio(event.clientX);
        return;
      }

      updateSidebarWidth(event.clientX);
    }

    function onPointerUp(event: PointerEvent) {
      if (!resizeStateRef.current || resizeStateRef.current.pointerId !== event.pointerId) {
        return;
      }

      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    function syncSidebarWidth() {
      const shell = appShellRef.current;
      if (!shell) {
        return;
      }

      const bounds = shell.getBoundingClientRect();
      const maxWidth = Math.min(bounds.width * 0.42, 520);
      const minWidth = Math.min(440, Math.max(290, bounds.width * 0.22));
      setSidebarWidth((previous) => Math.round(Math.min(maxWidth, Math.max(minWidth, previous))));
    }

    syncSidebarWidth();
    window.addEventListener("resize", syncSidebarWidth);
    return () => {
      window.removeEventListener("resize", syncSidebarWidth);
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (quickJumpOpen) {
          event.preventDefault();
          closeQuickJump();
          return;
        }
        setSettingsOpen(false);
        return;
      }

      if (!event.repeat && event.key === "Shift") {
        const now = performance.now();
        if (now - shiftPressedAtRef.current <= QUICK_JUMP_SHIFT_WINDOW) {
          event.preventDefault();
          openQuickJump();
          shiftPressedAtRef.current = 0;
          return;
        }
        shiftPressedAtRef.current = now;
      }

      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "s") {
        event.preventDefault();
        void handleSaveActiveTab();
        return;
      }

      if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }

      if (key === "shift") {
        return;
      }

      if (!zoomEnabled) {
        return;
      }

      if (key === "=" || key === "+") {
        event.preventDefault();
        adjustTextZoom(0.1);
        return;
      }

      if (key === "-" || key === "_") {
        event.preventDefault();
        adjustTextZoom(-0.1);
        return;
      }

      if (key === "0") {
        event.preventDefault();
        resetTextZoom();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [quickJumpOpen, zoomEnabled, settings.textZoom, activeTab]);

  const splitLayoutStyle =
    showEditorPanel && showPreviewPanel
      ? ({
          "--split-left": `${markdownSplitRatio}fr`,
          "--split-right": `${1 - markdownSplitRatio}fr`,
        } as CSSProperties)
      : undefined;

  return (
    <main
      className="app-shell"
      data-theme={settings.appearance}
      ref={appShellRef}
      style={shellLayoutStyle}
    >
      <aside className="sidebar">
        <div className="sidebar-section sidebar-card">
          <div className="section-header">
            <div className="section-heading">
              <span>Workspace</span>
              <p>
                {activeWorkspace
                  ? `${workspaces.length} workspaces · ${workspaceFileCount} files in ${activeWorkspace.name}`
                  : "Open folders to build a text-only workspace set"}
              </p>
            </div>
            <div className="section-actions">
              <button className="ghost-button" onClick={() => void handleOpenWorkspace()}>
                Open folders
              </button>
              <button
                className="ghost-button"
                onClick={() => setCreateFileOpen((previous) => !previous)}
                disabled={!activeWorkspace}
              >
                {createFileOpen ? "Close" : "New file"}
              </button>
            </div>
          </div>
          <div className="workspace-summary">
            <div className="workspace-path-pill">
              {activeWorkspace?.path ?? "No workspace selected"}
            </div>
            <div className="workspace-stats">
              <span>{workspaces.length} workspaces</span>
              <span>{totalWorkspaceFiles} text files</span>
              <span>{tabs.length} open tabs</span>
              <span>{recentFiles.length} recent</span>
            </div>
          </div>
          {createFileOpen ? (
            <form className="create-file-form" onSubmit={(event) => void handleCreateFile(event)}>
              <div className="create-file-row">
                <input
                  className="text-input"
                  value={createFileName}
                  onChange={(event) => setCreateFileName(event.currentTarget.value)}
                  placeholder="untitled"
                  autoFocus
                />
                <label className="select-wrap">
                  <span>Type</span>
                  <select
                    className="select-input"
                    value={createFileExtension}
                    onChange={(event) =>
                      setCreateFileExtension(event.currentTarget.value as CreatableFileExtension)
                    }
                  >
                    {CREATABLE_FILE_EXTENSIONS.map((extension) => (
                      <option key={extension} value={extension}>
                        .{extension}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="workspace-meta">
                {createFileTargetPath
                  ? `Create in ${shortenPath(createFileDirectory ?? activeWorkspace?.path ?? "")} as ${createFileTargetPath.split("/").pop()}`
                  : "Name the file. It will be created inside the active workspace."}
              </div>
              <div className="create-file-actions">
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    setCreateFileOpen(false);
                    setCreateFileName("");
                  }}
                >
                  Cancel
                </button>
                <button className="toolbar-button" type="submit" disabled={creatingFile}>
                  {creatingFile ? "Creating" : "Create"}
                </button>
              </div>
            </form>
          ) : null}
          <div className="tree-panel">
            {workspaces.length > 0 ? (
              workspaces.map((entry) => {
                const collapsed = collapsedPaths.has(entry.path);
                return (
                  <div
                    className={`workspace-group ${workspacePath === entry.path ? "active" : ""}`}
                    key={entry.path}
                  >
                    <div className="workspace-group-header">
                      <button
                        className="workspace-group-select"
                        onClick={() => setWorkspacePath(entry.path)}
                      >
                        <strong>{entry.name}</strong>
                        <span>{countEditableFiles(entry.tree)} files</span>
                      </button>
                      <div className="workspace-group-actions">
                        <button
                          className="workspace-mini-button"
                          onClick={() =>
                            setCollapsedPaths((previous) => {
                              const next = new Set(previous);
                              if (next.has(entry.path)) {
                                next.delete(entry.path);
                              } else {
                                next.add(entry.path);
                              }
                              return next;
                            })
                          }
                        >
                          {collapsed ? ">" : "v"}
                        </button>
                        <button
                          className="workspace-mini-button"
                          onClick={() => handleRemoveWorkspace(entry.path)}
                        >
                          x
                        </button>
                      </div>
                    </div>
                    <div className="workspace-group-path">{entry.path}</div>
                    {!collapsed
                      ? entry.tree.children.map((child) => (
                          <TreeNode
                            key={child.path}
                            node={child}
                            level={1}
                            activePath={activeTabPath}
                            collapsedPaths={collapsedPaths}
                            onToggle={(path) =>
                              setCollapsedPaths((previous) => {
                                const next = new Set(previous);
                                if (next.has(path)) {
                                  next.delete(path);
                                } else {
                                  next.add(path);
                                }
                                return next;
                              })
                            }
                            onOpen={(path) => void openFilePath(path, null, entry.path)}
                          />
                        ))
                      : null}
                  </div>
                );
              })
            ) : (
              <div className="empty-panel">Open folders to browse text files as grouped trees.</div>
            )}
          </div>
        </div>

        <div className="sidebar-section sidebar-card">
          <div className="section-header">
            <div className="section-heading">
              <span>Search</span>
              <p>
                {activeWorkspace
                  ? `Search only inside ${activeWorkspace.name} to keep large folders responsive`
                  : "Pick a workspace first, then run a scoped search"}
              </p>
            </div>
            <button className="ghost-button" onClick={() => void handleSearch()} disabled={searching}>
              {searching ? "Searching" : "Run"}
            </button>
          </div>
          <input
            className="text-input"
            value={searchText}
            onChange={(event) => setSearchText(event.currentTarget.value)}
            placeholder="Search workspace text"
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSearch();
              }
            }}
          />
          <div className="search-options">
            <label className="toggle">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.currentTarget.checked)}
              />
              <span>Case sensitive</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={wholeWord}
                onChange={(event) => setWholeWord(event.currentTarget.checked)}
              />
              <span>Whole word</span>
            </label>
          </div>
          <div className="search-feedback">{searchFeedback}</div>
          <div className="search-results">
            {groupedResults.length === 0 ? (
              <div className="empty-panel">Search results appear here.</div>
            ) : (
              groupedResults.map(([filePath, hits]) => (
                <div className="search-group" key={filePath}>
                  <button
                    className="search-file"
                    onClick={() =>
                      void openFilePath(
                        filePath,
                        null,
                        findWorkspacePathForFile(
                          filePath,
                          workspaces.map((item) => item.path),
                        ),
                      )
                    }
                  >
                    {shortenPath(filePath)} <span>{hits.length}</span>
                  </button>
                  {hits.map((hit) => (
                    <button
                      className="search-hit"
                      key={`${hit.filePath}:${hit.lineNumber}:${hit.columnStart}`}
                      onClick={() =>
                        void jumpToFileLocation({
                          path: hit.filePath,
                          name: fileNameFromPath(hit.filePath),
                          workspacePath: findWorkspacePathForFile(
                            hit.filePath,
                            workspaces.map((item) => item.path),
                          ),
                          source: "workspace",
                          line: hit.lineNumber,
                          column: hit.columnStart,
                          score: 0,
                        })
                      }
                    >
                      <strong>L{hit.lineNumber}</strong>
                      <span>{hit.lineText.trim() || "(blank line)"}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="sidebar-section sidebar-card">
          <div className="section-header">
            <div className="section-heading">
              <span>Recent</span>
              <p>Jump back into files you touched recently</p>
            </div>
            <button className="ghost-button" onClick={() => void handleOpenFiles()}>
              Open files
            </button>
          </div>
          <div className="recent-list">
            {recentFiles.length === 0 ? (
              <div className="empty-panel">Recently opened files will stay here.</div>
            ) : (
              recentFiles.map((filePath) => (
                <button
                  className="recent-item"
                  key={filePath}
                  onClick={() =>
                    void openFilePath(
                      filePath,
                      null,
                      findWorkspacePathForFile(
                        filePath,
                        workspaces.map((item) => item.path),
                      ),
                    )
                  }
                >
                  <span>{shortenPath(filePath)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </aside>

      <div
        className="shell-splitter"
        aria-label="Resize sidebar"
        onPointerDown={(event) => {
          resizeStateRef.current = { pointerId: event.pointerId, type: "sidebar" };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        role="separator"
      />

      <section className="workspace-shell">
        <header className="toolbar">
          <div className="toolbar-left">
            <button className="toolbar-button" onClick={() => void handleOpenFiles()}>
              Open file
            </button>
            <button
              className="toolbar-button"
              onClick={() => setCreateFileOpen(true)}
              disabled={!activeWorkspace}
            >
              New file
            </button>
            <button className="toolbar-button" onClick={() => void handleSaveActiveTab()} disabled={!activeTab}>
              Save
            </button>
            <button
              className="toolbar-button"
              onClick={() => void handleFormatActiveTab()}
              disabled={!activeTab || !supportsFormatting(activeTab.extension)}
            >
              Format
            </button>
            <button className="toolbar-button" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
          </div>
          <div className="toolbar-right">
            <button
              className="icon-button"
              onClick={() => editorRef.current?.trigger("toolbar", "undo", null)}
              disabled={!activeTab}
            >
              Undo
            </button>
            <button
              className="icon-button"
              onClick={() => editorRef.current?.trigger("toolbar", "redo", null)}
              disabled={!activeTab}
            >
              Redo
            </button>
            <button
              className="icon-button"
              onClick={() =>
                editorRef.current?.trigger(
                  "toolbar",
                  "editor.action.clipboardCopyAction",
                  null,
                )
              }
              disabled={!activeTab}
            >
              Copy
            </button>
            <button className="icon-button" onClick={() => void handleCopyLineReference()} disabled={!activeTab}>
              Copy line
            </button>
            <button className="icon-button" onClick={() => openQuickJump()}>
              Jump
            </button>
            {zoomEnabled ? (
              <div className="zoom-group" aria-label="Text zoom controls">
                <button className="icon-button" onClick={() => adjustTextZoom(-0.1)}>
                  A-
                </button>
                <button className="zoom-indicator" onClick={() => resetTextZoom()}>
                  {Math.round(settings.textZoom * 100)}%
                </button>
                <button className="icon-button" onClick={() => adjustTextZoom(0.1)}>
                  A+
                </button>
              </div>
            ) : null}
            {markdownActive ? (
              <div className="view-mode-group" role="tablist" aria-label="Markdown view mode">
                <button
                  className={`icon-button ${markdownViewMode === "editor" ? "active" : ""}`}
                  onClick={() => setMarkdownViewMode("editor")}
                >
                  Editor
                </button>
                <button
                  className={`icon-button ${markdownViewMode === "split" ? "active" : ""}`}
                  onClick={() => setMarkdownViewMode("split")}
                >
                  Split
                </button>
                <button
                  className={`icon-button ${markdownViewMode === "preview" ? "active" : ""}`}
                  onClick={() => setMarkdownViewMode("preview")}
                >
                  Preview
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="tab-strip">
          {tabs.length === 0 ? (
            <div className="tab-empty">Open a folder or file to start editing.</div>
          ) : (
            tabs.map((tab) => (
              <button
                key={tab.path}
                className={`tab-chip ${tab.path === activeTabPath ? "active" : ""}`}
                onClick={() => {
                  recordActiveViewState();
                  setActiveTabPath(tab.path);
                }}
              >
                <span>{tab.name}</span>
                {tab.dirty ? <span className="dirty-dot" /> : null}
                <span
                  className="tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCloseTab(tab.path);
                  }}
                >
                  x
                </span>
              </button>
            ))
          )}
        </div>

        {activeTab ? (
          <div
            className={`editor-layout ${showEditorPanel && showPreviewPanel ? "split" : ""}`}
            ref={editorLayoutRef}
            style={splitLayoutStyle}
          >
            {showEditorPanel ? (
              <div className="editor-panel">
                <div className="file-status">
                  <div>
                    <strong>{activeTab.name}</strong>
                    <span>{activeTab.path}</span>
                  </div>
                  <div className="status-badges">
                    <span>{activeTab.extension.toUpperCase()}</span>
                    <span>{activeTab.dirty ? "Unsaved" : "Saved"}</span>
                  </div>
                </div>
                {activeTab.extension === "jsonl" && jsonlStatus && !jsonlStatus.valid ? (
                  <div className="error-banner">{jsonlStatus.error}</div>
                ) : null}
                <div className="editor-surface">
                  <Editor
                    beforeMount={defineEditorTheme}
                    onMount={handleEditorMount}
                    theme={editorTheme}
                    path={activeTab.path}
                    value={activeTab.content}
                    language={inferLanguage(activeTab.extension)}
                    height="100%"
                    loading={<div className="empty-panel">Loading editor...</div>}
                    onChange={handleEditorChange}
                    options={{
                      minimap: { enabled: false },
                      fontSize: editorFontSize,
                      lineHeight: editorLineHeight,
                      smoothScrolling: true,
                      cursorBlinking: "smooth",
                      cursorSmoothCaretAnimation: "on",
                      automaticLayout: true,
                      padding: { top: 18, bottom: 18 },
                      fontFamily:
                        "'SF Mono', 'JetBrains Mono', 'Menlo', 'Consolas', monospace",
                      scrollBeyondLastLine: false,
                    }}
                  />
                </div>
              </div>
            ) : null}

            {showEditorPanel && showPreviewPanel ? (
              <div
                className="editor-splitter"
                aria-label="Resize markdown split view"
                onPointerDown={(event) => {
                  resizeStateRef.current = { pointerId: event.pointerId, type: "markdown" };
                  document.body.style.cursor = "col-resize";
                  document.body.style.userSelect = "none";
                }}
                role="separator"
              />
            ) : null}

            {showPreviewPanel ? (
              <article className="preview-panel">
                <div className="preview-header">Markdown preview</div>
                <div
                  className="preview-body"
                  ref={previewBodyRef}
                  style={previewBodyStyle}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </article>
            ) : null}
          </div>
        ) : (
          <div className="workspace-empty">
            <div>
              <p className="eyebrow">No file selected</p>
              <h2>Bring a folder, then move fast.</h2>
              <p>
                Use the left panel to open a workspace, search across files, and jump back into
                your previous session.
              </p>
            </div>
          </div>
        )}
      </section>

      {quickJumpOpen ? (
        <div className="quick-jump-overlay" onClick={() => closeQuickJump()}>
          <section
            className="quick-jump-dialog"
            aria-label="Quick jump"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="quick-jump-header">
              <div>
                <p className="eyebrow">Quick jump</p>
                <h2>Find a file, then jump to a line</h2>
              </div>
              <button className="icon-button" onClick={() => closeQuickJump()}>
                Close
              </button>
            </div>

            <input
              ref={quickJumpInputRef}
              className="quick-jump-input"
              placeholder="file name, path, or file:42"
              value={quickJumpQuery}
              onChange={(event) => {
                setQuickJumpQuery(event.target.value);
                setQuickJumpIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setQuickJumpIndex((previous) =>
                    quickJumpCandidates.length === 0
                      ? 0
                      : Math.min(previous + 1, quickJumpCandidates.length - 1),
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setQuickJumpIndex((previous) => Math.max(previous - 1, 0));
                  return;
                }

                if (event.key === "Enter") {
                  event.preventDefault();
                  void jumpToFileLocation(
                    quickJumpCandidates[quickJumpIndex] ?? quickJumpCandidates[0] ?? null,
                  );
                }
              }}
            />

            <div className="quick-jump-hint">
              Double-tap Shift to open. Use <code>file:42</code> or just <code>42</code> to jump.
            </div>

            <div className="quick-jump-results">
              {quickJumpCandidates.length === 0 ? (
                <div className="quick-jump-empty">No files matched this query.</div>
              ) : (
                quickJumpCandidates.map((candidate, index) => (
                  <button
                    key={candidate.path}
                    className={`quick-jump-item ${index === quickJumpIndex ? "active" : ""}`}
                    onMouseEnter={() => setQuickJumpIndex(index)}
                    onClick={() => void jumpToFileLocation(candidate)}
                  >
                    <div className="quick-jump-item-top">
                      <strong>{candidate.name}</strong>
                      <span>{candidate.line ? `Line ${candidate.line}` : candidate.source === "open" ? "Open tab" : "Workspace"}</span>
                    </div>
                    <div className="quick-jump-path">{candidate.path}</div>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}

      {settingsOpen ? (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            aria-label="System settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-header">
              <div>
                <p className="eyebrow">System settings</p>
                <h2>Appearance and reading scale</h2>
              </div>
              <button className="icon-button" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="settings-section">
              <span>Appearance</span>
              <div className="appearance-grid">
                {([
                  ["warm", "Warm"],
                  ["paper", "Paper"],
                  ["night", "Night"],
                ] as const).map(([appearance, label]) => (
                  <button
                    key={appearance}
                    className={`appearance-option ${
                      settings.appearance === appearance ? "active" : ""
                    }`}
                    onClick={() => setAppearance(appearance)}
                  >
                    <strong>{label}</strong>
                    <span>{appearance === "warm"
                      ? "Warm parchment tones"
                      : appearance === "paper"
                        ? "Cool clean daylight"
                        : "Dark focused contrast"}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-section">
              <span>Text zoom for TXT and Markdown</span>
              <div className="settings-zoom-row">
                <button className="icon-button" onClick={() => adjustTextZoom(-0.1)}>
                  A-
                </button>
                <div className="settings-zoom-value">{Math.round(settings.textZoom * 100)}%</div>
                <button className="icon-button" onClick={() => adjustTextZoom(0.1)}>
                  A+
                </button>
                <button className="ghost-button" onClick={() => resetTextZoom()}>
                  Reset
                </button>
              </div>
              <div className="workspace-meta">
                Applies to TXT editor text and Markdown editor or preview. Shortcuts:
                Cmd/Ctrl +, opens settings, Cmd/Ctrl + +/-/0 adjusts zoom.
              </div>
            </div>
          </section>
        </div>
      ) : null}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div className={`toast ${toast.tone}`} key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
    </main>
  );
}

export default App;
