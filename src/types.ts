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
};

export type SaveResult = {
  path: string;
  bytesWritten: number;
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

export type SessionState = {
  workspacePath: string | null;
  openTabs: string[];
  activeTab: string | null;
  views: EditorViewState[];
  recentFiles: string[];
};

export type FileTab = {
  path: string;
  name: string;
  extension: string;
  content: string;
  savedContent: string;
  dirty: boolean;
};
