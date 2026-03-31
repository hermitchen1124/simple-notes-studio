use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    env,
    fs,
    sync::{
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        Mutex,
    },
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, Url};
use walkdir::{DirEntry, WalkDir};

const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "dist", "target"];
const SUPPORTED_TEXT_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "json",
    "jsonl",
    "yaml",
    "yml",
    "toml",
    "log",
];
const MAX_SEARCH_BYTES: u64 = 1_500_000;
const MAX_SEARCH_RESULTS: usize = 1_500;
const OPEN_FILES_EVENT: &str = "studio://open-files";

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    appearance: String,
    text_zoom: f64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: "warm".into(),
            text_zoom: 1.0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    #[serde(default)]
    workspace_path: Option<String>,
    #[serde(default)]
    workspace_paths: Vec<String>,
    #[serde(default)]
    active_workspace_path: Option<String>,
    open_tabs: Vec<String>,
    active_tab: Option<String>,
    views: Vec<EditorViewState>,
    recent_files: Vec<String>,
    #[serde(default)]
    settings: AppSettings,
}

#[derive(Default)]
struct OpenRequestState {
    frontend_ready: AtomicBool,
    pending_paths: Mutex<Vec<String>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenFilesPayload {
    paths: Vec<String>,
}

#[tauri::command]
fn open_workspace(path: String) -> Result<WorkspaceNode, String> {
    let root = normalize_existing_path(Path::new(&path));
    if !root.exists() {
        return Err(format!("Workspace not found: {path}"));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: {path}"));
    }

    build_workspace_node(&root, true)?.ok_or_else(|| format!("Workspace not found: {path}"))
}

#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    let file_path = normalize_existing_path(Path::new(&path));
    let content = fs::read_to_string(&file_path)
        .map_err(|error| format!("Failed to read file {path}: {error}"))?;

    Ok(FileContent {
        path: file_path.to_string_lossy().to_string(),
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

    let normalized_path = normalize_existing_path(&file_path);

    Ok(SaveResult {
        path: normalized_path.to_string_lossy().to_string(),
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
    let root_path = normalize_existing_path(Path::new(&root));
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

        if !is_supported_text_file(entry.path()) {
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

#[tauri::command]
fn startup_files() -> Vec<String> {
    supported_file_paths(env::args_os().skip(1).map(PathBuf::from))
}

#[tauri::command]
fn take_pending_open_files(state: State<'_, OpenRequestState>) -> Vec<String> {
    state
        .frontend_ready
        .store(true, AtomicOrdering::SeqCst);

    let mut pending_paths = state
        .pending_paths
        .lock()
        .expect("pending open files lock poisoned");
    dedupe_file_paths(std::mem::take(&mut *pending_paths))
}

fn build_workspace_node(path: &Path, include_empty_dirs: bool) -> Result<Option<WorkspaceNode>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to read metadata for {}: {error}", path.display()))?;

    if metadata.is_file() {
        if !is_supported_text_file(path) {
            return Ok(None);
        }

        return Ok(Some(WorkspaceNode {
            name: file_name(path),
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            children: Vec::new(),
        }));
    }

    let mut children = Vec::new();
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

        if let Some(child) = build_workspace_node(&entry_path, false)? {
            children.push(child);
        }
    }

    if !include_empty_dirs && children.is_empty() {
        return Ok(None);
    }

    Ok(Some(WorkspaceNode {
        name: file_name(path),
        path: path.to_string_lossy().to_string(),
        is_dir: true,
        children,
    }))
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

fn is_supported_text_file(path: &Path) -> bool {
    SUPPORTED_TEXT_EXTENSIONS.contains(&file_extension(path).as_str())
}

fn normalize_existing_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn supported_file_paths<I>(paths: I) -> Vec<String>
where
    I: IntoIterator<Item = PathBuf>,
{
    dedupe_file_paths(
        paths.into_iter()
            .map(|path| normalize_existing_path(&path))
            .filter(|path| path.is_file() && is_supported_text_file(path))
            .map(|path| path.to_string_lossy().to_string())
            .collect(),
    )
}

fn supported_file_paths_from_urls(urls: Vec<Url>) -> Vec<String> {
    supported_file_paths(urls.into_iter().filter_map(|url| url.to_file_path().ok()))
}

fn dedupe_file_paths(paths: Vec<String>) -> Vec<String> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.contains(&path) {
            deduped.push(path);
        }
    }
    deduped
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
        .map(normalize_session_state)
        .map_err(|error| format!("Failed to parse session file {}: {error}", path.display()))
}

fn normalize_session_state(mut state: SessionState) -> SessionState {
    if state.workspace_paths.is_empty() {
        if let Some(path) = state.workspace_path.clone() {
            state.workspace_paths.push(path);
        }
    }

    if state.active_workspace_path.is_none() {
        state.active_workspace_path = state
            .workspace_path
            .clone()
            .or_else(|| state.workspace_paths.first().cloned());
    }

    state.workspace_path = state
        .active_workspace_path
        .clone()
        .or_else(|| state.workspace_paths.first().cloned());

    state
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn emit_or_queue_open_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    let open_request_state = app.state::<OpenRequestState>();
    if open_request_state
        .frontend_ready
        .load(AtomicOrdering::SeqCst)
    {
        let _ = app.emit(
            OPEN_FILES_EVENT,
            OpenFilesPayload {
                paths: paths.clone(),
            },
        );
    } else {
        let mut pending_paths = open_request_state
            .pending_paths
            .lock()
            .expect("pending open files lock poisoned");
        *pending_paths = dedupe_file_paths(
            pending_paths
                .iter()
                .cloned()
                .chain(paths.iter().cloned())
                .collect(),
        );
    }

    focus_main_window(app);
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
        .manage(OpenRequestState::default())
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
            load_session,
            startup_files,
            take_pending_open_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::Opened { urls } => {
                emit_or_queue_open_files(app, supported_file_paths_from_urls(urls));
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                focus_main_window(app);
            }
            _ => {}
        });
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
    fn workspace_search_skips_unsupported_extensions() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join("notes.md"), "Section 1\nSection 2").expect("write markdown");
        fs::write(dir.path().join("archive.log"), "Section 3").expect("write log");
        fs::write(dir.path().join("script.ts"), "Section 4").expect("write typescript");

