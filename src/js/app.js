// humd-editor frontend entry point. Pure layers live in sibling modules
// (api, icons, markdown); this file holds the stateful application logic.
import { apiFetch, apiPost } from "/js/api.js";
import { ICON_CHEVRON, ICON_FOLDER_CLOSED, ICON_FOLDER_OPEN, getFileIcon } from "/js/icons.js";
import {
  buildPreviewShell,
  configureMarked,
  renderMarkdownBody,
  rewriteImageSources,
  extractComments,
  restoreComments,
  COMMENT_BALLOON_SVG,
} from "/js/markdown.js";
import { renderGraph } from "/js/graph.js";

// ===== STATE =====

let currentPlatform = "macos";
let currentVaultPath = null;
let currentFilePath = null;
let currentUserCss = "";
let currentSpellCheck = true;
let currentUsePandoc = false;
let currentAutoSave = false;
let currentBibPath = null;
let currentCslPath = null;
let currentPandocRefDocPath = null;
let currentUserNickname = "";
let currentGeminiKey = "";
let currentGeminiModel = "";
let proofreadRange = null; // { start, end } in the editor that proofreading targets
let previewVisible = true;
let previewStale = false; // edits happened while preview was hidden; refresh on show
let savedEditorFlexBasis = null;
let isDirty = false;
let isInitialized = false;
let activeSidebarTab = "files";
let previewDebounceTimer = null;
let previewShellReady = false; // is the persistent preview document mounted?
let previewShellCss = null; // userCss the current shell was built with
let autoSaveDebounceTimer = null;
let editorScrollTimer = null;
let suppressEditorScroll = false;
let suppressPreviewScroll = false;
let dragDidOccur = false;
let tabs = [];
let undoStack = [];
let redoStack = [];
let undoDebounceTimer = null;
let activeTabId = null;
let tabCounter = 0;
let fileTreeCache = [];
let vaultHashCache = "";
let noteIndexCache = {}; // lowercased note name -> full path, from the link index
let tagIndexCache = {}; // lowercased tag -> {name, count, files}, from the link index
let untaggedCache = []; // paths of files with no tags at all, from the link index
let backlinksCache = {}; // wikilink target name -> [source note stems], from the link index
let graphCleanup = null; // Cleanup function for the current graph simulation

// Editor autocomplete ([[wikilinks]] and #tags)
let acActive = false;
let acType = null; // "wikilink" | "tag"
let acStart = 0; // index in the editor value where the query begins
let acItems = [];
let acIndex = 0;

// Citation engine state
let citeBibData = null;
let citeTemplateName = null;

// ===== INLINE RENAME =====

async function startInlineRename(nameEl, oldPath) {
  if (!nameEl.isConnected) return;

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
    if (!newName || newName === oldName) {
      input.replaceWith(nameEl);
      return;
    }
    try {
      const result = await apiPost("/api/rename-file", { old_path: oldPath, new_name: newName });
      const newPath = result.path;
      tabs.forEach((t) => {
        if (t.path === oldPath) {
          t.path = newPath;
          if (t.id === activeTabId) currentFilePath = newPath;
        }
      });
      renderTabBar();
      await refreshFileTree();
      if (currentFilePath === newPath) await revealFileInTree(newPath);
      // The server rewrites [[wikilinks]] to the renamed note across the vault;
      // refresh the index and any open notes that were edited on disk.
      await buildLinkIndex();
      await reloadCleanTabsFromDisk();
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
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      input.removeEventListener("blur", commit);
      cancel();
    }
  });
}

// ===== INITIALIZATION =====

