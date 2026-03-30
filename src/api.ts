import { invoke } from "@tauri-apps/api/core";
import type {
  FileContent,
  FormatResult,
  SaveResult,
  SearchHit,
  SessionState,
  WorkspaceNode,
} from "./types";

export function openWorkspace(path: string) {
  return invoke<WorkspaceNode>("open_workspace", { path });
}

export function readFile(path: string) {
  return invoke<FileContent>("read_file", { path });
}

export function writeFile(path: string, content: string) {
  return invoke<SaveResult>("write_file", { path, content });
}

export function searchWorkspace(
  root: string,
  query: string,
  caseSensitive: boolean,
  wholeWord: boolean,
) {
  return invoke<SearchHit[]>("search_workspace", {
    root,
    query,
    caseSensitive,
    wholeWord,
  });
}

export function validateAndFormatJson(content: string) {
  return invoke<FormatResult>("validate_and_format_json", { content });
}

export function validateAndFormatJsonl(content: string) {
  return invoke<FormatResult>("validate_and_format_jsonl", { content });
}

export function saveSession(state: SessionState) {
  return invoke<void>("save_session", { state });
}

export function loadSession() {
  return invoke<SessionState>("load_session");
}
