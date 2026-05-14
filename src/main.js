// Tauri API
let invoke;

if (!window.__TAURI__) {
  console.error("Tauri not available!");
  document.body.innerHTML = "<p style='color:red;padding:20px'>Error: Tauri API not available.</p>";
} else {
  invoke = window.__TAURI__.core.invoke;
}

// ===== STATE =====

let currentPlatform = "macos";
let currentVaultPath = null;
let currentFilePath = null;
let currentUserCss = "";
let currentSpellCheck = true;
let currentUsePandoc = false;
let currentBibPath = null;
let currentCslPath = null;
let previewVisible = true;
let savedEditorFlexBasis = null;
let isDirty = false;
let isInitialized = false;
let activeSidebarTab = "files";
let previewDebounceTimer = null;
let autoSaveDebounceTimer = null;
let editorScrollTimer = null;
let suppressEditorScroll = false;   // true while preview→editor sync is in progress
let suppressPreviewScroll = false;  // true while editor→preview sync is in progress
let dragDidOccur = false;    // suppresses click after a completed mouse-drag
let tabs = [];               // [{ id, path, isDirty, content, undoStack, redoStack }]
let undoStack = [];          // active tab's undo snapshots [{value, start, end}]
let redoStack = [];          // active tab's redo snapshots
let undoDebounceTimer = null;
let activeTabId = null;
let tabCounter = 0;
let fileTreeCache = [];

// Citation engine state
let citeBibData = null;
let citeTemplateName = null;

// ===== FILE TREE ICONS =====

const ICON_CHEVRON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ICON_FOLDER_CLOSED = `<svg class="folder-svg-closed" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="none" stroke="var(--icon-folder)" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1"/></svg>`;

const ICON_FOLDER_OPEN = `<svg class="folder-svg-open" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="none" stroke="var(--icon-folder)" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-1.75 7a1 1 0 0 1-.97.76H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1"/></svg>`;

const ICON_FILE_MD = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16"><path fill="none" stroke="var(--icon-md)" stroke-linecap="round" stroke-linejoin="round" d="m9.25 8.25l2.25 2.25l2.25-2.25M3.5 11V5.5l2.04 3l1.96-3V11m4-.5V5M1.65 2.5h12.7c.59 0 1.15.49 1.15 1v9c0 .51-.56 1-1.15 1H1.65c-.59 0-1.15-.49-1.15-1V3.58c0-.5.56-1.08 1.15-1.08"/></svg>`;

const ICON_FILE_GENERIC = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 15 15"><path fill="none" stroke="var(--icon-file)" stroke-linecap="round" stroke-linejoin="round" d="M3 2.5C3 2.22 3.22 2 3.5 2H9.09c.13 0 .26.05.35.15l2.41 2.41c.1.09.15.22.15.35V12.5c0 .28-.22.5-.5.5h-8c-.28 0-.5-.22-.5-.5v-10ZM3.5 3H8.5V5.5c0 .28.22.5.5.5H11.5V12h-8V3Z"/></svg>`;

function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  return ext === "md" ? ICON_FILE_MD : ICON_FILE_GENERIC;
}

// ===== INLINE RENAME =====

async function startInlineRename(nameEl, oldPath) {
  if (!nameEl.isConnected) return; // tree was refreshed since right-click

  const oldName = oldPath.split("/").pop();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-rename-input";
  input.value = oldName;
  nameEl.replaceWith(input);
  input.focus();
  const dotIdx = oldName.lastIndexOf(".");
  input.setSelectionRange(0, dotIdx > 0 ? dotIdx : oldName.length);

  let done = false;

  async function commit() {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!newName || newName === oldName) { input.replaceWith(nameEl); return; }
    try {
      const newPath = await invoke("rename_file", { oldPath, newName });
      tabs.forEach(t => {
        if (t.path === oldPath) {
          t.path = newPath;
          if (t.id === activeTabId) currentFilePath = newPath;
        }
      });
      renderTabBar();
      await refreshFileTree();
      if (currentFilePath === newPath) await revealFileInTree(newPath);
      showStatus(`Renamed to "${newName}"`);
    } catch (err) {
      input.replaceWith(nameEl);
      showStatus(`Rename failed: ${err}`, true);
    }
  }

  function cancel() {
    if (done) return;
    done = true;
    input.replaceWith(nameEl);
  }

  input.addEventListener("blur", commit);

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", commit); cancel(); }
  });
}

// ===== INITIALIZATION =====

async function initialize() {
  try {
    if (!invoke) throw new Error("Tauri invoke not available");

    currentPlatform = await invoke("get_platform");
    document.body.dataset.platform = currentPlatform;

    const settings = await invoke("get_settings");
    currentUserCss = settings.userCss || settings.user_css || "";
    currentSpellCheck = settings.spellCheck ?? settings.spell_check ?? true;
    currentUsePandoc = settings.usePandoc ?? false;
    currentBibPath = settings.cslJsonPath || settings.csl_json_path || null;
    currentCslPath = settings.cslStylePath || settings.csl_style_path || null;
    document.getElementById("editor").spellcheck = currentSpellCheck;

    let vaultPath = settings.vaultPath || settings.vault_path;

    if (!vaultPath) {
      if (currentPlatform === "macos") {
        const folderPath = await showVaultPicker();
        if (!folderPath || !folderPath.trim()) {
          showStatus("No vault selected. Please reload.");
          return;
        }
        vaultPath = folderPath.trim();
      } else {
        vaultPath = await invoke("get_ios_documents_path");
      }
      await invoke("save_settings", { vaultPath, userCss: currentUserCss });
    }

    currentVaultPath = vaultPath;
    document.getElementById("vault-path-display").textContent = vaultPath;

    setupEventListeners();
    restoreUiState(settings);

    await refreshFileTree();
    await buildLinkIndex();
    initializeFileWatcher();
    await loadCitations();

    isInitialized = true;

    const lastOpenFile = settings.lastOpenFile || settings.last_open_file;
    const openFiles = settings.openFiles || settings.open_files || (lastOpenFile ? [lastOpenFile] : []);

    if (openFiles.length > 0) {
      const results = await Promise.allSettled(
        openFiles.map(path => invoke("read_file", { filePath: path }))
      );
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          const tabId = `tab-${++tabCounter}`;
          tabs.push({ id: tabId, path: openFiles[i], isDirty: false, content: result.value });
        }
      });
      if (tabs.length > 0) {
        const activeTab = tabs.find(t => t.path === lastOpenFile) || tabs[tabs.length - 1];
        await switchToTab(activeTab.id);
      }
    }

    if (!currentFilePath) showStatus("Ready");

  } catch (error) {
    console.error("Init failed:", error);
    showStatus(`Error: ${error.message || error}`);
    document.getElementById("app").innerHTML = `
      <div style="padding:20px;color:red">
        <h2>Initialization Error</h2>
        <p>${error.message || error}</p>
      </div>
    `;
  }
}