async function initialize() {
  try {
    await loadScript("/js/marked.min.js");
    configureMarked();

    const settings = await apiFetch("/api/settings");
    currentUserCss = settings.userCss || "";
    currentSpellCheck = settings.spellCheck ?? true;
    currentUsePandoc = settings.usePandoc ?? false;
    currentAutoSave = settings.useAutoSave ?? false;
    currentBibPath = settings.cslJsonPath || null;
    currentCslPath = settings.cslStylePath || null;
    currentPandocRefDocPath = settings.pandocRefDocPath || null;
    currentUserNickname = settings.userNickname || "";
    currentGeminiKey = settings.geminiApiKey || "";
    currentGeminiModel = settings.geminiModel || "gemini-3-flash-preview";
    document.getElementById("editor").spellcheck = currentSpellCheck;

    let vaultPath = settings.vaultPath;

    if (!vaultPath) {
      const result = await apiPost("/api/pick-folder", {
        prompt: "Select your Markdown vault folder",
      });
      if (!result.path) {
        showStatus("No vault selected. Please reload.");
        return;
      }
      vaultPath = result.path;
      await apiPost("/api/settings", { vaultPath, userCss: currentUserCss });
    }

    currentVaultPath = vaultPath;
    document.getElementById("vault-path-display").textContent = vaultPath;

    setupEventListeners();
    restoreUiState(settings);

    const lastOpenFile = settings.lastOpenFile;
    const openFiles = settings.openFiles || (lastOpenFile ? [lastOpenFile] : []);

    // These startup steps are independent — run them concurrently instead of
    // awaiting each in turn. The open files are prefetched in the same batch.
    const [, , , results] = await Promise.all([
      refreshFileTree(),
      buildLinkIndex(),
      loadCitations(),
      openFiles.length > 0
        ? Promise.allSettled(
            openFiles.map((path) => apiFetch(`/api/read-file?path=${encodeURIComponent(path)}`)),
          )
        : Promise.resolve([]),
    ]);
    initializeFileWatcher();

    isInitialized = true;

    if (openFiles.length > 0) {
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          const tabId = `tab-${++tabCounter}`;
          tabs.push({
            id: tabId,
            path: openFiles[i],
            isDirty: false,
            content: result.value.content,
            undoStack: [],
            redoStack: [],
          });
        }
      });
      if (tabs.length > 0) {
        const activeTab = tabs.find((t) => t.path === lastOpenFile) || tabs[tabs.length - 1];
        await switchToTab(activeTab.id);
      }
    }

    if (!currentFilePath) showStatus("Ready");
  } catch (error) {
    console.error("Init failed:", error);
    showStatus(`Error: ${error.message || error}`);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ===== VAULT PICKER =====

async function changeVaultFolder() {
  const result = await apiPost("/api/pick-folder", { prompt: "Select your Markdown vault folder" });
  if (!result.path) return;

  currentVaultPath = result.path;
  document.getElementById("vault-path-display").textContent = result.path;
  await apiPost("/api/settings", { vaultPath: result.path, userCss: currentUserCss });
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
  editor.addEventListener("blur", () => setTimeout(closeAutocomplete, 100));
  editor.addEventListener("scroll", closeAutocomplete, { passive: true });
  editor.addEventListener("mouseup", closeAutocomplete);

  document.getElementById("preview-toggle-btn").addEventListener("click", togglePreview);

  document.getElementById("tab-scroll-left").addEventListener("click", () => scrollTabBar(-1));
  document.getElementById("tab-scroll-right").addEventListener("click", () => scrollTabBar(1));
  const tabBar = document.getElementById("editor-tab-bar");
  tabBar.addEventListener("scroll", updateTabScrollButtons, { passive: true });
  window.addEventListener("resize", updateTabScrollButtons, { passive: true });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "e") {
      e.preventDefault();
      togglePreview();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveCurrentFile();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") {
      e.preventDefault();
      openEditorSearch();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "h") {
      e.preventDefault();
      if (document.getElementById("editor-search-panel").style.display !== "none") {
        toggleEditorReplace();
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      insertComment();
    }
  });

  document.querySelectorAll(".sidebar-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchSidebarTab(btn.dataset.tab));
  });

  document.getElementById("search-input").addEventListener("input", onSearchInput);

  document.getElementById("new-file-btn").addEventListener("click", promptNewFile);
  document.getElementById("graph-btn").addEventListener("click", openGraphTab);
  document.getElementById("change-vault-btn").addEventListener("click", changeVaultFolder);
  document.getElementById("settings-btn").addEventListener("click", openSettingsDialog);
  document.getElementById("proofread-btn").addEventListener("click", runProofread);
  document.getElementById("export-docx-btn").addEventListener("click", exportToWord);
  document.getElementById("close-proofread").addEventListener("click", closeProofreadPanel);
  document.getElementById("editor-search-input").addEventListener("keydown", handleEditorSearchKeydown);
  document.getElementById("editor-replace-input").addEventListener("keydown", handleEditorSearchKeydown);
  document.getElementById("editor-search-prev-btn").addEventListener("click", editorSearchPrevious);
  document.getElementById("editor-search-next-btn").addEventListener("click", editorSearchNext);
  document.getElementById("editor-search-toggle-replace-btn").addEventListener("click", toggleEditorReplace);
  document.getElementById("editor-search-replace-btn").addEventListener("click", editorReplaceCurrent);
  document.getElementById("editor-search-replace-all-btn").addEventListener("click", editorReplaceAll);
  document.getElementById("editor-search-close-btn").addEventListener("click", closeEditorSearch);
  document.getElementById("close-settings").addEventListener("click", cancelSettings);
  document.getElementById("cancel-settings-btn").addEventListener("click", cancelSettings);
  document.getElementById("save-settings-btn").addEventListener("click", saveSettings);
  document.getElementById("auto-save-toggle").addEventListener("change", (e) => {
    document.getElementById("auto-save-warning").style.display = e.target.checked ? "" : "none";
  });
  document.getElementById("pick-vault-btn")?.addEventListener("click", pickVaultFolder);
  document
    .getElementById("pick-bib-btn")
    ?.addEventListener("click", () =>
      pickFileForSetting(
        "bib-path-display",
        ["json", "bib"],
        "Select bibliography file (CSL JSON or BibTeX)",
      ),
    );
  document.getElementById("clear-bib-btn")?.addEventListener("click", () => {
    document.getElementById("bib-path-display").textContent = "None selected";
  });
  document
    .getElementById("pick-csl-btn")
    ?.addEventListener("click", () =>
      pickFileForSetting("csl-path-display", ["csl", "xml"], "Select CSL style file"),
    );
  document.getElementById("clear-csl-btn")?.addEventListener("click", () => {
    document.getElementById("csl-path-display").textContent = "None selected (defaults to APA)";
  });
  document
    .getElementById("pick-pandoc-ref-doc-btn")
    ?.addEventListener("click", () =>
      pickFileForSetting(
        "pandoc-ref-doc-display",
        ["docx"],
        "Select Pandoc reference document (.docx)",
      ),
    );
  document.getElementById("clear-pandoc-ref-doc-btn")?.addEventListener("click", () => {
    document.getElementById("pandoc-ref-doc-display").textContent = "None selected";
  });

  document.getElementById("settings-dialog").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettingsDialog();
  });

  // Messages from preview iframe
  window.addEventListener("message", async (msg) => {
    if (msg.data.type === "open-url") {
      const href = msg.data.href || "";
      // In the packaged native window, links can't spawn a browser tab — hand
      // them to the OS via the pywebview bridge. In a real browser, fall back.
      if (window.pywebview?.api?.open_external) {
        window.pywebview.api.open_external(href);
      } else if (/^(https?:|mailto:)/i.test(href)) {
        window.open(href, "_blank", "noopener");
      } else {
        // App/custom protocols (zotero://, file://, obsidian://, …): trigger the
        // OS handler via an anchor click — avoids leaving a blank tab behind.
        const a = document.createElement("a");
        a.href = href;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      return;
    }
    if (msg.data.type === "wikilink") {
      const stem = (msg.data.href || "").replace(/^\.\//, "").replace(/\.md$/, "");
      const path = findNoteByName(stem);
      if (path) await loadFile(path);
      else showStatus(`Note not found: ${stem}`);
      return;
    }
    if (msg.data.type === "open-tag") {
      switchSidebarTab("tags");
      expandTag(msg.data.tag);
      return;
    }
    if (msg.data.type === "comment") {
      showStatus(msg.data.text || "(empty comment)", true);
      return;
    }
    if (msg.data.type === "preview-scroll") {
      if (suppressPreviewScroll || !currentFilePath) return;
      const { currentId, nextId, fraction } = msg.data;
      const positions = getEditorHeadingPositions();
      const editor = document.getElementById("editor");
      let targetScrollTop;
      if (positions.length === 0 || (currentId === null && nextId === null)) {
        targetScrollTop = fraction * Math.max(0, editor.scrollHeight - editor.clientHeight);
      } else {
        const cur = currentId ? positions.find((h) => h.slug === currentId) : null;
        const nxt = nextId ? positions.find((h) => h.slug === nextId) : null;
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
      setTimeout(() => {
        suppressEditorScroll = false;
      }, 300);
    }
  });
}

// ===== FILE DRAG =====

function addFileMouseDrag(li, filePath, fileName) {
  li.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.tagName === "INPUT") return;

    const startX = e.clientX,
      startY = e.clientY;
    let started = false,
      ghost = null;

    function clearHighlights() {
      document
        .querySelectorAll(".tree-drop-target")
        .forEach((el) => el.classList.remove("tree-drop-target"));
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
        const destDir =
          dir.querySelector(":scope > ul")?.dataset.path ??
          dir.querySelector("ul")?.dataset.path ??
          null;
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
        ghost.appendChild(document.createTextNode(" " + fileName));
        document.body.appendChild(ghost);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        document.body.classList.add("dragging-file");
      }
      ghost.style.left = e.clientX + 14 + "px";
      ghost.style.top = e.clientY - 10 + "px";
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

      const { destDir, overEditor } = getDropZone(e.clientX, e.clientY);

      if (overEditor) {
        const editor = document.getElementById("editor");
        editor.focus();
        const pos = editor.selectionStart;
        const stem = fileName.replace(/\.md$/i, "");
        editorReplace(editor, pos, pos, `[[${stem}]]`);
        return;
      }

      if (!destDir) return;
      const srcParent = filePath.split("/").slice(0, -1).join("/");
      if (srcParent === destDir) {
        showStatus("File is already in this folder");
        return;
      }

      try {
        const result = await apiPost("/api/move-file", { src_path: filePath, dest_dir: destDir });
        const newPath = result.path;
        tabs.forEach((t) => {
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
    if (savedEditorFlexBasis) editorPane.style.flex = `0 0 ${savedEditorFlexBasis}px`;
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
  // Re-showing a preview that went stale while hidden: render it now.
  if (previewVisible && previewStale) {
    previewStale = false;
    updatePreview();
  }
  updateTabScrollButtons();
  saveUiState();
}

// ===== RESIZE HANDLES =====

function startDrag(handle, startX, onDrag, onEnd) {
  const iframe = document.getElementById("preview");
  handle.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  if (iframe) iframe.style.pointerEvents = "none";

  function onMove(e) {
    onDrag(e.clientX - startX);
  }
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
  const sidebar = document.getElementById("sidebar");
  const editorPane = document.getElementById("editor-pane");
  const app = document.getElementById("app");

  const sidebarHandle = document.getElementById("sidebar-resize");
  sidebarHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startWidth = sidebar.getBoundingClientRect().width;
    startDrag(
      sidebarHandle,
      e.clientX,
      (dx) => {
        const newWidth = Math.max(160, Math.min(480, startWidth + dx));
        sidebar.style.flex = `0 0 ${newWidth}px`;
      },
      () => {
        updateTabScrollButtons();
        saveUiState();
      },
    );
  });

  const editorHandle = document.getElementById("editor-resize");
  editorHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startWidth = editorPane.getBoundingClientRect().width;
    startDrag(
      editorHandle,
      e.clientX,
      (dx) => {
        const appWidth = app.getBoundingClientRect().width;
        const sidebarWidth = sidebar.getBoundingClientRect().width;
        const maxWidth = appWidth - sidebarWidth - 200 - 10;
        const newWidth = Math.max(200, Math.min(maxWidth, startWidth + dx));
        editorPane.style.flex = `0 0 ${newWidth}px`;
        savedEditorFlexBasis = newWidth;
      },
      () => {
        updateTabScrollButtons();
        saveUiState();
      },
    );
  });
}

// ===== FILE TREE =====

async function refreshFileTree() {
  try {
    const nodes = await apiFetch(`/api/list-vault?path=${encodeURIComponent(currentVaultPath)}`);
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
      if (ul.dataset.path === dirPath) {
        nestedUl = ul;
        break;
      }
    }
    if (!nestedUl) continue;
    const dirLi = nestedUl.closest(".tree-dir");
    if (!dirLi) continue;
    if (dirLi.classList.contains("collapsed")) dirLi.classList.remove("collapsed");
    if (!nestedUl.dataset.loaded) {
      const children = await apiFetch(`/api/list-dir?path=${encodeURIComponent(dirPath)}`);
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
      li.className = "tree-dir collapsed";
      const label = document.createElement("div");
      label.className = "tree-label";
      label.innerHTML = `<span class="tree-chevron">${ICON_CHEVRON}</span><span class="tree-folder-icon">${ICON_FOLDER_CLOSED}${ICON_FOLDER_OPEN}</span>`;
      const nameSpan = document.createElement("span");
      nameSpan.className = "tree-item-name";
      nameSpan.textContent = node.name;
      label.appendChild(nameSpan);
      const nested = document.createElement("ul");
      nested.dataset.path = node.path;
      label.addEventListener("click", async (e) => {
        e.stopPropagation();
        const isCollapsed = li.classList.contains("collapsed");
        li.classList.toggle("collapsed");
        if (isCollapsed && !nested.dataset.loaded) {
          const children = await apiFetch(`/api/list-dir?path=${encodeURIComponent(node.path)}`);
          renderFileTree(children, nested);
          nested.dataset.loaded = "true";
        }
      });
      nameSpan.addEventListener("dblclick", (e) => {
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
        if (dragDidOccur) {
          dragDidOccur = false;
          return;
        }
        loadFile(node.path);
      });
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startInlineRename(nameEl, node.path);
      });
      addFileMouseDrag(li, node.path, node.name);
    }
    container.appendChild(li);
  });

  if (currentFilePath) {
    document.querySelectorAll(".file-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.path === currentFilePath);
    });
  }
}

// ===== TABS =====

function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function renderTabBar() {
  const bar = document.getElementById("editor-tab-bar");
  bar.innerHTML = "";
  tabs.forEach((tab) => {
    const el = document.createElement("div");
    el.className = "editor-tab" + (tab.id === activeTabId ? " active" : "");
    el.dataset.tabId = tab.id;

    const nameEl = document.createElement("span");
    nameEl.className = "tab-filename" + (tab.isDirty ? " tab-dirty" : "");
    nameEl.textContent = tab.isGraph ? "Graph" : tab.path.split("/").pop();
    nameEl.title = tab.isGraph ? "Graph visualization" : tab.path;
    el.appendChild(nameEl);

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close";
    closeBtn.title = "Close tab";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => switchToTab(tab.id));
    bar.appendChild(el);
  });

  bar.querySelector(".editor-tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
  updateTabScrollButtons();
}

