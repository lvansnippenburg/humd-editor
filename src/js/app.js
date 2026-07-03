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
  parseHeadingAttrs,
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
let currentSmartQuotes = false;
let currentBibPath = null;
let currentCslPath = null;
let currentPandocRefDocPath = null;
let currentUserNickname = "";
let currentGeminiKey = "";
let currentGeminiModel = "";
let currentProofreadProvider = "gemini"; // "gemini" | "ollama"
let currentOllamaUrl = "";
let currentOllamaModel = "";
let vaultIsGitRepo = false; // is the current vault a git working tree?
let gitCommitInFlight = false; // serialise commit triggers (blur + timer)
let gitAuthErrorShown = false; // only nag about credentials once per session
let gitAutoCommitTimer = null; // 60-min periodic commit interval handle
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

// Multi-pane state
let panes = [];
let activePaneId = null;
let paneCounter = 0;

class Pane {
  constructor(id, containerEl) {
    this.id = id;
    this.containerEl = containerEl;
    this.tabs = [];
    this.activeTabId = null;
    this.currentFilePath = null;
    this.isDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.editorEl = containerEl.querySelector(".editor-textarea");
    this.tabBarEl = containerEl.querySelector(".editor-tab-bar");
    this.toolbarEl = containerEl.querySelector(".editor-toolbar");
    this.noteTagsEl = containerEl.querySelector(".note-tags");
    this.commentGutterEl = containerEl.querySelector(".editor-comment-gutter");
    this.graphContainerEl = containerEl.querySelector(".graph-container");
    this.mediaContainerEl = containerEl.querySelector(".media-container");
  }
}
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
// Monotonic so each loaded CSL gets a unique template name (citation-js caches
// compiled engines by name and won't recompile under a reused name).
let cslTemplateCounter = 0;

// ===== INLINE RENAME =====

async function startInlineRename(nameEl, oldPath) {
  if (!nameEl.isConnected) return;

  const oldName = oldPath.split("/").pop();
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tree-rename-input";
  input.value = oldName;
  // Keep clicks inside the field from bubbling to the row (which would open
  // the file) while the user is positioning the caret.
  input.addEventListener("click", (e) => e.stopPropagation());
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
      remapTabPaths(oldPath, newPath);
      renderTabBar();
      await refreshFileTree();
      if (currentFilePath === newPath) await revealFileInTree(newPath);
      // The server rewrites [[wikilinks]] to the renamed note across the vault;
      // refresh the index and any open notes that were edited on disk.
      await buildLinkIndex();
      await reloadCleanTabsFromDisk();
      showStatus(`Renamed to "${newName}"`);
      handleGitResult(result.git);
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

// Hovering a tree name without moving the cursor for ~1s opens inline rename.
// Any cursor movement (or a drag) restarts the timer, so it only fires when
// the pointer genuinely rests on the name.
function addHoverRename(nameEl, path) {
  let timer = null;
  let lastX = 0;
  let lastY = 0;
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = (x, y) => {
    lastX = x;
    lastY = y;
    clear();
    timer = setTimeout(() => {
      timer = null;
      startInlineRename(nameEl, path);
    }, 1000);
  };
  nameEl.addEventListener("mouseenter", (e) => schedule(e.clientX, e.clientY));
  // Only a real move restarts the timer; ignore the sub-pixel jitter a still
  // hand/trackpad emits, otherwise the 1s timer never elapses.
  nameEl.addEventListener("mousemove", (e) => {
    if (Math.abs(e.clientX - lastX) < 4 && Math.abs(e.clientY - lastY) < 4) return;
    schedule(e.clientX, e.clientY);
  });
  nameEl.addEventListener("mouseleave", clear);
  // If a drag begins on the row, don't pop the rename mid-drag.
  nameEl.addEventListener("mousedown", clear);
}

// ===== MULTI-PANE MANAGEMENT =====

function updateSplitPaneButtons() {
  const isSplitActive = panes.length >= 2;
  panes.forEach((p) => {
    const splitBtn = p.containerEl.querySelector(".split-pane-btn");
    const closeBtn = p.containerEl.querySelector(".close-pane-btn");
    if (splitBtn) {
      splitBtn.style.display = isSplitActive ? "none" : "";
    }
    if (closeBtn) {
      closeBtn.style.display = isSplitActive ? "" : "none";
    }
  });
}

function renderPaneTabBar(pane) {
  const bar = pane.tabBarEl;
  bar.innerHTML = "";
  const paneActiveTabId = pane.id === activePaneId ? activeTabId : pane.activeTabId;
  const paneTabs = pane.id === activePaneId ? tabs : pane.tabs;

  paneTabs.forEach((tab) => {
    const el = document.createElement("div");
    el.className = "editor-tab" + (tab.id === paneActiveTabId ? " active" : "");
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
      switchActivePane(pane.id);
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener("click", () => {
      switchActivePane(pane.id);
      switchToTab(tab.id);
    });
    bar.appendChild(el);
  });

  bar.querySelector(".editor-tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
}

function showMediaContainerForPane(pane, tab) {
  const c = pane.mediaContainerEl;
  if (!c) return;
  const url = `/api/image?path=${encodeURIComponent(tab.path)}`;
  c.innerHTML =
    tab.mediaType === "pdf"
      ? `<iframe class="media-frame" src="${url}" title="PDF preview"></iframe>`
      : `<img class="media-image" src="${url}" alt="">`;
  c.style.display = "flex";
}

function createPane() {
  const template = document.getElementById("pane-template");
  const clone = template.content.cloneNode(true);
  const container = document.getElementById("editor-pane");

  const paneEl = clone.querySelector(".editor-pane-instance");
  const id = `pane-${paneCounter++}`;
  paneEl.dataset.paneId = id;

  const searchPanel = document.getElementById("editor-search-panel");
  container.insertBefore(paneEl, searchPanel);

  const pane = new Pane(id, paneEl);
  panes.push(pane);

  setupPaneEventListeners(pane);
  updateSplitPaneButtons();

  if (panes.length === 1) {
    activePaneId = id;
    pane.editorEl.id = "editor";
    pane.tabBarEl.id = "editor-tab-bar";
    pane.toolbarEl.id = "editor-toolbar";
    pane.noteTagsEl.id = "note-tags";
    pane.commentGutterEl.id = "editor-comment-gutter";
    pane.graphContainerEl.id = "graph-container";
    pane.mediaContainerEl.id = "media-container";
    pane.containerEl.classList.add("active");
  }

  return pane;
}

function setupPaneEventListeners(pane) {
  const editor = pane.editorEl;
  editor.addEventListener("input", onEditorInput);
  editor.addEventListener("keydown", onEditorKeydown);
  editor.addEventListener("scroll", onEditorScroll, { passive: true });
  editor.addEventListener("blur", () => setTimeout(closeAutocomplete, 100));
  editor.addEventListener("blur", onEditorBlurCommit);
  editor.addEventListener("scroll", closeAutocomplete, { passive: true });
  editor.addEventListener("mouseup", closeAutocomplete);
  editor.addEventListener("click", onEditorModifierClick);

  editor.addEventListener("focus", () => {
    switchActivePane(pane.id);
  });
  pane.containerEl.addEventListener("mousedown", () => {
    switchActivePane(pane.id);
  });

  pane.containerEl.querySelector(".preview-toggle-btn").addEventListener("click", togglePreview);
  pane.containerEl.querySelector(".proofread-btn").addEventListener("click", runProofread);
  pane.containerEl.querySelector(".suggest-tags-btn").addEventListener("click", runSuggestTags);
  pane.containerEl.querySelector(".export-docx-btn").addEventListener("click", exportToWord);

  pane.containerEl
    .querySelector(".tab-scroll-left")
    .addEventListener("click", () => scrollTabBar(-1));
  pane.containerEl
    .querySelector(".tab-scroll-right")
    .addEventListener("click", () => scrollTabBar(1));

  pane.tabBarEl.addEventListener("scroll", updateTabScrollButtons, { passive: true });

  pane.containerEl.querySelector(".split-pane-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    splitPaneHorizontal(pane);
  });

  pane.containerEl.querySelector(".close-pane-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    closePane(pane);
  });
}

function saveActivePaneState() {
  const activePane = panes.find((p) => p.id === activePaneId);
  if (activePane) {
    activePane.tabs = tabs;
    activePane.activeTabId = activeTabId;
    activePane.currentFilePath = currentFilePath;
    activePane.isDirty = isDirty;
    activePane.undoStack = undoStack;
    activePane.redoStack = redoStack;
  }
}

