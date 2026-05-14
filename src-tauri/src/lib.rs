use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::Emitter;
#[cfg(not(target_os = "ios"))]
use trash;

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
    #[serde(rename = "openFiles")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_files: Option<Vec<String>>,
    #[serde(rename = "usePandoc")]
    #[serde(default)]
    pub use_pandoc: bool,
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
            open_files: None,
            use_pandoc: false,
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
    use_pandoc: Option<bool>,
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
    settings.use_pandoc = use_pandoc.unwrap_or(false);

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
    open_files: Option<Vec<String>>,
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
    settings.open_files = open_files;

    write_settings(&settings_path, &settings)
}

fn write_settings(path: &std::path::Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(path, json).map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

fn get_settings_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    // Use a simple path in the home directory
    let home = dirs::home_dir().ok_or_else(|| "Failed to get home directory".to_string())?;
    let config_dir = home.join(".humd-editor");
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
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(entries)
}

#[tauri::command]
fn read_file(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {}", e))
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
    fs::write(&file_path, &content).map_err(|e| format!("Failed to write file: {}", e))
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
    fs::write(&path_str, "").map_err(|e| format!("Failed to create file: {}", e))?;

    Ok(path_str)
}

// ===== FILE OPERATIONS =====

#[tauri::command]
fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    if new_name.contains('/') || new_name.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    let old = Path::new(&old_path);
    let parent = old.parent().ok_or("Invalid file path")?;
    let new_path = parent.join(&new_name);
    if new_path.exists() {
        return Err(format!("'{}' already exists", new_name));
    }
    let new_str = new_path
        .to_str()
        .ok_or("Invalid path encoding")?
        .to_string();
    fs::rename(&old_path, &new_path).map_err(|e| format!("Rename failed: {}", e))?;
    Ok(new_str)
}

#[tauri::command]
fn move_file(src_path: String, dest_dir: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    let file_name = src.file_name().ok_or("Invalid source path")?;
    let dest = Path::new(&dest_dir).join(file_name);
    if dest.exists() {
        return Err(format!(
            "'{}' already exists in the destination",
            file_name.to_string_lossy()
        ));
    }
    let dest_str = dest.to_str().ok_or("Invalid destination path")?.to_string();
    fs::rename(&src_path, &dest).map_err(|e| format!("Move failed: {}", e))?;
    Ok(dest_str)
}

#[tauri::command]
fn trash_file(file_path: String) -> Result<(), String> {
    #[cfg(not(target_os = "ios"))]
    {
        trash::delete(&file_path).map_err(|e| format!("Failed to move to trash: {}", e))
    }
    #[cfg(target_os = "ios")]
    {
        fs::remove_file(&file_path).map_err(|e| format!("Failed to delete: {}", e))
    }
}

// ===== PHASE 3: MARKDOWN RENDERING =====

#[tauri::command]
fn make_comrak_options() -> comrak::Options<'static> {
    let mut options = comrak::Options::default();
    options.extension.footnotes = true;
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.description_lists = true;
    // shortcodes (emoji like :smile:) — field added in comrak 0.30+; skip for now
    // superscript handled in preprocess_inline_html to avoid greedy cross-line matching
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.header_ids = Some(String::new());
    options.render.unsafe_ = true;
    options
}

// comrak 0.29 lacks native highlight/subscript extensions; handle via preprocessing.
fn preprocess_inline_html(s: &str) -> String {
    // 1. ==text== → <mark>text</mark>  (must not match inside code spans/blocks)
    // 2. ~text~ → <sub>text</sub>  (single tilde; ~~ is strikethrough)
    // Strategy: scan line by line, skip fenced code blocks and inline code spans.
    let mut out = String::with_capacity(s.len());
    let mut in_fence = false;
    for line in s.split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            out.push_str(line);
            out.push('\n');
            continue;
        }
        if in_fence {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        out.push_str(&apply_inline_spans(line));
        out.push('\n');
    }
    // Remove trailing newline added by the loop
    if out.ends_with('\n') && !s.ends_with('\n') {
        out.pop();
    }
    out
}