// ===== VAULT PICKER =====

async function showVaultPicker() {
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
  await invoke("save_settings", { vaultPath: selected, userCss: currentUserCss });
  await refreshFileTree();
  await buildLinkIndex();
  closeFile();
}

// ===== EVENT LISTENERS =====

function setupEventListeners() {
  initResizableHandles();

  const editor = document.getElementById("editor");
  editor.addEventListener("input", onEditorInput);
  editor.addEventListener("keydown", onEditorKeydown);
  editor.addEventListener("scroll", onEditorScroll, { passive: true });

  document.getElementById("preview-toggle-btn").addEventListener("click", togglePreview);

  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "e") { e.preventDefault(); togglePreview(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); saveCurrentFile(); }
  });

  document.querySelectorAll(".sidebar-tab").forEach(btn => {
    btn.addEventListener("click", () => switchSidebarTab(btn.dataset.tab));
  });

  document.getElementById("new-file-btn").addEventListener("click", promptNewFile);
  document.getElementById("change-vault-btn").addEventListener("click", changeVaultFolder);
  document.getElementById("settings-btn").addEventListener("click", openSettingsDialog);
  document.getElementById("close-settings").addEventListener("click", cancelSettings);
  document.getElementById("cancel-settings-btn").addEventListener("click", cancelSettings);
  document.getElementById("save-settings-btn").addEventListener("click", saveSettings);
  document.getElementById("pick-vault-btn")?.addEventListener("click", pickVaultFolder);
  document.getElementById("pick-bib-btn")?.addEventListener("click", () => pickFileForSetting(
    "bib-path-display",
    ["json", "bib"],
    "Select bibliography file (CSL JSON or BibTeX)"
  ));
  document.getElementById("clear-bib-btn")?.addEventListener("click", () => {
    document.getElementById("bib-path-display").textContent = "None selected";
  });
  document.getElementById("pick-csl-btn")?.addEventListener("click", () => pickFileForSetting(
    "csl-path-display",
    ["csl", "xml"],
    "Select CSL style file"
  ));
  document.getElementById("clear-csl-btn")?.addEventListener("click", () => {
    document.getElementById("csl-path-display").textContent = "None selected (defaults to APA)";
  });

  if (currentPlatform === "ios") {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", e => switchTab(e.target.dataset.tab));
    });
    document.getElementById("settings-tab-btn")?.addEventListener("click", openSettingsDialog);
    switchTab("editor");
  }

  document.getElementById("settings-dialog").addEventListener("keydown", e => {
    if (e.key === "Escape") closeSettingsDialog();
  });

  // Messages from preview iframe
  window.addEventListener("message", async msg => {
    if (msg.data.type === "open-url") {
      await window.__TAURI__.opener.openUrl(msg.data.href);
      return;
    }

    if (msg.data.type === "wikilink") {
      const stem = (msg.data.href || "").replace(/^\.\//, "").replace(/\.md$/, "");
      const path = findNoteByName(stem);
      if (path) await loadFile(path);
      else showStatus(`Note not found: ${stem}`);
      return;
    }

    if (msg.data.type === "preview-scroll") {
      if (suppressPreviewScroll || !currentFilePath) return;
      const { currentId, nextId, fraction } = msg.data;
      const positions = getEditorHeadingPositions();
      const editor = document.getElementById("editor");

      let targetScrollTop;
      if (positions.length === 0 || currentId === null && nextId === null) {
        targetScrollTop = fraction * Math.max(0, editor.scrollHeight - editor.clientHeight);
      } else {
        const cur = currentId ? positions.find(h => h.slug === currentId) : null;
        const nxt = nextId ? positions.find(h => h.slug === nextId) : null;
        if (!cur && !nxt) {
          targetScrollTop = fraction * Math.max(0, editor.scrollHeight - editor.clientHeight);
        } else if (cur && nxt) {
          targetScrollTop = cur.pixelTop + fraction * (nxt.pixelTop - cur.pixelTop);
        } else if (cur) {
          targetScrollTop = cur.pixelTop + fraction * (editor.scrollHeight - cur.pixelTop);
        } else {
          targetScrollTop = fraction * nxt.pixelTop;
        }
      }

      suppressEditorScroll = true;
      editor.scrollTop = targetScrollTop;
      setTimeout(() => { suppressEditorScroll = false; }, 300);
    }
  });
}

// ===== FILE DRAG (mouse-event based, bypasses WKWebView native drag) =====