function switchActivePane(paneId) {
  if (activePaneId === paneId) return;

  const prevPane = panes.find((p) => p.id === activePaneId);
  const nextPane = panes.find((p) => p.id === paneId);
  if (!nextPane) return;

  if (prevPane) {
    prevPane.tabs = tabs;
    prevPane.activeTabId = activeTabId;
    prevPane.currentFilePath = currentFilePath;
    prevPane.isDirty = isDirty;
    prevPane.undoStack = undoStack;
    prevPane.redoStack = redoStack;

    prevPane.editorEl.id = "";
    prevPane.tabBarEl.id = "";
    prevPane.toolbarEl.id = "";
    prevPane.noteTagsEl.id = "";
    prevPane.commentGutterEl.id = "";
    prevPane.graphContainerEl.id = "";
    prevPane.mediaContainerEl.id = "";

    prevPane.containerEl.classList.remove("active");
  }

  activePaneId = paneId;
  tabs = nextPane.tabs;
  activeTabId = null; // Set to null temporarily to force switchToTab to execute rendering logic
  currentFilePath = nextPane.currentFilePath;
  isDirty = nextPane.isDirty;
  undoStack = nextPane.undoStack;
  redoStack = nextPane.redoStack;

  nextPane.editorEl.id = "editor";
  nextPane.tabBarEl.id = "editor-tab-bar";
  nextPane.toolbarEl.id = "editor-toolbar";
  nextPane.noteTagsEl.id = "note-tags";
  nextPane.commentGutterEl.id = "editor-comment-gutter";
  nextPane.graphContainerEl.id = "graph-container";
  nextPane.mediaContainerEl.id = "media-container";

  nextPane.containerEl.classList.add("active");

  const searchPanel = document.getElementById("editor-search-panel");
  if (searchPanel) {
    nextPane.containerEl.appendChild(searchPanel);
  }

  renderTabBar();
  updateTabScrollButtons();

  if (nextPane.activeTabId) {
    switchToTab(nextPane.activeTabId);
  } else {
    resetPreview();
    const stats = document.getElementById("preview-stats");
    if (stats) stats.textContent = "";
    document.getElementById("editor").value = "";
  }

  nextPane.editorEl.focus();
}

function splitPaneHorizontal(pane) {
  if (panes.length >= 2) {
    showStatus("Maximum 2 split panes allowed.");
    return;
  }

  saveActivePaneState();

  const resizer = document.createElement("div");
  resizer.className = "pane-resize-handle";
  const container = document.getElementById("editor-pane");
  const searchPanel = document.getElementById("editor-search-panel");
  container.insertBefore(resizer, searchPanel);

  const newPane = createPane();

  initPaneResizeHandle(resizer, pane.containerEl, newPane.containerEl);

  updateSplitPaneButtons();

  switchActivePane(newPane.id);

  if (pane.currentFilePath) {
    loadFile(pane.currentFilePath);
  }
}

function closePane(pane) {
  if (panes.length <= 1) return;

  saveActivePaneState();

  const idx = panes.indexOf(pane);
  if (idx === -1) return;

  const remainingPane = panes.find((p) => p.id !== pane.id);

  pane.containerEl.remove();

  const resizer = document.querySelector(".pane-resize-handle");
  if (resizer) resizer.remove();

  panes.splice(idx, 1);

  panes.forEach((p) => {
    p.containerEl.style.flex = "1";
  });
  updateSplitPaneButtons();

  activePaneId = null;
  switchActivePane(remainingPane.id);

  saveUiState();
}

function initPaneResizeHandle(resizer, topPaneEl, bottomPaneEl) {
  let startY, startTopHeight, startBottomHeight;

  function onMouseDown(e) {
    e.preventDefault();
    startY = e.clientY;
    startTopHeight = topPaneEl.getBoundingClientRect().height;
    startBottomHeight = bottomPaneEl.getBoundingClientRect().height;

    resizer.classList.add("dragging");
    document.body.classList.add("dragging-pane");

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    const dy = e.clientY - startY;
    const newTopHeight = Math.max(100, startTopHeight + dy);
    const newBottomHeight = Math.max(100, startBottomHeight - dy);

    topPaneEl.style.flex = `0 0 ${newTopHeight}px`;
    bottomPaneEl.style.flex = `0 0 ${newBottomHeight}px`;
  }

  function onMouseUp() {
    resizer.classList.remove("dragging");
    document.body.classList.remove("dragging-pane");

    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);

    saveUiState();
  }

  resizer.addEventListener("mousedown", onMouseDown);
}

// ===== INITIALIZATION =====

