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
let isDirty = false;
let isInitialized = false;
let editingBlockId = null;
let blockIdCounter = 0;
let activeSidebarTab = "files";
let autoSaveTimer = null;
let fileTreeCache = [];

// ===== INITIALIZATION =====

async function initialize() {
  try {
    if (!invoke) throw new Error("Tauri invoke not available");

    currentPlatform = await invoke("get_platform");
    document.body.dataset.platform = currentPlatform;

    const settings = await invoke("get_settings");
    currentUserCss = settings.userCss || settings.user_css || "";
    currentSpellCheck = settings.spellCheck ?? settings.spell_check ?? true;
    applyUserCss(currentUserCss);

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

    isInitialized = true;

    const lastOpenFile = settings.lastOpenFile || settings.last_open_file;
    if (lastOpenFile) {
      await loadFile(lastOpenFile).catch(() => {});
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

  // Click on empty area below blocks → activate last block
  document.getElementById("blocks-editor").addEventListener("click", e => {
    if (e.target === document.getElementById("blocks-editor") && currentFilePath) {
      const blocks = document.querySelectorAll(".block");
      if (blocks.length > 0) activateBlock(blocks[blocks.length - 1]);
    }
  });

  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveCurrentFile();
    }
  });
}

function startDrag(handle, startX, onDrag, onEnd) {
  handle.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function onMove(e) { onDrag(e.clientX - startX); }
  function onUp() {
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
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
  const handle = document.getElementById("sidebar-resize");
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    const startWidth = sidebar.getBoundingClientRect().width;
    startDrag(handle, e.clientX, dx => {
      const newWidth = Math.max(160, Math.min(480, startWidth + dx));
      sidebar.style.flex = `0 0 ${newWidth}px`;
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
      label.innerHTML = `<span class="tree-icon">▸</span><span>${node.name}</span>`;
      const nested = document.createElement("ul");
      nested.dataset.path = node.path;
      label.addEventListener("click", async e => {
        e.stopPropagation();
        const isCollapsed = li.classList.contains("collapsed");
        li.classList.toggle("collapsed");
        label.querySelector(".tree-icon").textContent = isCollapsed ? "▾" : "▸";
        if (isCollapsed && !nested.dataset.loaded) {
          const children = await invoke("list_dir", { dirPath: node.path });
          renderFileTree(children, nested);
          nested.dataset.loaded = "true";
        }
      });
      li.appendChild(label);
      li.appendChild(nested);
    } else {
      li.className = "file-item";
      li.dataset.path = node.path;
      li.textContent = node.name;
      li.addEventListener("click", () => loadFile(node.path));
    }
    container.appendChild(li);
  });

  if (currentFilePath) {
    document.querySelectorAll(".file-item").forEach(item => {
      item.classList.toggle("active", item.dataset.path === currentFilePath);
    });
  }
}

function closeFile() {
  currentFilePath = null;
  isDirty = false;
  editingBlockId = null;
  const filenameEl = document.getElementById("editor-filename");
  if (filenameEl) filenameEl.textContent = "No file open";
  document.getElementById("note-tags").innerHTML = "";
  document.getElementById("blocks-editor").innerHTML =
    '<p class="no-file-msg">Select a file to start editing...</p>';
  buildOutline();
  buildLinksPanel();
  saveUiState();
}