// Show the scroll arrows only when tabs overflow, and only for directions
// that can still be scrolled.
function updateTabScrollButtons() {
  const bar = document.getElementById("editor-tab-bar");
  const left = document.getElementById("tab-scroll-left");
  const right = document.getElementById("tab-scroll-right");
  if (!bar || !left || !right) return;

  const overflowing = bar.scrollWidth - bar.clientWidth > 1;
  // scrollLeft can be fractional; allow a 1px tolerance at each end.
  const atStart = bar.scrollLeft <= 1;
  const atEnd = bar.scrollLeft >= bar.scrollWidth - bar.clientWidth - 1;

  left.hidden = !overflowing || atStart;
  right.hidden = !overflowing || atEnd;
}

function scrollTabBar(direction) {
  const bar = document.getElementById("editor-tab-bar");
  if (!bar) return;
  bar.scrollBy({ left: direction * bar.clientWidth * 0.7, behavior: "smooth" });
}

async function switchToTab(tabId) {
  if (tabId === activeTabId) return;

  // Stop graph simulation if one is running
  if (graphCleanup) {
    graphCleanup();
    graphCleanup = null;
  }

  if (activeTabId !== null) {
    const cur = getActiveTab();
    if (cur && !cur.isGraph) {
      clearTimeout(autoSaveDebounceTimer);
      clearTimeout(undoDebounceTimer);
      cur.content = getEditorContent();
      cur.isDirty = isDirty;
      cur.undoStack = undoStack.slice();
      cur.redoStack = redoStack.slice();
      if (cur.isDirty) {
        try {
          await apiPost("/api/write-file", { path: cur.path, content: cur.content });
          cur.isDirty = false;
        } catch (e) {
          console.error("Auto-save on tab switch failed:", e);
        }
      }
    }
  }

  activeTabId = tabId;
  const tab = tabs.find((t) => t.id === tabId);

  const editor = document.getElementById("editor");
  const preview = document.getElementById("preview");
  const tabBar = document.getElementById("editor-tab-bar");

  const graphContainer = document.getElementById("graph-container");

  if (tab.isGraph) {
    // Show graph tab
    editor.style.display = "none";
    if (graphContainer) {
      graphContainer.style.display = "flex";
      graphContainer.innerHTML = ""; // Clear old graph
    }
    currentFilePath = null;
    isDirty = false;

    // Render the graph (show preview if it was visible, hide otherwise)
    // Actually, hide both editor and preview when showing graph to give it full space
    preview.style.display = "none";

    // Render the graph
    const linkIndex = {
      notes: noteIndexCache,
      tag_index: tagIndexCache,
      backlinks: backlinksCache,
    };

    const onDocClick = (noteKey) => {
      const path = noteIndexCache[noteKey];
      if (path) loadFile(path);
    };

    if (graphContainer) {
      graphCleanup = renderGraph(graphContainer, linkIndex, onDocClick);
    }
  } else {
    // Show document tab
    currentFilePath = tab.path;
    isDirty = tab.isDirty;
    undoStack = tab.undoStack ? tab.undoStack.slice() : [];
    redoStack = tab.redoStack ? tab.redoStack.slice() : [];

    editor.style.display = "block";
    preview.style.display = previewVisible ? "flex" : "none";
    if (graphContainer) graphContainer.style.display = "none";

    editor.value = tab.content;
    await updatePreview();
    renderEditorCommentGutter();
    await revealFileInTree(tab.path);
    document.querySelectorAll(".file-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.path === tab.path);
    });

    await updateTagsBar(tab.path);
    buildOutline();
    buildLinksPanel();
  }

  renderTabBar();
  saveUiState();
}

async function closeTab(tabId, skipSave = false) {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return;

  // Stop graph simulation if closing the graph tab
  if (tab.isGraph && graphCleanup) {
    graphCleanup();
    graphCleanup = null;
  }

  if (!skipSave && !tab.isGraph) {
    if (tabId === activeTabId && isDirty) {
      await saveCurrentFile();
    } else if (tab.isDirty) {
      try {
        await apiPost("/api/write-file", { path: tab.path, content: tab.content });
      } catch (e) {
        console.error("Failed to save on close:", e);
      }
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
      resetPreview();
      renderEditorCommentGutter();
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
  renderEditorCommentGutter();
  buildOutline();
  buildLinksPanel();
  renderTabBar();
  saveUiState();
}

async function openGraphTab() {
  // Check if graph tab already exists
  let graphTab = tabs.find((t) => t.path === "__graph__");
  if (!graphTab) {
    // Create a new graph tab
    graphTab = {
      id: ++tabCounter,
      path: "__graph__",
      isGraph: true,
      isDirty: false,
      content: "",
    };
    tabs.push(graphTab);
  }
  await switchToTab(graphTab.id);
}

async function loadFile(path) {
  try {
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      await switchToTab(existing.id);
      return;
    }

    const result = await apiFetch(`/api/read-file?path=${encodeURIComponent(path)}`);
    const content = result.content;

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
    const tab = {
      id: tabId,
      path,
      isDirty: false,
      content,
      undoStack: [initialSnap],
      redoStack: [],
    };
    tabs.push(tab);

    activeTabId = tabId;
    currentFilePath = path;
    isDirty = false;
    undoStack = [initialSnap];
    redoStack = [];

    document.getElementById("editor").value = content;
    await updatePreview();
    renderEditorCommentGutter();
    await revealFileInTree(path);
    document.querySelectorAll(".file-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.path === path);
    });

    await updateTagsBar(path);
    buildLinksPanel();
    buildOutline();
    showStatus(`Opened: ${path.split("/").pop()}`);
    renderTabBar();
    saveUiState();
  } catch (error) {
    showStatus(`Error loading file: ${error.message || error}`);
  }
}

