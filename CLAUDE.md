# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**md-editor** is an advanced Markdown editor for macOS and iOS (iPhone/iPad). The application provides a three-pane interface on desktop (file browser, editor, preview) with live HTML rendering, keyboard shortcuts for common markdown formatting, and automatic file management.

### Platforms
- macOS (desktop with three-pane layout)
- iOS (iPhone and iPad, responsive layout)
- Built with Tauri 2 for desktop, with iOS support considerations

## Architecture

The application follows Tauri's two-layer architecture with a focus on file system operations and markdown rendering.

### Desktop Layout (macOS)
1. **Left Pane**: File browser showing collapsed folder tree from user-selected source directory
2. **Center Pane**: Markdown editor with real-time editing and keyboard shortcuts
3. **Right Pane**: HTML preview (rendered via Pandoc-style conversion, styled with custom CSS)

### Frontend (`src/`)
- `index.html` — main application entry point (responsive for macOS/iOS)
- `main.js` — editor logic, file browser management, preview rendering, keyboard shortcuts
- `styles.css` — application styling
- `assets/` — static images and resources

### Backend (`src-tauri/`)
- `src/lib.rs` — Tauri command handlers for file operations (read, write, delete), folder watching, markdown rendering
- `src/main.rs` — application entry point and Tauri setup
- `tauri.conf.json` — application configuration
- `Cargo.toml` — Rust dependencies (needs markdown-to-HTML converter, file watcher, etc.)

### Key Features to Implement
- **File Management**: Create new `.md` files, read/write/delete operations, folder selection (first launch + preferences)
- **Keyboard Shortcuts**: `**bold**`, `_italic_`, `#H1`, `##H2`, `###H3` (with selection wrapping)
- **Preview**: Live HTML rendering with custom CSS applied to the head
- **File Watching**: Detect changes on the filesystem and update file tree accordingly
- **Auto-save**: Save markdown after user stops typing
- **Folder Tree**: Collapsible folder tree in file browser (collapsed by default)

## Calling Rust from JavaScript

To invoke Rust functions from the frontend:

1. Define a command in `src-tauri/src/lib.rs`:
   ```rust
   #[tauri::command]
   fn my_command(input: String) -> String {
       format!("Processed: {}", input)
   }
   ```

2. Register it in the invoke handler in `lib.rs`:
   ```rust
   .invoke_handler(tauri::generate_handler![greet, my_command])
   ```

3. Call from JavaScript using `window.__TAURI__.core.invoke()`:
   ```javascript
   const { invoke } = window.__TAURI__.core;
   const result = await invoke("my_command", { input: "test" });
   ```

## Common Commands

### Development
```bash
npm run tauri dev        # Run the app in development mode with hot reload
```

### Building
```bash
npm run tauri build      # Build production bundles for the current platform
```

### Other Tauri Commands
```bash
npm run tauri info       # Display environment and dependency information
npm run tauri plugin list # List available plugins
```

## Development Workflow

1. **Backend changes**: Edit `src-tauri/src/lib.rs`, add new `#[tauri::command]` handlers, register in invoke handler
2. **Frontend changes**: Edit files in `src/` (HTML, CSS, JS)
3. **Run**: `npm run tauri dev` — both frontend and backend rebuild on file changes
4. **Test backend**: Rust tests can be run with `cargo test` in `src-tauri/`

## Key Dependencies

### Frontend
- None yet (vanilla JS), but consider if a markdown editor library or UI framework would help

### Backend (Rust)
- **tauri** (v2) — desktop framework
- **tauri-plugin-fs** — file system operations (read, write, watch)
- **tauri-plugin-dialog** — folder/file pickers for initial folder selection and preferences
- **tauri-plugin-opener** — file and URL opening
- **serde/serde_json** — JSON serialization
- **pandoc** or **pulldown_cmark** — markdown-to-HTML conversion (Pandoc-style rendering)
- **notify** — file system watcher for detecting folder changes
- **tokio** — async runtime for file watchers

## Current Implementation Status

### ✅ Completed Phases (All 6!)
- **Phase 1**: Settings persistence, platform detection, vault initialization
- **Phase 2**: Three-pane layout, file tree with lazy loading, file I/O
- **Phase 3**: Markdown editor with keyboard shortcuts, live preview, auto-save
- **Phase 4**: Wikilinks (`[[note|alias]]`), backlinks panel, YAML tag extraction
- **Phase 5**: File watching with polling, inline file creation UI
- **Phase 6**: Settings dialog with folder picker & CSS editor

## Features Implemented

### Keyboard Shortcuts
- **Cmd/Ctrl+B**: Bold (`**text**`)
- **Cmd/Ctrl+I**: Italic (`_text_`)
- **Cmd/Ctrl+1/2/3**: Headings (`# H1`, `## H2`, `### H3`)

### Markdown Support
- **Rendering**: Comrak with footnotes, wikilinks, tables, strikethrough
- **Footnotes**: Reference-style `[^1]` + Pandoc inline `^[text]` (auto-converted)
- **Wikilinks**: `[[note-name]]` or `[[note-name|Display Text]]`
- **Tags**: YAML front matter `tags: [tag1, tag2, ...]` (inline array format)
- **Backlinks**: Auto-detected and displayed in collapsible panel below preview

### File Management
- **Create new file**: Inline input in file tree (click + button, type name, press Enter/Escape)
- **File watching**: Polling mechanism detects external file changes (2-3 second latency)
- **Auto-refresh**: File tree and link index rebuild automatically on changes
- **Note creation**: Files created at vault root, auto-opens in editor

### Settings Management
- **Settings dialog**: Accessible via ⚙️ button (iOS) or main toolbar
- **Vault location**: Change vault folder (macOS: native picker or path input)
- **Preview CSS**: Live editing with example placeholder CSS
- **Changes**: Validate before saving; handle vault changes transparently
- **Persistence**: Settings saved to file-based JSON storage (~/.md-editor/settings.json)

### Responsive Design
- **Desktop (macOS)**: Three-pane layout (sidebar, editor, preview)
- **Mobile (iOS)**: Tab-based navigation (Files, Edit, Preview)
- **Dark mode**: Automatic based on system preferences

## Configuration Notes

- The frontend is served from `src/` (configured in `tauri.conf.json` as `frontendDist`)
- Window should be resizable and support three-pane layout (1200x800 default, min 900x600)
- File watcher is partially implemented (Phase 5)
- HTML preview uses user-editable CSS injected into `<head>` via iframe `srcdoc`
- Wikilink click handling via postMessage bridge (iframe → parent JS)