async function initialize() {
  try {
    await loadScript("/js/marked.min.js");
    configureMarked();

    const settings = await apiFetch("/api/settings");

    // Create the initial pane before any other operations attempt to access the editor DOM node!
    createPane();

    currentUserCss = settings.userCss || "";
    currentSpellCheck = settings.spellCheck ?? true;
    currentUsePandoc = settings.usePandoc ?? false;
    currentAutoSave = settings.useAutoSave ?? false;
    currentSmartQuotes = settings.smartQuotes ?? false;
    currentBibPath = settings.cslJsonPath || null;
    currentCslPath = settings.cslStylePath || null;
    currentPandocRefDocPath = settings.pandocRefDocPath || null;
    currentUserNickname = settings.userNickname || "";
    currentGeminiKey = settings.geminiApiKey || "";
    currentGeminiModel = settings.geminiModel || "gemini-3-flash-preview";
    currentProofreadProvider = settings.proofreadProvider || "gemini";
    currentOllamaUrl = settings.ollamaUrl || "";
    currentOllamaModel = settings.ollamaModel || "";
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

    const panesLayout = settings.panesLayout || [];
    const isSplitActive =
      panes.length >= 2 ||
      (settings.openFiles && settings.openFiles.length > 0 && settings.panesLayout); // Wait, we will save split layout under settings.panes
    // Let's use settings.panes which will contain full layout details!
    const savedPanes = settings.panes || [];
    const isSplitSaved = savedPanes && savedPanes.length >= 2;

    const openFiles = [];
    if (isSplitActive || savedEditorFlexBasis) {
      // Let's gather open files across all saved panes if present
    }

    // Let's support full settings restoration for multi-pane.
    // If settings has a "panes" field, we can load it.
    // Let's design settings.panes:
    // "panes": [
    //   { "id": "pane-0", "activeTabId": "...", "currentFilePath": "...", "openFiles": [...] },
    //   ...
    // ]
    //
    // For extreme simplicity, backwards compatibility, and robustness, let's design it so:
    // settings.panes = [
    //   { tabs: ["file1.md", "file2.md"], activeTab: "file1.md", height: 350 },
    //   { tabs: ["file3.md"], activeTab: "file3.md", height: 350 }
    // ]
    // This is incredibly clean!
    const layoutPanes = settings.panes || [];
    const openFilesToPrefetch = [];
    if (layoutPanes.length > 0) {
      layoutPanes.forEach((lp) => {
        if (lp.tabs) {
          lp.tabs.forEach((path) => {
            if (!openFilesToPrefetch.includes(path)) {
              openFilesToPrefetch.push(path);
            }
          });
        }
      });
    } else {
      const lastOpenFile = settings.lastOpenFile;
      openFilesToPrefetch.push(...(settings.openFiles || (lastOpenFile ? [lastOpenFile] : [])));
    }

    // These startup steps are independent — run them concurrently instead of
    // awaiting each in turn. The open files are prefetched in the same batch.
    const [, , , results] = await Promise.all([
      refreshFileTree(),
      buildLinkIndex(),
      loadCitations(),
      openFilesToPrefetch.length > 0
        ? Promise.allSettled(
            openFilesToPrefetch.map((path) =>
              apiFetch(`/api/read-file?path=${encodeURIComponent(path)}`),
            ),
          )
        : Promise.resolve([]),
    ]);
    initializeFileWatcher();
    checkGitRepo();

    isInitialized = true;

    // Map fetched contents by file path
    const fileContents = {};
    if (openFilesToPrefetch.length > 0) {
      openFilesToPrefetch.forEach((path, i) => {
        const res = results[i];
        if (res && res.status === "fulfilled") {
          fileContents[path] = res.value.content;
        } else {
          fileContents[path] = "";
        }
      });
    }

    if (layoutPanes.length >= 2) {
      // Restore split pane layout!
      const resizer = document.createElement("div");
      resizer.className = "pane-resize-handle";
      const container = document.getElementById("editor-pane");
      const searchPanel = document.getElementById("editor-search-panel");
      container.insertBefore(resizer, searchPanel);

      const pane0 = panes[0];
      const pane1 = createPane();

      initPaneResizeHandle(resizer, pane0.containerEl, pane1.containerEl);

      // Restore sizes
      if (layoutPanes[0].height) {
        pane0.containerEl.style.flex = `0 0 ${layoutPanes[0].height}px`;
      }
      if (layoutPanes[1].height) {
        pane1.containerEl.style.flex = `0 0 ${layoutPanes[1].height}px`;
      }

      // Populate tabs for both panes
      [pane0, pane1].forEach((pane, idx) => {
        const lp = layoutPanes[idx];
        pane.tabs = [];
        if (lp.tabs) {
          lp.tabs.forEach((path) => {
            const mediaType = mediaTypeForPath(path);
            if (mediaType) {
              pane.tabs.push({
                id: `tab-${++tabCounter}`,
                path,
                isMedia: true,
                mediaType,
                isDirty: false,
                content: "",
              });
            } else {
              const content = fileContents[path] || "";
              pane.tabs.push({
                id: `tab-${++tabCounter}`,
                path,
                isDirty: false,
                content,
                undoStack: [{ value: content, start: 0, end: 0 }],
                redoStack: [],
              });
            }
          });
        }

        if (lp.activeTabPath) {
          const matchingTab = pane.tabs.find((t) => t.path === lp.activeTabPath);
          if (matchingTab) {
            pane.activeTabId = matchingTab.id;
            pane.currentFilePath = lp.activeTabPath;
          }
        }
        if (!pane.activeTabId && pane.tabs.length > 0) {
          pane.activeTabId = pane.tabs[pane.tabs.length - 1].id;
          pane.currentFilePath = pane.tabs[pane.tabs.length - 1].path;
        }

        // Force render this pane's UI immediately on load so it displays correctly before any clicks!
        renderPaneTabBar(pane);

        const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
        if (activeTab) {
          if (activeTab.isMedia) {
            pane.editorEl.style.display = "none";
            showMediaContainerForPane(pane, activeTab);
          } else {
            pane.editorEl.value = activeTab.content;
            pane.editorEl.style.display = "block";
            if (pane.mediaContainerEl) pane.mediaContainerEl.style.display = "none";
          }
        } else {
          pane.editorEl.value = "";
        }
      });

      updateSplitPaneButtons();
      const savedActiveId = settings.activePaneId === "pane-1" ? "pane-1" : "pane-0";
      // Force loading active pane state to globals
      activePaneId = null;
      switchActivePane(savedActiveId);
    } else {
      // Single pane restore (falls back to old logic)
      const lastOpenFile = settings.lastOpenFile;
      const pane = panes[0];
      pane.tabs = [];

      openFilesToPrefetch.forEach((path) => {
        const mediaType = mediaTypeForPath(path);
        if (mediaType) {
          pane.tabs.push({
            id: `tab-${++tabCounter}`,
            path,
            isMedia: true,
            mediaType,
            isDirty: false,
            content: "",
          });
        } else {
          const content = fileContents[path] || "";
          pane.tabs.push({
            id: `tab-${++tabCounter}`,
            path,
            isDirty: false,
            content,
            undoStack: [{ value: content, start: 0, end: 0 }],
            redoStack: [],
          });
        }
      });

      if (pane.tabs.length > 0) {
        const activeTab =
          pane.tabs.find((t) => t.path === lastOpenFile) || pane.tabs[pane.tabs.length - 1];
        pane.activeTabId = activeTab.id;
        pane.currentFilePath = activeTab.path;
      }

      // Load into globals
      tabs = pane.tabs;
      activeTabId = null; // Set to null temporarily to force switchToTab rendering logic
      currentFilePath = pane.currentFilePath;
      isDirty = pane.isDirty;
      undoStack = pane.activeTabId
        ? pane.tabs.find((t) => t.id === pane.activeTabId)?.undoStack || []
        : [];
      redoStack = [];

      updateSplitPaneButtons();
      renderTabBar();
      updateTabScrollButtons();

      if (pane.activeTabId) {
        switchToTab(pane.activeTabId);
      } else {
        resetPreview();
        const stats = document.getElementById("preview-stats");
        if (stats) stats.textContent = "";
        document.getElementById("editor").value = "";
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

  window.addEventListener("resize", updateTabScrollButtons, { passive: true });

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "e") {
      e.preventDefault();
      togglePreview();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveCurrentFile(true);
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
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      openTableDialog();
    }
  });

  document.getElementById("close-table").addEventListener("click", closeTableDialog);
  document.getElementById("table-cancel-btn").addEventListener("click", closeTableDialog);
  document.getElementById("table-insert-btn").addEventListener("click", insertTableFromDialog);
  document.getElementById("table-cols").addEventListener("input", () => renderTableAlignControls());

  document.querySelectorAll(".sidebar-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchSidebarTab(btn.dataset.tab));
  });

  document.getElementById("search-input").addEventListener("input", onSearchInput);

  document.getElementById("new-file-btn").addEventListener("click", promptNewFile);
  document.getElementById("new-folder-btn").addEventListener("click", promptNewFolder);
  document.getElementById("graph-btn").addEventListener("click", openGraphTab);
  document.getElementById("change-vault-btn").addEventListener("click", changeVaultFolder);
  document.getElementById("settings-btn").addEventListener("click", openSettingsDialog);
  document
    .getElementById("proofread-provider-select")
    .addEventListener("change", updateProofreadProviderVisibility);
  document.getElementById("help-btn").addEventListener("click", openHelpDialog);
  document.getElementById("close-help").addEventListener("click", closeHelpDialog);
  document.getElementById("close-proofread").addEventListener("click", closeProofreadPanel);
  // Delegated: the Apply button replaces the passage; clicking elsewhere on a
  // suggestion highlights its source passage in the editor.
  document.getElementById("proofread-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-original]");
    if (!li) return;
    if (e.target.closest(".proofread-apply")) {
      applyProofreadSuggestion(li);
    } else {
      highlightProofreadSnippet(li.dataset.original, li);
    }
  });
  document
    .getElementById("editor-search-input")
    .addEventListener("keydown", handleEditorSearchKeydown);
  document
    .getElementById("editor-replace-input")
    .addEventListener("keydown", handleEditorSearchKeydown);
  document.getElementById("editor-search-prev-btn").addEventListener("click", editorSearchPrevious);
  document.getElementById("editor-search-next-btn").addEventListener("click", editorSearchNext);
  document
    .getElementById("editor-search-toggle-replace-btn")
    .addEventListener("click", toggleEditorReplace);
  document
    .getElementById("editor-search-replace-btn")
    .addEventListener("click", editorReplaceCurrent);
  document
    .getElementById("editor-search-replace-all-btn")
    .addEventListener("click", editorReplaceAll);
  document.getElementById("editor-search-close-btn").addEventListener("click", closeEditorSearch);
  document.getElementById("close-settings").addEventListener("click", cancelSettings);
  document.getElementById("cancel-settings-btn").addEventListener("click", cancelSettings);
  document.getElementById("save-settings-btn").addEventListener("click", saveSettings);

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
      pickFileForSetting("csl-path-display", ["csl"], "Select CSL style file (.csl)"),
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
      openExternalUrl(msg.data.href || "");
      return;
    }
    if (msg.data.type === "wikilink") {
      // marked percent-encodes spaces in the href (e.g. "./My%20Note.md"), so
      // decode before resolving the note name.
      const raw = (msg.data.href || "").replace(/^\.\//, "").replace(/\.md$/, "");
      let stem = raw;
      try {
        stem = decodeURIComponent(raw);
      } catch {}
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
      const content = msg.data.content || "";
      // Parse comment thread
      let thread = [];
      try {
        const trimmed = content.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          thread = JSON.parse(trimmed);
        }
      } catch (e) {}
      // Fallback for old format
      if (thread.length === 0) {
        const dm = content.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\s*(.*)/s);
        if (dm) {
          thread = [{ creator: dm[1].trim(), timestamp: dm[2], comment: dm[3] }];
        } else {
          thread = [{ creator: "Comment", timestamp: "", comment: content }];
        }
      }
      // Find the matching comment balloon in the editor and open its popup
      const editor = document.getElementById("editor");
      const comments = findCommentLines(editor.value);
      for (const c of comments) {
        if (c.fullContent === content) {
          // Found the matching comment - find its balloon in the gutter
          const gutter = document.getElementById("editor-comment-gutter");
          const balloons = gutter.querySelectorAll(".editor-comment-balloon");
          if (balloons.length > 0) {
            // Open popup for the first matching balloon
            showCommentPopup(balloons[0], c.thread, c.fullContent, c.offset);
          }
          return;
        }
      }
      // Fallback: show in status bar if we can't find the editor comment
      showStatus("Comment: " + (thread[0]?.comment || content), false);
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

