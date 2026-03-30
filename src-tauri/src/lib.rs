use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use walkdir::{DirEntry, WalkDir};

const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "dist", "target"];
const MAX_SEARCH_BYTES: u64 = 1_500_000;
const MAX_SEARCH_RESULTS: usize = 1_500;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspaceNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<WorkspaceNode>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileContent {
    path: String,
    name: String,
    extension: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    path: String,
    bytes_written: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    file_path: String,
    line_number: usize,
    column_start: usize,
    column_end: usize,
    line_text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct FormatResult {
    valid: bool,
    formatted: Option<String>,
    error: Option<String>,
    error_line: Option<usize>,
    error_column: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct EditorViewState {
    file_path: String,
    line: u32,
    column: u32,
    scroll_top: u32,
    scroll_left: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    workspace_path: Option<String>,
    open_tabs: Vec<String>,
    active_tab: Option<String>,
    views: Vec<EditorViewState>,
    recent_files: Vec<String>,
}

#[tauri::command]
fn open_workspace(path: String) -> Result<WorkspaceNode, String> {
    let root = PathBuf::from(&path);
    if !root.exists() {
        return Err(format!("Workspace not found: {path}"));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    build_workspace_node(&root)
}

#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    let file_path = PathBuf::from(&path);
    let content = fs::read_to_string(&file_path)
        .map_err(|error| format!("Failed to read file {path}: {error}"))?;

    Ok(FileContent {
        path,
        name: file_name(&file_path),
        extension: file_extension(&file_path),
        content,
    })
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<SaveResult, String> {
    let file_path = PathBuf::from(&path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create parent directories for {path}: {error}"))?;
    }

    fs::write(&file_path, content.as_bytes())
        .map_err(|error| format!("Failed to write file {path}: {error}"))?;

    Ok(SaveResult {
        path,
        bytes_written: content.len(),
    })
}

#[tauri::command]
fn search_workspace(
    root: String,
    query: String,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Vec<SearchHit>, String> {
    let root_path = PathBuf::from(&root);
    if !root_path.exists() || !root_path.is_dir() {
        return Err(format!("Workspace not found: {root}"));
    }

    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(Vec::new());
    }

    let searcher = Searcher::new(trimmed_query, case_sensitive, whole_word)?;
    let mut hits = Vec::new();

    for entry in WalkDir::new(&root_path)
        .into_iter()
        .filter_entry(|entry| !should_skip_entry(entry))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        if metadata.len() > MAX_SEARCH_BYTES {
            continue;
        }

        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };

        for (line_index, line) in content.lines().enumerate() {
            for (start, end) in searcher.find_occurrences(line) {
                let start_column = byte_index_to_column(line, start);
                let end_column = byte_index_to_column(line, end);
                hits.push(SearchHit {
                    file_path: entry.path().to_string_lossy().to_string(),
                    line_number: line_index + 1,
                    column_start: start_column,
                    column_end: end_column.max(start_column + 1),
                    line_text: line.to_string(),
                });

                if hits.len() >= MAX_SEARCH_RESULTS {
                    return Ok(hits);
                }
            }
        }
    }

    Ok(hits)
}

#[tauri::command]
fn validate_and_format_json(content: String) -> FormatResult {
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(value) => FormatResult {
            valid: true,
            formatted: serde_json::to_string_pretty(&value).ok(),
            error: None,
            error_line: None,
            error_column: None,
        },
        Err(error) => FormatResult {
            valid: false,
            formatted: None,
            error: Some(error.to_string()),
            error_line: Some(error.line()),
            error_column: Some(error.column()),
        },
    }
}

