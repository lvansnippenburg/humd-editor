use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::collections::HashMap;
use tauri::Emitter;
use regex::Regex;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "serde")]
pub struct Settings {
    #[serde(rename = "vaultPath")]
    pub vault_path: Option<String>,
    #[serde(rename = "userCss")]
    #[serde(default)]
    pub user_css: String,
    #[serde(rename = "spellCheck")]
    #[serde(default = "default_spell_check")]
    pub spell_check: bool,
    #[serde(rename = "cslJsonPath")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csl_json_path: Option<String>,
    #[serde(rename = "cslStylePath")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csl_style_path: Option<String>,
    #[serde(rename = "sidebarWidth")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<f64>,
    #[serde(rename = "editorWidth")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor_width: Option<f64>,
    #[serde(rename = "previewVisible")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_visible: Option<bool>,
    #[serde(rename = "lastOpenFile")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_open_file: Option<String>,
}

fn default_spell_check() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            vault_path: None,
            user_css: String::new(),
            spell_check: true,
            csl_json_path: None,
            csl_style_path: None,
            sidebar_width: None,
            editor_width: None,
            preview_visible: None,
            last_open_file: None,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkIndex {
    /// note_stem -> set of note_stems that link to it (backlinks)
    pub backlinks: HashMap<String, Vec<String>>,
    /// note_path -> list of tags
    pub tags: HashMap<String, Vec<String>>,
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let settings_path = get_settings_path(&app)?;

    if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;

        serde_json::from_str::<Settings>(&content)
            .map_err(|e| format!("Failed to parse settings: {}", e))
    } else {
        Ok(Settings::default())
    }
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    vault_path: Option<String>,
    user_css: String,
    spell_check: Option<bool>,
) -> Result<(), String> {
    let settings_path = get_settings_path(&app)?;

    // Load existing to preserve UI state fields and citation paths
    let mut settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str::<Settings>(&content).unwrap_or_default()
    } else {
        Settings::default()
    };

    settings.vault_path = vault_path;
    settings.user_css = user_css;
    settings.spell_check = spell_check.unwrap_or(true);

    write_settings(&settings_path, &settings)
}

#[tauri::command]
fn save_citation_settings(
    app: tauri::AppHandle,
    csl_json_path: Option<String>,
    csl_style_path: Option<String>,
) -> Result<(), String> {
    let settings_path = get_settings_path(&app)?;

    let mut settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str::<Settings>(&content).unwrap_or_default()
    } else {
        Settings::default()
    };

    settings.csl_json_path = csl_json_path;
    settings.csl_style_path = csl_style_path;

    write_settings(&settings_path, &settings)
}

#[tauri::command]
fn save_ui_state(
    app: tauri::AppHandle,
    sidebar_width: Option<f64>,
    editor_width: Option<f64>,
    preview_visible: bool,
    last_open_file: Option<String>,
) -> Result<(), String> {
    let settings_path = get_settings_path(&app)?;

    let mut settings = if settings_path.exists() {
        let content = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str::<Settings>(&content).unwrap_or_default()
    } else {
        Settings::default()
    };

    settings.sidebar_width = sidebar_width;
    settings.editor_width = editor_width;
    settings.preview_visible = Some(preview_visible);
    settings.last_open_file = last_open_file;

    write_settings(&settings_path, &settings)
}

fn write_settings(path: &std::path::Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(path, json)
        .map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

fn get_settings_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // Use a simple path in the home directory
    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    let config_dir = home.join(".md-editor");
    Ok(config_dir.join("settings.json"))
}

#[tauri::command]
fn get_platform() -> &'static str {
    #[cfg(target_os = "ios")]
    return "ios";

    #[cfg(target_os = "macos")]
    return "macos";

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    return "unknown";
}

#[tauri::command]
fn get_ios_documents_path(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        app.path()
            .app_document_dir()
            .ok()
            .and_then(|p| p.to_str().map(|s| s.to_string()))
            .ok_or_else(|| "Failed to get iOS documents path".to_string())
    }

    #[cfg(not(target_os = "ios"))]
    {
        let _ = app; // Suppress unused warning on non-iOS
        Err("get_ios_documents_path is only available on iOS".to_string())
    }
}

// ===== PHASE 2: FILE TREE =====

#[tauri::command]
fn list_vault(vault_path: String) -> Result<Vec<FileNode>, String> {
    list_dir_internal(&vault_path, true)
}

#[tauri::command]
fn list_dir(dir_path: String) -> Result<Vec<FileNode>, String> {
    list_dir_internal(&dir_path, false)
}