// Repoint open tabs after a file/folder is renamed or moved. Handles a moved
// folder by remapping every open tab whose path sits under the old folder path.
function remapTabPaths(oldPath, newPath) {
  tabs.forEach((t) => {
    if (t.path === oldPath) {
      t.path = newPath;
    } else if (t.path && t.path.startsWith(oldPath + "/")) {
      t.path = newPath + t.path.slice(oldPath.length);
    } else {
      return;
    }
    if (t.id === activeTabId) currentFilePath = t.path;
  });
}

// Express `toFile` as a path relative to `fromFile`'s directory (both absolute
// vault paths), e.g. /v/a/note.md + /v/images/x.png -> ../images/x.png. Used to
// build Markdown image/link paths when dropping a file into the editor. With no
// open document, fall back to the vault-relative path.
function relativeVaultPath(fromFile, toFile) {
  if (!fromFile) {
    return currentVaultPath && toFile.startsWith(currentVaultPath + "/")
      ? toFile.slice(currentVaultPath.length + 1)
      : toFile;
  }
  const fromDir = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  let i = 0;
  while (i < fromDir.length && i < to.length - 1 && fromDir[i] === to[i]) i++;
  const up = fromDir.slice(i).map(() => "..");
  return up.concat(to.slice(i)).join("/");
}