async function promptNewFile() {
  let input = document.getElementById("new-file-input");
  if (input) {
    input.focus();
    return;
  }
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
      const result = await apiPost("/api/create-file", {
        vault_path: currentVaultPath,
        name: fullName,
      });
      await refreshFileTree();
      await loadFile(result.path);
      await buildLinkIndex();
      showStatus(`Created: ${fullName}`);
    } catch (error) {
      showStatus(`Error: ${error.message || error}`);
    }
  };

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") await handleSave();
    else if (e.key === "Escape") li.remove();
  });
  input.addEventListener("blur", () =>
    setTimeout(() => {
      if (li.parentNode) li.remove();
    }, 100),
  );
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
  if (cur && !cur.isDirty) {
    cur.isDirty = true;
    renderTabBar();
  }

  clearTimeout(undoDebounceTimer);
  undoDebounceTimer = setTimeout(snapshotForUndo, 500);

  updateAutocomplete();

  renderEditorCommentGutter();

  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updatePreview();
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  }, 300);

  if (currentAutoSave) {
    clearTimeout(autoSaveDebounceTimer);
    autoSaveDebounceTimer = setTimeout(saveCurrentFile, 800);
  }
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

  // Autocomplete navigation takes priority over everything else.
  if (handleAutocompleteKeydown(e)) return;

  // Zotero Better BibTeX CAYW: \@ triggers citation picker
  if (e.key === "@" && !isMeta && !e.altKey) {
    const pos = editor.selectionStart;
    if (pos >= 1 && editor.value[pos - 1] === "\\" && !isCursorInCode(editor.value, pos - 1)) {
      e.preventDefault();
      const insertPos = pos - 1;
      editorReplace(editor, insertPos, pos, "");
      (async () => {
        showStatus("Opening Zotero citation picker…");
        try {
          // Routed through the local server proxy (/api/zotero-cayw) instead of
          // fetching Zotero cross-origin, which Safari drops mid-request.
          const res = await apiFetch("/api/zotero-cayw?format=pandoc");
          const raw = (res.citation || "").trim();
          if (!raw) {
            showStatus("No citation selected");
            return;
          }
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

  if (isMeta && !e.shiftKey && e.key === "z") {
    e.preventDefault();
    performUndo();
    return;
  }
  if (isMeta && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
    e.preventDefault();
    performRedo();
    return;
  }
  if (isMeta && e.key === "b") {
    e.preventDefault();
    snapshotForUndo();
    wrapSelection("**", "**");
    return;
  }
  if (isMeta && e.key === "i") {
    e.preventDefault();
    snapshotForUndo();
    wrapSelection("_", "_");
    return;
  }
  if (isMeta && e.key === "1") {
    e.preventDefault();
    snapshotForUndo();
    prefixLine("# ");
    return;
  }
  if (isMeta && e.key === "2") {
    e.preventDefault();
    snapshotForUndo();
    prefixLine("## ");
    return;
  }
  if (isMeta && e.key === "3") {
    e.preventDefault();
    snapshotForUndo();
    prefixLine("### ");
    return;
  }
}

function editorReplace(editor, start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  document.execCommand("insertText", false, text);
}

// ===== AUTOCOMPLETE ([[wikilinks]] and #tags) =====

function getAutocompletePopup() {
  let el = document.getElementById("autocomplete-popup");
  if (!el) {
    el = document.createElement("ul");
    el.id = "autocomplete-popup";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

// Pixel position of a caret offset within the textarea, via a hidden mirror div.
function getCaretCoords(textarea, pos) {
  const div = document.createElement("div");
  const style = getComputedStyle(textarea);
  const props = [
    "boxSizing",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "tabSize",
  ];
  props.forEach((p) => (div.style[p] = style[p]));
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  div.style.width = textarea.clientWidth + "px";
  div.textContent = textarea.value.substring(0, pos);
  const span = document.createElement("span");
  span.textContent = textarea.value.substring(pos) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const coords = {
    left: span.offsetLeft,
    top: span.offsetTop,
    height: parseInt(style.lineHeight, 10) || parseInt(style.fontSize, 10) || 16,
  };
  document.body.removeChild(div);
  return coords;
}

function closeAutocomplete() {
  if (!acActive) return;
  acActive = false;
  acItems = [];
  getAutocompletePopup().style.display = "none";
}

// ===== COMMENTS =====

// Two-digit zero-pad.
function pad2(n) {
  return String(n).padStart(2, "0");
}

// Local timestamp "YYYY-MM-DD HH:MM" for signing comments.
function commentTimestamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

// Locate every HTML comment, the character offset where its marker begins
// (used to align the balloon to the correct visual row, even on wrapped lines),
// the author nickname, and the full comment body. Returns { offset, nick, text }.
function findCommentLines(text) {
  const out = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const content = m[1].trim();
    const dm = content.match(/^(.*?)\s+\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/);
    const nick = (dm ? dm[1].trim() : content.split(/\s+/)[0] || "Comment") || "Comment";
    out.push({ offset: m.index, nick, text: content });
  }
  return out;
}

let commentGutterRaf = null;
function scheduleCommentGutterRender() {
  if (commentGutterRaf) return;
  commentGutterRaf = requestAnimationFrame(() => {
    commentGutterRaf = null;
    renderEditorCommentGutter();
  });
}

// Draw a balloon in the editor's right margin for each line holding a comment,
// aligned via the same hidden-mirror measurement used for the caret. Balloons
// scrolled out of the textarea's viewport are skipped.
function renderEditorCommentGutter() {
  const gutter = document.getElementById("editor-comment-gutter");
  if (!gutter) return;
  gutter.innerHTML = "";
  if (!currentFilePath) return;
  const editor = document.getElementById("editor");
  const comments = findCommentLines(editor.value);
  if (comments.length === 0) return;
  const viewTop = editor.offsetTop;
  const viewHeight = editor.clientHeight;
  const scrollTop = editor.scrollTop;
  for (const c of comments) {
    const y = getCaretCoords(editor, c.offset).top - scrollTop;
    if (y < 0 || y > viewHeight) continue; // off-screen
    const b = document.createElement("div");
    b.className = "editor-comment-balloon";
    b.innerHTML = COMMENT_BALLOON_SVG;
    b.title = c.nick;
    b.style.top = `${viewTop + y}px`;
    b.addEventListener("click", () => showStatus(c.text, true));
    gutter.appendChild(b);
  }
}

// Ensure a nickname is configured; prompt for and persist one if not.
async function ensureNickname() {
  if (currentUserNickname) return currentUserNickname;
  const entered = (await promptDialog("Enter a nickname to sign your comments:", "")) || "";
  const nick = entered.trim();
  if (!nick) return "";
  currentUserNickname = nick;
  try {
    await apiPost("/api/settings", { userNickname: nick });
  } catch (e) {
    console.warn("Failed to save nickname:", e);
  }
  return nick;
}

// Insert an HTML comment at the cursor, signed with the nickname + timestamp.
// Any selected text is wrapped inside; otherwise the caret lands ready to type.
async function insertComment() {
  if (!currentFilePath) {
    showStatus("Open a file to add a comment", true);
    return;
  }
  const nick = await ensureNickname();
  if (!nick) return; // user cancelled the nickname prompt
  const editor = document.getElementById("editor");
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  const prefix = `<!-- ${nick} ${commentTimestamp()}: `;
  const suffix = " -->";
  const insertText = prefix + selected + suffix;
  editor.value = editor.value.slice(0, start) + insertText + editor.value.slice(end);
  // Caret just after "... : " (before the closing -->) so the user can type.
  const caret = start + prefix.length + selected.length;
  editor.focus();
  editor.setSelectionRange(caret, caret);
  onEditorInput();
  showStatus("Comment inserted");
}

// Minimal promise-based text prompt (window.prompt is unreliable in the
// packaged native window). Resolves to the entered string, or null on cancel.
function promptDialog(message, defaultValue = "") {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "prompt-dialog";
    const label = document.createElement("p");
    label.textContent = message;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "settings-input";
    input.value = defaultValue;
    const row = document.createElement("div");
    row.className = "prompt-dialog-buttons";
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = "OK";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    row.append(cancel, ok);
    dlg.append(label, input, row);
    document.body.appendChild(dlg);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    ok.addEventListener("click", () => finish(input.value));
    cancel.addEventListener("click", () => finish(null));
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      }
    });
    dlg.showModal();
    input.focus();
    input.select();
  });
}

// Inspect the text before the caret and (re)build the completion list.
function updateAutocomplete() {
  const editor = document.getElementById("editor");
  if (editor.selectionStart !== editor.selectionEnd) {
    closeAutocomplete();
    return;
  }
  const pos = editor.selectionStart;
  const before = editor.value.slice(0, pos);

  let type = null;
  let query = "";
  const wl = before.match(/\[\[([^\]\n|]*)$/);
  if (wl) {
    type = "wikilink";
    query = wl[1];
  } else {
    const tg = before.match(/(?:^|[\s(>])#([A-Za-z][\w/-]*)?$/);
    if (tg) {
      type = "tag";
      query = tg[1] || "";
    }
  }

  if (type === null) {
    closeAutocomplete();
    return;
  }

  const q = query.toLowerCase();
  let items = [];
  if (type === "wikilink") {
    const names = [
      ...new Set(Object.values(noteIndexCache).map((p) => p.split("/").pop().replace(/\.md$/, ""))),
    ];
    items = names
      .filter((n) => n.toLowerCase().includes(q))
      .sort((a, b) => {
        const as = a.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || a.localeCompare(b);
      })
      .slice(0, 12)
      .map((n) => ({ label: n, insert: n }));
  } else {
    items = Object.values(tagIndexCache)
      .filter((e) => e.name.toLowerCase().includes(q))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 12)
      .map((e) => ({ label: `#${e.name}`, insert: e.name, count: e.count }));
  }

  if (items.length === 0) {
    closeAutocomplete();
    return;
  }

  acActive = true;
  acType = type;
  acStart = pos - query.length;
  acItems = items;
  acIndex = 0;
  renderAutocomplete();
}

function renderAutocomplete() {
  const popup = getAutocompletePopup();
  popup.innerHTML = "";
  acItems.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "ac-item" + (i === acIndex ? " active" : "");
    const label = document.createElement("span");
    label.className = "ac-label";
    label.textContent = item.label;
    li.appendChild(label);
    if (item.count !== undefined) {
      const c = document.createElement("span");
      c.className = "ac-count";
      c.textContent = item.count;
      li.appendChild(c);
    }
    // mousedown (not click) so it fires before the textarea blur closes us.
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acIndex = i;
      acceptAutocomplete();
    });
    popup.appendChild(li);
  });

  const editor = document.getElementById("editor");
  const coords = getCaretCoords(editor, acStart);
  const rect = editor.getBoundingClientRect();
  popup.style.display = "block";
  popup.style.left = Math.round(rect.left + coords.left - editor.scrollLeft) + "px";
  popup.style.top = Math.round(rect.top + coords.top - editor.scrollTop + coords.height + 2) + "px";
}

function moveAutocomplete(delta) {
  acIndex = (acIndex + delta + acItems.length) % acItems.length;
  renderAutocomplete();
}

function acceptAutocomplete() {
  const editor = document.getElementById("editor");
  const item = acItems[acIndex];
  if (!item) {
    closeAutocomplete();
    return;
  }
  const after = editor.value.slice(editor.selectionStart);
  if (acType === "wikilink") {
    // Insert the name and a closing ]] unless one already follows the caret.
    const needsClose = !after.startsWith("]]");
    editorReplace(editor, acStart, editor.selectionStart, item.insert + (needsClose ? "]]" : ""));
    const caret = acStart + item.insert.length + (needsClose ? 2 : 0);
    editor.setSelectionRange(caret, caret);
  } else {
    editorReplace(editor, acStart, editor.selectionStart, item.insert);
  }
  closeAutocomplete();
  onEditorInput();
}

// Returns true if the keydown was consumed by the autocomplete UI.
function handleAutocompleteKeydown(e) {
  if (!acActive) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    moveAutocomplete(1);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    moveAutocomplete(-1);
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    acceptAutocomplete();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeAutocomplete();
    return true;
  }
  return false;
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
  renderEditorCommentGutter();
  isDirty = true;
  const tab = getActiveTab();
  if (tab) {
    tab.content = snap.value;
    if (!tab.isDirty) {
      tab.isDirty = true;
      renderTabBar();
    }
  }
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updatePreview();
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  }, 100);
  if (currentAutoSave) {
    clearTimeout(autoSaveDebounceTimer);
    autoSaveDebounceTimer = setTimeout(saveCurrentFile, 800);
  }
}