function addFileMouseDrag(li, filePath, fileName) {
  li.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    if (e.target.tagName === "INPUT") return; // don't interfere with rename input

    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let ghost = null;

    function clearHighlights() {
      document.querySelectorAll(".tree-drop-target").forEach(el => el.classList.remove("tree-drop-target"));
    }

    function getDropZone(x, y) {
      const editorEl = document.getElementById("editor");
      const er = editorEl?.getBoundingClientRect();
      if (er && x >= er.left && x <= er.right && y >= er.top && y <= er.bottom) {
        return { destDir: null, dir: null, overEditor: true };
      }
      const el = document.elementFromPoint(x, y);
      const dir = el?.closest(".tree-dir");
      if (dir) {
        const destDir = dir.querySelector(":scope > ul")?.dataset.path
                     ?? dir.querySelector("ul")?.dataset.path ?? null;
        return { destDir, dir, overEditor: false };
      }
      const sidebar = document.getElementById("sidebar");
      const sr = sidebar?.getBoundingClientRect();
      if (sr && x >= sr.left && x <= sr.right && y >= sr.top && y <= sr.bottom) {
        return { destDir: currentVaultPath, dir: null, overEditor: false };
      }
      return { destDir: null, dir: null, overEditor: false };
    }

    function onMove(e) {
      if (!started) {
        if (Math.abs(e.clientX - startX) < 5 && Math.abs(e.clientY - startY) < 5) return;
        started = true;
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.innerHTML = getFileIcon(fileName);
        ghost.appendChild(document.createTextNode(" " + fileName));
        document.body.appendChild(ghost);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        document.body.classList.add("dragging-file");
      }

      ghost.style.left = (e.clientX + 14) + "px";
      ghost.style.top  = (e.clientY - 10) + "px";

      clearHighlights();
      const { dir } = getDropZone(e.clientX, e.clientY);
      if (dir) dir.classList.add("tree-drop-target");
    }

    async function onUp(e) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (!started) return;

      dragDidOccur = true;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.body.classList.remove("dragging-file");
      ghost?.remove();
      clearHighlights();

      const { destDir, dir, overEditor } = getDropZone(e.clientX, e.clientY);

      if (overEditor) {
        const editor = document.getElementById("editor");
        editor.focus();
        const pos = editor.selectionStart;
        const stem = fileName.replace(/\.md$/i, "");
        const link = `[[${stem}]]`;
        editorReplace(editor, pos, pos, link);
        return;
      }

      if (!destDir) return;

      const srcParent = filePath.split("/").slice(0, -1).join("/");
      if (srcParent === destDir) { showStatus("File is already in this folder"); return; }

      try {
        const newPath = await invoke("move_file", { srcPath: filePath, destDir });
        tabs.forEach(t => {
          if (t.path === filePath) {
            t.path = newPath;
            if (t.id === activeTabId) currentFilePath = newPath;
          }
        });
        renderTabBar();
        await refreshFileTree();
        showStatus(`Moved to ${destDir.split("/").pop()}/`);
      } catch (err) {
        showStatus(`Move failed: ${err}`, true);
      }
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ===== TOGGLE PREVIEW =====

function togglePreview() {
  const editorPane = document.getElementById("editor-pane");
  if (previewVisible) {
    const w = editorPane.getBoundingClientRect().width;
    if (w > 0) savedEditorFlexBasis = w;
    editorPane.style.flex = "";
  } else {
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

// ===== RESIZE HANDLES =====

function startDrag(handle, startX, onDrag, onEnd) {
  const iframe = document.getElementById("preview");
  handle.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  if (iframe) iframe.style.pointerEvents = "none";

  function onMove(e) { onDrag(e.clientX - startX); }
  function onUp() {
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (iframe) iframe.style.pointerEvents = "";
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    if (onEnd) onEnd();
  }
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function initResizableHandles() {
  if (currentPlatform === "ios") return;
  const sidebar = document.getElementById("sidebar");
  const editorPane = document.getElementById("editor-pane");
  const app = document.getElementById("app");

  const sidebarHandle = document.getElementById("sidebar-resize");
  sidebarHandle.addEventListener("mousedown", e => {
    e.preventDefault();
    const startWidth = sidebar.getBoundingClientRect().width;
    startDrag(sidebarHandle, e.clientX, dx => {
      const newWidth = Math.max(160, Math.min(480, startWidth + dx));
      sidebar.style.flex = `0 0 ${newWidth}px`;
    }, saveUiState);
  });

  const editorHandle = document.getElementById("editor-resize");
  editorHandle.addEventListener("mousedown", e => {
    e.preventDefault();
    const startWidth = editorPane.getBoundingClientRect().width;
    startDrag(editorHandle, e.clientX, dx => {
      const appWidth = app.getBoundingClientRect().width;
      const sidebarWidth = sidebar.getBoundingClientRect().width;
      const maxWidth = appWidth - sidebarWidth - 200 - 10;
      const newWidth = Math.max(200, Math.min(maxWidth, startWidth + dx));
      editorPane.style.flex = `0 0 ${newWidth}px`;
      savedEditorFlexBasis = newWidth;
    }, saveUiState);
  });
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

async function revealFileInTree(filePath) {
  if (!filePath || !currentVaultPath) return;
  const relative = filePath.startsWith(currentVaultPath)
    ? filePath.slice(currentVaultPath.length).replace(/^\//, "")
    : filePath;
  const segments = relative.split("/");
  if (segments.length <= 1) return;

  let dirPath = currentVaultPath;
  for (let i = 0; i < segments.length - 1; i++) {
    dirPath = dirPath + "/" + segments[i];
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

  nodes.forEach(node => {
    const li = document.createElement("li");
    if (node.is_dir) {
      li.className = "tree-dir collapsed";
      const label = document.createElement("div");
      label.className = "tree-label";
      // Icons via innerHTML (trusted constants), name via textContent (safe)
      label.innerHTML = `<span class="tree-chevron">${ICON_CHEVRON}</span><span class="tree-folder-icon">${ICON_FOLDER_CLOSED}${ICON_FOLDER_OPEN}</span>`;
      const nameSpan = document.createElement("span");
      nameSpan.className = "tree-item-name";
      nameSpan.textContent = node.name;
      label.appendChild(nameSpan);
      const nested = document.createElement("ul");
      nested.dataset.path = node.path;
      label.addEventListener("click", async e => {
        e.stopPropagation();
        const isCollapsed = li.classList.contains("collapsed");
        li.classList.toggle("collapsed");
        // No manual icon swap needed — CSS handles chevron rotation and folder open/close
        if (isCollapsed && !nested.dataset.loaded) {
          const children = await invoke("list_dir", { dirPath: node.path });
          renderFileTree(children, nested);
          nested.dataset.loaded = "true";
        }
      });
      nameSpan.addEventListener("dblclick", e => {
        e.stopPropagation();
        startInlineRename(nameSpan, node.path);
      });
      li.appendChild(label);
      li.appendChild(nested);
    } else {
      li.className = "file-item";
      li.dataset.path = node.path;
      const iconEl = document.createElement("span");
      iconEl.className = "tree-file-icon";
      iconEl.innerHTML = getFileIcon(node.name);
      const nameEl = document.createElement("span");
      nameEl.className = "tree-item-name";
      nameEl.textContent = node.name;
      li.appendChild(iconEl);
      li.appendChild(nameEl);
      li.addEventListener("click", () => {
        if (dragDidOccur) { dragDidOccur = false; return; }
        loadFile(node.path);
      });
      nameEl.addEventListener("dblclick", e => {
        e.stopPropagation();
        startInlineRename(nameEl, node.path);
      });
      addFileMouseDrag(li, node.path, node.name);
    }
    container.appendChild(li);
  });

  if (currentFilePath) {
    document.querySelectorAll(".file-item").forEach(item => {
      item.classList.toggle("active", item.dataset.path === currentFilePath);
    });
  }
}

// ===== TABS =====

function getActiveTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

function renderTabBar() {
  const bar = document.getElementById("editor-tab-bar");
  bar.innerHTML = "";
  tabs.forEach(tab => {
    const el = document.createElement("div");
    el.className = "editor-tab" + (tab.id === activeTabId ? " active" : "");
    el.dataset.tabId = tab.id;

    const nameEl = document.createElement("span");
    nameEl.className = "tab-filename" + (tab.isDirty ? " tab-dirty" : "");
    nameEl.textContent = tab.path.split("/").pop();
    nameEl.title = tab.path;
    el.appendChild(nameEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.title = "Close tab";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", e => { e.stopPropagation(); closeTab(tab.id); });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => switchToTab(tab.id));
    bar.appendChild(el);
  });
}

async function switchToTab(tabId) {
  if (tabId === activeTabId) return;

  // Flush active tab to memory before switching
  if (activeTabId !== null) {
    const cur = getActiveTab();
    if (cur) {
      clearTimeout(autoSaveDebounceTimer);
      clearTimeout(undoDebounceTimer);
      cur.content = getEditorContent();
      cur.isDirty = isDirty;
      cur.undoStack = undoStack.slice();
      cur.redoStack = redoStack.slice();
      if (cur.isDirty) {
        try {
          await invoke("write_file", { filePath: cur.path, content: cur.content });
          cur.isDirty = false;
        } catch (e) { console.error("Auto-save on tab switch failed:", e); }
      }
    }
  }

  activeTabId = tabId;
  const tab = tabs.find(t => t.id === tabId);
  currentFilePath = tab.path;
  isDirty = tab.isDirty;
  undoStack = tab.undoStack ? tab.undoStack.slice() : [];
  redoStack = tab.redoStack ? tab.redoStack.slice() : [];

  document.getElementById("editor").value = tab.content;
  await updatePreview();

  await revealFileInTree(tab.path);
  document.querySelectorAll(".file-item").forEach(item => {
    item.classList.toggle("active", item.dataset.path === tab.path);
  });

  await updateTagsBar(tab.path);
  buildOutline();
  buildLinksPanel();
  renderTabBar();
  saveUiState();
}

async function closeTab(tabId, skipSave = false) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  if (!skipSave) {
    if (tabId === activeTabId && isDirty) {
      await saveCurrentFile();
    } else if (tab.isDirty) {
      try { await invoke("write_file", { filePath: tab.path, content: tab.content }); }
      catch (e) { console.error("Failed to save on close:", e); }
    }
  }

  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);

  if (tabId === activeTabId) {
    activeTabId = null;
    if (tabs.length > 0) {
      await switchToTab(tabs[Math.min(idx, tabs.length - 1)].id);
    } else {
      currentFilePath = null;
      isDirty = false;
      document.getElementById("note-tags").innerHTML = "";
      document.getElementById("editor").value = "";
      document.getElementById("preview").srcdoc = "<p>No file open</p>";
      buildOutline();
      buildLinksPanel();
      renderTabBar();
      saveUiState();
    }
  } else {
    renderTabBar();
  }
}

function closeFile() {
  tabs = [];
  activeTabId = null;
  currentFilePath = null;
  isDirty = false;
  document.getElementById("note-tags").innerHTML = "";
  document.getElementById("editor").value = "";
  document.getElementById("preview").srcdoc = "<p>No file open</p>";
  buildOutline();
  buildLinksPanel();
  renderTabBar();
  saveUiState();
}

async function loadFile(path) {
  try {
    const existing = tabs.find(t => t.path === path);
    if (existing) {
      await switchToTab(existing.id);
      return;
    }

    const content = await invoke("read_file", { filePath: path });

    // Flush current tab to memory before opening new one
    if (activeTabId !== null) {
      const cur = getActiveTab();
      if (cur) {
        clearTimeout(autoSaveDebounceTimer);
        clearTimeout(undoDebounceTimer);
        cur.content = getEditorContent();
        cur.isDirty = isDirty;
        cur.undoStack = undoStack.slice();
        cur.redoStack = redoStack.slice();
      }
    }

    const tabId = `tab-${++tabCounter}`;
    const initialSnap = { value: content, start: 0, end: 0 };
    const tab = { id: tabId, path, isDirty: false, content, undoStack: [initialSnap], redoStack: [] };
    tabs.push(tab);

    activeTabId = tabId;
    currentFilePath = path;
    isDirty = false;
    undoStack = [initialSnap];
    redoStack = [];

    document.getElementById("editor").value = content;
    await updatePreview();

    await revealFileInTree(path);
    document.querySelectorAll(".file-item").forEach(item => {
      item.classList.toggle("active", item.dataset.path === path);
    });

    await updateTagsBar(path);
    buildLinksPanel();
    buildOutline();

    if (currentPlatform === "ios") switchTab("editor");
    showStatus(`Opened: ${path.split("/").pop()}`);
    renderTabBar();
    saveUiState();
  } catch (error) {
    console.error("Failed to load file:", error);
    showStatus(`Error loading file: ${error.message || error}`);
  }
}

async function promptNewFile() {
  let input = document.getElementById("new-file-input");
  if (input) { input.focus(); return; }
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
      const fullName = fileName.endsWith(".md") ? fileName : `${fileName}.md`;
      const path = await invoke("create_new_file", { vaultPath: currentVaultPath, name: fullName });
      await refreshFileTree();
      await loadFile(path);
      await buildLinkIndex();
      showStatus(`Created: ${fullName}`);
    } catch (error) {
      showStatus(`Error: ${error.message || error}`);
    }
  };

  input.addEventListener("keydown", async e => {
    if (e.key === "Enter") await handleSave();
    else if (e.key === "Escape") li.remove();
  });
  input.addEventListener("blur", () => setTimeout(() => { if (li.parentNode) li.remove(); }, 100));
  li.appendChild(input);
  fileTree.insertBefore(li, fileTree.firstChild);
  input.focus();
}

// ===== EDITOR =====

function getEditorContent() {
  return document.getElementById("editor").value;
}

function onEditorInput() {
  if (!currentFilePath) return;
  isDirty = true;
  const cur = getActiveTab();
  if (cur && !cur.isDirty) { cur.isDirty = true; renderTabBar(); }

  clearTimeout(undoDebounceTimer);
  undoDebounceTimer = setTimeout(snapshotForUndo, 500);

  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updatePreview();
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  }, 300);

  clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(saveCurrentFile, 800);
}

function isCursorInCode(value, pos) {
  if (/^(`{3,}|~{3,})/.test(value)) return true;
  let inCode = false;
  for (let i = 0; i < pos; i++) {
    if (value[i] === "`") inCode = !inCode;
  }
  return inCode;
}

function onEditorKeydown(e) {
  const editor = document.getElementById("editor");
  const isMeta = e.metaKey || e.ctrlKey;

  // Zotero Better BibTeX CAYW: \@ triggers the citation picker
  if (e.key === "@" && !isMeta && !e.altKey) {
    const pos = editor.selectionStart;
    if (pos >= 1 && editor.value[pos - 1] === "\\" && !isCursorInCode(editor.value, pos - 1)) {
      e.preventDefault();
      const insertPos = pos - 1;
      editorReplace(editor, insertPos, pos, "");

      (async () => {
        showStatus("Opening Zotero citation picker…");
        try {
          const raw = (await invoke("fetch_zotero_cayw")).trim();
          if (!raw) { showStatus("No citation selected"); return; }
          const citation = raw.startsWith("[") ? raw : `[${raw}]`;
          editorReplace(editor, insertPos, insertPos, citation);
          showStatus("Citation inserted");
        } catch {
          showStatus("Zotero not available — is Zotero running with Better BibTeX?", true);
        }
      })();
      return;
    }
  }

  if (isMeta && !e.shiftKey && e.key === "z") { e.preventDefault(); performUndo(); return; }
  if (isMeta && (e.key === "y" || (e.shiftKey && e.key === "z"))) { e.preventDefault(); performRedo(); return; }

  if (isMeta && e.key === "b") { e.preventDefault(); snapshotForUndo(); wrapSelection("**", "**"); return; }
  if (isMeta && e.key === "i") { e.preventDefault(); snapshotForUndo(); wrapSelection("_", "_"); return; }
  if (isMeta && e.key === "1") { e.preventDefault(); snapshotForUndo(); prefixLine("# "); return; }
  if (isMeta && e.key === "2") { e.preventDefault(); snapshotForUndo(); prefixLine("## "); return; }
  if (isMeta && e.key === "3") { e.preventDefault(); snapshotForUndo(); prefixLine("### "); return; }
}

// Replace editor text in [start, end) while preserving the undo stack.
function editorReplace(editor, start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  document.execCommand("insertText", false, text);
}

// ===== UNDO / REDO =====

function snapshotForUndo() {
  const editor = document.getElementById("editor");
  if (!editor || !currentFilePath) return;
  const snap = { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
  if (undoStack.length > 0 && undoStack[undoStack.length - 1].value === snap.value) return;
  undoStack.push(snap);
  redoStack = [];
  if (undoStack.length > 200) undoStack.shift();
}

function performUndo() {
  const editor = document.getElementById("editor");
  if (!editor) return;
  const cur = editor.value;
  // Discard stale top entries that match the current state
  while (undoStack.length > 0 && undoStack[undoStack.length - 1].value === cur) undoStack.pop();
  if (undoStack.length === 0) return;
  redoStack.push({ value: cur, start: editor.selectionStart, end: editor.selectionEnd });
  applyUndoSnapshot(editor, undoStack.pop());
}

function performRedo() {
  const editor = document.getElementById("editor");
  if (!editor || redoStack.length === 0) return;
  undoStack.push({ value: editor.value, start: editor.selectionStart, end: editor.selectionEnd });
  applyUndoSnapshot(editor, redoStack.pop());
}

function applyUndoSnapshot(editor, snap) {
  editor.value = snap.value;
  editor.setSelectionRange(snap.start, snap.end);
  isDirty = true;
  const tab = getActiveTab();
  if (tab) { tab.content = snap.value; if (!tab.isDirty) { tab.isDirty = true; renderTabBar(); } }
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updatePreview();
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  }, 100);
  clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(saveCurrentFile, 800);
}

function wrapSelection(before, after) {
  const editor = document.getElementById("editor");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.substring(start, end);
  if (!selected) {
    editorReplace(editor, start, end, before + after);
    editor.setSelectionRange(start + before.length, start + before.length);
  } else {
    editorReplace(editor, start, end, before + selected + after);
    editor.setSelectionRange(start, start + before.length + selected.length);
  }
}

function prefixLine(prefix) {
  const editor = document.getElementById("editor");
  const start = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = editor.value.indexOf("\n", lineStart);
  const currentLine = editor.value.substring(lineStart, lineEnd === -1 ? editor.value.length : lineEnd);
  const trimmed = currentLine.replace(/^#+\s/, "");
  editorReplace(editor, lineStart, lineStart + currentLine.length, prefix + trimmed);
}

// ===== PREVIEW =====

function updatePreviewStats(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const text = tmp.innerText || tmp.textContent || "";
  const lines = text.split(/\n/).filter(l => l.trim().length > 0).length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const chars = text.replace(/\s/g, "").length;
  const charsWithSpaces = text.trim().length;
  const el = document.getElementById("preview-stats");
  if (el) el.textContent = `${lines} lines, ${words} words, ${charsWithSpaces} (${chars}) characters`;
}

async function updatePreview() {
  if (!currentFilePath) {
    document.getElementById("preview").srcdoc = "<p>No file open</p>";
    const el = document.getElementById("preview-stats");
    if (el) el.textContent = "";
    return;
  }
  try {
    const content = document.getElementById("editor").value;
    const renderCmd = currentUsePandoc ? "render_markdown_pandoc" : "render_markdown";
    const html = await invoke(renderCmd, {
      markdown: content,
      userCss: currentUserCss,
      filePath: currentFilePath,
    });

    if (citeBibData && citeBibData.length > 0) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const style = doc.createElement("style");
      style.textContent = CITATION_CSS;
      doc.head.appendChild(style);
      await processCitations(doc.body);
      document.getElementById("preview").srcdoc = "<!DOCTYPE html>" + doc.documentElement.outerHTML;
      updatePreviewStats(doc.body.innerHTML);
    } else {
      document.getElementById("preview").srcdoc = html;
      updatePreviewStats(html);
    }
  } catch (error) {
    const errorHtml = `<div style="padding:20px;color:red"><strong>Error rendering preview:</strong><br>${error.message || error}</div>`;
    document.getElementById("preview").srcdoc = errorHtml;
    const el = document.getElementById("preview-stats");
    if (el) el.textContent = "";
  }
}

// ===== FILE SAVE =====

async function saveCurrentFile() {
  if (!currentFilePath || !isDirty) return;
  try {
    const content = getEditorContent();
    await invoke("write_file", { filePath: currentFilePath, content });
    isDirty = false;
    const cur = getActiveTab();
    if (cur) { cur.isDirty = false; cur.content = content; }
    renderTabBar();
    await buildLinkIndex();
    await updateTagsBar(currentFilePath);
    showStatus("Saved");
  } catch (error) {
    console.error("Save failed:", error);
    showStatus(`Error saving: ${error.message || error}`);
  }
}

// ===== WIKILINKS & TAGS =====

async function buildLinkIndex() {
  try {
    await invoke("build_link_index", { vaultPath: currentVaultPath });
  } catch (error) {
    console.warn("Failed to build link index:", error);
  }
}

function findNoteByName(name) {
  const normalized = name.toLowerCase().trim();
  const walk = nodes => {
    for (const node of nodes) {
      if (!node.is_dir) {
        if (node.name.replace(/\.md$/, "").toLowerCase() === normalized) return node.path;
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
    const tags = await invoke("get_tags_for_note", { vaultPath: currentVaultPath, notePath: filePath });
    const container = document.getElementById("note-tags");
    container.innerHTML = "";
    if (!tags || tags.length === 0) return;
    tags.forEach(tag => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      container.appendChild(span);
    });
  } catch (error) {
    console.warn("Failed to update tags:", error);
  }
}

// ===== FILE WATCHING =====

async function initializeFileWatcher() {
  try {
    await invoke("start_watch", { vaultPath: currentVaultPath });
    if (window.__TAURI__?.event) {
      const { listen } = window.__TAURI__.event;
      await listen("vault-changed", async () => {
        await new Promise(r => setTimeout(r, 500));
        await refreshFileTree();
        await buildLinkIndex();
      });
    } else {
      setInterval(async () => {
        const nodes = await invoke("list_vault", { vaultPath: currentVaultPath });
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

// ===== SIDEBAR TABS =====

function switchSidebarTab(tab) {
  activeSidebarTab = tab;
  document.querySelectorAll(".sidebar-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("file-tree-container").style.display = tab === "files" ? "" : "none";
  document.getElementById("outline-container").style.display = tab === "outline" ? "block" : "none";
  document.getElementById("links-container").style.display = tab === "links" ? "block" : "none";
  document.getElementById("new-file-btn").style.display = tab === "files" ? "" : "none";
  if (tab === "outline") buildOutline();
  if (tab === "links") buildLinksPanel();
}

// ===== OUTLINE =====

function stripMarkdown(text) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function headerSlug(text) {
  return Array.from(text.toLowerCase())
    .map(c => (/[a-z0-9]/.test(c) ? c : c === " " ? "-" : ""))
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
    if (match) headers.push({ level: match[1].length, text: match[2].trim(), lineIndex });
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
      setTimeout(() => scrollPreviewToHeader(display), 500);
    });
    list.appendChild(li);
  });
}

function getEditorHeadingPositions() {
  const editor = document.getElementById("editor");
  const lines = editor.value.split("\n");

  // Collect headings with their char offsets and slugs
  const headings = [];
  let charOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (m) {
      headings.push({ slug: headerSlug(stripMarkdown(m[2].trim())), charOffset });
    }
    charOffset += lines[i].length + 1;
  }
  if (headings.length === 0) return [];

  // Single mirror div pass — place all markers at once for efficiency
  const style = getComputedStyle(editor);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", overflow: "hidden",
    width: editor.clientWidth + "px",
    fontFamily: style.fontFamily, fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
    whiteSpace: "pre-wrap", wordBreak: "break-word", boxSizing: "border-box",
  });

  const fullText = editor.value;
  const markers = [];
  let lastOffset = 0;
  for (const h of headings) {
    mirror.appendChild(document.createTextNode(fullText.substring(lastOffset, h.charOffset)));
    const marker = document.createElement("span");
    marker.textContent = "​";
    mirror.appendChild(marker);
    markers.push(marker);
    lastOffset = h.charOffset;
  }
  mirror.appendChild(document.createTextNode(fullText.substring(lastOffset)));
  document.body.appendChild(mirror);

  const result = headings.map((h, i) => ({ slug: h.slug, pixelTop: markers[i].offsetTop }));
  document.body.removeChild(mirror);
  return result;
}

function onEditorScroll() {
  if (suppressEditorScroll || !previewVisible || !currentFilePath) return;
  clearTimeout(editorScrollTimer);
  editorScrollTimer = setTimeout(() => {
    const editor = document.getElementById("editor");
    const scrollTop = editor.scrollTop;
    const positions = getEditorHeadingPositions();

    let currentId = null, nextId = null, fraction = 0;

    if (positions.length === 0) {
      const max = Math.max(1, editor.scrollHeight - editor.clientHeight);
      fraction = scrollTop / max;
    } else {
      let curIdx = -1;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i].pixelTop <= scrollTop + 2) curIdx = i;
      }
      if (curIdx === -1) {
        // Before first heading
        const firstTop = positions[0].pixelTop;
        nextId = positions[0].slug;
        fraction = firstTop > 0 ? Math.min(1, scrollTop / firstTop) : 0;
      } else {
        currentId = positions[curIdx].slug;
        const nxt = positions[curIdx + 1] || null;
        if (nxt) {
          nextId = nxt.slug;
          const range = nxt.pixelTop - positions[curIdx].pixelTop;
          fraction = range > 0 ? (scrollTop - positions[curIdx].pixelTop) / range : 0;
        } else {
          const tail = editor.scrollHeight - positions[curIdx].pixelTop;
          fraction = tail > 0 ? (scrollTop - positions[curIdx].pixelTop) / tail : 0;
        }
      }
      fraction = Math.max(0, Math.min(1, fraction));
    }

    suppressPreviewScroll = true;
    document.getElementById("preview").contentWindow?.postMessage(
      { type: "scroll-to-fraction", currentId, nextId, fraction }, "*"
    );
    setTimeout(() => { suppressPreviewScroll = false; }, 300);
  }, 50);
}