async function loadFile(path) {
  try {
    const content = await invoke("read_file", { filePath: path });
    currentFilePath = path;
    isDirty = false;
    editingBlockId = null;

    const filenameEl = document.getElementById("editor-filename");
    if (filenameEl) filenameEl.textContent = path.split("/").pop();

    await revealFileInTree(path);
    document.querySelectorAll(".file-item").forEach(item => {
      item.classList.toggle("active", item.dataset.path === path);
    });

    const blocks = parseBlocks(content);
    await renderAllBlocks(blocks);

    await updateTagsBar(path);
    buildLinksPanel();
    buildOutline();

    if (currentPlatform === "ios") switchTab("editor");
    showStatus(`Opened: ${path.split("/").pop()}`);
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

// ===== BLOCK PARSING =====

function parseBlocks(markdown) {
  if (!markdown || !markdown.trim()) return [];
  const lines = markdown.split("\n");
  const result = [];
  let i = 0;
  let current = [];
  let inFence = false;

  // Preserve YAML front matter as a single block
  if (lines[0] && lines[0].trim() === "---") {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== "---") j++;
    if (j < lines.length) {
      result.push(lines.slice(0, j + 1).join("\n"));
      i = j + 1;
      while (i < lines.length && lines[i].trim() === "") i++;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.match(/^(`{3,}|~{3,})/)) {
      inFence = !inFence;
      current.push(line);
    } else if (!inFence && trimmed === "") {
      if (current.length > 0) {
        result.push(current.join("\n"));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) result.push(current.join("\n"));
  return result;
}

function getEditorContent() {
  const blocks = document.querySelectorAll("#blocks-editor .block");
  return Array.from(blocks)
    .map(b => b.dataset.markdown || "")
    .filter(m => m.trim() !== "")
    .join("\n\n");
}

// ===== BLOCK RENDERING =====

// Extract all reference-style footnote definitions from a markdown string.
// Returns a string of "[^id]: ..." lines (including indented continuations)
// that can be appended to any block so comrak can resolve cross-block references.
function extractFootnoteDefs(markdown) {
  const lines = markdown.split("\n");
  const defs = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\[\^[^\]]+\]:/.test(lines[i])) {
      defs.push(lines[i]);
      i++;
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        defs.push(lines[i]);
        i++;
      }
    } else {
      i++;
    }
  }
  return defs.join("\n");
}

async function renderAllBlocks(markdownBlocks) {
  const container = document.getElementById("blocks-editor");
  container.innerHTML = "";
  if (!markdownBlocks || markdownBlocks.length === 0) {
    container.appendChild(createBlockElement(""));
    return;
  }
  const footnoteDefs = extractFootnoteDefs(markdownBlocks.join("\n\n"));
  const els = markdownBlocks.map(md => {
    const el = createBlockElement(md);
    container.appendChild(el);
    return el;
  });
  await Promise.all(els.map(el => renderBlockEl(el, footnoteDefs)));
  consolidateFootnotes();
}

function createBlockElement(markdown) {
  const div = document.createElement("div");
  div.className = "block";
  div.dataset.markdown = markdown;
  div.dataset.id = `blk-${++blockIdCounter}`;
  div.addEventListener("click", e => {
    if (e.target.tagName !== "A" && !div.classList.contains("editing")) {
      activateBlock(div);
    }
  });
  return div;
}

async function renderBlockEl(blockEl, footnoteDefs = "") {
  const markdown = blockEl.dataset.markdown || "";
  blockEl.classList.remove("rendered", "editing", "block-frontmatter");
  blockEl.innerHTML = "";

  if (!markdown.trim()) {
    blockEl.classList.add("rendered");
    return;
  }

  // Front matter block: render as preformatted text
  if (markdown.trim().startsWith("---")) {
    const lines = markdown.trim().split("\n");
    const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (closeIdx > 0) {
      blockEl.classList.add("rendered", "block-frontmatter");
      const pre = document.createElement("pre");
      pre.textContent = markdown;
      blockEl.appendChild(pre);
      return;
    }
  }

  // Append footnote definitions from the rest of the document so comrak can
  // resolve [^id] references that live in a different block.
  const markdownToRender = footnoteDefs
    ? markdown + "\n\n" + footnoteDefs
    : markdown;

  try {
    const html = await invoke("render_block", {
      markdown: markdownToRender,
      filePath: currentFilePath || null,
    });
    blockEl.innerHTML = html;
    blockEl.classList.add("rendered");

    // Wire up all links to internal navigation
    blockEl.querySelectorAll("a").forEach(a => {
      a.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        handleLinkClick(a.getAttribute("href") || "");
      });
    });
  } catch (err) {
    blockEl.textContent = markdown;
    blockEl.classList.add("rendered");
  }
}

function handleLinkClick(href) {
  if (!href) return;
  if (href.startsWith("http://") || href.startsWith("https://")) {
    // Open external URLs via Tauri opener plugin
    invoke("plugin:opener|open_url", { url: href }).catch(() => {});
  } else {
    const stem = href.replace(/^\.\//, "").replace(/\.md$/, "");
    const path = findNoteByName(stem);
    if (path) loadFile(path);
    else showStatus(`Note not found: ${stem}`);
  }
}

// ===== BLOCK ACTIVATION / EDITING =====

async function activateBlock(blockEl) {
  if (blockEl.dataset.id === editingBlockId) return;

  // Save whatever was previously being edited
  if (editingBlockId) {
    const cur = document.querySelector(`[data-id="${editingBlockId}"]`);
    if (cur) await saveBlock(cur, false);
  }

  editingBlockId = blockEl.dataset.id;
  const markdown = blockEl.dataset.markdown || "";

  blockEl.classList.remove("rendered", "block-frontmatter");
  blockEl.classList.add("editing");
  blockEl.innerHTML = "";

  const ta = document.createElement("textarea");
  ta.className = "block-textarea";
  ta.value = markdown;
  ta.spellcheck = currentSpellCheck;

  function autoResize() {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  ta.addEventListener("input", () => {
    autoResize();
    blockEl.dataset.markdown = ta.value;
    isDirty = true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(saveCurrentFile, 800);
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  });

  ta.addEventListener("blur", async () => {
    if (editingBlockId === blockEl.dataset.id) {
      await saveBlock(blockEl, true);
    }
  });

  ta.addEventListener("keydown", e => handleBlockKeydown(e, blockEl, ta));

  blockEl.appendChild(ta);
  blockEl.scrollIntoView({ block: "nearest" });

  requestAnimationFrame(() => {
    autoResize();
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  });
}

async function saveBlock(blockEl, triggerFileSave) {
  const ta = blockEl.querySelector("textarea");
  if (!ta) return;
  editingBlockId = null;

  const newMarkdown = ta.value;
  const container = blockEl.parentElement;
  const nextSibling = blockEl.nextSibling;

  blockEl.classList.remove("editing");
  blockEl.innerHTML = "";

  const subBlocks = parseBlocks(newMarkdown);

  // Compute footnote definitions from the full document for cross-block resolution.
  // Do this after updating dataset.markdown so the current block's content is included.
  if (!newMarkdown.trim()) {
    const allBlocks = container?.querySelectorAll(".block");
    if (allBlocks && allBlocks.length > 1) {
      blockEl.remove();
    } else {
      blockEl.dataset.markdown = "";
      blockEl.classList.add("rendered");
    }
  } else if (subBlocks.length > 1) {
    // Blank lines within editing split the block
    blockEl.remove();
    const newEls = subBlocks.map(md => createBlockElement(md));
    for (const el of [...newEls].reverse()) {
      container.insertBefore(el, nextSibling);
    }
    const footnoteDefs = extractFootnoteDefs(getEditorContent());
    await Promise.all(newEls.map(el => renderBlockEl(el, footnoteDefs)));
  } else {
    blockEl.dataset.markdown = newMarkdown;
    const footnoteDefs = extractFootnoteDefs(getEditorContent());
    await renderBlockEl(blockEl, footnoteDefs);
  }

  if (triggerFileSave) {
    consolidateFootnotes();
    saveCurrentFile();
    if (activeSidebarTab === "outline") buildOutline();
    if (activeSidebarTab === "links") buildLinksPanel();
  }
}

function handleBlockKeydown(e, blockEl, ta) {
  const isMeta = e.metaKey || e.ctrlKey;

  if (isMeta && e.key === "b") { e.preventDefault(); wrapInTextarea(ta, "**", "**"); return; }
  if (isMeta && e.key === "i") { e.preventDefault(); wrapInTextarea(ta, "_", "_"); return; }
  if (isMeta && e.key === "1") { e.preventDefault(); prefixInTextarea(ta, "# "); return; }
  if (isMeta && e.key === "2") { e.preventDefault(); prefixInTextarea(ta, "## "); return; }
  if (isMeta && e.key === "3") { e.preventDefault(); prefixInTextarea(ta, "### "); return; }
  if (isMeta && e.key === "s") { e.preventDefault(); saveCurrentFile(); return; }

  if (e.key === "Escape") { ta.blur(); return; }

  // Backspace on completely empty textarea: remove block, focus previous
  if (e.key === "Backspace" && ta.value === "") {
    e.preventDefault();
    const prev = blockEl.previousElementSibling;
    editingBlockId = null;
    blockEl.classList.remove("editing");
    blockEl.innerHTML = "";
    const allBlocks = document.querySelectorAll(".block");
    if (allBlocks.length > 1) blockEl.remove();
    if (prev) activateBlock(prev);
    saveCurrentFile();
    return;
  }

  // Arrow navigation across block boundaries
  if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
    const prev = blockEl.previousElementSibling;
    if (prev) { e.preventDefault(); activateBlock(prev); }
    return;
  }
  if (e.key === "ArrowDown" && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
    const next = blockEl.nextElementSibling;
    if (next) {
      e.preventDefault();
      activateBlock(next);
    } else if (currentFilePath) {
      e.preventDefault();
      const newEl = createBlockElement("");
      document.getElementById("blocks-editor").appendChild(newEl);
      activateBlock(newEl);
    }
  }
}

function wrapInTextarea(ta, before, after) {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.substring(start, end);
  if (!selected) {
    ta.value = ta.value.substring(0, start) + before + after + ta.value.substring(end);
    ta.selectionStart = ta.selectionEnd = start + before.length;
  } else {
    ta.value = ta.value.substring(0, start) + before + selected + after + ta.value.substring(end);
    ta.selectionStart = start;
    ta.selectionEnd = start + before.length + selected.length;
  }
  ta.dispatchEvent(new Event("input"));
}

function prefixInTextarea(ta, prefix) {
  const start = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = ta.value.indexOf("\n", lineStart);
  const currentLine = ta.value.substring(lineStart, lineEnd === -1 ? ta.value.length : lineEnd);
  const trimmed = currentLine.replace(/^#+\s/, "");
  ta.value = ta.value.substring(0, lineStart) + prefix + trimmed + ta.value.substring(lineStart + currentLine.length);
  ta.dispatchEvent(new Event("input"));
}

// ===== FILE SAVE =====

async function saveCurrentFile() {
  if (!currentFilePath || !isDirty) return;
  try {
    const content = getEditorContent();
    await invoke("write_file", { filePath: currentFilePath, content });
    isDirty = false;
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

function buildOutline() {
  const list = document.getElementById("outline-list");
  list.innerHTML = "";

  const blockEls = document.querySelectorAll("#blocks-editor .block");
  if (!currentFilePath || blockEls.length === 0) {
    const li = document.createElement("li");
    li.className = "outline-empty";
    li.textContent = currentFilePath ? "No headings found" : "No file open";
    list.appendChild(li);
    return;
  }

  const headers = [];
  blockEls.forEach(blockEl => {
    const markdown = blockEl.dataset.markdown || "";
    const firstLine = markdown.split("\n")[0];
    const match = firstLine.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headers.push({ level: match[1].length, text: match[2].trim(), blockId: blockEl.dataset.id });
    }
  });

  if (headers.length === 0) {
    const li = document.createElement("li");
    li.className = "outline-empty";
    li.textContent = "No headings found";
    list.appendChild(li);
    return;
  }

  headers.forEach(({ level, text, blockId }) => {
    const display = stripMarkdown(text);
    const li = document.createElement("li");
    li.className = `outline-item h${level}`;
    li.textContent = display;
    li.title = display;
    li.addEventListener("click", () => {
      const blockEl = document.querySelector(`[data-id="${blockId}"]`);
      if (blockEl) {
        blockEl.scrollIntoView({ behavior: "smooth", block: "start" });
        activateBlock(blockEl);
      }
    });
    list.appendChild(li);
  });
}

// ===== FOOTNOTE CONSOLIDATION =====

function consolidateFootnotes() {
  const container = document.getElementById("blocks-editor");

  // Remove any previously consolidated section
  document.getElementById("footnotes-section")?.remove();

  let globalN = 0;
  const collectedDefs = [];

  // Walk every rendered block in DOM order
  container.querySelectorAll(".block.rendered").forEach(block => {
    const section = block.querySelector("section.footnotes");
    if (!section) return;

    // For each inline superscript reference in this block, assign the next
    // global number and update both the ref and its matching definition.
    block.querySelectorAll("sup.footnote-ref a").forEach(refA => {
      globalN++;
      const oldFnId  = (refA.getAttribute("href") || "").slice(1); // "fn1"
      const oldRefId =  refA.getAttribute("id")   || "";           // "fnref1"

      // Update inline reference
      refA.setAttribute("href", `#fn${globalN}`);
      refA.setAttribute("id",   `fnref${globalN}`);
      refA.textContent = `[${globalN}]`;

      // Find matching definition and update its IDs
      const def = section.querySelector(`li[id="${oldFnId}"]`);
      if (def) {
        def.setAttribute("id", `fn${globalN}`);
        const backLink = def.querySelector(`a[href="#${oldRefId}"]`);
        if (backLink) backLink.setAttribute("href", `#fnref${globalN}`);
        collectedDefs.push(def.cloneNode(true));
      }
    });

    section.remove();
  });

  if (collectedDefs.length === 0) return;

  // Build a single footnotes block at the end
  const wrapper = document.createElement("div");
  wrapper.id = "footnotes-section";
  wrapper.className = "block rendered";  // inherits prose + user CSS

  const sec = document.createElement("section");
  sec.className = "footnotes";
  const ol = document.createElement("ol");
  collectedDefs.forEach(li => ol.appendChild(li));
  sec.appendChild(ol);
  wrapper.appendChild(sec);
  container.appendChild(wrapper);
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

  const content = getEditorContent();
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
}

async function saveUiState() {
  if (!isInitialized || currentPlatform === "ios") return;
  try {
    const sidebarWidth = document.getElementById("sidebar").getBoundingClientRect().width;
    await invoke("save_ui_state", {
      sidebarWidth: sidebarWidth > 0 ? sidebarWidth : null,
      editorWidth: null,
      previewVisible: true,
      lastOpenFile: currentFilePath,
    });
  } catch (_) {}
}

function scopeUserCss(css) {
  if (!css) return "";
  // Prefix each rule's selector with the blocks container scope.
  // Handles simple rules; skips @-rules (media, keyframes, etc.).
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector, rules) => {
    const trimmed = selector.trim();
    if (!trimmed || trimmed.startsWith("@")) return match;
    const scoped = trimmed
      .split(",")
      .map(s => {
        const t = s.trim();
        if (!t) return "";
        if (t === "body") return "#blocks-editor .block.rendered";
        return `#blocks-editor .block.rendered ${t}`;
      })
      .filter(Boolean)
      .join(", ");
    return `${scoped} { ${rules} }`;
  });
}