function wrapSelection(before, after) {
  const editor = document.getElementById("editor");
  const start = editor.selectionStart,
    end = editor.selectionEnd;
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
  const currentLine = editor.value.substring(
    lineStart,
    lineEnd === -1 ? editor.value.length : lineEnd,
  );
  const trimmed = currentLine.replace(/^#+\s/, "");
  editorReplace(editor, lineStart, lineStart + currentLine.length, prefix + trimmed);
}

// ===== PREVIEW =====

function updatePreviewStats(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  const text = tmp.innerText || tmp.textContent || "";
  const lines = text.split(/\n/).filter((l) => l.trim().length > 0).length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
  const chars = text.replace(/\s/g, "").length;
  const charsWithSpaces = text.trim().length;
  const el = document.getElementById("preview-stats");
  if (el)
    el.textContent = `${lines} lines, ${words} words, ${charsWithSpaces} (${chars}) characters`;
}

// Reset to the empty state. Replacing srcdoc tears down the persistent shell,
// so flag it for a rebuild on the next render.
function resetPreview() {
  previewShellReady = false;
  document.getElementById("preview").srcdoc =
    "<p style='font-family:sans-serif;color:#888;padding:20px'>No file open</p>";
  const el = document.getElementById("preview-stats");
  if (el) el.textContent = "";
}

// Mount the preview document once (styles + scripts + listeners). Subsequent
// renders only swap the body, avoiding a full iframe reload per keystroke.
function ensurePreviewShell(userCss) {
  const iframe = document.getElementById("preview");
  if (
    previewShellReady &&
    previewShellCss === userCss &&
    iframe.contentDocument?.getElementById("hp-body")
  ) {
    return Promise.resolve();
  }
  previewShellReady = false;
  previewShellCss = userCss;
  return new Promise((resolve) => {
    iframe.addEventListener(
      "load",
      () => {
        const doc = iframe.contentDocument;
        if (doc && !doc.getElementById("citation-style")) {
          const st = doc.createElement("style");
          st.id = "citation-style";
          st.textContent = CITATION_CSS;
          doc.head.appendChild(st);
        }
        previewShellReady = true;
        resolve();
      },
      { once: true },
    );
    iframe.srcdoc = buildPreviewShell(userCss);
  });
}

async function updatePreview() {
  // While the preview pane is hidden, skip all rendering work (markdown/Pandoc,
  // citation processing, shell build, stats). Mark it stale so it refreshes the
  // moment it's shown again (see togglePreview).
  if (!previewVisible) {
    previewStale = true;
    return;
  }
  const iframe = document.getElementById("preview");
  if (!currentFilePath) {
    resetPreview();
    return;
  }
  try {
    const content = document.getElementById("editor").value;
    let bodyHtml;

    // Extract citations before rendering to protect them from markdown processor.
    // Use a placeholder format that won't be interpreted as markdown (no __, **, etc).
    const citationRe = /\[@[^\]]+\]/g;
    const citations = [];
    const contentWithPlaceholders = content.replace(citationRe, (match) => {
      citations.push(match);
      return `ⓘCITATION_PLACEHOLDER_${citations.length - 1}ⓘ`;
    });

    // Tokenize HTML comments before rendering so they survive both render paths
    // (Pandoc strips comments; marked drops them too), then splice the balloons
    // back into the rendered HTML afterward.
    const { text: contentForRender, balloons: commentBalloons } =
      extractComments(contentWithPlaceholders);

    if (currentUsePandoc) {
      const result = await apiPost("/api/pandoc", {
        markdown: contentForRender,
        file_path: currentFilePath,
      });
      bodyHtml = result.html;
    } else {
      bodyHtml = renderMarkdownBody(contentForRender);
    }
    bodyHtml = restoreComments(bodyHtml, commentBalloons);

    await ensurePreviewShell(currentUserCss);
    const doc = iframe.contentDocument;
    const bodyEl = doc && doc.getElementById("hp-body");
    if (!bodyEl) return; // shell not ready (e.g. mid-reload); next edit retries

    bodyEl.innerHTML = bodyHtml;

    // Restore citations in the DOM by walking text nodes and replacing placeholders.
    const walker = doc.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
    const nodesToReplace = [];
    let node;
    while ((node = walker.nextNode())) {
      if (/ⓘCITATION_PLACEHOLDER_\d+ⓘ/.test(node.textContent)) {
        nodesToReplace.push(node);
      }
    }
    for (const textNode of nodesToReplace) {
      const parts = textNode.textContent.split(/(ⓘCITATION_PLACEHOLDER_\d+ⓘ)/);
      const fragment = doc.createDocumentFragment();
      for (const part of parts) {
        const m = part.match(/ⓘCITATION_PLACEHOLDER_(\d+)ⓘ/);
        if (m) {
          fragment.appendChild(doc.createTextNode(citations[parseInt(m[1])]));
        } else if (part) {
          fragment.appendChild(doc.createTextNode(part));
        }
      }
      textNode.parentNode.replaceChild(fragment, textNode);
    }

    rewriteImageSources(bodyEl, currentFilePath);

    // Highlight only the freshly inserted code blocks (no full-document rescan).
    const hl = iframe.contentWindow.hljs;
    if (hl) {
      bodyEl.querySelectorAll("pre code").forEach((b) => {
        try {
          hl.highlightElement(b);
        } catch {}
      });
    }

    // Resolve [@cite] keys only when a bibliography is loaded and the text
    // actually contains a citation — skip the whole pipeline otherwise.
    if (citeBibData && citeBibData.length > 0 && /\[[^\]]*@/.test(content)) {
      await processCitations(bodyEl);
    }

    updatePreviewStats(bodyEl.innerHTML);
  } catch (error) {
    previewShellReady = false;
    iframe.srcdoc = `<div style="padding:20px;color:red;font-family:sans-serif"><strong>Error rendering preview:</strong><br>${error.message || error}</div>`;
    const el = document.getElementById("preview-stats");
    if (el) el.textContent = "";
  }
}

// ===== FILE SAVE =====

async function saveCurrentFile() {
  if (!currentFilePath || !isDirty) return;
  try {
    const content = getEditorContent();
    await apiPost("/api/write-file", { path: currentFilePath, content });
    isDirty = false;
    const cur = getActiveTab();
    if (cur) {
      cur.isDirty = false;
      cur.content = content;
    }
    renderTabBar();
    await buildLinkIndex();
    await updateTagsBar(currentFilePath);
    showStatus("Saved");
  } catch (error) {
    showStatus(`Error saving: ${error.message || error}`);
  }
}

// ===== WIKILINKS & TAGS =====

async function buildLinkIndex() {
  try {
    const index = await apiPost("/api/build-link-index", { vault_path: currentVaultPath });
    noteIndexCache = index.notes || {};
    tagIndexCache = index.tag_index || {};
    untaggedCache = index.untagged || [];
    backlinksCache = index.backlinks || {};
    if (activeSidebarTab === "tags") buildTagsPanel();
    if (activeSidebarTab === "links") buildLinksPanel();
  } catch (error) {
    console.warn("Failed to build link index:", error);
  }
}

function findNoteByName(name) {
  // A wikilink target may carry a folder prefix (e.g. "folder/note"); resolve
  // by the bare note name.
  const normalized = name.split("/").pop().toLowerCase().trim();
  // Prefer the link index — it covers the whole vault, including folders the
  // file tree hasn't lazily loaded yet.
  if (noteIndexCache[normalized]) return noteIndexCache[normalized];
  const walk = (nodes) => {
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
    const tags = await apiFetch(
      `/api/tags?vault_path=${encodeURIComponent(currentVaultPath)}&note_path=${encodeURIComponent(filePath)}`,
    );
    const container = document.getElementById("note-tags");
    container.innerHTML = "";
    if (!tags || tags.length === 0) return;
    tags.forEach((tag) => {
      const span = document.createElement("span");
      span.className = "tag";
      span.textContent = tag;
      container.appendChild(span);
    });
  } catch (error) {
    console.warn("Failed to update tags:", error);
  }
}

// Re-read open tabs whose on-disk content changed underneath us (e.g. after a
// rename rewrites wikilinks, or an external edit). Dirty tabs are left alone so
// unsaved work is never clobbered.
async function reloadCleanTabsFromDisk() {
  for (const t of tabs) {
    if (t.id === activeTabId ? isDirty : t.isDirty) continue;
    try {
      const { content } = await apiFetch(`/api/read-file?path=${encodeURIComponent(t.path)}`);
      if (content === t.content) continue;
      t.content = content;
      if (t.id === activeTabId) {
        document.getElementById("editor").value = content;
        await updatePreview();
        renderEditorCommentGutter();
        if (activeSidebarTab === "links") buildLinksPanel();
      }
    } catch (_) {}
  }
}

// ===== FILE WATCHING (polling) =====

async function initializeFileWatcher() {
  if (!currentVaultPath) return;
  try {
    vaultHashCache = (
      await apiFetch(`/api/vault-hash?path=${encodeURIComponent(currentVaultPath)}`)
    ).hash;
  } catch (_) {}

  setInterval(async () => {
    // Skip the disk scan while the window is hidden — nothing's changing on
    // screen, and we re-sync as soon as it's focused again (below).
    if (document.hidden) return;
    try {
      const result = await apiFetch(`/api/vault-hash?path=${encodeURIComponent(currentVaultPath)}`);
      if (result.hash !== vaultHashCache) {
        vaultHashCache = result.hash;
        await new Promise((r) => setTimeout(r, 500));
        await refreshFileTree();
        await buildLinkIndex();
        await reloadCleanTabsFromDisk();
      }
    } catch (_) {}
  }, 3000);

  // Re-sync immediately when the window regains focus after being hidden.
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden || !currentVaultPath) return;
    try {
      const result = await apiFetch(`/api/vault-hash?path=${encodeURIComponent(currentVaultPath)}`);
      if (result.hash !== vaultHashCache) {
        vaultHashCache = result.hash;
        await refreshFileTree();
        await buildLinkIndex();
        await reloadCleanTabsFromDisk();
      }
    } catch (_) {}
  });
}

// ===== SIDEBAR TABS =====

function switchSidebarTab(tab) {
  activeSidebarTab = tab;
  document.querySelectorAll(".sidebar-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.getElementById("file-tree-container").style.display = tab === "files" ? "" : "none";
  document.getElementById("outline-container").style.display = tab === "outline" ? "block" : "none";
  document.getElementById("links-container").style.display = tab === "links" ? "block" : "none";
  document.getElementById("tags-container").style.display = tab === "tags" ? "block" : "none";
  document.getElementById("search-container").style.display = tab === "search" ? "flex" : "none";
  document.getElementById("new-file-btn").style.display = tab === "files" ? "" : "none";
  if (tab === "outline") buildOutline();
  if (tab === "links") buildLinksPanel();
  if (tab === "tags") buildTagsPanel();
  if (tab === "search") document.getElementById("search-input").focus();
}

// ===== SEARCH PANEL =====

let searchDebounceTimer = null;

function onSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 200);
}

