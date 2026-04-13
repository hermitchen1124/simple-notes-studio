export type WorkspaceNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: WorkspaceNode[];
};

export type FileContent = {
  path: string;
  name: string;
  extension: string;
  content: string;
  modifiedAtMs: number | null;
};

export type SaveResult = {
  path: string;
  bytesWritten: number;
  modifiedAtMs: number | null;
};

export type FileInspection = {
  path: string;
  exists: boolean;
  modifiedAtMs: number | null;
};

export type SearchHit = {
  filePath: string;
  lineNumber: number;
  columnStart: number;
  columnEnd: number;
  lineText: string;
};

export type FormatResult = {
  valid: boolean;
  formatted: string | null;
  error: string | null;
  errorLine: number | null;
  errorColumn: number | null;
};

export type EditorViewState = {
  filePath: string;
  line: number;
  column: number;
  scrollTop: number;
  scrollLeft: number;
};

export type AppAppearance = "warm" | "paper" | "night";

export type AppSettings = {
  appearance: AppAppearance;
  textZoom: number;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  tree: WorkspaceNode;
};

export type SessionState = {
  workspacePath: string | null;
  workspacePaths: string[];
  activeWorkspacePath: string | null;
  openTabs: string[];
  activeTab: string | null;
  views: EditorViewState[];
  recentFiles: string[];
  settings: AppSettings;
};

export type FileTab = {
  path: string;
  workspacePath: string | null;
  name: string;
  extension: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  lastModifiedMs: number | null;
  externalStatus: "clean" | "modified" | "missing";
};