#[tauri::command]
fn validate_and_format_jsonl(content: String) -> FormatResult {
    let mut formatted_lines = Vec::new();

    for (index, raw_line) in content.lines().enumerate() {
        if raw_line.trim().is_empty() {
            formatted_lines.push(String::new());
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(raw_line) {
            Ok(value) => {
                let pretty = serde_json::to_string(&value).unwrap_or_else(|_| raw_line.to_string());
                formatted_lines.push(pretty);
            }
            Err(error) => {
                return FormatResult {
                    valid: false,
                    formatted: None,
                    error: Some(format!("Line {}: {}", index + 1, error)),
                    error_line: Some(index + 1),
                    error_column: Some(error.column()),
                };
            }
        }
    }

    FormatResult {
        valid: true,
        formatted: Some(formatted_lines.join("\n")),
        error: None,
        error_line: None,
        error_column: None,
    }
}

#[tauri::command]
fn save_session(app: AppHandle, state: SessionState) -> Result<(), String> {
    let session_path = session_file_path(&app)?;
    write_session_file(&session_path, &state)
}

#[tauri::command]
fn load_session(app: AppHandle) -> Result<SessionState, String> {
    let session_path = session_file_path(&app)?;
    if !session_path.exists() {
        return Ok(SessionState::default());
    }

    read_session_file(&session_path)
}

fn build_workspace_node(path: &Path) -> Result<WorkspaceNode, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to read metadata for {}: {error}", path.display()))?;

    let mut children = Vec::new();
    if metadata.is_dir() {
        let mut entries = fs::read_dir(path)
            .map_err(|error| format!("Failed to list {}: {error}", path.display()))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();

        entries.sort_by(|left, right| compare_dir_entries(&left.path(), &right.path()));

        for entry in entries {
            let entry_path = entry.path();
            if should_skip_path(&entry_path) {
                continue;
            }

            children.push(build_workspace_node(&entry_path)?);
        }
    }

    Ok(WorkspaceNode {
        name: file_name(path),
        path: path.to_string_lossy().to_string(),
        is_dir: metadata.is_dir(),
        children,
    })
}

fn compare_dir_entries(left: &Path, right: &Path) -> Ordering {
    match (left.is_dir(), right.is_dir()) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => file_name(left)
            .to_lowercase()
            .cmp(&file_name(right).to_lowercase()),
    }
}

fn should_skip_entry(entry: &DirEntry) -> bool {
    should_skip_path(entry.path())
}

fn should_skip_path(path: &Path) -> bool {
    if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
        return path.is_dir() && SKIPPED_DIRS.contains(&name);
    }

    false
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn file_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("txt")
        .to_lowercase()
}

fn session_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to resolve app config directory: {error}"))?;
    fs::create_dir_all(&app_dir)
        .map_err(|error| format!("Failed to create app config directory {}: {error}", app_dir.display()))?;
    Ok(app_dir.join("session.json"))
}

fn byte_index_to_column(line: &str, index: usize) -> usize {
    line[..index].chars().count() + 1
}

fn write_session_file(path: &Path, state: &SessionState) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(state)
        .map_err(|error| format!("Failed to serialize session: {error}"))?;
    fs::write(path, payload)
        .map_err(|error| format!("Failed to save session to {}: {error}", path.display()))
}

fn read_session_file(path: &Path) -> Result<SessionState, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read session file {}: {error}", path.display()))?;

    serde_json::from_str::<SessionState>(&content)
        .map_err(|error| format!("Failed to parse session file {}: {error}", path.display()))
}

struct Searcher {
    case_sensitive: bool,
    needle: String,
    needle_lowercase: String,
    whole_word_pattern: Option<Regex>,
}

impl Searcher {
    fn new(query: &str, case_sensitive: bool, whole_word: bool) -> Result<Self, String> {
        let whole_word_pattern = if whole_word && query.chars().all(|value| value.is_alphanumeric() || value == '_') {
            let pattern = format!(r"\b{}\b", regex::escape(query));
            Some(
                RegexBuilder::new(&pattern)
                    .case_insensitive(!case_sensitive)
                    .build()
                    .map_err(|error| format!("Invalid search query: {error}"))?,
            )
        } else {
            None
        };

        Ok(Self {
            case_sensitive,
            needle: query.to_string(),
            needle_lowercase: query.to_lowercase(),
            whole_word_pattern,
        })
    }