async function runSearch() {
  const query = document.getElementById("search-input").value.trim();
  const results = document.getElementById("search-results");
  results.innerHTML = "";
  // Require a couple of characters before scanning the vault — single-letter
  // queries match almost everything and aren't worth the full pass.
  if (query.length < 2 || !currentVaultPath) return;

  let hits;
  try {
    hits = await apiFetch(
      `/api/search?vault_path=${encodeURIComponent(currentVaultPath)}&q=${encodeURIComponent(query)}`,
    );
  } catch (error) {
    showStatus(`Search failed: ${error.message || error}`, true);
    return;
  }

  if (hits.length === 0) {
    const li = document.createElement("li");
    li.className = "links-empty";
    li.textContent = "No matches";
    results.appendChild(li);
    return;
  }

  hits.forEach((hit) => {
    const fileLi = document.createElement("li");
    fileLi.className = "search-file";

    const head = document.createElement("div");
    head.className = "search-file-name";
    head.innerHTML =
      `<span class="tree-file-icon">${getFileIcon(hit.path)}</span>` +
      `<span class="tree-item-name">${escapeHtml(hit.name)}</span>`;
    head.title = hit.path;
    head.addEventListener("click", () => loadFile(hit.path));
    fileLi.appendChild(head);

    (hit.matches || []).forEach((m) => {
      const matchEl = document.createElement("div");
      matchEl.className = "search-match";
      matchEl.innerHTML = highlightQuery(m.text, query);
      matchEl.title = `Line ${m.line}`;
      matchEl.addEventListener("click", async () => {
        await loadFile(hit.path);
        scrollEditorToLine(m.line - 1);
      });
      fileLi.appendChild(matchEl);
    });

    results.appendChild(fileLi);
  });
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function highlightQuery(text, query) {
  const escaped = escapeHtml(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(new RegExp(q, "ig"), (m) => `<mark>${m}</mark>`);
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
  const headings = [];
  let charOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (m) headings.push({ slug: headerSlug(stripMarkdown(m[2].trim())), charOffset });
    charOffset += lines[i].length + 1;
  }
  if (headings.length === 0) return [];

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
  // Comment balloons must track the scroll regardless of preview visibility.
  scheduleCommentGutterRender();
  if (suppressEditorScroll || !previewVisible || !currentFilePath) return;
  clearTimeout(editorScrollTimer);
  editorScrollTimer = setTimeout(() => {
    const editor = document.getElementById("editor");
    const scrollTop = editor.scrollTop;
    const positions = getEditorHeadingPositions();
    let currentId = null,
      nextId = null,
      fraction = 0;

    if (positions.length === 0) {
      const max = Math.max(1, editor.scrollHeight - editor.clientHeight);
      fraction = scrollTop / max;
    } else {
      let curIdx = -1;
      for (let i = 0; i < positions.length; i++) {
        if (positions[i].pixelTop <= scrollTop + 2) curIdx = i;
      }
      if (curIdx === -1) {
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
    document
      .getElementById("preview")
      .contentWindow?.postMessage({ type: "scroll-to-fraction", currentId, nextId, fraction }, "*");
    setTimeout(() => {
      suppressPreviewScroll = false;
    }, 300);
  }, 50);
}

function scrollEditorToLine(lineIndex) {
  const editor = document.getElementById("editor");
  const lines = editor.value.split("\n");
  let charOffset = 0;
  for (let i = 0; i < lineIndex; i++) charOffset += (lines[i]?.length ?? 0) + 1;

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
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  editor.scrollTop = marker.offsetTop;
  document.body.removeChild(mirror);
}

function scrollPreviewToHeader(headerText) {
  const id = headerSlug(headerText);
  document
    .getElementById("preview")
    .contentWindow?.postMessage({ type: "scroll-to-heading", id }, "*");
}

// ===== LINKS PANEL =====

function buildLinksPanel() {
  const list = document.getElementById("links-list");
  list.innerHTML = "";
  if (!currentFilePath) {
    const li = document.createElement("li");
    li.className = "links-empty";
    li.textContent = "No file open";
    list.appendChild(li);
    return;
  }

  // Outgoing links: distinct wikilink targets in the current note.
  const content = getEditorContent();
  const wikilinkRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const seen = new Set();
  const outgoing = [];
  let match;
  while ((match = wikilinkRe.exec(content)) !== null) {
    const stem = match[1].trim();
    if (stem && !seen.has(stem.toLowerCase())) {
      seen.add(stem.toLowerCase());
      outgoing.push(stem);
    }
  }

  // Incoming links (backlinks): notes whose wikilinks resolve to this note.
  // The index keys backlinks by target name; match the current note's stem.
  const myStem = currentFilePath.split("/").pop().replace(/\.md$/, "");
  const myKey = myStem.toLowerCase();
  let incoming = [];
  for (const [target, sources] of Object.entries(backlinksCache)) {
    if (target.toLowerCase() === myKey) incoming = incoming.concat(sources);
  }
  incoming = [...new Set(incoming)].filter((s) => s.toLowerCase() !== myKey).sort();

  // References: distinct citation keys in the current note. Parse each [@...]
  // block with parseCitationInner so multi-cites ([@a; @b]) and locators
  // ([@a, p. 5]) yield clean keys rather than raw captured text.
  const citeBlockRe = /\[[^\]]*@[^\]]+\]/g;
  const refSeen = new Set();
  const references = [];
  let citMatch;
  while ((citMatch = citeBlockRe.exec(content)) !== null) {
    const inner = citMatch[0].slice(1, -1); // strip surrounding [ ]
    for (const item of parseCitationInner(inner).citationItems) {
      if (item.id && !refSeen.has(item.id.toLowerCase())) {
        refSeen.add(item.id.toLowerCase());
        references.push(item.id);
      }
    }
  }
  references.sort((a, b) => a.localeCompare(b));

  const openByStem = async (stem) => {
    const path = findNoteByName(stem);
    if (path) await loadFile(path);
    else showStatus(`Note not found: ${stem}`);
  };

  const addSection = (title, stems) => {
    const header = document.createElement("li");
    header.className = "links-section";
    header.textContent = title;
    list.appendChild(header);
    if (stems.length === 0) {
      const empty = document.createElement("li");
      empty.className = "links-empty";
      empty.textContent = "None";
      list.appendChild(empty);
      return;
    }
    stems.forEach((stem) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = stem;
      a.addEventListener("click", () => openByStem(stem));
      li.appendChild(a);
      list.appendChild(li);
    });
  };

  // References render as the full formatted bibliography entry (same output as
  // the preview's reference list), via citation-js. Falls back to the raw key
  // when no bibliography is loaded or a key is missing from it.
  const addReferencesSection = (title, citKeys) => {
    const header = document.createElement("li");
    header.className = "links-section";
    header.textContent = title;
    list.appendChild(header);
    if (citKeys.length === 0) {
      const empty = document.createElement("li");
      empty.className = "links-empty";
      empty.textContent = "None";
      list.appendChild(empty);
      return;
    }

    let allCite = null;
    const refMap = {};
    if (citeBibData && citeBibData.length > 0 && Cite) {
      citeBibData.forEach((ref) => {
        refMap[ref.id] = ref;
      });
      try {
        allCite = new Cite(citeBibData);
      } catch {
        allCite = null;
      }
    }
    const template = citeTemplateName || "apa";

    citKeys.forEach((key) => {
      const li = document.createElement("li");
      li.className = "reference-item";
      li.title = key; // Show the citation key on hover
      // Format as HTML so emphasis (italic titles etc.) is preserved, mirroring
      // the preview's reference list. citation-js wraps the entry in a
      // .csl-entry container; we lift out its inner HTML for the list item.
      let html = null;
      if (allCite && refMap[key]) {
        try {
          const formatted = allCite.format("bibliography", {
            format: "html",
            template,
            entry: [key],
            nosort: true,
          });
          const tmp = document.createElement("div");
          tmp.innerHTML = formatted;
          const entryEl = tmp.querySelector(".csl-entry");
          const inner = (entryEl ? entryEl.innerHTML : tmp.innerHTML).trim();
          if (inner) html = inner;
        } catch {
          /* fall back to key */
        }
      }
      if (html) li.innerHTML = html;
      else li.textContent = key;
      list.appendChild(li);
    });
  };

  addSection("Links", outgoing);
  addSection("Backlinks", incoming);
  addReferencesSection("References", references);
}

// ===== TAGS PANEL =====