function applyUserCss(css) {
  let styleEl = document.getElementById("user-custom-css");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "user-custom-css";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = scopeUserCss(css);
}

// ===== SETTINGS =====

let settingsBeforeEdit = { vaultPath: null, userCss: "", spellCheck: true };

function openSettingsDialog() {
  settingsBeforeEdit = { vaultPath: currentVaultPath, userCss: currentUserCss, spellCheck: currentSpellCheck };
  document.getElementById("vault-path-display").textContent = currentVaultPath;
  document.getElementById("css-editor").value = currentUserCss;
  document.getElementById("spell-check-toggle").checked = currentSpellCheck;
  document.getElementById("settings-dialog").showModal();
}

function closeSettingsDialog() {
  document.getElementById("settings-dialog").close();
}

async function saveSettings() {
  try {
    const newCss = document.getElementById("css-editor").value;
    const newSpellCheck = document.getElementById("spell-check-toggle").checked;
    let newVaultPath = currentVaultPath;
    const displayedPath = document.getElementById("vault-path-display").textContent;
    if (displayedPath !== currentVaultPath) newVaultPath = displayedPath;

    try {
      await invoke("list_vault", { vaultPath: newVaultPath });
    } catch {
      showStatus(`Invalid vault path: ${newVaultPath}`);
      return;
    }

    await invoke("save_settings", { vaultPath: newVaultPath, userCss: newCss, spellCheck: newSpellCheck });
    currentUserCss = newCss;
    currentSpellCheck = newSpellCheck;
    applyUserCss(newCss);
    document.querySelectorAll(".block-textarea").forEach(ta => { ta.spellcheck = newSpellCheck; });

    if (newVaultPath !== currentVaultPath) {
      currentVaultPath = newVaultPath;
      currentFilePath = null;
      closeFile();
      await refreshFileTree();
      await buildLinkIndex();
      showStatus(`Vault changed to: ${newVaultPath}`);
    } else {
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

// ===== iOS TABS =====

function switchTab(tabName) {
  if (currentPlatform !== "ios") return;
  document.getElementById("sidebar").classList.remove("active");
  document.getElementById("editor-pane").classList.remove("active");
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  switch (tabName) {
    case "files": document.getElementById("sidebar").classList.add("active"); break;
    case "editor": document.getElementById("editor-pane").classList.add("active"); break;
  }
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add("active");
}

// ===== UI HELPERS =====

function showStatus(message) {
  console.log(`Status: ${message}`);
  const statusBar = document.getElementById("status-bar");
  const statusMessage = document.getElementById("status-message");
  if (statusBar && statusMessage) {
    statusMessage.textContent = message;
    statusBar.classList.add("visible");
    setTimeout(() => statusBar.classList.remove("visible"), 3000);
  }
}

// ===== MAIN =====

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(initialize, 100);
});