function scrollEditorToLine(lineIndex) {
  const editor = document.getElementById("editor");
  const lines = editor.value.split("\n");

  // Find the character offset of the target line's start
  let charOffset = 0;
  for (let i = 0; i < lineIndex; i++) {
    charOffset += (lines[i]?.length ?? 0) + 1; // +1 for the newline
  }

  // Mirror div: same dimensions/font as the textarea so wrapped lines are measured correctly
  const style = getComputedStyle(editor);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    overflow: "hidden",
    width: editor.clientWidth + "px",
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    boxSizing: "border-box",
  });

  mirror.appendChild(document.createTextNode(editor.value.substring(0, charOffset)));
  const marker = document.createElement("span");
  marker.textContent = "​"; // zero-width space marks the target line
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const pixelTop = marker.offsetTop;
  document.body.removeChild(mirror);

  editor.scrollTop = pixelTop;
}

function scrollPreviewToHeader(headerText) {
  const iframe = document.getElementById("preview");
  const id = headerSlug(headerText);
  iframe.contentWindow?.postMessage({ type: "scroll-to-heading", id }, "*");
}

// ===== LINKS PANEL =====

function buildLinksPanel() {
  const list = document.getElementById("links-list");
  list.innerHTML = "";

  const content = getEditorContent();
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

  links.forEach(stem => {
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

// ===== UI STATE =====

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
    previewVisible = false;
    document.getElementById("preview-pane").style.display = "none";
    document.getElementById("editor-resize").style.display = "none";
    const btn = document.getElementById("preview-toggle-btn");
    btn.classList.remove("active");
    btn.title = "Show preview (⌘E)";
    btn.setAttribute("aria-label", "Show preview");
  } else if (savedEditorFlexBasis) {
    document.getElementById("editor-pane").style.flex = `0 0 ${savedEditorFlexBasis}px`;
  }
}

async function saveUiState() {
  if (!isInitialized || currentPlatform === "ios") return;
  try {
    const sidebarWidth = document.getElementById("sidebar").getBoundingClientRect().width;
    const editorWidth = previewVisible
      ? document.getElementById("editor-pane").getBoundingClientRect().width
      : null;
    await invoke("save_ui_state", {
      sidebarWidth: sidebarWidth > 0 ? sidebarWidth : null,
      editorWidth: editorWidth && editorWidth > 0 ? editorWidth : null,
      previewVisible,
      lastOpenFile: currentFilePath,
      openFiles: tabs.map(t => t.path),
    });
  } catch (_) {}
}

// ===== CITATIONS =====

const Cite = window.Cite;

const CITATION_CSS = `
.citation-ref { color: #888; font-size: 0.9em; cursor: default; }
.citation-ref a { color: #6366f1; text-decoration: none; }
.citation-ref a:hover { text-decoration: underline; }
.citation-missing { color: #888; background: rgba(99,102,241,0.1); border-radius: 2px; padding: 0 2px; }
#citation-bibliography { margin-top: 16px; border-top: 1px solid #e5e5e5; padding-top: 8px; }
#citation-bibliography h2 { font-size: 1em; font-weight: 600; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.05em; }
#citation-bibliography .csl-entry { margin-bottom: 8px; font-size: 0.9em; line-height: 1.5; padding-left: 1.5em; text-indent: -1.5em; }
#citation-bibliography .csl-left-margin { float: left; padding-right: 0.5em; min-width: 2em; text-align: right; }
#citation-bibliography .csl-right-inline { display: block; overflow: hidden; }
`;

async function loadCitations() {
  citeBibData = null;
  citeTemplateName = null;
  if (!currentBibPath) return;
  try {
    const raw = await invoke("read_file", { filePath: currentBibPath });
    const parsed = new Cite(raw);
    citeBibData = parsed.get();
  } catch (e) {
    console.warn("Failed to load bibliography:", e);
    showStatus("Warning: could not load bibliography file");
    return;
  }
  if (currentCslPath) {
    try {
      const cslXml = await invoke("read_file", { filePath: currentCslPath });
      citeTemplateName = "user-csl";
      Cite.plugins.config.get("@csl").templates.add(citeTemplateName, cslXml);
    } catch (e) {
      console.warn("Failed to load CSL style:", e);
      citeTemplateName = null;
    }
  }
}

const LOCATOR_TYPES = [
  [/^pp?\.\s*/, "page"],
  [/^chaps?\.\s*/i, "chapter"],
  [/^sec\.\s*/i, "section"],
  [/^fig\.\s*/i, "figure"],
  [/^vol\.\s*/i, "volume"],
  [/^no\.\s*/i, "issue"],
  [/^¶\s*/, "paragraph"],
  [/^§\s*/, "section"],
];

function parseLocator(str) {
  for (const [re, label] of LOCATOR_TYPES) {
    const m = str.match(re);
    if (m) return { label, locator: str.slice(m[0].length).trim() };
  }
  return { label: "page", locator: str.trim() };
}

function parseCitationInner(inner) {
  const citationItems = [];
  for (const segment of inner.split(";")) {
    const s = segment.trim();
    const atIdx = s.indexOf("@");
    if (atIdx === -1) continue;
    const keyMatch = s.slice(atIdx).match(/^@([^\s,;\]]+)/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const prefix = s.slice(0, atIdx).trim();
    const after = s.slice(atIdx + 1 + key.length).replace(/^,\s*/, "").trim();
    const item = { id: key };
    if (prefix) item.prefix = prefix + " ";
    if (after) Object.assign(item, parseLocator(after));
    citationItems.push(item);
  }
  return { citationItems, properties: { noteIndex: 0 } };
}

async function processCitations(container) {
  if (!citeBibData || citeBibData.length === 0) return;

  const doc = container.ownerDocument;
  const template = citeTemplateName || "apa";
  const refMap = {};
  citeBibData.forEach(ref => { refMap[ref.id] = ref; });
  const allCite = new Cite(citeBibData);
  const CITE_RE = /(\[[^\]]*@[^\]]+\])/;

  const textNodes = [];
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (CITE_RE.test(node.textContent)) textNodes.push(node);
  }

  if (textNodes.length === 0) return;

  const citedKeys = [];

  for (const textNode of textNodes) {
    const parts = textNode.textContent.split(CITE_RE);
    if (parts.length <= 1) continue;

    const fragment = doc.createDocumentFragment();
    for (const part of parts) {
      const m = part.match(/^\[([^\]]*@[^\]]*)\]$/);
      if (!m) {
        fragment.appendChild(doc.createTextNode(part));
        continue;
      }
      const citObj = parseCitationInner(m[1]);
      const validItems = citObj.citationItems.filter(item => refMap[item.id]);
      const validKeys = validItems.map(item => item.id);
      validKeys.forEach(k => { if (!citedKeys.includes(k)) citedKeys.push(k); });

      const span = doc.createElement("span");
      span.className = validKeys.length > 0 ? "citation-ref" : "citation-ref citation-missing";

      if (validKeys.length > 0) {
        try {
          const entry = { citationItems: validItems, properties: { noteIndex: 0 } };
          const html = allCite.format("citation", { format: "html", template, entry });
          span.innerHTML = html;
        } catch {
          span.textContent = citeSimpleInline(validKeys, refMap);
        }
      } else {
        span.textContent = part;
      }
      fragment.appendChild(span);
    }
    textNode.parentNode.replaceChild(fragment, textNode);
  }

  if (citedKeys.length === 0) return;

  try {
    const bibHtml = allCite.format("bibliography", {
      format: "html",
      template,
      entry: citedKeys,
      nosort: true,
    });
    const wrapper = doc.createElement("div");
    wrapper.id = "citation-bibliography";
    wrapper.innerHTML = `<h2>References</h2>${bibHtml}`;
    container.appendChild(wrapper);
  } catch (e) {
    console.warn("Bibliography formatting failed:", e);
  }
}

