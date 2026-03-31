import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  EditorViewState,
  FileContent,
  FormatResult,
  SaveResult,
  SearchHit,
  SessionState,
  WorkspaceNode,
} from "./types";

const MOCK_WORKSPACE_ROOTS = ["/demo", "/notes-lab"] as const;
const MOCK_FILES_KEY = "simple-notes-studio.mock.files";
const MOCK_SESSION_KEY = "simple-notes-studio.mock.session";
const SUPPORTED_EXTENSIONS = [
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "log",
] as const;
const DEFAULT_SETTINGS: AppSettings = {
  appearance: "warm",
  textZoom: 1,
};
const OPEN_FILES_EVENT = "studio://open-files";

type OpenFilesPayload = {
  paths?: string[];
};

const defaultMockFiles: Record<string, string> = {
  "/demo/README.md": `# Simple Notes Studio

This browser preview mirrors the desktop UI.

- Multi-tab editing
- Markdown preview
- JSON and JSONL formatting
- Session restore
`,
  "/demo/notes.txt": `Simple Notes Studio keeps text work tidy.
Search across files.
Restore tabs from the previous session.
`,
  "/demo/data/config.json": `{"name":"Simple Notes Studio","formats":["json","jsonl","md","txt"],"search":{"caseSensitive":true,"wholeWord":true}}`,
  "/demo/data/events.jsonl": `{"event":"open","count":3}
{"event":"save","count":2}`,
  "/demo/logs/app.log": `2026-03-31 10:00:12 INFO launch app
2026-03-31 10:00:13 INFO restore session`,
  "/notes-lab/guide.md": `# Notes Lab

This mock workspace exists so the browser preview can exercise multi-workspace UI.
`,
  "/notes-lab/config/app.toml": `[app]
name = "Simple Notes Studio"
theme = "night"`,
  "/notes-lab/config/workflow.yaml": `name: preview
steps:
  - open
  - search`,
};

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const isTauriRuntime = hasTauriRuntime();

function detectExtension(filePath: string) {
  const value = filePath.split(/[/\\]/).pop() ?? filePath;
  const parts = value.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "txt";
}

function isSearchableExtension(extension: string) {
  return SUPPORTED_EXTENSIONS.includes(extension as (typeof SUPPORTED_EXTENSIONS)[number]);
}

function detectName(filePath: string) {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

function buildWorkspaceTree(files: Record<string, string>, rootPath: string): WorkspaceNode {
  const rootName = rootPath.split(/[/\\]/).pop() ?? rootPath;
  const root: WorkspaceNode = {
    name: rootName,
    path: rootPath,
    isDir: true,
    children: [],
  };

  for (const filePath of Object.keys(files).sort()) {
    if (!filePath.startsWith(`${rootPath}/`) || !isSearchableExtension(detectExtension(filePath))) {
      continue;
    }

    const relativePath = filePath.replace(`${rootPath}/`, "");
    const segments = relativePath.split("/");
    let current = root;
    let currentPath = rootPath;

    segments.forEach((segment, index) => {
      currentPath = `${currentPath}/${segment}`;
      const isFile = index === segments.length - 1;
      let node = current.children.find((item) => item.path === currentPath);
      if (!node) {
        node = {
          name: segment,
          path: currentPath,
          isDir: !isFile,
          children: [],
        };
        current.children.push(node);
        current.children.sort((left, right) => {
          if (left.isDir !== right.isDir) {
            return left.isDir ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });
      }

      current = node;
    });
  }

  return root;
}

function defaultMockSession(files: Record<string, string>): SessionState {
  const openTabs = ["/demo/README.md", "/demo/data/config.json"].filter(
    (path) => path in files,
  );
  const views: EditorViewState[] = openTabs.map((filePath) => ({
    filePath,
    line: 1,
    column: 1,
    scrollTop: 0,
    scrollLeft: 0,
  }));

  return {
    workspacePath: "/demo",
    workspacePaths: ["/demo"],
    activeWorkspacePath: "/demo",
    openTabs,
    activeTab: openTabs[indexOrZero(openTabs.length - 1)] ?? openTabs[0] ?? null,
    views,
    recentFiles: openTabs,
    settings: DEFAULT_SETTINGS,
  };
}

function indexOrZero(value: number) {
  return value < 0 ? 0 : value;
}

function loadMockFiles() {
  const stored = window.localStorage.getItem(MOCK_FILES_KEY);
  if (!stored) {
    window.localStorage.setItem(MOCK_FILES_KEY, JSON.stringify(defaultMockFiles));
    return { ...defaultMockFiles };
  }

  return JSON.parse(stored) as Record<string, string>;
}

function saveMockFiles(files: Record<string, string>) {
  window.localStorage.setItem(MOCK_FILES_KEY, JSON.stringify(files));
}

function loadMockSessionState(files: Record<string, string>) {
  const stored = window.localStorage.getItem(MOCK_SESSION_KEY);
  if (!stored) {
    const session = defaultMockSession(files);
    window.localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(session));
    return session;
  }

  return normalizeSessionState(JSON.parse(stored) as Partial<SessionState>);
}

function saveMockSessionState(state: SessionState) {
  window.localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(state));
}