function renderTagRow(entry) {
  const li = document.createElement("li");
  li.className = "tag-item";
  li.dataset.tag = entry.name.toLowerCase();

  const header = document.createElement("button");
  header.className = "tag-row";
  header.setAttribute("aria-expanded", "false");
  header.innerHTML =
    `<span class="tag-chevron">${ICON_CHEVRON}</span>` +
    `<span class="tag-name">#${entry.name}</span>` +
    `<span class="tag-count">${entry.count}</span>`;

  const files = document.createElement("ul");
  files.className = "tag-files";
  files.style.display = "none";

  (entry.files || []).forEach((path) => {
    const name = path.split("/").pop();
    // Render exactly like a file in the file tree (icon + name).
    const fileLi = document.createElement("li");
    fileLi.className = "file-item";
    fileLi.dataset.path = path;
    fileLi.title = path;
    const iconEl = document.createElement("span");
    iconEl.className = "tree-file-icon";
    iconEl.innerHTML = getFileIcon(name);
    const nameEl = document.createElement("span");
    nameEl.className = "tree-item-name";
    nameEl.textContent = name;
    fileLi.appendChild(iconEl);
    fileLi.appendChild(nameEl);
    fileLi.addEventListener("click", () => loadFile(path));
    files.appendChild(fileLi);
  });

  header.addEventListener("click", () => {
    const open = files.style.display !== "none";
    files.style.display = open ? "none" : "block";
    header.setAttribute("aria-expanded", String(!open));
    li.classList.toggle("expanded", !open);
  });

  li.appendChild(header);
  li.appendChild(files);
  return li;
}

// Expand a tag row by name and scroll it into view (used when a #tag is
// clicked in the preview).
function expandTag(tagName) {
  const key = (tagName || "").toLowerCase();
  const list = document.getElementById("tags-list");
  const li = [...list.querySelectorAll(".tag-item")].find((el) => el.dataset.tag === key);
  if (!li) return;
  const files = li.querySelector(".tag-files");
  if (files && files.style.display === "none") li.querySelector(".tag-row").click();
  li.scrollIntoView({ block: "nearest" });
}

function buildTagsPanel() {
  const list = document.getElementById("tags-list");
  list.innerHTML = "";

  // Sort real tags alphabetically (case-insensitive).
  const entries = Object.values(tagIndexCache);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  // Pin a synthetic "#notag" entry to the top for files with no tags.
  const rows = [];
  if (untaggedCache.length > 0) {
    rows.push({ name: "notag", count: untaggedCache.length, files: untaggedCache });
  }
  rows.push(...entries);

  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "links-empty";
    li.textContent = "No tags found";
    list.appendChild(li);
    return;
  }

  rows.forEach((entry) => list.appendChild(renderTagRow(entry)));
}

// ===== UI STATE =====