function citeSimpleInline(keys, refMap) {
  const parts = keys.map(k => {
    const ref = refMap[k];
    if (!ref) return `@${k}`;
    const auth = ref.author?.[0];
    const year = ref.issued?.["date-parts"]?.[0]?.[0];
    const name = auth?.family || auth?.literal || k;
    return year ? `${name}, ${year}` : name;
  });
  return `(${parts.join("; ")})`;
}

// ===== SETTINGS =====

let settingsBeforeEdit = { vaultPath: null, userCss: "", spellCheck: true, usePandoc: false, bibPath: null, cslPath: null };

function openSettingsDialog() {
  settingsBeforeEdit = {
    vaultPath: currentVaultPath,
    userCss: currentUserCss,
    spellCheck: currentSpellCheck,
    usePandoc: currentUsePandoc,
    bibPath: currentBibPath,
    cslPath: currentCslPath,
  };
  document.getElementById("vault-path-display").textContent = currentVaultPath;
  document.getElementById("css-editor").value = currentUserCss;
  document.getElementById("spell-check-toggle").checked = currentSpellCheck;
  document.getElementById("use-pandoc-toggle").checked = currentUsePandoc;
  document.getElementById("bib-path-display").textContent = currentBibPath || "None selected";
  document.getElementById("csl-path-display").textContent = currentCslPath || "None selected (defaults to APA)";
  document.getElementById("settings-dialog").showModal();
}