fn apply_inline_spans(line: &str) -> String {
    // Parse character by character, respecting inline code spans.
    let chars: Vec<char> = line.chars().collect();
    let mut result = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        // Skip inline code spans — pass through verbatim.
        if chars[i] == '`' {
            let start = i;
            i += 1;
            while i < chars.len() && chars[i] != '`' {
                i += 1;
            }
            if i < chars.len() { i += 1; } // closing backtick
            result.extend(chars[start..i].iter());
            continue;
        }
        // ==highlight==
        if chars[i] == '=' && i + 1 < chars.len() && chars[i + 1] == '=' {
            if let Some(end) = find_closing(&chars, i + 2, "==") {
                result.push_str("<mark>");
                result.extend(chars[i + 2..end].iter());
                result.push_str("</mark>");
                i = end + 2;
                continue;
            }
        }
        // ~subscript~ (not ~~strikethrough~~)
        if chars[i] == '~' {
            let is_double = i + 1 < chars.len() && chars[i + 1] == '~';
            if !is_double {
                if let Some(end) = find_closing_char(&chars, i + 1, '~', false) {
                    result.push_str("<sub>");
                    result.extend(chars[i + 1..end].iter());
                    result.push_str("</sub>");
                    i = end + 1;
                    continue;
                }
            }
        }
        // ^superscript^ — skip [^ (footnote ref) and ^[ (inline footnote)
        if chars[i] == '^' {
            let prev_is_bracket = i > 0 && chars[i - 1] == '[';
            let next_is_bracket = i + 1 < chars.len() && chars[i + 1] == '[';
            if !prev_is_bracket && !next_is_bracket {
                if let Some(end) = find_closing_char(&chars, i + 1, '^', true) {
                    result.push_str("<sup>");
                    result.extend(chars[i + 1..end].iter());
                    result.push_str("</sup>");
                    i = end + 1;
                    continue;
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

fn find_closing(chars: &[char], start: usize, pat: &str) -> Option<usize> {
    let pat_chars: Vec<char> = pat.chars().collect();
    let plen = pat_chars.len();
    let mut i = start;
    while i + plen <= chars.len() {
        if chars[i..i + plen] == pat_chars[..] {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn find_closing_char(chars: &[char], start: usize, ch: char, allow_double: bool) -> Option<usize> {
    let mut i = start;
    while i < chars.len() {
        if chars[i] == ch {
            let next_is_same = i + 1 < chars.len() && chars[i + 1] == ch;
            if next_is_same && !allow_double {
                i += 2; // skip ~~, it's strikethrough
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

#[tauri::command]
fn render_markdown(
    markdown: String,
    user_css: String,
    file_path: Option<String>,
) -> Result<String, String> {
    use comrak::plugins::syntect::SyntectAdapterBuilder;

    let content = strip_front_matter(&markdown);
    let content = preprocess_inline_html(&content);
    let preprocessed = preprocess_footnotes(&content);
    let options = make_comrak_options();

    let adapter = SyntectAdapterBuilder::new().theme("InspiredGitHub").build();
    let mut plugins = comrak::Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&adapter);

    let html = comrak::markdown_to_html_with_plugins(&preprocessed, &options, &plugins);

    let html = if let Some(ref path) = file_path {
        embed_local_images(&html, path)
    } else {
        html
    };

    build_preview_html(html, user_css)
}

#[tauri::command]
fn render_markdown_pandoc(
    markdown: String,
    user_css: String,
    file_path: Option<String>,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let content = strip_front_matter(&markdown);

    let mut child = Command::new("pandoc")
        .args([
            "--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+pipe_tables",
            "--to=html5",
            "--standalone=false",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch pandoc: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write to pandoc stdin: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed to wait for pandoc: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Pandoc error: {}", stderr));
    }

    let mut html = String::from_utf8_lossy(&output.stdout).into_owned();

    if let Some(ref path) = file_path {
        html = embed_local_images(&html, path);
    }

    // Reuse the same click-intercept + scroll-sync script and page template
    // by delegating to a shared helper.
    build_preview_html(html, user_css)
}

fn build_preview_html(body_html: String, user_css: String) -> Result<String, String> {
    let click_intercept = r#"
<script>
document.addEventListener('click', function(e) {
  var a = e.target.closest('a');
  if (!a) return;
  var href = a.getAttribute('href') || '';
  if (!href) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
    window.parent.postMessage({ type: 'open-url', href: href }, '*');
  } else if (href.charAt(0) === '#') {
    var target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    window.parent.postMessage({ type: 'wikilink', href: href }, '*');
  }
});
var _scrollSyncTimer = null;
var _ignoringScroll = false;
function _getScrollInfo() {
  var headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  var scrollTop = window.scrollY;
  var scrollHeight = document.documentElement.scrollHeight;
  var clientHeight = document.documentElement.clientHeight;
  var maxScroll = Math.max(1, scrollHeight - clientHeight);
  if (headings.length === 0) return { currentId: null, nextId: null, fraction: scrollTop / maxScroll };
  var curIdx = -1;
  for (var i = 0; i < headings.length; i++) { if (headings[i].offsetTop <= scrollTop + 2) curIdx = i; }
  if (curIdx === -1) {
    var firstTop = headings[0].offsetTop;
    return { currentId: null, nextId: headings[0].id, fraction: firstTop > 0 ? Math.min(1, scrollTop / firstTop) : 0 };
  }
  var cur = headings[curIdx]; var nxt = headings[curIdx + 1] || null; var fraction;
  if (nxt) { var range = nxt.offsetTop - cur.offsetTop; fraction = range > 0 ? (scrollTop - cur.offsetTop) / range : 0; }
  else { var tail = scrollHeight - cur.offsetTop; fraction = tail > 0 ? (scrollTop - cur.offsetTop) / tail : 0; }
  return { currentId: cur.id, nextId: nxt ? nxt.id : null, fraction: Math.max(0, Math.min(1, fraction)) };
}
window.addEventListener('scroll', function() {
  if (_ignoringScroll) return;
  clearTimeout(_scrollSyncTimer);
  _scrollSyncTimer = setTimeout(function() {
    var info = _getScrollInfo();
    window.parent.postMessage({ type: 'preview-scroll', currentId: info.currentId, nextId: info.nextId, fraction: info.fraction }, '*');
  }, 50);
}, { passive: true });
window.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'scroll-to-heading') { var el = document.getElementById(e.data.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (e.data.type === 'scroll-to-fraction') {
    _ignoringScroll = true;
    var scrollHeight = document.documentElement.scrollHeight;
    var clientHeight = document.documentElement.clientHeight;
    var maxScroll = Math.max(0, scrollHeight - clientHeight);
    var cur = e.data.currentId ? document.getElementById(e.data.currentId) : null;
    var nxt = e.data.nextId ? document.getElementById(e.data.nextId) : null;
    var targetY;
    if (!cur && !nxt) { targetY = e.data.fraction * maxScroll; }
    else if (cur && nxt) { targetY = cur.offsetTop + e.data.fraction * (nxt.offsetTop - cur.offsetTop); }
    else if (cur) { targetY = cur.offsetTop + e.data.fraction * (scrollHeight - cur.offsetTop); }
    else { targetY = e.data.fraction * nxt.offsetTop; }
    window.scrollTo(0, Math.max(0, Math.min(maxScroll, targetY)));
    setTimeout(function() { _ignoringScroll = false; }, 150);
  }
});
</script>
"#;

    Ok(format!(
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
/* Syntax highlighting */
pre {{ border-radius: 5px; overflow-x: auto; padding: 12px 16px; font-size: 0.9em; }}
pre code {{ background: none; padding: 0; font-size: inherit; }}
code {{ background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }}
/* Highlight */
mark {{ background-color: #fff176; color: inherit; padding: 1px 2px; border-radius: 2px; }}
/* Task lists */
.task-list-item {{ list-style-type: none; margin-left: -20px; }}
.task-list-item input[type="checkbox"] {{ margin-right: 6px; vertical-align: middle; }}
/* Definition lists */
dt {{ font-weight: 600; margin-top: 10px; }}
dd {{ margin-left: 24px; color: #555; }}
/* Tables */
table {{ border-collapse: collapse; width: 100%; margin: 1em 0; }}
th, td {{ border: 1px solid #ddd; padding: 6px 12px; text-align: left; }}
th {{ background: #f5f5f5; font-weight: 600; }}
tr:nth-child(even) {{ background: #fafafa; }}
@media (prefers-color-scheme: dark) {{
  body {{ background-color: #1e1e1e; color: #e0e0e0; }}
  a {{ color: #6da3f5; }}
  code {{ background: #2d2d2d; }}
  mark {{ background-color: #7a6a00; color: #fff176; }}
  dd {{ color: #aaa; }}
  th {{ background: #2a2a2a; }}
  tr:nth-child(even) {{ background: #242424; }}
  th, td {{ border-color: #444; }}
  /* Reset inline syntax-highlight colors for dark mode */
  pre span {{ color: #abb2bf !important; background: none !important; }}
  pre {{ background-color: #282c34 !important; color: #abb2bf; }}
}}
{}
</style>
{}
</head>
<body>
{}
</body>
</html>"#,
        user_css, click_intercept, body_html
    ))
}

fn embed_local_images(html: &str, file_path: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use once_cell::sync::Lazy;
    use std::path::PathBuf;

    static IMG_SRC_RE: Lazy<Regex> = Lazy::new(|| {
        // Captures the opening up-to-and-including src=", the path, and the closing ".
        Regex::new(r#"(<img\b[^>]*?\bsrc=")([^"]+)(")"#).unwrap()
    });

    let file_dir = Path::new(file_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));

    IMG_SRC_RE
        .replace_all(html, |caps: &regex::Captures| {
            let prefix = &caps[1];
            let src = &caps[2];
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

            let mime = match abs_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase()
                .as_str()
            {
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "svg" | "svgz" => "image/svg+xml",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "ico" => "image/x-icon",
                _ => "image/png",
            };

            format!(
                "{}data:{};base64,{}{}",
                prefix,
                mime,
                STANDARD.encode(&data),
                suffix
            )
        })
        .to_string()
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
        let wikilink_re = Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").expect("Invalid regex");
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

    let json =
        serde_json::to_string(&index).map_err(|e| format!("Failed to serialize index: {}", e))?;

    fs::write(&index_path, json).map_err(|e| format!("Failed to save index: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_backlinks(vault_path: String, note_stem: String) -> Result<Vec<String>, String> {
    let index_path = std::path::PathBuf::from(&vault_path).join(".link-index.json");

    if index_path.exists() {
        let content =
            fs::read_to_string(&index_path).map_err(|e| format!("Failed to read index: {}", e))?;

        let index: LinkIndex = serde_json::from_str(&content).unwrap_or(LinkIndex {
            backlinks: HashMap::new(),
            tags: HashMap::new(),
        });

        Ok(index.backlinks.get(&note_stem).cloned().unwrap_or_default())
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn get_tags_for_note(vault_path: String, note_path: String) -> Result<Vec<String>, String> {
    let index_path = std::path::PathBuf::from(&vault_path).join(".link-index.json");

    if index_path.exists() {
        let content =
            fs::read_to_string(&index_path).map_err(|e| format!("Failed to read index: {}", e))?;

        let index: LinkIndex = serde_json::from_str(&content).unwrap_or(LinkIndex {
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
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

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
            rename_file,
            move_file,
            trash_file,
            render_markdown,
            render_markdown_pandoc,
            build_link_index,
            get_backlinks,
            get_tags_for_note,
            start_watch,
            pick_vault_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