fn list_dir_internal(dir_path: &str, is_root: bool) -> Result<Vec<FileNode>, String> {
    let path = Path::new(dir_path);

    if !path.is_dir() {
        return Err(format!("{} is not a directory", dir_path));
    }

    let mut entries = fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string())?;

            // Skip hidden files/folders
            if name.starts_with('.') {
                return None;
            }

            let is_dir = path.is_dir();

            // On root, skip non-.md files and non-directories
            if is_root && !is_dir && !name.ends_with(".md") {
                return None;
            }

            Some(FileNode {
                name,
                path: path.to_str().unwrap_or("").to_string(),
                is_dir,
                children: if is_dir { Some(vec![]) } else { None },
            })
        })
        .collect::<Vec<_>>();

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        }
    });

    Ok(entries)
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
async fn fetch_zotero_cayw(window: tauri::WebviewWindow) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        match ureq::get("http://127.0.0.1:23119/better-bibtex/cayw?format=pandoc").call() {
            Ok(response) => response.into_string().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, _)) => Err(format!("Zotero returned HTTP {}", code)),
            Err(e) => Err(format!("Zotero not available: {}", e)),
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    let _ = window.set_focus();
    result
}

#[tauri::command]
fn write_file(file_path: String, content: String) -> Result<(), String> {
    fs::write(&file_path, &content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn create_new_file(vault_path: String, name: String) -> Result<String, String> {
    let file_name = if name.ends_with(".md") {
        name
    } else {
        format!("{}.md", name)
    };

    let file_path = Path::new(&vault_path).join(&file_name);
    let path_str = file_path
        .to_str()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string();

    // Create empty file
    fs::write(&path_str, "")
        .map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(path_str)
}

// ===== PHASE 3: MARKDOWN RENDERING =====

#[tauri::command]
fn render_block(markdown: String, file_path: Option<String>) -> Result<String, String> {
    let preprocessed = preprocess_footnotes(&markdown);

    let mut options = comrak::ComrakOptions::default();
    options.extension.footnotes = true;
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.header_ids = Some(String::new());

    let mut html = comrak::markdown_to_html(&preprocessed, &options);

    if let Some(ref path) = file_path {
        html = embed_local_images(&html, path);
    }

    Ok(html)
}

#[tauri::command]
fn render_markdown(markdown: String, user_css: String, file_path: Option<String>) -> Result<String, String> {
    // Strip YAML front matter before processing
    let content = strip_front_matter(&markdown);
    let preprocessed = preprocess_footnotes(&content);

    let mut options = comrak::ComrakOptions::default();
    options.extension.footnotes = true;
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.header_ids = Some(String::new());

    let html = comrak::markdown_to_html(&preprocessed, &options);

    // Embed local images as base64 data URIs so they load in the sandboxed iframe.
    let html = if let Some(ref path) = file_path {
        embed_local_images(&html, path)
    } else {
        html
    };

    let click_intercept = r#"
<script>
document.addEventListener('click', function(e) {
  var a = e.target.closest('a');
  if (a && a.href) {
    e.preventDefault();
    window.parent.postMessage({ type: 'wikilink', href: a.getAttribute('href') }, '*');
  }
});
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'scroll-to-heading') {
    var el = document.getElementById(e.data.id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
</script>
"#;

    let full_html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.6;
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
  color: #333;
}}
img {{ max-width: 100%; height: auto; }}
@media (prefers-color-scheme: dark) {{
  body {{ background-color: #1e1e1e; color: #e0e0e0; }}
  a {{ color: #6da3f5; }}
}}
{}
</style>
{}
</head>
<body>
{}
</body>
</html>"#,
        user_css, click_intercept, html
    );

    Ok(full_html)
}

fn embed_local_images(html: &str, file_path: &str) -> String {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use once_cell::sync::Lazy;
    use std::path::PathBuf;

    static IMG_SRC_RE: Lazy<Regex> = Lazy::new(|| {
        // Captures the opening up-to-and-including src=", the path, and the closing ".
        Regex::new(r#"(<img\b[^>]*?\bsrc=")([^"]+)(")"#).unwrap()
    });

    let file_dir = Path::new(file_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));

    IMG_SRC_RE.replace_all(html, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let src    = &caps[2];
        let suffix = &caps[3];

        // Leave data URIs and external URLs untouched.
        if src.starts_with("data:") || src.contains("://") {
            return caps[0].to_string();
        }

        let abs_path: PathBuf = if src.starts_with('/') {
            PathBuf::from(src)
        } else {
            file_dir.join(src)
        };

        let data = match fs::read(&abs_path) {
            Ok(d) => d,
            Err(_) => return caps[0].to_string(),
        };

        let mime = match abs_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "gif"          => "image/gif",
            "svg" | "svgz" => "image/svg+xml",
            "webp"         => "image/webp",
            "bmp"          => "image/bmp",
            "ico"          => "image/x-icon",
            _              => "image/png",
        };

        format!("{}data:{};base64,{}{}", prefix, mime, STANDARD.encode(&data), suffix)
    }).to_string()
}

// ===== PHASE 6: SETTINGS DIALOG =====

#[tauri::command]
fn pick_vault_folder(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "ios")]
    {
        Err("Folder picker not available on iOS".to_string())
    }

    #[cfg(not(target_os = "ios"))]
    {
        // Dialog picker is handled on the frontend via the Tauri dialog plugin
        // This command is kept for API consistency but returns None
        // The frontend uses the native dialog directly
        Ok(None)
    }
}

