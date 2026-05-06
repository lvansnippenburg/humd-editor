// Tauri API with withGlobalTauri: true
let invoke;

// Ensure Tauri is available
if (!window.__TAURI__) {
  console.error("Tauri not available! Make sure the app is running in Tauri context.");
  document.body.innerHTML =
    "<p style='color: red; padding: 20px;'>Error: Tauri API not available. This app must run inside Tauri.</p>";
} else {
  invoke = window.__TAURI__.core.invoke;
  console.log("Tauri API loaded successfully");
}

// ===== STATE =====

let currentPlatform = "macos";
let currentVaultPath = null;
let currentFilePath = null;
let currentUserCss = "";
let currentSpellCheck = true;
let previewVisible = true;
let savedEditorFlexBasis = null;
let activeSidebarTab = "files";
let isDirty = false;
let isInitialized = false;

// File tree state
let fileTreeCache = [];

// Debounce timers
let previewDebounceTimer = null;
let autoSaveDebounceTimer = null;

// ===== INITIALIZATION =====

async function initialize() {
  try {
    console.log("Starting initialization...");

    // Check if invoke is available
    if (!invoke) {
      throw new Error("Tauri invoke function not available");
    }

    // 1. Get platform
    console.log("Getting platform...");
    currentPlatform = await invoke("get_platform");
    console.log(`Platform: ${currentPlatform}`);
    document.body.dataset.platform = currentPlatform;

    // 2. Get settings
    console.log("Getting settings...");
    const settings = await invoke("get_settings");
    console.log("Settings retrieved:", settings);
    currentUserCss = settings.userCss || settings.user_css || "";
    currentSpellCheck = settings.spellCheck ?? settings.spell_check ?? true;
    document.getElementById("editor").spellcheck = currentSpellCheck;

    // 3. Setup vault path
    let vaultPath = settings.vaultPath || settings.vault_path;
    console.log(`Current vault path: ${vaultPath}`);

    if (!vaultPath) {
      console.log("No vault path set, prompting user...");
      // First launch - need to pick vault
      if (currentPlatform === "macos") {
        // On macOS, show custom dialog for folder path
        console.log("Showing vault picker dialog...");
        const folderPath = await showVaultPicker();
        if (!folderPath || folderPath.trim() === "") {
          showStatus("No vault selected. Please reload and select a folder.");
          console.error("User did not select a vault");
          return;
        }
        vaultPath = folderPath.trim();
      } else {
        // iOS: use app documents directory
        console.log("Getting iOS documents path...");
        vaultPath = await invoke("get_ios_documents_path");
      }

      console.log(`Saving vault path: ${vaultPath}`);
      // Save vault path
      await invoke("save_settings", {
        vaultPath,
        userCss: currentUserCss,
      });
    }

    currentVaultPath = vaultPath;
    document.getElementById("vault-path-display").textContent = vaultPath;
    console.log(`Vault path set to: ${currentVaultPath}`);

    // 4. Initialize UI
    console.log("Setting up event listeners...");
    setupEventListeners();
    restoreUiState(settings);

    console.log("Refreshing file tree...");
    await refreshFileTree();

    // 5. Build link index for wikilinks and tags
    console.log("Building link index...");
    await buildLinkIndex();

    console.log("Initializing file watcher...");
    initializeFileWatcher();

    isInitialized = true;

    // Restore last open file
    const lastOpenFile = settings.lastOpenFile || settings.last_open_file;
    if (lastOpenFile) {
      await loadFile(lastOpenFile).catch(() => {});
    }

    if (!currentFilePath) {
      showStatus("Ready");
    }
    console.log("Initialization complete!");
  } catch (error) {
    console.error("Initialization failed:", error);
    console.error("Stack:", error.stack);
    showStatus(`Error: ${error.message || error}`);
    // Show error in DOM for debugging
    document.getElementById("app").innerHTML = `
      <div style="padding: 20px; color: red;">
        <h2>Initialization Error</h2>
        <p>${error.message || error}</p>
        <p style="font-size: 12px; color: #666; margin-top: 10px;">
          Check browser console (F12) for more details.
        </p>
      </div>
    `;
  }
}