    fn find_occurrences(&self, line: &str) -> Vec<(usize, usize)> {
        if let Some(pattern) = &self.whole_word_pattern {
            return pattern.find_iter(line).map(|matched| (matched.start(), matched.end())).collect();
        }

        if self.needle.is_empty() {
            return Vec::new();
        }

        let mut matches = Vec::new();
        if self.case_sensitive {
            let mut offset = 0;
            while let Some(found) = line[offset..].find(&self.needle) {
                let start = offset + found;
                let end = start + self.needle.len();
                matches.push((start, end));
                offset = end;
            }
        } else {
            let lowercase = line.to_lowercase();
            let mut offset = 0;
            while let Some(found) = lowercase[offset..].find(&self.needle_lowercase) {
                let start = offset + found;
                let end = start + self.needle_lowercase.len();
                matches.push((start, end));
                offset = end;
            }
        }

        matches
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_workspace,
            read_file,
            write_file,
            search_workspace,
            validate_and_format_json,
            validate_and_format_jsonl,
            save_session,
            load_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn json_validation_formats_valid_payloads() {
        let result = validate_and_format_json(r#"{"title":"demo","count":2}"#.into());

        assert!(result.valid);
        assert!(result.formatted.unwrap_or_default().contains("\n  \"title\""));
    }

    #[test]
    fn jsonl_validation_reports_failing_line() {
        let result = validate_and_format_jsonl("{\"ok\":1}\n{\"broken\":}\n".into());

        assert!(!result.valid);
        assert_eq!(result.error_line, Some(2));
    }

    #[test]
    fn whole_word_search_ignores_partial_matches() {
        let searcher = Searcher::new("cat", false, true).expect("searcher");
        let matches = searcher.find_occurrences("cat catalog Cat");

        assert_eq!(matches.len(), 2);
    }

    #[test]
    fn workspace_search_respects_case_and_word_boundaries() {
        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("notes.txt");
        fs::write(&file_path, "Alpha beta\nalphabet\nALPHA beta").expect("write");

        let insensitive = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "alpha".into(),
            false,
            true,
        )
        .expect("search insensitive");
        assert_eq!(insensitive.len(), 2);

        let sensitive = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "Alpha".into(),
            true,
            true,
        )
        .expect("search sensitive");
        assert_eq!(sensitive.len(), 1);
    }

    #[test]
    fn session_roundtrip_keeps_tabs_and_recent_files() {
        let dir = tempdir().expect("tempdir");
        let session_path = dir.path().join("session.json");
        let session = SessionState {
            workspace_path: Some("/tmp/demo".into()),
            open_tabs: vec!["/tmp/demo/a.md".into()],
            active_tab: Some("/tmp/demo/a.md".into()),
            views: vec![EditorViewState {
                file_path: "/tmp/demo/a.md".into(),
                line: 12,
                column: 3,
                scroll_top: 200,
                scroll_left: 0,
            }],
            recent_files: vec!["/tmp/demo/a.md".into()],
        };

        write_session_file(&session_path, &session).expect("write session");
        let loaded = read_session_file(&session_path).expect("read session");

        assert_eq!(loaded.active_tab, session.active_tab);
        assert_eq!(loaded.views[0].line, 12);
        assert_eq!(loaded.recent_files.len(), 1);
    }

    #[test]
    fn workspace_tree_sorts_directories_before_files() {
        let dir = tempdir().expect("tempdir");
        let folder = dir.path().join("folder");
        let file = dir.path().join("zeta.txt");
        fs::create_dir_all(&folder).expect("mkdir");
        fs::write(&file, "hello").expect("write");

        let tree = build_workspace_node(dir.path()).expect("tree");

        assert_eq!(tree.children.len(), 2);
        assert!(tree.children[0].is_dir);
        assert_eq!(tree.children[1].name, "zeta.txt");
    }
}