// ===== PHASE 5: FILE WATCHING =====

#[tauri::command]
fn start_watch(app: tauri::AppHandle, vault_path: String) -> Result<(), String> {
    // Note: Full async file watching with tauri-plugin-fs requires using the watch command
    // For now, we'll use a simple polling mechanism that checks for file changes
    // A production implementation would use the fs plugin's watch API directly

    let app_clone = app.clone();
    let vault_path_clone = vault_path.clone();

    // Spawn a background task to poll for changes (every 2 seconds)
    std::thread::spawn(move || {
        let mut last_state = get_vault_file_state(&vault_path_clone);

        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));

            let current_state = get_vault_file_state(&vault_path_clone);

            // If file structure changed, emit event
            if current_state != last_state {
                let _ = app_clone.emit("vault-changed", Some("files-changed"));
                last_state = current_state;
            }
        }
    });

    Ok(())
}

fn get_vault_file_state(path: &str) -> String {
    // Simple hash of all .md file names and modification times
    let mut state = String::new();
    let mut files = Vec::new();
    let _ = collect_md_files(path, &mut files);

    for file in files.iter() {
        if let Ok(metadata) = fs::metadata(file) {
            state.push_str(&format!("{}:{:?};", file, metadata.modified()));
        }
    }

    state
}

// ===== PHASE 4: WIKILINKS, BACKLINKS, TAGS =====

#[tauri::command]
fn build_link_index(vault_path: String) -> Result<(), String> {
    let mut backlinks: HashMap<String, Vec<String>> = HashMap::new();
    let mut tags: HashMap<String, Vec<String>> = HashMap::new();

    // Walk through all .md files in vault
    let mut files_to_process = Vec::new();
    collect_md_files(&vault_path, &mut files_to_process)?;

    // Extract wikilinks and tags from each file
    for file_path in &files_to_process {
        let content = fs::read_to_string(file_path)
            .map_err(|e| format!("Failed to read {}: {}", file_path, e))?;

        // Extract wikilinks: [[note-name]] or [[note-name|display]]
        let wikilink_re =
            Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").expect("Invalid regex");
        let file_stem = get_file_stem(file_path).unwrap_or_default();

        for cap in wikilink_re.captures_iter(&content) {
            let target_stem = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let target_stem = target_stem.trim().to_string();

            if !target_stem.is_empty() && target_stem != file_stem {
                backlinks
                    .entry(target_stem)
                    .or_insert_with(Vec::new)
                    .push(file_stem.clone());
            }
        }

        // Extract tags from YAML front matter
        let file_tags = extract_tags_from_yaml(&content);
        if !file_tags.is_empty() {
            tags.insert(file_path.clone(), file_tags);
        }
    }

    // Deduplicate backlinks
    for sources in backlinks.values_mut() {
        sources.sort();
        sources.dedup();
    }

    // Save to file
    let index = LinkIndex { backlinks, tags };
    let index_path = std::path::PathBuf::from(&vault_path).join(".link-index.json");

    let json = serde_json::to_string(&index)
        .map_err(|e| format!("Failed to serialize index: {}", e))?;

    fs::write(&index_path, json)
        .map_err(|e| format!("Failed to save index: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_backlinks(vault_path: String, note_stem: String) -> Result<Vec<String>, String> {
    let index_path = std::path::PathBuf::from(&vault_path).join(".link-index.json");

    if index_path.exists() {
        let content = fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read index: {}", e))?;

        let index: LinkIndex = serde_json::from_str(&content)
            .unwrap_or(LinkIndex {
                backlinks: HashMap::new(),
                tags: HashMap::new(),
            });

        Ok(index
            .backlinks
            .get(&note_stem)
            .cloned()
            .unwrap_or_default())
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn get_tags_for_note(vault_path: String, note_path: String) -> Result<Vec<String>, String> {
    let index_path = std::path::PathBuf::from(&vault_path).join(".link-index.json");

    if index_path.exists() {
        let content = fs::read_to_string(&index_path)
            .map_err(|e| format!("Failed to read index: {}", e))?;

        let index: LinkIndex = serde_json::from_str(&content)
            .unwrap_or(LinkIndex {
                backlinks: HashMap::new(),
                tags: HashMap::new(),
            });

        Ok(index.tags.get(&note_path).cloned().unwrap_or_default())
    } else {
        Ok(Vec::new())
    }
}

// Helper: collect all .md files recursively
fn collect_md_files(path: &str, files: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            let path_str = path
                .to_str()
                .ok_or_else(|| "Invalid path".to_string())?
                .to_string();
            collect_md_files(&path_str, files)?;
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".md"))
            .unwrap_or(false)
        {
            let path_str = path
                .to_str()
                .ok_or_else(|| "Invalid path".to_string())?
                .to_string();
            files.push(path_str);
        }
    }

    Ok(())
}

// Helper: get file stem from full path
fn get_file_stem(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
}

// Helper: extract tags from YAML front matter
fn strip_front_matter(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();

    // Check if file starts with ---
    if lines.is_empty() || !lines[0].trim().starts_with("---") {
        return markdown.to_string();
    }

    // Find closing ---
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim().starts_with("---") {
            // Return content after the closing ---
            return lines[i + 1..].join("\n");
        }
    }

    markdown.to_string()
}