// ===== VAULT PICKER DIALOG =====

async function showVaultPicker() {
  // Use Tauri native dialog instead of custom HTML dialog
  const selected = await window.__TAURI__.dialog.open({
    directory: true,
    multiple: false,
    title: "Select your Markdown vault folder",
  });
  return selected || "";
}

async function changeVaultFolder() {
  const selected = await window.__TAURI__.dialog.open({
    directory: true,
    multiple: false,
    title: "Select your Markdown vault folder",
  });
  if (!selected) return;

  currentVaultPath = selected;
  document.getElementById("vault-path-display").textContent = selected;

  // Save the new vault path
  await invoke("save_settings", {
    vaultPath: selected,
    userCss: currentUserCss,
  });

  // Refresh everything
  await refreshFileTree();
  await buildLinkIndex();
  closeFile();
}

// ===== EVENT LISTENERS =====

function togglePreview() {
  const editorPane = document.getElementById("editor-pane");

  if (previewVisible) {
    // Hiding: save the current editor width so it restores when shown again
    const w = editorPane.getBoundingClientRect().width;
    if (w > 0) savedEditorFlexBasis = w;
    editorPane.style.flex = "";
  } else {
    // Showing: restore saved editor width
    if (savedEditorFlexBasis) {
      editorPane.style.flex = `0 0 ${savedEditorFlexBasis}px`;
    }
  }

  previewVisible = !previewVisible;
  const pane = document.getElementById("preview-pane");
  const btn = document.getElementById("preview-toggle-btn");
  const editorHandle = document.getElementById("editor-resize");
  pane.style.display = previewVisible ? "" : "none";
  editorHandle.style.display = previewVisible ? "" : "none";
  btn.classList.toggle("active", previewVisible);
  btn.title = previewVisible ? "Hide preview (⌘E)" : "Show preview (⌘E)";
  btn.setAttribute("aria-label", previewVisible ? "Hide preview" : "Show preview");

  saveUiState();
}

function startDrag(handle, startX, onDrag, onEnd) {
  const iframe = document.getElementById("preview");
  handle.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  if (iframe) iframe.style.pointerEvents = "none";

  function onMouseMove(e) {
    onDrag(e.clientX - startX);
  }

  function onMouseUp() {
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (iframe) iframe.style.pointerEvents = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    if (onEnd) onEnd();
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function initResizableHandles() {
  if (currentPlatform === "ios") return;

  const sidebar = document.getElementById("sidebar");
  const sidebarHandle = document.getElementById("sidebar-resize");
  const editorPane = document.getElementById("editor-pane");
  const editorHandle = document.getElementById("editor-resize");
  const app = document.getElementById("app");

  sidebarHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startWidth = sidebar.getBoundingClientRect().width;
    startDrag(sidebarHandle, e.clientX, (dx) => {
      const newWidth = Math.max(160, Math.min(480, startWidth + dx));
      sidebar.style.flex = `0 0 ${newWidth}px`;
    }, saveUiState);
  });

  editorHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startWidth = editorPane.getBoundingClientRect().width;
    startDrag(editorHandle, e.clientX, (dx) => {
      const appWidth = app.getBoundingClientRect().width;
      const sidebarWidth = sidebar.getBoundingClientRect().width;
      const maxWidth = appWidth - sidebarWidth - 200 - 10;
      const newWidth = Math.max(200, Math.min(maxWidth, startWidth + dx));
      editorPane.style.flex = `0 0 ${newWidth}px`;
      savedEditorFlexBasis = newWidth;
    }, saveUiState);
  });
}