function addFileMouseDrag(li, filePath, fileName, isDir = false) {
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
      const el = document.elementFromPoint(x, y);
      // Trash sits in the sidebar footer; check it before the generic
      // sidebar->vault-root zone below.
      if (el?.closest("#trash-btn")) {
        return { destDir: null, dir: null, overEditor: false, trash: true };
      }
      const editorEl = document.getElementById("editor");
      const er = editorEl?.getBoundingClientRect();
      if (er && x >= er.left && x <= er.right && y >= er.top && y <= er.bottom) {
        return { destDir: null, dir: null, overEditor: true };
      }
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
        ghost.innerHTML = isDir ? ICON_FOLDER_CLOSED : getFileIcon(fileName);
        ghost.appendChild(document.createTextNode(" " + fileName));
        document.body.appendChild(ghost);
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
        document.body.classList.add("dragging-file");
      }
      ghost.style.left = e.clientX + 14 + "px";
      ghost.style.top = e.clientY - 10 + "px";
      clearHighlights();
      const { dir, trash } = getDropZone(e.clientX, e.clientY);
      if (trash) document.getElementById("trash-btn")?.classList.add("tree-drop-target");
      else if (dir) dir.classList.add("tree-drop-target");
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

      const { destDir, overEditor, trash } = getDropZone(e.clientX, e.clientY);

      if (trash) {
        try {
          await apiPost("/api/trash-file", { path: filePath });
          // Close any open tabs for the trashed file/folder (folders: every tab
          // under that path) without trying to save them.
          for (const t of tabs.filter(
            (t) => t.path === filePath || t.path.startsWith(filePath + "/"),
          )) {
            await closeTab(t.id, true);
          }
          await refreshFileTree();
          await buildLinkIndex();
          maybeGitCommit();
          showStatus(`Moved "${fileName}" to Trash`);
        } catch (err) {
          showStatus(`Trash failed: ${err}`, true);
        }
        return;
      }

      if (overEditor) {
        if (isDir) return; // dropping a folder into the editor is meaningless
        const editor = document.getElementById("editor");
        editor.focus();
        const pos = editor.selectionStart;
        const ext = fileName.split(".").pop().toLowerCase();
        let snippet;
        if (mediaTypeForPath(filePath) === "image") {
          // Images embed as a Markdown image, relative to the current document.
          snippet = `![](${relativeVaultPath(currentFilePath, filePath)})`;
        } else if (ext === "md" || ext === "html" || ext === "htm") {
          // Notes/pages link as a wikilink (resolved elsewhere in the app).
          snippet = `[[${fileName.replace(/\.(md|html?)$/i, "")}]]`;
        } else {
          // Everything else (pdf, …): a plain relative link.
          snippet = `[${fileName}](${relativeVaultPath(currentFilePath, filePath)})`;
        }
        editorReplace(editor, pos, pos, snippet);
        return;
      }

      if (!destDir) return;
      const srcParent = filePath.split("/").slice(0, -1).join("/");
      if (srcParent === destDir) {
        showStatus(`"${fileName}" is already in this folder`);
        return;
      }
      if (isDir && (destDir === filePath || destDir.startsWith(filePath + "/"))) {
        showStatus("Cannot move a folder into itself", true);
        return;
      }

      try {
        const result = await apiPost("/api/move-file", { src_path: filePath, dest_dir: destDir });
        const newPath = result.path;
        remapTabPaths(filePath, newPath);
        renderTabBar();
        await refreshFileTree();
        showStatus(`Moved to ${destDir.split("/").pop()}/`);
        handleGitResult(result.git);
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
        // A drag just ended on this label — swallow the click so it doesn't
        // also toggle the folder open/closed.
        if (dragDidOccur) {
          dragDidOccur = false;
          return;
        }
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
      addHoverRename(nameSpan, node.path);
      addFileMouseDrag(label, node.path, node.name, true);
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
      addHoverRename(nameEl, node.path);
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
    if (cur && !cur.isGraph && !cur.isMedia) {
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
  const mediaContainer = document.getElementById("media-container");

  if (tab.isMedia) {
    // Show an image/PDF in the read-only viewer; hide editor, preview, graph.
    currentFilePath = null;
    isDirty = false;
    editor.style.display = "none";
    preview.style.display = "none";
    if (graphContainer) graphContainer.style.display = "none";
    renderEditorCommentGutter(); // clear comment balloons from the previous doc
    showMediaContainer(tab);
    await revealFileInTree(tab.path);
    document.querySelectorAll(".file-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.path === tab.path);
    });
  } else if (tab.isGraph) {
    // Show graph tab
    editor.style.display = "none";
    if (mediaContainer) mediaContainer.style.display = "none";
    if (graphContainer) {
      graphContainer.style.display = "flex";
      graphContainer.innerHTML = ""; // Clear old graph
    }
    currentFilePath = null;
    isDirty = false;
    renderEditorCommentGutter(); // clear comment balloons from the previous doc

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
    if (mediaContainer) mediaContainer.style.display = "none";

    editor.value = tab.content;
    // Re-read the bibliography from disk in case it changed externally (e.g.
    // re-exported from Zotero) since it was last loaded.
    await loadCitations();
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

  if (!skipSave && !tab.isGraph && !tab.isMedia) {
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
      // Restore the editor view in case the closed tab was a media/graph viewer.
      document.getElementById("editor").style.display = "block";
      const mediaContainer = document.getElementById("media-container");
      if (mediaContainer) mediaContainer.style.display = "none";
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

  if (tabs.length === 0 && panes.length > 1) {
    const pane = panes.find((p) => p.id === activePaneId);
    if (pane) {
      closePane(pane);
    }
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

// Non-markdown files we can display in a read-only viewer tab.
const MEDIA_TYPES = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  pdf: "pdf",
};

function mediaTypeForPath(path) {
  return MEDIA_TYPES[path.split(".").pop().toLowerCase()] || null;
}

// Open an image/PDF in a read-only viewer tab (no text content, not editable).
async function openMediaTab(path) {
  const tab = {
    id: `tab-${++tabCounter}`,
    path,
    isMedia: true,
    mediaType: mediaTypeForPath(path),
    isDirty: false,
    content: "",
  };
  tabs.push(tab);
  await switchToTab(tab.id);
  showStatus(`Opened: ${path.split("/").pop()}`);
}

// Fill the media container with the current image/PDF (served by /api/image,
// which returns the file bytes with the right MIME type).
function showMediaContainer(tab) {
  const c = document.getElementById("media-container");
  if (!c) return;
  const url = `/api/image?path=${encodeURIComponent(tab.path)}`;
  c.innerHTML =
    tab.mediaType === "pdf"
      ? `<iframe class="media-frame" src="${url}" title="PDF preview"></iframe>`
      : `<img class="media-image" src="${url}" alt="">`;
  c.style.display = "flex";
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

    // Images and PDFs open in a read-only viewer rather than the text editor.
    if (mediaTypeForPath(path)) {
      await openMediaTab(path);
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
    // Re-read the bibliography from disk in case it changed externally (e.g.
    // re-exported from Zotero) since it was last loaded.
    await loadCitations();
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

async function promptNewFolder() {
  let input = document.getElementById("new-folder-input");
  if (input) {
    input.focus();
    return;
  }
  const fileTree = document.getElementById("file-tree");
  const li = document.createElement("li");
  input = document.createElement("input");
  input.id = "new-folder-input";
  input.className = "file-input-inline";
  input.type = "text";
  input.placeholder = "New folder name...";
  input.spellcheck = false;

  const handleSave = async () => {
    const name = input.value.trim();
    li.remove();
    if (!name) return;
    try {
      await apiPost("/api/create-folder", {
        vault_path: currentVaultPath,
        name,
      });
      await refreshFileTree();
      showStatus(`Created folder: ${name}`);
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

  // Quotes: insert them ourselves so the app's smart-quotes setting is the sole
  // authority — this also prevents the macOS system-wide "Smart Quotes" text
  // substitution from sneaking curly quotes in when the setting is off (or
  // double-converting when it's on). We intercept only when the key truly
  // produces a quote: dead keys report e.key === "Dead", so accent input on
  // international layouts is unaffected.
  if (!isMeta && (e.key === "'" || e.key === '"')) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;
    const smart = currentSmartQuotes && !isCursorInCode(value, start);
    const before = start > 0 ? value[start - 1] : "";
    // A backslash before the quote keeps it straight (drop the backslash).
    if (smart && before === "\\" && start === end) {
      e.preventDefault();
      editorReplace(editor, start - 1, end, e.key);
      return;
    }
    let ch = e.key; // straight by default — defeats the OS substitution
    if (smart) {
      // Opening quote after a space/bracket/quote or at the start; else closing
      // (this also gives the apostrophe ’ inside contractions like it's).
      const open = !before || /[\s(\[{'"‘“]/.test(before);
      ch = e.key === '"' ? (open ? "“" : "”") : open ? "‘" : "’";
    }
    e.preventDefault();
    editorReplace(editor, start, end, ch);
    return;
  }

  // Hyphens: insert a second consecutive hyphen ourselves so the macOS system
  // "Smart Dashes" substitution can't turn "--" into an em dash — that would
  // corrupt HTML comment markers (<!-- … -->). Always on, independent of the
  // smart-quotes setting.
  if (!isMeta && e.key === "-") {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start === end && start > 0 && editor.value[start - 1] === "-") {
      e.preventDefault();
      editorReplace(editor, start, end, "-");
      return;
    }
  }

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

// ===== TABLE GENERATOR (⌘⇧T) =====

let tableInsertPos = 0; // editor caret captured when the dialog opened

function openTableDialog() {
  if (!currentFilePath) {
    showStatus("Open a document to insert a table", true);
    return;
  }
  tableInsertPos = document.getElementById("editor").selectionStart;
  renderTableAlignControls();
  document.getElementById("table-dialog").showModal();
}

function closeTableDialog() {
  document.getElementById("table-dialog").close();
}

// One alignment <select> per column (Left/Center/Right), rebuilt whenever the
// column count changes. Existing choices are preserved where possible.
function renderTableAlignControls() {
  const cols = Math.max(
    1,
    Math.min(20, parseInt(document.getElementById("table-cols").value, 10) || 1),
  );
  const row = document.getElementById("table-align-row");
  const prev = Array.from(row.querySelectorAll("select")).map((s) => s.value);
  row.innerHTML = "";
  for (let c = 0; c < cols; c++) {
    const wrap = document.createElement("label");
    wrap.className = "table-align-item";
    wrap.textContent = `Col ${c + 1}`;
    const sel = document.createElement("select");
    sel.className = "settings-input";
    for (const [val, label] of [
      ["left", "Left"],
      ["center", "Center"],
      ["right", "Right"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = prev[c] || "left";
    wrap.appendChild(sel);
    row.appendChild(wrap);
  }
}

function insertTableFromDialog() {
  const rows = Math.max(
    1,
    Math.min(50, parseInt(document.getElementById("table-rows").value, 10) || 1),
  );
  const aligns = Array.from(
    document.getElementById("table-align-row").querySelectorAll("select"),
  ).map((s) => s.value);
  const md = buildTableMarkdown(rows, aligns);

  const editor = document.getElementById("editor");
  const value = editor.value;
  const before = value.slice(0, tableInsertPos);
  const after = value.slice(tableInsertPos);
  // A Markdown table must be separated from surrounding text by a blank line
  // (required by Pandoc's pipe_tables), so pad to a blank line on each side.
  let lead = "";
  if (before.length && !before.endsWith("\n\n")) lead = before.endsWith("\n") ? "\n" : "\n\n";
  let trail = "\n";
  if (after.length && !after.startsWith("\n")) trail = "\n\n";
  const insert = lead + md + trail;

  closeTableDialog();
  // Set the value directly rather than via execCommand("insertText"): the
  // latter is subject to the macOS Smart Dashes substitution, which mangles the
  // "---" separators into en/em dashes and breaks the table.
  snapshotForUndo();
  editor.value = before + insert + after;
  const caret = before.length + insert.length;
  editor.focus();
  editor.setSelectionRange(caret, caret);
  onEditorInput();
}

// Build a GFM table: a header row, an alignment separator, and `rows-1` empty
// body rows (rows counts the header). Alignment: left `:--`, center `:-:`, right `--:`.
function buildTableMarkdown(rows, aligns) {
  const cols = aligns.length;
  const header = aligns.map((_, c) => `Column ${c + 1}`);
  const sep = aligns.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : ":---"));
  const emptyCells = Array(cols).fill("   ");
  const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
  for (let r = 1; r < rows; r++) lines.push(`| ${emptyCells.join(" | ")} |`);
  return lines.join("\n");
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

// Parse comment JSON from HTML comment content, returning array of {creator, timestamp, comment}.
function parseCommentThread(content) {
  try {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return JSON.parse(trimmed);
    }
  } catch (e) {
    // Fall back to old format if JSON parsing fails
  }
  // Fallback for old format "nickname YYYY-MM-DD HH:MM: text"
  const dm = content.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\s*(.*)/s);
  if (dm) {
    return [{ creator: dm[1].trim(), timestamp: dm[2], comment: dm[3] }];
  }
  return [{ creator: "Comment", timestamp: "", comment: content }];
}

// Locate every HTML comment, the character offset where its marker begins
// (used to align the balloon to the correct visual row, even on wrapped lines),
// the creator of the first comment, and the full thread. Returns { offset, nick, thread, fullContent }.
function findCommentLines(text) {
  const out = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const content = m[1].trim();
    const thread = parseCommentThread(content);
    const nick = (thread && thread[0] ? thread[0].creator : "Comment") || "Comment";
    out.push({ offset: m.index, nick, thread, fullContent: content });
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
    b.addEventListener("click", () => showCommentPopup(b, c.thread, c.fullContent, c.offset));
    gutter.appendChild(b);
  }
}

// Show a popup displaying a comment thread and allowing replies
function showCommentPopup(balloonElement, thread, fullContent, commentOffset) {
  const editor = document.getElementById("editor");
  const rect = balloonElement.getBoundingClientRect();

  // Create popup container
  const popup = document.createElement("div");
  popup.className = "comment-popup";
  popup.style.position = "fixed";
  popup.style.zIndex = "1000";
  popup.style.backgroundColor = "var(--bg-primary)";
  popup.style.border = "1px solid var(--border)";
  popup.style.borderRadius = "6px";
  popup.style.padding = "12px";
  popup.style.maxWidth = "400px";
  popup.style.maxHeight = "400px";
  popup.style.display = "flex";
  popup.style.flexDirection = "column";
  popup.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";

  // Thread display
  const threadEl = document.createElement("div");
  threadEl.style.flex = "1";
  threadEl.style.minHeight = "0";
  threadEl.style.overflowY = "auto";
  threadEl.style.marginBottom = "8px";

  thread.forEach((comment, idx) => {
    const item = document.createElement("div");
    item.style.marginBottom = "8px";
    item.style.paddingBottom = "8px";
    item.style.borderBottom = idx < thread.length - 1 ? "1px solid var(--border)" : "none";

    const header = document.createElement("div");
    header.style.fontSize = "12px";
    header.style.fontWeight = "600";
    header.style.color = "var(--text-primary)";
    header.textContent = `${comment.creator} — ${comment.timestamp}`;
    item.appendChild(header);

    const body = document.createElement("div");
    body.style.fontSize = "12px";
    body.style.color = "var(--text-secondary)";
    body.style.marginTop = "4px";
    body.textContent = comment.comment;
    item.appendChild(body);

    threadEl.appendChild(item);
  });

  popup.appendChild(threadEl);

  // Reply input
  const inputDiv = document.createElement("div");
  inputDiv.style.display = "flex";
  inputDiv.style.gap = "4px";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add a reply...";
  input.style.flex = "1";
  input.style.fontSize = "12px";
  input.style.padding = "6px 8px";
  input.style.border = "1px solid var(--border)";
  input.style.borderRadius = "4px";
  input.style.backgroundColor = "var(--bg-secondary)";
  input.style.color = "var(--text-primary)";
  inputDiv.appendChild(input);

  const replyBtn = document.createElement("button");
  replyBtn.textContent = "Reply";
  replyBtn.style.padding = "6px 10px";
  replyBtn.style.fontSize = "11px";
  replyBtn.style.border = "1px solid var(--border)";
  replyBtn.style.borderRadius = "4px";
  replyBtn.style.backgroundColor = "var(--bg-secondary)";
  replyBtn.style.color = "var(--accent)";
  replyBtn.style.cursor = "pointer";
  replyBtn.style.fontWeight = "600";

  replyBtn.addEventListener("click", async () => {
    const reply = input.value.trim();
    if (!reply) return;

    const nick = currentUserNickname || (await ensureNickname());
    if (!nick) return;

    // Add reply to thread
    thread.push({ creator: nick, timestamp: commentTimestamp(), comment: reply });

    // Update the comment in the editor
    const commentRegex = /<!--([\s\S]*?)-->/g;
    let match;
    let targetStart = -1;
    let targetEnd = -1;

    while ((match = commentRegex.exec(editor.value)) !== null) {
      if (match.index === commentOffset) {
        targetStart = match.index;
        targetEnd = match.index + match[0].length;
        break;
      }
    }

    if (targetStart !== -1) {
      const newJson = `<!-- ${JSON.stringify(thread)} -->`;
      editor.value = editor.value.slice(0, targetStart) + newJson + editor.value.slice(targetEnd);
      onEditorInput();
    }

    // Close and reopen popup to show new reply
    popup.remove();
    input.value = "";
  });

  inputDiv.appendChild(replyBtn);
  popup.appendChild(inputDiv);

  document.body.appendChild(popup);

  // Position popup to stay in viewport
  let top = rect.top - popup.offsetHeight - 8;
  let left = rect.right + 8;

  if (top < 8) {
    top = rect.bottom + 8;
  }
  if (left + popup.offsetWidth > window.innerWidth - 8) {
    left = rect.left - popup.offsetWidth - 8;
  }

  popup.style.top = `${Math.max(8, top)}px`;
  popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - popup.offsetWidth - 8))}px`;

  // Close on outside click
  const closePopup = (e) => {
    if (!popup.contains(e.target) && !balloonElement.contains(e.target)) {
      popup.remove();
      document.removeEventListener("click", closePopup);
    }
  };

  setTimeout(() => {
    document.addEventListener("click", closePopup);
    input.focus();
  }, 0);
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

// Insert an HTML comment at the cursor, signed with the nickname + timestamp, in JSON format.
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
  const thread = [{ creator: nick, timestamp: commentTimestamp(), comment: selected }];
  const commentJson = JSON.stringify(thread);
  const insertText = `<!-- ${commentJson} -->`;
  editor.value = editor.value.slice(0, start) + insertText + editor.value.slice(end);
  // Position caret after the comment for continued editing
  const caret = start + insertText.length;
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
  if (el) el.textContent = `${words} words, ${charsWithSpaces} (${chars}) characters`;
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
    // Pandoc numbers sections itself; flag the body so the CSS section-numbering
    // counters (for the built-in renderer) don't double up.
    bodyEl.classList.toggle("pandoc", currentUsePandoc);

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

    // Rebuild the comment gutter for the freshly rendered body. This also
    // empties the gutter, clearing any ghost balloons from a prior document.
    iframe.contentWindow?.repositionComments?.();
  } catch (error) {
    previewShellReady = false;
    iframe.srcdoc = `<div style="padding:20px;color:red;font-family:sans-serif"><strong>Error rendering preview:</strong><br>${error.message || error}</div>`;
    const el = document.getElementById("preview-stats");
    if (el) el.textContent = "";
  }
}

// ===== FILE SAVE =====

// `reloadCites` re-reads the bibliography from disk and refreshes the preview so
// external changes to the citation file are picked up. Skipped for auto-save
// (which calls this on a typing debounce) to avoid re-parsing it constantly.
async function saveCurrentFile(reloadCites = false) {
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
    if (reloadCites && currentBibPath) {
      await loadCitations();
      await updatePreview();
    }
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
  document.getElementById("new-folder-btn").style.display = tab === "files" ? "" : "none";
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
    // Drop any trailing Pandoc heading attributes ({-}, {.unnumbered}, {#id}).
    if (match) {
      const attr = parseHeadingAttrs(match[2].trim());
      headers.push({
        level: match[1].length,
        text: attr.text,
        unnumbered: attr.unnumbered,
        lineIndex,
      });
    }
  });
  if (headers.length === 0) {
    const li = document.createElement("li");
    li.className = "outline-empty";
    li.textContent = "No headings found";
    list.appendChild(li);
    return;
  }
  // Hierarchical section numbers (1, 1.1, …) matching the preview; unnumbered
  // headings ({-}/{.unnumbered}) are skipped and don't affect the count.
  const counters = [0, 0, 0, 0, 0, 0];
  headers.forEach(({ level, text, lineIndex, unnumbered }) => {
    let number = "";
    if (!unnumbered) {
      counters[level - 1]++;
      for (let i = level; i < 6; i++) counters[i] = 0;
      number = counters.slice(0, level).join(".");
    }
    const display = stripMarkdown(text);
    const label = number ? `${number}  ${display}` : display;
    const li = document.createElement("li");
    li.className = `outline-item h${level}`;
    li.textContent = label;
    li.title = label;
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

    // Synchronize active globals into the active pane object
    saveActivePaneState();

    const savedPanes = panes.map((p) => {
      return {
        id: p.id,
        tabs: p.tabs.map((t) => t.path),
        activeTabPath: p.tabs.find((t) => t.id === p.activeTabId)?.path || null,
        height: panes.length >= 2 ? p.containerEl.getBoundingClientRect().height : null,
      };
    });

    await apiPost("/api/settings", {
      sidebarWidth: sidebarWidth > 0 ? sidebarWidth : null,
      editorWidth: editorWidth && editorWidth > 0 ? editorWidth : null,
      previewVisible,
      lastOpenFile: currentFilePath,
      openFiles: tabs.map((t) => t.path),
      panes: savedPanes,
      activePaneId,
    });
  } catch (_) {}
}

// ===== CITATIONS =====

const Cite = window.Cite;

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
      // citation-js caches the compiled CSL engine by template name and never
      // invalidates it when the XML changes. Registering under a fresh name
      // each time forces a new engine, so changing the CSL file in settings
      // actually takes effect in the preview (instead of reusing the first
      // style loaded this session).
      citeTemplateName = `user-csl-${++cslTemplateCounter}`;
      Cite.plugins.config.get("@csl").templates.add(citeTemplateName, cslResult.content);
    } catch (e) {
      console.warn("Failed to load CSL style:", e);
      showStatus("Warning: could not load CSL style — using default (APA)");
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
    smartQuotes: currentSmartQuotes,
    bibPath: currentBibPath,
    cslPath: currentCslPath,
    pandocRefDocPath: currentPandocRefDocPath,
    proofreadProvider: currentProofreadProvider,
    ollamaUrl: currentOllamaUrl,
    ollamaModel: currentOllamaModel,
  };
  document.getElementById("vault-path-display").textContent = currentVaultPath;
  document.getElementById("css-editor").value = currentUserCss;
  document.getElementById("spell-check-toggle").checked = currentSpellCheck;
  document.getElementById("use-pandoc-toggle").checked = currentUsePandoc;
  document.getElementById("auto-save-toggle").checked = currentAutoSave;
  document.getElementById("smart-quotes-toggle").checked = currentSmartQuotes;
  document.getElementById("bib-path-display").textContent = currentBibPath || "None selected";
  document.getElementById("csl-path-display").textContent =
    currentCslPath || "None selected (defaults to APA)";
  document.getElementById("pandoc-ref-doc-display").textContent =
    currentPandocRefDocPath || "None selected";
  document.getElementById("nickname-input").value = currentUserNickname;
  document.getElementById("gemini-key-input").value = currentGeminiKey;
  document.getElementById("gemini-model-input").value = currentGeminiModel;
  document.getElementById("proofread-provider-select").value = currentProofreadProvider;
  document.getElementById("ollama-url-input").value = currentOllamaUrl;
  document.getElementById("ollama-model-input").value = currentOllamaModel;
  updateProofreadProviderVisibility();
  document.getElementById("settings-dialog").showModal();
}

// Show only the fields relevant to the selected proofreading provider.
function updateProofreadProviderVisibility() {
  const provider = document.getElementById("proofread-provider-select").value;
  document.getElementById("gemini-settings-group").style.display =
    provider === "gemini" ? "" : "none";
  document.getElementById("ollama-settings-group").style.display =
    provider === "ollama" ? "" : "none";
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
    const newSmartQuotes = document.getElementById("smart-quotes-toggle").checked;
    const displayedPath = document.getElementById("vault-path-display").textContent;
    const newVaultPath = displayedPath !== currentVaultPath ? displayedPath : currentVaultPath;

    const bibDisplay = document.getElementById("bib-path-display").textContent;
    const newBibPath = bibDisplay && bibDisplay !== "None selected" ? bibDisplay : null;
    const cslDisplay = document.getElementById("csl-path-display").textContent;
    const newCslPath = cslDisplay && !cslDisplay.startsWith("None selected") ? cslDisplay : null;
    const pandocRefDocDisplay = document.getElementById("pandoc-ref-doc-display").textContent;
    const newPandocRefDocPath =
      pandocRefDocDisplay && pandocRefDocDisplay !== "None selected" ? pandocRefDocDisplay : null;

    const newNickname = document.getElementById("nickname-input").value.trim();
    const newGeminiKey = document.getElementById("gemini-key-input").value.trim();
    const newGeminiModel = document.getElementById("gemini-model-input").value.trim();
    const newProofreadProvider = document.getElementById("proofread-provider-select").value;
    const newOllamaUrl = document.getElementById("ollama-url-input").value.trim();
    const newOllamaModel = document.getElementById("ollama-model-input").value.trim();

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
      smartQuotes: newSmartQuotes,
      cslJsonPath: newBibPath,
      cslStylePath: newCslPath,
      pandocRefDocPath: newPandocRefDocPath,
      userNickname: newNickname,
      geminiApiKey: newGeminiKey,
      geminiModel: newGeminiModel,
      proofreadProvider: newProofreadProvider,
      ollamaUrl: newOllamaUrl,
      ollamaModel: newOllamaModel,
    });

    currentUserCss = newCss;
    currentSpellCheck = newSpellCheck;
    currentUsePandoc = newUsePandoc;
    currentAutoSave = newAutoSave;
    currentSmartQuotes = newSmartQuotes;
    currentUserNickname = newNickname;
    currentGeminiKey = newGeminiKey;
    currentGeminiModel = newGeminiModel;
    currentProofreadProvider = newProofreadProvider;
    currentOllamaUrl = newOllamaUrl;
    currentOllamaModel = newOllamaModel;
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
      await checkGitRepo();
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
  document.getElementById("smart-quotes-toggle").checked = settingsBeforeEdit.smartQuotes;

  document.getElementById("bib-path-display").textContent =
    settingsBeforeEdit.bibPath || "None selected";
  document.getElementById("csl-path-display").textContent =
    settingsBeforeEdit.cslPath || "None selected (defaults to APA)";
  closeSettingsDialog();
}

// ===== SUGGEST TAGS =====

// Ask the AI provider which existing vault tags fit the open document, then
// append the new ones (as #tags) on a fresh line at the bottom of the document.
async function runSuggestTags() {
  if (!currentFilePath) {
    showStatus("Open a file to suggest tags", true);
    return;
  }
  const editor = document.getElementById("editor");
  const text = editor.value;
  if (!text.trim()) {
    showStatus("Nothing to analyse", true);
    return;
  }

  // Existing tags across the vault (canonical spellings from the link index).
  const existingTags = Object.values(tagIndexCache).map((t) => t.name);
  if (existingTags.length === 0) {
    showStatus("No existing tags in the vault to choose from", true);
    return;
  }

  const btn = document.getElementById("suggest-tags-btn");
  btn.disabled = true;
  showStatus("Suggesting tags…");
  try {
    const res = await apiPost("/api/suggest-tags", { text, existing_tags: existingTags });
    if (res.warning) showStatus(res.warning);

    // Skip tags already present in the document.
    const lower = text.toLowerCase();
    const newTags = (res.tags || []).filter(
      (t) => !new RegExp(`(^|[^\\w&#])#${escapeRegExp(t)}\\b`, "i").test(lower),
    );

    if (newTags.length === 0) {
      showStatus("No new tag suggestions");
      return;
    }

    const line = newTags.map((t) => `#${t}`).join(" ");
    const needsBlank = text.length > 0 && !text.endsWith("\n");
    const insert = (needsBlank ? "\n\n" : text.endsWith("\n\n") ? "" : "\n") + line + "\n";
    const pos = editor.value.length;
    editorReplace(editor, pos, pos, insert); // undoable; triggers preview/dirty
    showStatus(`Added tags: ${newTags.map((t) => `#${t}`).join(" ")}`);
  } catch (err) {
    showStatus(`Suggest tags failed: ${err.message || err}`, true);
  } finally {
    btn.disabled = false;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

    // Non-fatal notice (e.g. Ollama not running → fell back to Gemini). Shown
    // unobtrusively in the status bar; the suggestions still render normally.
    if (res.warning) showStatus(res.warning);

    // Preferred path: structured suggestions ({ original, suggestion, comment }).
    // Each item is clickable and highlights its source passage in the editor.
    if (Array.isArray(res.suggestions)) {
      if (res.suggestions.length === 0) {
        list.innerHTML =
          "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found — excellent work!</li>";
      } else {
        for (const item of res.suggestions) {
          list.appendChild(buildSuggestionItem(item));
        }
      }
      loading.style.display = "none";
      suggestions.style.display = "";
      return;
    }

    // Legacy fallback: model returned a markdown bulleted list as plain text.
    const suggestionsText = res.result || "";

    // Gemini returns markdown bulleted list. Render it as HTML.
    if (!suggestionsText.trim()) {
      list.innerHTML =
        "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found — excellent work!</li>";
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
        list.innerHTML =
          "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found.</li>";
      }
    } else {
      // Fallback if marked isn't loaded: treat as plain text bullets.
      const lines = suggestionsText.split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        list.innerHTML =
          "<li style='color: var(--text-secondary); padding: 16px;'>No suggestions found.</li>";
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

// Build a clickable suggestion <li> from a structured proofread item. The exact
// source passage and its replacement are stashed in the dataset so a click can
// locate it (highlight) and the Apply button can swap it in.
function buildSuggestionItem(item) {
  const li = document.createElement("li");
  li.className = "proofread-item";
  if (item.original) li.dataset.original = item.original;
  if (item.suggestion != null) li.dataset.suggestion = item.suggestion;
  const comment = item.comment || item.suggestion || "";
  let html = `<div class="proofread-comment">${escapeHtml(comment)}</div>`;
  if (item.original || item.suggestion) {
    html +=
      `<div class="proofread-change">` +
      `<span class="proofread-original">${escapeHtml(item.original || "")}</span>` +
      ` → <span class="proofread-suggestion">${escapeHtml(item.suggestion || "")}</span>` +
      `</div>`;
  }
  // Apply button — replaces the original passage with the suggestion. Only shown
  // when there's an actual change to make.
  if (item.original && item.suggestion != null && item.suggestion !== item.original) {
    html +=
      `<div class="proofread-actions">` +
      `<button type="button" class="proofread-apply">Apply</button>` +
      `</div>`;
  }
  li.innerHTML = html;
  return li;
}

// Locate a proofread snippet in the editor, returning a {start, end} range in
// full-document offsets, or null if not found. Searches only within the region
// that was proofread (proofreadRange) so offsets map back correctly.
function findProofreadSnippetRange(snippet) {
  if (!snippet) return null;
  const editor = document.getElementById("editor");
  const range = proofreadRange || { start: 0, end: editor.value.length };
  const haystack = editor.value.slice(range.start, range.end);

  let idx = haystack.indexOf(snippet);
  let len = snippet.length;
  if (idx === -1) {
    // Fall back to a whitespace-normalised, case-insensitive match: collapse
    // runs of whitespace in both sides and map the hit back to a real range.
    const norm = (s) => s.replace(/\s+/g, " ");
    const normHay = norm(haystack).toLowerCase();
    const normSnip = norm(snippet).trim().toLowerCase();
    const ni = normSnip ? normHay.indexOf(normSnip) : -1;
    if (ni !== -1) {
      // Walk the original text counting normalised characters to recover offsets.
      const map = mapNormalizedToOriginal(haystack);
      idx = map[ni] ?? -1;
      const endNorm = ni + normSnip.length - 1;
      const endOrig = map[endNorm] ?? -1;
      if (idx !== -1 && endOrig !== -1) len = endOrig - idx + 1;
    }
  }
  if (idx === -1) return null;
  return { start: range.start + idx, end: range.start + idx + len };
}

// Select and scroll to a passage in the editor.
function highlightProofreadSnippet(snippet, li) {
  const r = findProofreadSnippetRange(snippet);
  if (!r) {
    showStatus("Couldn't locate that passage in the editor", true);
    return;
  }
  const editor = document.getElementById("editor");
  editor.focus();
  editor.setSelectionRange(r.start, r.end);
  editor.scrollTop = editor.scrollHeight * (r.start / Math.max(1, editor.value.length));

  // Mark the clicked item active for visual feedback.
  document
    .querySelectorAll("#proofread-list li.active")
    .forEach((el) => el.classList.remove("active"));
  if (li) li.classList.add("active");
}

// Replace the original passage with the suggested text in the editor. The user
// triggers this explicitly via the Apply button, so they stay in control.
function applyProofreadSuggestion(li) {
  const original = li.dataset.original;
  const suggestion = li.dataset.suggestion;
  if (original == null || suggestion == null) return;
  const r = findProofreadSnippetRange(original);
  if (!r) {
    showStatus("Couldn't locate that passage in the editor", true);
    return;
  }
  const editor = document.getElementById("editor");
  editorReplace(editor, r.start, r.end, suggestion);
  // The document length changed; shift the proofread window's end so later
  // lookups still search the right region.
  if (proofreadRange) proofreadRange.end += suggestion.length - (r.end - r.start);
  // Keep the new text selected and visible.
  editor.setSelectionRange(r.start, r.start + suggestion.length);
  editor.scrollTop = editor.scrollHeight * (r.start / Math.max(1, editor.value.length));

  // Mark this suggestion as applied so it's clearly done and can't double-apply.
  li.classList.add("applied");
  li.classList.remove("active");
  const btn = li.querySelector(".proofread-apply");
  if (btn) {
    btn.textContent = "Applied";
    btn.disabled = true;
  }
}

// Build an index mapping each character position in the whitespace-normalised
// form of `text` back to its position in the original string.
function mapNormalizedToOriginal(text) {
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const isSpace = /\s/.test(text[i]);
    if (isSpace) {
      if (prevSpace) continue; // collapsed run — skip
      map.push(i);
      prevSpace = true;
    } else {
      map.push(i);
      prevSpace = false;
    }
  }
  return map;
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

// ===== GIT AUTO-SYNC =====

// Detect whether the current vault is a git repo and (re)arm the periodic
// commit timer. Called at startup and whenever the vault changes.
async function checkGitRepo() {
  if (gitAutoCommitTimer) {
    clearInterval(gitAutoCommitTimer);
    gitAutoCommitTimer = null;
  }
  vaultIsGitRepo = false;
  gitAuthErrorShown = false;
  try {
    const info = await apiFetch("/api/git-info");
    vaultIsGitRepo = !!info.is_repo;
  } catch {
    vaultIsGitRepo = false;
  }
  if (vaultIsGitRepo) {
    // Commit any changes once an hour as well as on focus loss.
    gitAutoCommitTimer = setInterval(maybeGitCommit, 60 * 60 * 1000);
  }
}

// When the editor loses focus, persist any pending edit first, then commit so
// the just-finished change is captured per "commit when a file loses focus".
async function onEditorBlurCommit() {
  if (!vaultIsGitRepo) return;
  if (isDirty) {
    clearTimeout(autoSaveDebounceTimer);
    await saveCurrentFile();
  }
  maybeGitCommit();
}

// Commit + push all vault changes. Safe to call freely: it no-ops when the
// vault isn't a repo, nothing changed, or a commit is already running.
async function maybeGitCommit() {
  if (!vaultIsGitRepo || gitCommitInFlight) return;
  gitCommitInFlight = true;
  try {
    const res = await apiPost("/api/git-commit", {});
    handleGitResult(res);
  } catch (err) {
    console.warn("Git commit failed:", err);
  } finally {
    gitCommitInFlight = false;
  }
}

// Act on a git result returned by /api/git-commit or by rename/move endpoints.
function handleGitResult(res) {
  if (!res || !res.is_repo) return;
  if (res.committed && res.pushed) {
    showStatus(`Git: ${res.message || "changes pushed"}`);
  } else if (res.committed && res.needs_auth) {
    promptGitAuth(res.error);
  } else if (res.committed && res.reason === "no-remote") {
    showStatus("Git: committed locally (no remote configured)");
  }
}

// Push failed — almost always missing credentials. Tell the user to fix it in a
// terminal, but only once per session so we don't nag on every commit.
function promptGitAuth(error) {
  console.warn("Git push failed:", error);
  if (gitAuthErrorShown) return;
  gitAuthErrorShown = true;
  showStatus(
    "Git push failed — set up your remote/credentials in a terminal (try `git push`).",
    true,
  );
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
  editorSearchIndex =
    (editorSearchIndex - 1 + editorSearchMatches.length) % editorSearchMatches.length;
  updateEditorSearchDisplay();
}

function handleEditorSearchKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    // First time: perform the search. Subsequent times: navigate.
    if (
      editorSearchMatches.length === 0 &&
      document.getElementById("editor-search-input").value.trim()
    ) {
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

// Ctrl/Cmd-click on a token in the editor: if it's a URL, open it. The click
// has already moved the caret, so editor.selectionStart marks where the user
// clicked; we grow out to the surrounding whitespace-delimited token. (On macOS
// Ctrl-click is intercepted by the OS as a right-click, so Cmd-click is the
// reliable gesture there.)
function onEditorModifierClick(e) {
  if (!(e.ctrlKey || e.metaKey)) return;
  const editor = e.currentTarget;
  const value = editor.value;
  const pos = editor.selectionStart;
  let start = pos;
  let end = pos;
  while (start > 0 && !/\s/.test(value[start - 1])) start--;
  while (end < value.length && !/\s/.test(value[end])) end++;
  const url = extractUrlFromToken(value.slice(start, end));
  if (url) {
    e.preventDefault();
    openExternalUrl(url);
  }
}

// Pull a URL out of a whitespace-delimited token, returning it or null. Handles
// a markdown link `[text](url)` and a URL wrapped in (), [] or <> (e.g. an
// autolink or a parenthesised aside), plus trailing sentence punctuation.
function extractUrlFromToken(token) {
  let s = token.trim();
  if (!s) return null;
  const md = s.match(/\]\(([^()\s]+)\)/); // [text](url)
  if (md) s = md[1];
  s = s.replace(/^[<([]+/, "").replace(/[>)\].,;:!?'"]+$/, "");
  // Undo markdown backslash-escapes (e.g. a Zotero link's "page=7\&annotation").
  s = s.replace(/\\(.)/g, "$1");
  // Accept any scheme://… (http, zotero, file, obsidian, …) or mailto:.
  return /^([a-z][a-z0-9+.-]*:\/\/|mailto:)\S+$/i.test(s) ? s : null;
}

// Open a URL/app-protocol link with the OS. In the packaged native window links
// can't spawn a browser tab, so hand them to the pywebview bridge; in a real
// browser, fall back to window.open / an anchor click for custom schemes.
function openExternalUrl(href) {
  if (!href) return;
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
}

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

// ===== HELP =====

async function openHelpDialog() {
  const dialog = document.getElementById("help-dialog");
  const content = document.getElementById("help-content");

  try {
    const response = await fetch("/help.md");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const markdown = await response.text();
    // Use renderMarkdownBody to get proper processing of superscript, subscript, etc.
    const html = renderMarkdownBody(markdown);
    content.innerHTML = html;
    dialog.showModal();

    // Wire up anchor links inside the dialog to scroll to headings.
    // Important: scroll within the content container only, don't affect window scroll.
    content.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const targetId = link.getAttribute("href").slice(1);
        const target = content.querySelector(`#${CSS.escape(targetId)}`);
        if (target) {
          // Scroll within the content container, not the window
          const offset = target.offsetTop - content.offsetTop;
          content.scrollTo({ top: offset, behavior: "smooth" });
        }
      });
    });
  } catch (error) {
    showStatus(`Failed to load help: ${error.message || error}`, true);
  }
}

function closeHelpDialog() {
  const dialog = document.getElementById("help-dialog");
  dialog.close();
}

// ===== MAIN =====

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(initialize, 100);
});