fn extract_tags_from_yaml(markdown: &str) -> Vec<String> {
    let lines: Vec<&str> = markdown.lines().collect();

    // Check if file starts with ---
    if lines.is_empty() || !lines[0].trim().starts_with("---") {
        return Vec::new();
    }

    // Find closing ---
    let mut end_idx = None;
    for (i, line) in lines.iter().enumerate().skip(1) {
        if line.trim().starts_with("---") {
            end_idx = Some(i);
            break;
        }
    }

    let end_idx = match end_idx {
        Some(i) => i,
        None => return Vec::new(),
    };

    // Look for tags: line
    for line in &lines[1..end_idx] {
        if line.starts_with("tags:") {
            return parse_tags_line(line);
        }
    }

    Vec::new()
}

// Helper: parse tags from "tags: [a, b, c]" or "tags: \n  - a\n  - b"
fn parse_tags_line(line: &str) -> Vec<String> {
    if !line.starts_with("tags:") {
        return Vec::new();
    }

    let remainder = &line[5..];

    // Inline array: tags: [a, b, c]
    if remainder.contains('[') && remainder.contains(']') {
        let start = remainder.find('[').unwrap() + 1;
        let end = remainder.find(']').unwrap();
        let content = &remainder[start..end];

        return content
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }

    Vec::new()
}

fn preprocess_footnotes(markdown: &str) -> String {
    let mut result = String::new();
    let mut footnote_counter = 0;
    let mut footnotes = Vec::new();
    let chars: Vec<char> = markdown.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if i + 1 < chars.len() && chars[i] == '^' && chars[i + 1] == '[' {
            // Found start of inline footnote
            let mut j = i + 2;
            let mut bracket_depth = 1;
            let mut footnote_content = String::new();

            // Find the matching closing bracket, accounting for nested brackets
            while j < chars.len() && bracket_depth > 0 {
                if chars[j] == '[' && (j == 0 || chars[j - 1] != '\\') {
                    bracket_depth += 1;
                } else if chars[j] == ']' && (j == 0 || chars[j - 1] != '\\') {
                    bracket_depth -= 1;
                    if bracket_depth == 0 {
                        break;
                    }
                }
                footnote_content.push(chars[j]);
                j += 1;
            }

            if bracket_depth == 0 {
                // Valid footnote found
                footnote_counter += 1;
                let footnote_id = format!("fn{}", footnote_counter);
                result.push_str(&format!("[^{}]", footnote_id));
                footnotes.push(format!("[^{}]: {}", footnote_id, footnote_content));
                i = j + 1;
            } else {
                // Unmatched bracket, just output as-is
                result.push(chars[i]);
                i += 1;
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }

    if !footnotes.is_empty() {
        result.push_str("\n\n");
        result.push_str(&footnotes.join("\n"));
    }

    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            save_citation_settings,
            save_ui_state,
            get_platform,
            get_ios_documents_path,
            list_vault,
            list_dir,
            read_file,
            write_file,
            fetch_zotero_cayw,
            create_new_file,
            render_block,
            render_markdown,
            build_link_index,
            get_backlinks,
            get_tags_for_note,
            start_watch,
            pick_vault_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