function normalizeSettings(value?: Partial<AppSettings>): AppSettings {
  return {
    appearance:
      value?.appearance === "paper" || value?.appearance === "night"
        ? value.appearance
        : DEFAULT_SETTINGS.appearance,
    textZoom:
      typeof value?.textZoom === "number" && Number.isFinite(value.textZoom)
        ? Math.min(1.8, Math.max(0.8, value.textZoom))
        : DEFAULT_SETTINGS.textZoom,
  };
}

function normalizeSessionState(value?: Partial<SessionState>): SessionState {
  const legacyWorkspacePath = value?.workspacePath ?? null;
  const workspacePaths = Array.isArray(value?.workspacePaths)
    ? value?.workspacePaths.filter((item): item is string => typeof item === "string")
    : legacyWorkspacePath
      ? [legacyWorkspacePath]
      : [];
  const activeWorkspacePath =
    value?.activeWorkspacePath ??
    legacyWorkspacePath ??
    workspacePaths[0] ??
    null;

  return {
    workspacePath: activeWorkspacePath,
    workspacePaths,
    activeWorkspacePath,
    openTabs: value?.openTabs ?? [],
    activeTab: value?.activeTab ?? null,
    views: value?.views ?? [],
    recentFiles: value?.recentFiles ?? [],
    settings: normalizeSettings(value?.settings),
  };
}

function mockSearch(
  files: Record<string, string>,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  const hits: SearchHit[] = [];
  const matcher = wholeWord
    ? new RegExp(`\\b${escapeRegExp(query)}\\b`, caseSensitive ? "g" : "gi")
    : null;

  for (const [filePath, content] of Object.entries(files)) {
    if (!isSearchableExtension(detectExtension(filePath))) {
      continue;
    }

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
      while (needle && source.slice(offset).includes(needle)) {
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
  }

  return hits;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mockFormatJson(content: string): FormatResult {
  try {
    const parsed = JSON.parse(content) as unknown;
    return {
      valid: true,
      formatted: JSON.stringify(parsed, null, 2),
      error: null,
      errorLine: null,
      errorColumn: null,
    };
  } catch (error) {
    return {
      valid: false,
      formatted: null,
      error: String(error),
      errorLine: 1,
      errorColumn: 1,
    };
  }
}

function mockFormatJsonl(content: string): FormatResult {
  const lines = content.split("\n");
  const formatted: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      formatted.push("");
      continue;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      formatted.push(JSON.stringify(parsed));
    } catch (error) {
      return {
        valid: false,
        formatted: null,
        error: `Line ${index + 1}: ${String(error)}`,
        errorLine: index + 1,
        errorColumn: 1,
      };
    }
  }

  return {
    valid: true,
    formatted: formatted.join("\n"),
    error: null,
    errorLine: null,
    errorColumn: null,
  };
}

