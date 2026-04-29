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

    console.log("Refreshing file tree...");
    await refreshFileTree();

    // 5. Build link index for wikilinks and tags
    console.log("Building link index...");
    await buildLinkIndex();

    console.log("Initializing file watcher...");
    initializeFileWatcher();

    isInitialized = true;
    console.log("Initialization complete!");
    // Auto-expand sidebar on first launch (macOS)
    if (currentPlatform === "macos") {
      document.getElementById("sidebar").classList.add("expanded");
    }
    showStatus("Ready");
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

function showVaultPicker() {
  return new Promise((resolve) => {
    const dialog = document.getElementById("vault-picker-dialog");
    const input = document.getElementById("vault-path-input");
    const submitBtn = document.getElementById("vault-picker-submit");

    input.value = "";
    input.focus();

    const handleSubmit = () => {
      const path = input.value.trim();
      dialog.close();
      cleanupHandlers();
      resolve(path);
    };

    const handleKeyPress = (e) => {
      if (e.key === "Enter") {
        handleSubmit();
      }
    };

    const cleanupHandlers = () => {
      submitBtn.removeEventListener("click", handleSubmit);
      input.removeEventListener("keypress", handleKeyPress);
      dialog.removeEventListener("cancel", handleCancel);
    };

    const handleCancel = () => {
      cleanupHandlers();
      resolve("");
    };

    submitBtn.addEventListener("click", handleSubmit);
    input.addEventListener("keypress", handleKeyPress);
    dialog.addEventListener("cancel", handleCancel);

    dialog.showModal();
  });
}

// ===== EVENT LISTENERS =====

function setupEventListeners() {
  // Sidebar toggle (desktop)
  document
    .getElementById("sidebar-toggle")
    .addEventListener("click", toggleSidebar);

  // Editor
  const editor = document.getElementById("editor");
  editor.addEventListener("input", onEditorInput);
  editor.addEventListener("keydown", onEditorKeydown);

  // New file button
  document
    .getElementById("new-file-btn")
    .addEventListener("click", promptNewFile);

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
    .addEventListener("click", pickVaultFolder);

  // iOS tabs
  if (currentPlatform === "ios") {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => switchTab(e.target.dataset.tab));
    });
    // Default to editor tab on iOS
    switchTab("editor");
  }

  // Dialog close buttons
  const dialog = document.getElementById("settings-dialog");
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSettingsDialog();
  });
}

// ===== FILE TREE =====

async function refreshFileTree() {
  try {
    const nodes = await invoke("list_vault", { vaultPath: currentVaultPath });
    fileTreeCache = nodes;
    renderFileTree(nodes);
  } catch (error) {
    console.error("Failed to refresh file tree:", error);
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
      li.innerHTML = `
        <button class="folder-toggle" data-path="${node.path}">▶</button>
        <span class="file-item folder-icon" data-path="${node.path}">${node.name}</span>
      `;

      const toggle = li.querySelector(".folder-toggle");
      const nested = document.createElement("ul");
      nested.className = "file-tree-nested";
      nested.style.display = "none";
      nested.dataset.path = node.path;

      toggle.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (nested.style.display === "none") {
          if (!nested.dataset.loaded) {
            const children = await invoke("list_dir", { dirPath: node.path });
            renderFileTree(children, nested);
            nested.dataset.loaded = "true";
          }
          nested.style.display = "block";
          toggle.textContent = "▼";
        } else {
          nested.style.display = "none";
          toggle.textContent = "▶";
        }
      });

      container.appendChild(li);
      container.appendChild(nested);
    } else {
      // File
      li.innerHTML = `<span class="file-item file-icon" data-path="${node.path}">${node.name}</span>`;
      const fileItem = li.querySelector(".file-item");

      fileItem.addEventListener("click", () => {
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

async function loadFile(path) {
  try {
    const content = await invoke("read_file", { filePath: path });
    const editor = document.getElementById("editor");

    currentFilePath = path;
    isDirty = false;
    editor.value = content;

    // Update active state in file tree
    document.querySelectorAll(".file-item").forEach((item) => {
      if (item.dataset.path === path) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    });

    // Update preview
    await updatePreview();

    // Update backlinks panel
    await updateBacklinksPanel(path);

    // Update tags bar
    await updateTagsBar(path);

    // Collapse sidebar on mobile after selection
    if (currentPlatform === "ios") {
      switchTab("editor");
    }

    showStatus(`Opened: ${path.split("/").pop()}`);
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

  // Preview debounce (300ms)
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    updatePreview();
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

    // Refresh backlinks and tags
    await updateBacklinksPanel(currentFilePath);
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

async function updateBacklinksPanel(filePath) {
  try {
    const stem = filePath
      .split("/")
      .pop()
      .replace(/\.md$/, "");
    const backlinks = await invoke("get_backlinks", {
      vaultPath: currentVaultPath,
      noteStem: stem
    });

    const backlinksPanel = document.getElementById("backlinks-panel");
    const backlinkslist = document.getElementById("backlinks-list");

    if (!backlinks || backlinks.length === 0) {
      backlinksPanel.style.display = "none";
      return;
    }

    backlinksPanel.style.display = "block";
    backlinkslist.innerHTML = "";

    backlinks.forEach((noteStem) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.textContent = noteStem;
      a.style.cursor = "pointer";
      a.addEventListener("click", async () => {
        const path = findNoteByName(noteStem);
        if (path) {
          await loadFile(path);
        }
      });
      li.appendChild(a);
      backlinkslist.appendChild(li);
    });

    // Update summary text
    document.getElementById("backlinks-summary").textContent = `Backlinks (${backlinks.length})`;
  } catch (error) {
    console.warn("Failed to update backlinks:", error);
  }
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

// ===== SETTINGS =====

let settingsBeforeEdit = {
  vaultPath: null,
  userCss: "",
};

function openSettingsDialog() {
  const dialog = document.getElementById("settings-dialog");
  const cssEditor = document.getElementById("css-editor");

  // Store current values for cancel
  settingsBeforeEdit = {
    vaultPath: currentVaultPath,
    userCss: currentUserCss,
  };

  // Populate dialog
  document.getElementById("vault-path-display").textContent = currentVaultPath;
  cssEditor.value = currentUserCss;

  dialog.showModal();
}

function closeSettingsDialog() {
  document.getElementById("settings-dialog").close();
}

async function saveSettings() {
  try {
    const newCss = document.getElementById("css-editor").value;
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
    });

    currentUserCss = newCss;

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
  // Restore previous values
  document.getElementById("vault-path-display").textContent =
    settingsBeforeEdit.vaultPath;
  document.getElementById("css-editor").value = settingsBeforeEdit.userCss;
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
      document.getElementById("sidebar").classList.add("expanded");
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