function closeSettingsDialog() {
  document.getElementById("settings-dialog").close();
}

async function saveSettings() {
  try {
    const newCss = document.getElementById("css-editor").value;
    const newSpellCheck = document.getElementById("spell-check-toggle").checked;
    const newUsePandoc = document.getElementById("use-pandoc-toggle").checked;
    let newVaultPath = currentVaultPath;
    const displayedPath = document.getElementById("vault-path-display").textContent;
    if (displayedPath !== currentVaultPath) newVaultPath = displayedPath;

    const bibDisplay = document.getElementById("bib-path-display").textContent;
    const newBibPath = (bibDisplay && bibDisplay !== "None selected") ? bibDisplay : null;
    const cslDisplay = document.getElementById("csl-path-display").textContent;
    const newCslPath = (cslDisplay && !cslDisplay.startsWith("None selected")) ? cslDisplay : null;

    try {
      await invoke("list_vault", { vaultPath: newVaultPath });
    } catch {
      showStatus(`Invalid vault path: ${newVaultPath}`);
      return;
    }

    await invoke("save_settings", { vaultPath: newVaultPath, userCss: newCss, spellCheck: newSpellCheck, usePandoc: newUsePandoc });
    await invoke("save_citation_settings", { cslJsonPath: newBibPath, cslStylePath: newCslPath });

    currentUserCss = newCss;
    currentSpellCheck = newSpellCheck;
    currentUsePandoc = newUsePandoc;
    document.getElementById("editor").spellcheck = newSpellCheck;

    const bibChanged = newBibPath !== currentBibPath;
    const cslChanged = newCslPath !== currentCslPath;
    currentBibPath = newBibPath;
    currentCslPath = newCslPath;
    if (bibChanged || cslChanged) {
      await loadCitations();
    }

    if (newVaultPath !== currentVaultPath) {
      currentVaultPath = newVaultPath;
      currentFilePath = null;
      closeFile();
      await refreshFileTree();
      await buildLinkIndex();
      showStatus(`Vault changed to: ${newVaultPath}`);
    } else {
      if (currentFilePath) await updatePreview();
      showStatus("Settings saved");
    }
    closeSettingsDialog();
  } catch (error) {
    console.error("Failed to save settings:", error);
    showStatus(`Error: ${error.message || error}`);
  }
}