function mockReadFile(path: string): FileContent {
  const files = loadMockFiles();
  const content = files[path];
  if (content === undefined) {
    throw new Error(`Mock file not found: ${path}`);
  }

  return {
    path,
    name: detectName(path),
    extension: detectExtension(path),
    content,
  };
}

function openWorkspace(path: string) {
  if (!isTauriRuntime) {
    const files = loadMockFiles();
    if (!MOCK_WORKSPACE_ROOTS.includes(path as (typeof MOCK_WORKSPACE_ROOTS)[number])) {
      return Promise.reject(new Error(`Mock workspace not found: ${path}`));
    }
    return Promise.resolve(buildWorkspaceTree(files, path));
  }

  return invoke<WorkspaceNode>("open_workspace", { path });
}

function readFile(path: string) {
  if (!isTauriRuntime) {
    return Promise.resolve(mockReadFile(path));
  }

  return invoke<FileContent>("read_file", { path });
}

function writeFile(path: string, content: string) {
  if (!isTauriRuntime) {
    const files = loadMockFiles();
    files[path] = content;
    saveMockFiles(files);
    return Promise.resolve({
      path,
      bytesWritten: new TextEncoder().encode(content).length,
    });
  }

  return invoke<SaveResult>("write_file", { path, content });
}

function startupFiles() {
  if (!isTauriRuntime) {
    return Promise.resolve<string[]>([]);
  }

  return invoke<string[]>("startup_files");
}

function takePendingOpenFiles() {
  if (!isTauriRuntime) {
    return Promise.resolve<string[]>([]);
  }

  return invoke<string[]>("take_pending_open_files");
}

function listenForOpenFiles(handler: (paths: string[]) => void | Promise<void>) {
  if (!isTauriRuntime) {
    return Promise.resolve<UnlistenFn>(() => {});
  }

  return listen<OpenFilesPayload>(OPEN_FILES_EVENT, (event) => {
    const paths = Array.isArray(event.payload?.paths)
      ? event.payload.paths.filter((item): item is string => typeof item === "string")
      : [];
    if (paths.length === 0) {
      return;
    }

    void handler(paths);
  });
}

function searchWorkspace(
  root: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  if (!isTauriRuntime) {
    const files = loadMockFiles();
    return Promise.resolve(mockSearch(files, query, caseSensitive, wholeWord));
  }

  return invoke<SearchHit[]>("search_workspace", {
    root,
    query,
    caseSensitive,
    wholeWord,
  });
}

function validateAndFormatJson(content: string) {
  if (!isTauriRuntime) {
    return Promise.resolve(mockFormatJson(content));
  }

  return invoke<FormatResult>("validate_and_format_json", { content });
}

function validateAndFormatJsonl(content: string) {
  if (!isTauriRuntime) {
    return Promise.resolve(mockFormatJsonl(content));
  }

  return invoke<FormatResult>("validate_and_format_jsonl", { content });
}

function saveSession(state: SessionState) {
  if (!isTauriRuntime) {
    saveMockSessionState(state);
    return Promise.resolve();
  }

  return invoke<void>("save_session", { state });
}

function loadSession() {
  if (!isTauriRuntime) {
    const files = loadMockFiles();
    return Promise.resolve(loadMockSessionState(files));
  }

  return invoke<SessionState>("load_session").then((session) =>
    normalizeSessionState(session),
  );
}

export { DEFAULT_SETTINGS, normalizeSettings };

export {
  loadSession,
  openWorkspace,
  readFile,
  saveSession,
  searchWorkspace,
  takePendingOpenFiles,
  listenForOpenFiles,
  startupFiles,
  validateAndFormatJson,
  validateAndFormatJsonl,
  writeFile,
};