function setupEventListeners() {
  // Editor
  const editor = document.getElementById("editor");
  editor.addEventListener("input", onEditorInput);
  editor.addEventListener("keydown", onEditorKeydown);

  // Preview toggle
  document
    .getElementById("preview-toggle-btn")
    .addEventListener("click", togglePreview);

  // Global Cmd+E shortcut for preview toggle
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "e") {
      e.preventDefault();
      togglePreview();
    }
  });

  // Sidebar tabs
  document.querySelectorAll(".sidebar-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchSidebarTab(btn.dataset.tab));
  });

  // New file button
  document
    .getElementById("new-file-btn")
    .addEventListener("click", promptNewFile);

  // Change vault folder button
  document
    .getElementById("change-vault-btn")
    .addEventListener("click", changeVaultFolder);

  // Settings
  document
    .getElementById("settings-btn")
    .addEventListener("click", openSettingsDialog);
  document
    .getElementById("close-settings")
    .addEventListener("click", cancelSettings);
  document
    .getElementById("cancel-settings-btn")
    .addEventListener("click", cancelSettings);
  document
    .getElementById("save-settings-btn")
    .addEventListener("click", saveSettings);
  document
    .getElementById("pick-vault-btn")
    ?.addEventListener("click", pickVaultFolder);

  // iOS tabs
  if (currentPlatform === "ios") {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => switchTab(e.target.dataset.tab));
    });
    document
      .getElementById("settings-tab-btn")
      ?.addEventListener("click", openSettingsDialog);
    // Default to editor tab on iOS
    switchTab("editor");
  }

  // Dialog close buttons
  const dialog = document.getElementById("settings-dialog");
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettingsDialog();
  });

  initResizableHandles();
}

// ===== FILE TREE =====

async function refreshFileTree() {
  try {
    const nodes = await invoke("list_vault", { vaultPath: currentVaultPath });
    fileTreeCache = nodes;
    renderFileTree(nodes);
    if (currentFilePath) await revealFileInTree(currentFilePath);
  } catch (error) {
    console.error("Failed to refresh file tree:", error);
  }
}

// Expand every ancestor directory of filePath so its file-item is in the DOM.
async function revealFileInTree(filePath) {
  if (!filePath || !currentVaultPath) return;

  const relative = filePath.startsWith(currentVaultPath)
    ? filePath.slice(currentVaultPath.length).replace(/^\//, "")
    : filePath;
  const segments = relative.split("/");

  // Nothing to expand for vault-root files.
  if (segments.length <= 1) return;

  let dirPath = currentVaultPath;
  for (let i = 0; i < segments.length - 1; i++) {
    dirPath = dirPath + "/" + segments[i];

    // Find the <ul data-path="..."> that represents this directory's children.
    let nestedUl = null;
    for (const ul of document.querySelectorAll("#file-tree-container ul[data-path]")) {
      if (ul.dataset.path === dirPath) { nestedUl = ul; break; }
    }
    if (!nestedUl) continue;

    const dirLi = nestedUl.closest(".tree-dir");
    if (!dirLi) continue;

    if (dirLi.classList.contains("collapsed")) {
      dirLi.classList.remove("collapsed");
      const icon = dirLi.querySelector(".tree-icon");
      if (icon) icon.textContent = "▾";
    }

    if (!nestedUl.dataset.loaded) {
      const children = await invoke("list_dir", { dirPath });
      renderFileTree(children, nestedUl);
      nestedUl.dataset.loaded = "true";
    }
  }
}

function renderFileTree(nodes, container = null) {
  if (!container) {
    container = document.getElementById("file-tree");
    container.innerHTML = "";
  }

  nodes.forEach((node) => {
    const li = document.createElement("li");

    if (node.is_dir) {
      // Directory
      li.className = "tree-dir collapsed";
      const label = document.createElement("div");
      label.className = "tree-label";
      label.innerHTML = `<span class="tree-icon">▸</span><span>${node.name}</span>`;

      const nested = document.createElement("ul");
      nested.dataset.path = node.path;

      label.addEventListener("click", async (e) => {
        e.stopPropagation();
        const isCollapsed = li.classList.contains("collapsed");
        li.classList.toggle("collapsed");
        const icon = label.querySelector(".tree-icon");
        icon.textContent = isCollapsed ? "▾" : "▸";

        if (isCollapsed && !nested.dataset.loaded) {
          const children = await invoke("list_dir", { dirPath: node.path });
          renderFileTree(children, nested);
          nested.dataset.loaded = "true";
        }
      });

      li.appendChild(label);
      li.appendChild(nested);
      container.appendChild(li);
    } else {
      // File
      li.className = "file-item file-icon";
      li.dataset.path = node.path;
      li.textContent = node.name;

      li.addEventListener("click", () => {
        loadFile(node.path);
      });

      container.appendChild(li);
    }
  });

  // Mark current file as active
  if (currentFilePath) {
    document.querySelectorAll(".file-item").forEach((item) => {
      if (item.dataset.path === currentFilePath) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });
  }
}

function closeFile() {
  currentFilePath = null;
  isDirty = false;
  document.getElementById("editor").value = "";
  const filenameEl = document.getElementById("editor-filename");
  if (filenameEl) filenameEl.textContent = "No file open";
  document.getElementById("note-tags").innerHTML = "";
  document.getElementById("preview").srcdoc = "<p>No file open</p>";
  buildOutline();
  buildLinksPanel();
  saveUiState();
}

async function loadFile(path) {
  try {
    const content = await invoke("read_file", { filePath: path });
    const editor = document.getElementById("editor");

    currentFilePath = path;
    isDirty = false;
    editor.value = content;

    const filenameEl = document.getElementById("editor-filename");
    if (filenameEl) filenameEl.textContent = path.split("/").pop();

    // Expand ancestor dirs so the file item is in the DOM, then mark it active.
    await revealFileInTree(path);
    document.querySelectorAll(".file-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.path === path);
    });

    // Update preview
    await updatePreview();

    // Update tags bar
    await updateTagsBar(path);

    // Update links panel
    buildLinksPanel();

    // Collapse sidebar on mobile after selection
    if (currentPlatform === "ios") {
      switchTab("editor");
    }

    showStatus(`Opened: ${path.split("/").pop()}`);
    buildOutline();
    saveUiState();
  } catch (error) {
    console.error("Failed to load file:", error);
    showStatus(`Error loading file: ${error.message || error}`);
  }
}