function restoreUiState(settings) {
  if (settings.sidebarWidth) {
    document.getElementById("sidebar").style.flex = `0 0 ${settings.sidebarWidth}px`;
  }
  if (settings.editorWidth) savedEditorFlexBasis = settings.editorWidth;
  if (settings.previewVisible === false) {
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
  if (!isInitialized) return;
  try {
    const sidebarWidth = document.getElementById("sidebar").getBoundingClientRect().width;
    const editorWidth = previewVisible
      ? document.getElementById("editor-pane").getBoundingClientRect().width
      : null;
    await apiPost("/api/settings", {
      sidebarWidth: sidebarWidth > 0 ? sidebarWidth : null,
      editorWidth: editorWidth && editorWidth > 0 ? editorWidth : null,
      previewVisible,
      lastOpenFile: currentFilePath,
      openFiles: tabs.map((t) => t.path),
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
`;

async function loadCitations() {
  citeBibData = null;
  citeTemplateName = null;
  if (!currentBibPath || !Cite) return;
  try {
    const result = await apiFetch(`/api/read-file?path=${encodeURIComponent(currentBibPath)}`);
    const parsed = new Cite(result.content);
    citeBibData = parsed.get();
  } catch (e) {
    console.warn("Failed to load bibliography:", e);
    showStatus("Warning: could not load bibliography file");
    return;
  }
  if (currentCslPath) {
    try {
      const cslResult = await apiFetch(`/api/read-file?path=${encodeURIComponent(currentCslPath)}`);
      citeTemplateName = "user-csl";
      Cite.plugins.config.get("@csl").templates.add(citeTemplateName, cslResult.content);
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
    const after = s
      .slice(atIdx + 1 + key.length)
      .replace(/^,\s*/, "")
      .trim();
    const item = { id: key };
    if (prefix) item.prefix = prefix + " ";
    if (after) Object.assign(item, parseLocator(after));
    citationItems.push(item);
  }
  return { citationItems, properties: { noteIndex: 0 } };
}

async function processCitations(container) {
  if (!citeBibData || citeBibData.length === 0 || !Cite) return;
  const doc = container.ownerDocument;
  const template = citeTemplateName || "apa";
  const refMap = {};
  citeBibData.forEach((ref) => {
    refMap[ref.id] = ref;
  });
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
      const validItems = citObj.citationItems.filter((item) => refMap[item.id]);
      const validKeys = validItems.map((item) => item.id);
      validKeys.forEach((k) => {
        if (!citedKeys.includes(k)) citedKeys.push(k);
      });
      const span = doc.createElement("span");
      span.className = validKeys.length > 0 ? "citation-ref" : "citation-ref citation-missing";
      if (validKeys.length > 0) {
        try {
          const entry = { citationItems: validItems, properties: { noteIndex: 0 } };
          span.innerHTML = allCite.format("citation", { format: "html", template, entry });
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
  const parts = keys.map((k) => {
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

let settingsBeforeEdit = {
  vaultPath: null,
  userCss: "",
  spellCheck: true,
  usePandoc: false,
  autoSave: false,
  bibPath: null,
  cslPath: null,
  pandocRefDocPath: null,
};

function openSettingsDialog() {
  settingsBeforeEdit = {
    vaultPath: currentVaultPath,
    userCss: currentUserCss,
    spellCheck: currentSpellCheck,
    usePandoc: currentUsePandoc,
    autoSave: currentAutoSave,
    bibPath: currentBibPath,
    cslPath: currentCslPath,
    pandocRefDocPath: currentPandocRefDocPath,
  };
  document.getElementById("vault-path-display").textContent = currentVaultPath;
  document.getElementById("css-editor").value = currentUserCss;
  document.getElementById("spell-check-toggle").checked = currentSpellCheck;
  document.getElementById("use-pandoc-toggle").checked = currentUsePandoc;
  document.getElementById("auto-save-toggle").checked = currentAutoSave;
  document.getElementById("auto-save-warning").style.display = currentAutoSave ? "" : "none";
  document.getElementById("bib-path-display").textContent = currentBibPath || "None selected";
  document.getElementById("csl-path-display").textContent =
    currentCslPath || "None selected (defaults to APA)";
  document.getElementById("pandoc-ref-doc-display").textContent =
    currentPandocRefDocPath || "None selected";
  document.getElementById("nickname-input").value = currentUserNickname;
  document.getElementById("gemini-key-input").value = currentGeminiKey;
  document.getElementById("gemini-model-input").value = currentGeminiModel;
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
    const newAutoSave = document.getElementById("auto-save-toggle").checked;
    const displayedPath = document.getElementById("vault-path-display").textContent;
    const newVaultPath = displayedPath !== currentVaultPath ? displayedPath : currentVaultPath;

    const bibDisplay = document.getElementById("bib-path-display").textContent;
    const newBibPath = bibDisplay && bibDisplay !== "None selected" ? bibDisplay : null;
    const cslDisplay = document.getElementById("csl-path-display").textContent;
    const newCslPath = cslDisplay && !cslDisplay.startsWith("None selected") ? cslDisplay : null;
    const pandocRefDocDisplay = document.getElementById("pandoc-ref-doc-display").textContent;
    const newPandocRefDocPath =
      pandocRefDocDisplay && pandocRefDocDisplay !== "None selected"
        ? pandocRefDocDisplay
        : null;

    const newNickname = document.getElementById("nickname-input").value.trim();
    const newGeminiKey = document.getElementById("gemini-key-input").value.trim();
    const newGeminiModel = document.getElementById("gemini-model-input").value.trim();

    // Validate vault path
    try {
      await apiFetch(`/api/list-vault?path=${encodeURIComponent(newVaultPath)}`);
    } catch {
      showStatus(`Invalid vault path: ${newVaultPath}`);
      return;
    }

    await apiPost("/api/settings", {
      vaultPath: newVaultPath,
      userCss: newCss,
      spellCheck: newSpellCheck,
      usePandoc: newUsePandoc,
      useAutoSave: newAutoSave,
      cslJsonPath: newBibPath,
      cslStylePath: newCslPath,
      pandocRefDocPath: newPandocRefDocPath,
      userNickname: newNickname,
      geminiApiKey: newGeminiKey,
      geminiModel: newGeminiModel,
    });

    currentUserCss = newCss;
    currentSpellCheck = newSpellCheck;
    currentUsePandoc = newUsePandoc;
    currentAutoSave = newAutoSave;
    currentUserNickname = newNickname;
    currentGeminiKey = newGeminiKey;
    currentGeminiModel = newGeminiModel;
    document.getElementById("editor").spellcheck = newSpellCheck;

    const bibChanged = newBibPath !== currentBibPath;
    const cslChanged = newCslPath !== currentCslPath;
    currentBibPath = newBibPath;
    currentCslPath = newCslPath;
    currentPandocRefDocPath = newPandocRefDocPath;
    if (bibChanged || cslChanged) await loadCitations();

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
    showStatus(`Error: ${error.message || error}`);
  }
}

function cancelSettings() {
  document.getElementById("vault-path-display").textContent = settingsBeforeEdit.vaultPath;
  document.getElementById("css-editor").value = settingsBeforeEdit.userCss;
  document.getElementById("spell-check-toggle").checked = settingsBeforeEdit.spellCheck;
  document.getElementById("use-pandoc-toggle").checked = settingsBeforeEdit.usePandoc;
  document.getElementById("auto-save-toggle").checked = settingsBeforeEdit.autoSave;
  document.getElementById("auto-save-warning").style.display = settingsBeforeEdit.autoSave
    ? ""
    : "none";
  document.getElementById("bib-path-display").textContent =
    settingsBeforeEdit.bibPath || "None selected";
  document.getElementById("csl-path-display").textContent =
    settingsBeforeEdit.cslPath || "None selected (defaults to APA)";
  closeSettingsDialog();
}

// ===== PROOFREADING (Gemini) =====

// Split Gemini's "revised text first, then a bulleted list of changes" reply
// into the two parts so the revised text can be applied on its own.
async function runProofread() {
  if (!currentFilePath) {
    showStatus("Open a file to proofread", true);
    return;
  }
  const editor = document.getElementById("editor");
  const isSelection = editor.selectionStart !== editor.selectionEnd;
  const start = isSelection ? editor.selectionStart : 0;
  const end = isSelection ? editor.selectionEnd : editor.value.length;
  const text = editor.value.slice(start, end);
  if (!text.trim()) {
    showStatus("Nothing to proofread", true);
    return;
  }
  proofreadRange = { start, end };

  const panel = document.getElementById("proofread-panel");
  const loading = document.getElementById("proofread-loading");
  const suggestions = document.getElementById("proofread-suggestions");
  const list = document.getElementById("proofread-list");

  // Sync panel width to the sidebar (which may have been resized).
  const sidebar = document.getElementById("sidebar");
  const sidebarWidth = sidebar.offsetWidth;
  panel.style.width = sidebarWidth + "px";

  document.getElementById("proofread-scope").textContent =
    `${isSelection ? "Selected text" : "Whole document"} (${text.length} chars)`;
  loading.style.display = "";
  suggestions.style.display = "none";
  list.innerHTML = "";
  panel.style.display = "";

  try {
    const res = await apiPost("/api/proofread", { text });
    const suggestionsText = res.result || "";

    // Gemini returns markdown bulleted list. Render it as HTML.
    if (!suggestionsText.trim()) {
      list.innerHTML = "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found — excellent work!</li>";
    } else if (typeof marked !== "undefined") {
      // Parse the markdown (which is a bulleted list) and extract just the items.
      const html = marked.parse(suggestionsText);
      // marked wraps bullet lists in <ul><li>…</li></ul>, so extract and insert.
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = html;
      const ul = tempDiv.querySelector("ul");
      if (ul && ul.childNodes.length > 0) {
        // Copy the <li> elements into our list.
        for (const li of ul.querySelectorAll("li")) {
          list.appendChild(li.cloneNode(true));
        }
      } else {
        list.innerHTML = "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found.</li>";
      }
    } else {
      // Fallback if marked isn't loaded: treat as plain text bullets.
      const lines = suggestionsText.split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        list.innerHTML = "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found.</li>";
      } else {
        for (const line of lines) {
          const clean = line.replace(/^[-•*]\s*/, "").trim();
          if (clean) {
            const li = document.createElement("li");
            li.textContent = clean;
            list.appendChild(li);
          }
        }
      }
    }
    loading.style.display = "none";
    suggestions.style.display = "";
  } catch (err) {
    loading.innerHTML = `<p style="color: var(--text-secondary); margin: 0; padding: 12px 16px; font-size: 12px;">Error: ${escapeHtml(err.message || err)}</p>`;
  }
}

function closeProofreadPanel() {
  document.getElementById("proofread-panel").style.display = "none";
  proofreadRange = null;
}

function syncProofreadPanelWidth() {
  const panel = document.getElementById("proofread-panel");
  if (panel.style.display !== "none") {
    const sidebar = document.getElementById("sidebar");
    panel.style.width = sidebar.offsetWidth + "px";
  }
}

// Sync panel width whenever the window resizes (catches sidebar resize too).
window.addEventListener("resize", syncProofreadPanelWidth);
window.addEventListener("resize", scheduleCommentGutterRender);

async function exportToWord() {
  if (!currentFilePath) {
    showStatus("No file open");
    return;
  }
  if (!currentBibPath || !currentCslPath) {
    showStatus("Bibliography or CSL style not configured in settings");
    return;
  }

  try {
    const content = getEditorContent();
    if (!content.trim()) {
      showStatus("Document is empty");
      return;
    }

    showStatus("Exporting to Word...");
    // Use fetch directly for binary response (apiPost returns JSON)
    const response = await fetch("/api/export-docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: content }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Export failed");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const fileName = currentFilePath.split("/").pop().replace(/\.md$/, ".docx");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showStatus("Document exported successfully");
  } catch (error) {
    showStatus(`Export failed: ${error.message || error}`);
    console.error("Export error:", error);
  }
}

async function pickVaultFolder() {
  try {
    const result = await apiPost("/api/pick-folder", { prompt: "Select new vault folder" });
    if (!result.path) return;
    try {
      await apiFetch(`/api/list-vault?path=${encodeURIComponent(result.path)}`);
      document.getElementById("vault-path-display").textContent = result.path;
      showStatus("Vault path updated (click Save to confirm)");
    } catch {
      showStatus(`Cannot access folder: ${result.path}`);
    }
  } catch (error) {
    showStatus(`Error: ${error.message || error}`);
  }
}

async function pickFileForSetting(displayId, extensions, title) {
  try {
    const result = await apiPost("/api/pick-file", { extensions, prompt: title });
    if (result.path) document.getElementById(displayId).textContent = result.path;
  } catch (error) {
    showStatus(`Error: ${error.message || error}`);
  }
}

// ===== EDITOR SEARCH AND REPLACE =====

let editorSearchMatches = [];
let editorSearchIndex = -1;

function openEditorSearch() {
  const panel = document.getElementById("editor-search-panel");
  panel.style.display = "";
  document.getElementById("editor-search-input").focus();
  document.getElementById("editor-search-input").select();
}

function closeEditorSearch() {
  document.getElementById("editor-search-panel").style.display = "none";
  editorSearchMatches = [];
  editorSearchIndex = -1;
  document.getElementById("editor").focus();
}

function toggleEditorReplace() {
  const row = document.getElementById("editor-replace-row");
  const replaceBtn = document.getElementById("editor-search-replace-btn");
  const replaceAllBtn = document.getElementById("editor-search-replace-all-btn");
  const isHidden = row.style.display === "none";
  row.style.display = isHidden ? "" : "none";
  replaceBtn.style.display = isHidden ? "" : "none";
  replaceAllBtn.style.display = isHidden ? "" : "none";
  if (isHidden) document.getElementById("editor-replace-input").focus();
}

function updateEditorSearchResults() {
  const query = document.getElementById("editor-search-input").value;
  const editor = document.getElementById("editor");
  const text = editor.value;

  if (!query.trim()) {
    editorSearchMatches = [];
    editorSearchIndex = -1;
    document.getElementById("editor-search-count").textContent = "0/0";
    return;
  }

  editorSearchMatches = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let pos = 0;
  while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
    editorSearchMatches.push({ start: pos, end: pos + query.length });
    pos += 1;
  }

  editorSearchIndex = editorSearchMatches.length > 0 ? 0 : -1;
  updateEditorSearchDisplay();
}

function updateEditorSearchDisplay() {
  const editor = document.getElementById("editor");
  const count = editorSearchMatches.length;
  const currentNum = editorSearchIndex >= 0 ? editorSearchIndex + 1 : 0;
  document.getElementById("editor-search-count").textContent = `${currentNum}/${count}`;

  if (editorSearchIndex >= 0 && editorSearchMatches[editorSearchIndex]) {
    const match = editorSearchMatches[editorSearchIndex];
    editor.setSelectionRange(match.start, match.end);
    editor.focus();
    editor.scrollTop = editor.scrollHeight * (match.start / editor.value.length);
  }
}

function editorSearchNext() {
  if (editorSearchMatches.length === 0) return;
  editorSearchIndex = (editorSearchIndex + 1) % editorSearchMatches.length;
  updateEditorSearchDisplay();
}

function editorSearchPrevious() {
  if (editorSearchMatches.length === 0) return;
  editorSearchIndex = (editorSearchIndex - 1 + editorSearchMatches.length) % editorSearchMatches.length;
  updateEditorSearchDisplay();
}

function handleEditorSearchKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    // First time: perform the search. Subsequent times: navigate.
    if (editorSearchMatches.length === 0 && document.getElementById("editor-search-input").value.trim()) {
      updateEditorSearchResults();
    } else if (e.shiftKey) {
      editorSearchPrevious();
    } else {
      editorSearchNext();
    }
  } else if (e.key === "Escape") {
    closeEditorSearch();
  }
}

function editorReplaceCurrent() {
  if (editorSearchIndex < 0 || !editorSearchMatches[editorSearchIndex]) return;
  const editor = document.getElementById("editor");
  const replace = document.getElementById("editor-replace-input").value;
  const match = editorSearchMatches[editorSearchIndex];

  snapshotForUndo();
  const newText = editor.value.slice(0, match.start) + replace + editor.value.slice(match.end);
  editor.value = newText;

  const query = document.getElementById("editor-search-input").value;
  updateEditorSearchResults();
  isDirty = true;
  updatePreview();
}

function editorReplaceAll() {
  if (editorSearchMatches.length === 0) return;
  const editor = document.getElementById("editor");
  const replace = document.getElementById("editor-replace-input").value;

  snapshotForUndo();
  let newText = editor.value;
  for (let i = editorSearchMatches.length - 1; i >= 0; i--) {
    const match = editorSearchMatches[i];
    newText = newText.slice(0, match.start) + replace + newText.slice(match.end);
  }
  editor.value = newText;
  updateEditorSearchResults();
  isDirty = true;
  updatePreview();
  showStatus(`Replaced ${editorSearchMatches.length} occurrence(s)`);
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
      isError ? 8000 : 3000,
    );
  }
}

// ===== MAIN =====

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(initialize, 100);
});
