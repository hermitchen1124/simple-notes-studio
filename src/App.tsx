import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { startTransition, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_SETTINGS,
  isTauriRuntime,
  loadSession,
  normalizeSettings,
  openWorkspace,
  readFile,
  saveSession,
  searchWorkspace,
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

function shortenPath(filePath: string) {
  const parts = filePath.split(/[/\\]+/);
  return parts.slice(-3).join("/");
}

function mergeRecentFiles(previous: string[], nextPath: string) {
  return [nextPath, ...previous.filter((item) => item !== nextPath)].slice(0, 10);
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
  const [workspace, setWorkspace] = useState<WorkspaceNode | null>(null);
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
  const [searching, setSearching] = useState(false);
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>("split");
  const [markdownSplitRatio, setMarkdownSplitRatio] = useState(0.58);
  const [jsonlStatus, setJsonlStatus] = useState<FormatResult | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const editorLayoutRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<FileTab[]>([]);
  const activeTabPathRef = useRef<string | null>(null);
  const viewStateRef = useRef<Record<string, EditorViewState>>({});
  const pendingViewStateRef = useRef<EditorViewState | null>(null);
  const sessionReadyRef = useRef(false);
  const toastIdRef = useRef(0);
  const resizeStateRef = useRef<{ pointerId: number } | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
    activeTabPathRef.current = activeTabPath;
  }, [tabs, activeTabPath]);

  const activeTab = tabs.find((tab) => tab.path === activeTabPath) ?? null;
  const markdownActive = activeTab ? isMarkdownFile(activeTab.extension) : false;
  const zoomEnabled = activeTab ? supportsTextZoom(activeTab.extension) : false;
  const showEditorPanel = !markdownActive || markdownViewMode !== "preview";
  const showPreviewPanel = markdownActive && markdownViewMode !== "editor";
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

  function pushToast(message: string, tone: ToastTone = "info") {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((previous) => [...previous, { id, message, tone }].slice(-4));
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((item) => item.id !== id));
    }, 3200);
  }

  function recordActiveViewState() {
    const editor = editorRef.current;
    const currentPath = activeTabPathRef.current;
    if (!editor || !currentPath) {
      return;
    }

    const position = editor.getPosition();
    if (!position) {
      return;
    }

    viewStateRef.current[currentPath] = {
      filePath: currentPath,
      line: position.lineNumber,
      column: position.column,
      scrollTop: Math.round(editor.getScrollTop()),
      scrollLeft: Math.round(editor.getScrollLeft()),
    };
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

  async function openFilePath(filePath: string, viewState?: EditorViewState | null) {
    const existing = tabsRef.current.find((tab) => tab.path === filePath);
    if (existing) {
      if (viewState) {
        viewStateRef.current[filePath] = viewState;
        pendingViewStateRef.current = viewState;
      }
      setActiveTabPath(filePath);
      setRecentFiles((previous) => mergeRecentFiles(previous, filePath));
      return;
    }

    try {
      const file = await readFile(filePath);
      const nextTab: FileTab = {
        path: file.path,
        name: file.name,
        extension: file.extension,
        content: file.content,
        savedContent: file.content,
        dirty: false,
      };

      if (viewState) {
        viewStateRef.current[filePath] = viewState;
        pendingViewStateRef.current = viewState;
      }

      startTransition(() => {
        setTabs((previous) => [...previous, nextTab]);
        setActiveTabPath(file.path);
      });
      setRecentFiles((previous) => mergeRecentFiles(previous, filePath));
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  async function handleOpenWorkspace() {
    if (!isTauriRuntime) {
      try {
        const nextWorkspace = await openWorkspace("/demo");
        setWorkspace(nextWorkspace);
        setWorkspacePath("/demo");
        setCollapsedPaths(new Set());
        pushToast("Loaded mock workspace preview", "success");
      } catch (error) {
        pushToast(String(error), "error");
      }
      return;
    }

    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open workspace",
    });

    if (typeof selected !== "string") {
      return;
    }

    try {
      const nextWorkspace = await openWorkspace(selected);
      setWorkspace(nextWorkspace);
      setWorkspacePath(selected);
      setCollapsedPaths(new Set());
      pushToast(`Workspace loaded: ${shortenPath(selected)}`, "success");
    } catch (error) {
      pushToast(String(error), "error");
    }
  }

  async function handleOpenFiles() {
    if (!isTauriRuntime) {
      await openFilePath("/demo/notes.txt");
      return;
    }

    const selected = await open({
      multiple: true,
      title: "Open files",
      filters: [
        {
          name: "Text formats",
          extensions: ["txt", "md", "markdown", "json", "jsonl"],
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

    const nextTabs = currentTabs.filter((tab) => tab.path !== filePath);
    setTabs(nextTabs);

    if (activeTabPathRef.current === filePath) {
      const fallback = nextTabs[index] ?? nextTabs[index - 1] ?? null;
      setActiveTabPath(fallback?.path ?? null);
    }
  }

  async function handleSearch() {
    if (!workspacePath || !searchText.trim()) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const backendResults = await searchWorkspace(
        workspacePath,
        searchText.trim(),
        caseSensitive,
        wholeWord,
      );
      const openedWorkspaceTabs = tabsRef.current.filter((tab) =>
        isInsideWorkspace(tab.path, workspacePath),
      );
      const openedPaths = new Set(openedWorkspaceTabs.map((tab) => tab.path));
      const inMemoryResults = openedWorkspaceTabs.flatMap((tab) =>
        searchContent(tab.path, tab.content, searchText.trim(), caseSensitive, wholeWord),
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

      setSearchResults(nextResults);
      pushToast(`Found ${nextResults.length} matches`, "info");
    } catch (error) {
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
  };

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const session = await loadSession();
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

        if (session.workspacePath) {
          try {
            const nextWorkspace = await openWorkspace(session.workspacePath);
            if (!cancelled) {
              setWorkspace(nextWorkspace);
              setWorkspacePath(session.workspacePath);
            }
          } catch {
            pushToast("Previous workspace is no longer available.", "error");
          }
        }

        const restoredTabs: FileTab[] = [];
        const missingTabs: string[] = [];

        for (const filePath of session.openTabs ?? []) {
          try {
            const file = await readFile(filePath);
            restoredTabs.push({
              path: file.path,
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
          setTabs(restoredTabs);
          setActiveTabPath(
            restoredTabs.some((tab) => tab.path === session.activeTab)
              ? session.activeTab
              : restoredTabs[0]?.path ?? null,
          );
        });

        if (missingTabs.length > 0) {
          pushToast("Some previous tabs were removed because the files no longer exist.", "error");
        }
      } catch (error) {
        pushToast(String(error), "error");
      } finally {
        sessionReadyRef.current = true;
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
  }, [workspacePath, tabs, activeTabPath, recentFiles, settings]);

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
    const editor = editorRef.current;
    if (!editor || !activeTabPath) {
      return;
    }

    const pending =
      pendingViewStateRef.current?.filePath === activeTabPath
        ? pendingViewStateRef.current
        : viewStateRef.current[activeTabPath];

    if (!pending) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      editor.setPosition({ lineNumber: pending.line || 1, column: pending.column || 1 });
      editor.setScrollTop(pending.scrollTop || 0);
      editor.setScrollLeft(pending.scrollLeft || 0);
      editor.revealPositionInCenterIfOutsideViewport({
        lineNumber: pending.line || 1,
        column: pending.column || 1,
      });
      pendingViewStateRef.current = null;
      syncPreviewScrollFromEditor();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeTabPath, activeTab?.content]);

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
    function updateSplitRatio(clientX: number) {
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

    function onPointerMove(event: PointerEvent) {
      if (!resizeStateRef.current) {
        return;
      }

      event.preventDefault();
      updateSplitRatio(event.clientX);
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
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        return;
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
  }, [zoomEnabled, settings.textZoom, activeTab]);

  const groupedResults = groupHits(searchResults);
  const splitLayoutStyle =
    showEditorPanel && showPreviewPanel
      ? ({
          "--split-left": `${markdownSplitRatio}fr`,
          "--split-right": `${1 - markdownSplitRatio}fr`,
        } as CSSProperties)
      : undefined;

  return (
    <main className="app-shell" data-theme={settings.appearance}>
      <aside className="sidebar">
        <div className="brand-card">
          <p className="eyebrow">Simple Notes Studio</p>
          <h1>Quiet workspace for noisy text files.</h1>
          <p className="brand-copy">
            One window for JSON, JSONL, Markdown and plain text. Search fast. Restore your
            session. Keep the interface out of the way.
          </p>
        </div>

        <div className="sidebar-section">
          <div className="section-header">
            <span>Workspace</span>
            <button className="ghost-button" onClick={() => void handleOpenWorkspace()}>
              Open folder
            </button>
          </div>
          <div className="workspace-meta">{workspacePath ?? "No workspace selected"}</div>
          <div className="tree-panel">
            {workspace ? (
              <TreeNode
                node={workspace}
                level={0}
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
                onOpen={(path) => void openFilePath(path)}
              />
            ) : (
              <div className="empty-panel">Open a folder to browse files as a tree.</div>
            )}
          </div>
        </div>

        <div className="sidebar-section">
          <div className="section-header">
            <span>Search</span>
            <button className="ghost-button" onClick={() => void handleSearch()} disabled={searching}>
              {searching ? "Searching" : "Run"}
            </button>
          </div>
          <input
            className="text-input"
            value={searchText}
            onChange={(event) => setSearchText(event.currentTarget.value)}
            placeholder="Search workspace text"
          />
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
          <div className="search-results">
            {groupedResults.length === 0 ? (
              <div className="empty-panel">Search results appear here.</div>
            ) : (
              groupedResults.map(([filePath, hits]) => (
                <div className="search-group" key={filePath}>
                  <button className="search-file" onClick={() => void openFilePath(filePath)}>
                    {shortenPath(filePath)} <span>{hits.length}</span>
                  </button>
                  {hits.map((hit) => (
                    <button
                      className="search-hit"
                      key={`${hit.filePath}:${hit.lineNumber}:${hit.columnStart}`}
                      onClick={() => {
                        pendingViewStateRef.current = {
                          filePath: hit.filePath,
                          line: hit.lineNumber,
                          column: hit.columnStart,
                          scrollTop: 0,
                          scrollLeft: 0,
                        };
                        void openFilePath(hit.filePath, pendingViewStateRef.current);
                      }}
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

        <div className="sidebar-section">
          <div className="section-header">
            <span>Recent</span>
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
                  onClick={() => void openFilePath(filePath)}
                >
                  <span>{shortenPath(filePath)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </aside>

      <section className="workspace-shell">
        <header className="toolbar">
          <div className="toolbar-left">
            <button className="toolbar-button" onClick={() => void handleOpenFiles()}>
              Open file
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
                    saveViewState
                    loading={<div className="empty-panel">Loading editor...</div>}
                    onChange={handleEditorChange}
                    options={{
                      minimap: { enabled: false },
                      fontSize: editorFontSize,
                      lineHeight: editorLineHeight,
                      smoothScrolling: true,
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
                  resizeStateRef.current = { pointerId: event.pointerId };
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