async function promptNewFile() {
  // Check if there's already a file creation input
  let input = document.getElementById("new-file-input");

  if (input) {
    // Already in edit mode, focus the input
    input.focus();
    return;
  }

  // Create inline input
  const fileTree = document.getElementById("file-tree");
  const li = document.createElement("li");

  input = document.createElement("input");
  input.id = "new-file-input";
  input.className = "file-input-inline";
  input.type = "text";
  input.placeholder = "New file name...";
  input.spellcheck = false;

  const handleSave = async () => {
    const fileName = input.value.trim();
    li.remove();

    if (!fileName) return;

    try {
      const fullName = fileName.endsWith(".md")
        ? fileName
        : `${fileName}.md`;
      const path = await invoke("create_new_file", {
        vaultPath: currentVaultPath,
        name: fullName,
      });

      await refreshFileTree();
      await loadFile(path);
      await buildLinkIndex();
      showStatus(`Created: ${fullName}`);
    } catch (error) {
      console.error("Failed to create file:", error);
      showStatus(`Error: ${error.message || error}`);
    }
  };

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      await handleSave();
    } else if (e.key === "Escape") {
      li.remove();
    }
  });

  input.addEventListener("blur", async () => {
    // Delay to allow click handler to fire
    setTimeout(() => {
      if (li.parentNode) {
        li.remove();
      }
    }, 100);
  });

  li.appendChild(input);
  fileTree.insertBefore(li, fileTree.firstChild);
  input.focus();
}

// ===== EDITOR =====

function onEditorInput(e) {
  if (!currentFilePath) return;

  isDirty = true;

  // Preview + outline debounce (300ms)
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updatePreview();
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  }, 300);

  // Auto-save debounce (800ms)
  clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(() => {
    saveCurrentFile();
  }, 800);
}

function onEditorKeydown(e) {
  const isMeta = e.metaKey || e.ctrlKey;

  if (isMeta && e.key === "b") {
    e.preventDefault();
    wrapSelection("**", "**");
  } else if (isMeta && e.key === "i") {
    e.preventDefault();
    wrapSelection("_", "_");
  } else if (isMeta && e.key === "1") {
    e.preventDefault();
    prefixLine("# ");
  } else if (isMeta && e.key === "2") {
    e.preventDefault();
    prefixLine("## ");
  } else if (isMeta && e.key === "3") {
    e.preventDefault();
    prefixLine("### ");
  }
}