function cancelSettings() {
  document.getElementById("vault-path-display").textContent = settingsBeforeEdit.vaultPath;
  document.getElementById("css-editor").value = settingsBeforeEdit.userCss;
  document.getElementById("spell-check-toggle").checked = settingsBeforeEdit.spellCheck;
  document.getElementById("use-pandoc-toggle").checked = settingsBeforeEdit.usePandoc;
  document.getElementById("bib-path-display").textContent = settingsBeforeEdit.bibPath || "None selected";
  document.getElementById("csl-path-display").textContent = settingsBeforeEdit.cslPath || "None selected (defaults to APA)";
  closeSettingsDialog();
}

async function pickVaultFolder() {
  try {
    let folderPath = null;
    if (window.__TAURI__?.dialog) {
      folderPath = await window.__TAURI__.dialog.open({ directory: true, title: "Select new vault folder" });
    }
    if (!folderPath) {
      folderPath = prompt("Enter the full path to your vault folder:");
    }
    if (folderPath?.trim()) {
      try {
        await invoke("list_vault", { vaultPath: folderPath });
        document.getElementById("vault-path-display").textContent = folderPath;
        showStatus("Vault path updated (click Save to confirm)");
      } catch {
        showStatus(`Cannot access folder: ${folderPath}`);
      }
    }
  } catch (error) {
    showStatus(`Error: ${error.message || error}`);
  }
}