        let hits = search_workspace(
            dir.path().to_string_lossy().to_string(),
            "Section".into(),
            false,
            false,
        )
        .expect("search workspace");

        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|hit| !hit.file_path.ends_with("script.ts")));
    }

    #[test]
    fn workspace_tree_keeps_only_supported_text_files() {
        let dir = tempdir().expect("tempdir");
        let docs = dir.path().join("docs");
        let src = dir.path().join("src");
        fs::create_dir_all(&docs).expect("mkdir docs");
        fs::create_dir_all(&src).expect("mkdir src");
        fs::write(docs.join("notes.toml"), "title = \"demo\"").expect("write toml");
        fs::write(src.join("main.rs"), "fn main() {}").expect("write rust");

        let tree = build_workspace_node(dir.path(), true)
            .expect("tree")
            .expect("root node");

        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].name, "docs");
        assert_eq!(tree.children[0].children[0].name, "notes.toml");
    }

    #[test]
    fn session_roundtrip_keeps_tabs_and_recent_files() {
        let dir = tempdir().expect("tempdir");
        let session_path = dir.path().join("session.json");
        let session = SessionState {
            workspace_path: Some("/tmp/demo".into()),
            workspace_paths: vec!["/tmp/demo".into(), "/tmp/notes".into()],
            active_workspace_path: Some("/tmp/demo".into()),
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
            settings: AppSettings {
                appearance: "night".into(),
                text_zoom: 1.2,
            },
        };

        write_session_file(&session_path, &session).expect("write session");
        let loaded = read_session_file(&session_path).expect("read session");

        assert_eq!(loaded.active_tab, session.active_tab);
        assert_eq!(loaded.views[0].line, 12);
        assert_eq!(loaded.recent_files.len(), 1);
        assert_eq!(loaded.settings.appearance, "night");
        assert_eq!(loaded.settings.text_zoom, 1.2);
        assert_eq!(loaded.workspace_paths.len(), 2);
    }

    #[test]
    fn workspace_tree_sorts_directories_before_files() {
        let dir = tempdir().expect("tempdir");
        let folder = dir.path().join("folder");
        let file = dir.path().join("zeta.txt");
        fs::create_dir_all(&folder).expect("mkdir");
        fs::write(folder.join("alpha.txt"), "nested").expect("write nested");
        fs::write(&file, "hello").expect("write");

        let tree = build_workspace_node(dir.path(), true)
            .expect("tree")
            .expect("root node");

        assert_eq!(tree.children.len(), 2);
        assert!(tree.children[0].is_dir);
        assert_eq!(tree.children[1].name, "zeta.txt");
    }

    #[test]
    fn supported_file_paths_from_urls_keeps_only_supported_files() {
        let dir = tempdir().expect("tempdir");
        let notes = dir.path().join("notes.md");
        let script = dir.path().join("script.ts");
        fs::write(&notes, "# notes").expect("write notes");
        fs::write(&script, "console.log('x')").expect("write script");

        let urls = vec![
            Url::from_file_path(&notes).expect("notes url"),
            Url::from_file_path(&script).expect("script url"),
            Url::from_file_path(&notes).expect("duplicate notes url"),
        ];

        let paths = supported_file_paths_from_urls(urls);
        let expected = normalize_existing_path(&notes).to_string_lossy().to_string();

        assert_eq!(paths, vec![expected]);
    }
}