function wrapSelection(before, after) {
  const editor = document.getElementById("editor");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selectedText = editor.value.substring(start, end);

  if (!selectedText) {
    editor.value =
      editor.value.substring(0, start) +
      before +
      after +
      editor.value.substring(end);
    editor.selectionStart = start + before.length;
    editor.selectionEnd = start + before.length;
  } else {
    editor.value =
      editor.value.substring(0, start) +
      before +
      selectedText +
      after +
      editor.value.substring(end);
    editor.selectionStart = start;
    editor.selectionEnd = start + before.length + selectedText.length;
  }

  editor.dispatchEvent(new Event("input"));
}

function prefixLine(prefix) {
  const editor = document.getElementById("editor");
  const start = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;

  const currentLine = editor.value.substring(
    lineStart,
    editor.value.indexOf("\n", lineStart) === -1
      ? editor.value.length
      : editor.value.indexOf("\n", lineStart)
  );

  // Remove any existing heading prefix
  let trimmed = currentLine.replace(/^#+\s/, "");

  const newLine = prefix + trimmed;
  editor.value =
    editor.value.substring(0, lineStart) +
    newLine +
    editor.value.substring(lineStart + currentLine.length);

  editor.dispatchEvent(new Event("input"));
}

async function saveCurrentFile() {
  if (!currentFilePath || !isDirty) return;

  try {
    const content = document.getElementById("editor").value;
    await invoke("write_file", {
      filePath: currentFilePath,
      content,
    });
    isDirty = false;

    // Rebuild link index after save
    await buildLinkIndex();

    await updateTagsBar(currentFilePath);

    showStatus("Saved");
  } catch (error) {
    console.error("Failed to save file:", error);
    showStatus(`Error saving: ${error.message || error}`);
  }
}

// ===== PREVIEW =====

async function updatePreview() {
  if (!currentFilePath) {
    document.getElementById("preview").srcdoc = "<p>No file open</p>";
    return;
  }

  try {
    const content = document.getElementById("editor").value;
    const html = await invoke("render_markdown", {
      markdown: content,
      userCss: currentUserCss,
      filePath: currentFilePath,
    });

    document.getElementById("preview").srcdoc = html;
  } catch (error) {
    console.error("Failed to render preview:", error);
    const errorHtml = `<div style="padding: 20px; color: red;"><strong>Error rendering preview:</strong><br>${error.message || error}</div>`;
    document.getElementById("preview").srcdoc = errorHtml;
  }
}

// ===== WIKILINKS, BACKLINKS, TAGS =====

async function buildLinkIndex() {
  try {
    await invoke("build_link_index", { vaultPath: currentVaultPath });
  } catch (error) {
    console.warn("Failed to build link index:", error);
  }
}

// Listen for wikilink clicks from preview iframe
window.addEventListener("message", async (msg) => {
  if (msg.data.type === "wikilink") {
    const href = msg.data.href || "";
    const stem = href.replace(/^\.\//, "").replace(/\.md$/, "");
    const path = findNoteByName(stem);
    if (path) {
      await loadFile(path);
    } else {
      showStatus(`Note not found: ${stem}`);
    }
  }
});

function findNoteByName(name) {
  const normalizedName = name.toLowerCase().trim();

  const walk = (nodes) => {
    for (const node of nodes) {
      if (!node.is_dir) {
        const nodeStem = node.name.replace(/\.md$/, "").toLowerCase();
        if (nodeStem === normalizedName) {
          return node.path;
        }
      } else if (node.children) {
        const found = walk(node.children);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(fileTreeCache);
}


async function updateTagsBar(filePath) {
  try {
    const tags = await invoke("get_tags_for_note", {
      vaultPath: currentVaultPath,
      notePath: filePath
    });
    const tagsContainer = document.getElementById("note-tags");

    tagsContainer.innerHTML = "";

    if (!tags || tags.length === 0) {
      return;
    }

    tags.forEach((tag) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      tagsContainer.appendChild(span);
    });
  } catch (error) {
    console.warn("Failed to update tags:", error);
  }
}

// ===== FILE WATCHING =====

async function initializeFileWatcher() {
  try {
    // Start file watcher on the vault
    await invoke("start_watch", { vaultPath: currentVaultPath });

    // Try to listen for vault-changed events
    try {
      // Attempt to use Tauri event system if available
      if (window.__TAURI__ && window.__TAURI__.event) {
        const { listen } = window.__TAURI__.event;
        const unlisten = await listen("vault-changed", async () => {
          console.log("Vault changed, refreshing file tree...");
          // Small delay to allow file system to settle
          await new Promise((resolve) => setTimeout(resolve, 500));
          await refreshFileTree();
          await buildLinkIndex();
        });

        // Store unlisten for potential cleanup
        window.vaultWatcherUnlisten = unlisten;
      }
    } catch (eventError) {
      console.warn(
        "Event listener not available, using polling fallback:",
        eventError
      );
      // Fallback: poll every 3 seconds
      setInterval(async () => {
        const nodes = await invoke("list_vault", {
          vaultPath: currentVaultPath,
        });
        // Simple check: compare file counts
        if (JSON.stringify(nodes) !== JSON.stringify(fileTreeCache)) {
          await refreshFileTree();
          await buildLinkIndex();
        }
      }, 3000);
    }
  } catch (error) {
    console.warn("File watching setup failed:", error);
  }
}

// ===== SIDEBAR TABS & OUTLINE =====

function switchSidebarTab(tab) {
  activeSidebarTab = tab;
  document.querySelectorAll(".sidebar-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("file-tree-container").style.display = tab === "files" ? "" : "none";
  document.getElementById("outline-container").style.display = tab === "outline" ? "block" : "none";
  document.getElementById("links-container").style.display = tab === "links" ? "block" : "none";
  document.getElementById("new-file-btn").style.display = tab === "files" ? "" : "none";
  if (tab === "outline") buildOutline();
  if (tab === "links") buildLinksPanel();
}

function stripMarkdown(text) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2") // [[link|alias]] → alias
    .replace(/\[\[([^\]]+)\]\]/g, "$1")             // [[link]] → link
    .replace(/\*\*([^*]+)\*\*/g, "$1")              // **bold**
    .replace(/\*([^*]+)\*/g, "$1")                  // *italic*
    .replace(/_([^_]+)_/g, "$1")                    // _italic_
    .replace(/`([^`]+)`/g, "$1")                    // `code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")        // [text](url)
    .trim();
}

function headerSlug(text) {
  // Same algorithm comrak uses for header_ids: lowercase, spaces→hyphens, keep a-z 0-9 hyphens only
  return Array.from(text.toLowerCase())
    .map((c) => (/[a-z0-9]/.test(c) ? c : c === " " ? "-" : ""))
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildOutline() {
  const list = document.getElementById("outline-list");
  list.innerHTML = "";

  const content = document.getElementById("editor").value;
  if (!content || !currentFilePath) {
    const li = document.createElement("li");
    li.className = "outline-empty";
    li.textContent = currentFilePath ? "No headings found" : "No file open";
    list.appendChild(li);
    return;
  }

  const lines = content.split("\n");
  const headers = [];
  lines.forEach((line, lineIndex) => {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headers.push({ level: match[1].length, text: match[2].trim(), lineIndex });
    }
  });

  if (headers.length === 0) {
    const li = document.createElement("li");
    li.className = "outline-empty";
    li.textContent = "No headings found";
    list.appendChild(li);
    return;
  }

  headers.forEach(({ level, text, lineIndex }) => {
    const display = stripMarkdown(text);
    const li = document.createElement("li");
    li.className = `outline-item h${level}`;
    li.textContent = display;
    li.title = display;
    li.addEventListener("click", () => {
      scrollEditorToLine(lineIndex);
      scrollPreviewToHeader(display);
    });
    list.appendChild(li);
  });
}

function buildLinksPanel() {
  const list = document.getElementById("links-list");
  list.innerHTML = "";

  const content = document.getElementById("editor").value;
  if (!content || !currentFilePath) {
    const li = document.createElement("li");
    li.className = "links-empty";
    li.textContent = currentFilePath ? "No links found" : "No file open";
    list.appendChild(li);
    return;
  }

  const wikilinkRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const seen = new Set();
  const links = [];
  let match;
  while ((match = wikilinkRe.exec(content)) !== null) {
    const stem = match[1].trim();
    if (stem && !seen.has(stem.toLowerCase())) {
      seen.add(stem.toLowerCase());
      links.push(stem);
    }
  }

  if (links.length === 0) {
    const li = document.createElement("li");
    li.className = "links-empty";
    li.textContent = "No links found";
    list.appendChild(li);
    return;
  }

  links.forEach((stem) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.textContent = stem;
    a.addEventListener("click", async () => {
      const path = findNoteByName(stem);
      if (path) await loadFile(path);
      else showStatus(`Note not found: ${stem}`);
    });
    li.appendChild(a);
    list.appendChild(li);
  });
}

function scrollEditorToLine(lineIndex) {
  const editor = document.getElementById("editor");
  const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 23;
  editor.scrollTop = Math.max(0, lineIndex * lineHeight);
}

function scrollPreviewToHeader(headerText) {
  const iframe = document.getElementById("preview");
  const id = headerSlug(headerText);
  iframe.contentWindow?.postMessage({ type: "scroll-to-heading", id }, "*");
}

// ===== UI STATE PERSISTENCE =====

function restoreUiState(settings) {
  if (currentPlatform === "ios") return;

  if (settings.sidebarWidth) {
    document.getElementById("sidebar").style.flex = `0 0 ${settings.sidebarWidth}px`;
  }

  if (settings.editorWidth) {
    savedEditorFlexBasis = settings.editorWidth;
  }

  const savedPreview = settings.previewVisible;
  if (savedPreview === false) {
    // Directly set state without going through togglePreview (avoids saveUiState during init)
    previewVisible = false;
    document.getElementById("preview-pane").style.display = "none";
    document.getElementById("editor-resize").style.display = "none";
    const btn = document.getElementById("preview-toggle-btn");
    btn.classList.remove("active");
    btn.title = "Show preview (⌘E)";
    btn.setAttribute("aria-label", "Show preview");
    // Editor expands freely when preview is hidden
  } else if (savedEditorFlexBasis) {
    document.getElementById("editor-pane").style.flex = `0 0 ${savedEditorFlexBasis}px`;
  }
}

async function saveUiState() {
  if (!isInitialized || currentPlatform === "ios") return;
  try {
    const sidebarWidth = document.getElementById("sidebar").getBoundingClientRect().width || null;
    const editorWidth = previewVisible
      ? (document.getElementById("editor-pane").getBoundingClientRect().width || null)
      : null;
    await invoke("save_ui_state", {
      sidebarWidth: sidebarWidth > 0 ? sidebarWidth : null,
      editorWidth: editorWidth && editorWidth > 0 ? editorWidth : null,
      previewVisible,
      lastOpenFile: currentFilePath,
    });
  } catch (_) {}
}

// ===== SETTINGS =====

let settingsBeforeEdit = {
  vaultPath: null,
  userCss: "",
  spellCheck: true,
};

function openSettingsDialog() {
  const dialog = document.getElementById("settings-dialog");

  settingsBeforeEdit = {
    vaultPath: currentVaultPath,
    userCss: currentUserCss,
    spellCheck: currentSpellCheck,
  };

  document.getElementById("vault-path-display").textContent = currentVaultPath;
  document.getElementById("css-editor").value = currentUserCss;
  document.getElementById("spell-check-toggle").checked = currentSpellCheck;

  dialog.showModal();
}

function closeSettingsDialog() {
  document.getElementById("settings-dialog").close();
}

async function saveSettings() {
  try {
    const newCss = document.getElementById("css-editor").value;
    const newSpellCheck = document.getElementById("spell-check-toggle").checked;
    let newVaultPath = currentVaultPath;

    // Check if vault path changed
    const vaultPathInput = document.getElementById("vault-path-display");
    const displayedPath = vaultPathInput.textContent;

    if (displayedPath !== currentVaultPath) {
      newVaultPath = displayedPath;
    }

    // Validate vault path exists
    try {
      await invoke("list_vault", { vaultPath: newVaultPath });
    } catch (error) {
      showStatus(`Invalid vault path: ${newVaultPath}`);
      return;
    }

    // Save settings
    await invoke("save_settings", {
      vaultPath: newVaultPath,
      userCss: newCss,
      spellCheck: newSpellCheck,
    });

    currentUserCss = newCss;
    currentSpellCheck = newSpellCheck;
    document.getElementById("editor").spellcheck = newSpellCheck;

    // If vault changed, reload everything
    if (newVaultPath !== currentVaultPath) {
      currentVaultPath = newVaultPath;
      currentFilePath = null;
      document.getElementById("editor").value = "";
      await refreshFileTree();
      await buildLinkIndex();
      showStatus(`Vault changed to: ${newVaultPath}`);
    } else {
      // Just update preview with new CSS
      if (currentFilePath) {
        await updatePreview();
      }
      showStatus("Settings saved");
    }

    closeSettingsDialog();
  } catch (error) {
    console.error("Failed to save settings:", error);
    showStatus(`Error: ${error.message || error}`);
  }
}

function cancelSettings() {
  document.getElementById("vault-path-display").textContent =
    settingsBeforeEdit.vaultPath;
  document.getElementById("css-editor").value = settingsBeforeEdit.userCss;
  document.getElementById("spell-check-toggle").checked =
    settingsBeforeEdit.spellCheck;
  closeSettingsDialog();
}

async function pickVaultFolder() {
  try {
    // Try to use native dialog if available
    let folderPath = null;

    // Try Tauri plugin dialog if available
    if (window.__TAURI__ && window.__TAURI__.plugin) {
      try {
        const dialogModule = await window.__TAURI__.plugin.dialog();
        if (dialogModule && dialogModule.open) {
          folderPath = await dialogModule.open({
            directory: true,
            title: "Select new vault folder",
          });
        }
      } catch (e) {
        // Plugin not available, fall back to prompt
      }
    }

    // Fallback to prompt
    if (!folderPath) {
      folderPath = prompt(
        "Enter the full path to your new vault folder:\n\nExample: /Users/yourname/my-vault"
      );
    }

    if (folderPath && folderPath.trim()) {
      // Validate path
      try {
        await invoke("list_vault", { vaultPath: folderPath });
      } catch (error) {
        showStatus(`Cannot access folder: ${folderPath}`);
        return;
      }

      // Update display
      document.getElementById("vault-path-display").textContent = folderPath;
      showStatus("Vault path updated (click Save to confirm)");
    }
  } catch (error) {
    console.error("Failed to pick vault:", error);
    showStatus(`Error: ${error.message || error}`);
  }
}

// ===== iOS TABS =====

function switchTab(tabName) {
  if (currentPlatform !== "ios") return;

  // Hide all panes
  document.getElementById("sidebar").classList.remove("active");
  document.getElementById("editor-pane").classList.remove("active");
  document.getElementById("preview-pane").classList.remove("active");

  // Deactivate all tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  // Show selected pane
  switch (tabName) {
    case "files":
      document.getElementById("sidebar").classList.add("active");
      break;
    case "editor":
      document.getElementById("editor-pane").classList.add("active");
      break;
    case "preview":
      document.getElementById("preview-pane").classList.add("active");
      break;
  }

  // Activate selected tab
  document
    .querySelector(`[data-tab="${tabName}"]`)
    ?.classList.add("active");
}

// ===== UI HELPERS =====

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("expanded");
}

function showStatus(message) {
  console.log(`Status: ${message}`);

  const statusBar = document.getElementById("status-bar");
  const statusMessage = document.getElementById("status-message");

  if (statusBar && statusMessage) {
    statusMessage.textContent = message;
    statusBar.classList.add("visible");

    setTimeout(() => {
      statusBar.classList.remove("visible");
    }, 3000);
  }
}

// ===== MAIN =====

console.log("Script loaded, setting up initialization...");

// Wait for both DOM and Tauri to be ready
document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM content loaded");

  // Give Tauri a moment to initialize
  setTimeout(() => {
    console.log("Calling initialize...");
    initialize();
  }, 100);
});