async function pickFileForSetting(displayId, extensions, title) {
  try {
    let filePath = null;
    if (window.__TAURI__?.dialog) {
      filePath = await window.__TAURI__.dialog.open({
        directory: false,
        multiple: false,
        title,
        filters: [{ name: "Files", extensions }],
      });
    }
    if (!filePath) {
      filePath = prompt(`Enter the full path to the file:\n(${extensions.join(", ")} files)`);
    }
    if (filePath?.trim()) {
      document.getElementById(displayId).textContent = filePath.trim();
    }
  } catch (error) {
    showStatus(`Error: ${error.message || error}`);
  }
}

// ===== iOS TABS =====

function switchTab(tabName) {
  if (currentPlatform !== "ios") return;
  document.getElementById("sidebar").classList.remove("active");
  document.getElementById("editor-pane").classList.remove("active");
  document.getElementById("preview-pane").classList.remove("active");
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  switch (tabName) {
    case "files": document.getElementById("sidebar").classList.add("active"); break;
    case "editor": document.getElementById("editor-pane").classList.add("active"); break;
    case "preview": document.getElementById("preview-pane").classList.add("active"); break;
  }
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add("active");
}

// ===== UI HELPERS =====

function showStatus(message, isError = false) {
  const statusBar = document.getElementById("status-bar");
  const statusMessage = document.getElementById("status-message");
  if (statusBar && statusMessage) {
    statusMessage.textContent = message;
    statusBar.classList.toggle("error", isError);
    statusBar.classList.add("visible");
    clearTimeout(statusBar._hideTimer);
    statusBar._hideTimer = setTimeout(
      () => statusBar.classList.remove("visible", "error"),
      isError ? 8000 : 3000
    );
  }
}

// ===== MAIN =====

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(initialize, 100);
});
