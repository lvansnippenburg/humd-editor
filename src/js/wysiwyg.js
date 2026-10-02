// Rich-text (WYSIWYG) editing layer, built on Milkdown (ProseMirror + remark).
//
// The pane's <textarea> stays the single source of truth: Milkdown is mounted
// over it, and every rich-text change is serialised straight back to Markdown
// and written into the textarea. The caller (app.js) then routes that through
// the textarea's normal `input` handling, so preview, dirty-tracking, autosave,
// the outline and version control keep working unchanged.
//
// The humanities syntax the app adds on top of CommonMark is taught to Milkdown
// in wysiwyg-build/src/syntax.js and survives a full round-trip:
//   ==highlight==  ->  <mark>
//   ^sup^ / ~sub~  ->  <sup> / <sub>
//   [[wikilink]]   ->  <a class="wikilink" href="file://…">  (click opens note)
//   ^[footnote]    ->  numbered marker; text shown/edited in the Links sidebar
//   #tags          ->  left as plain text (by design)
// YAML front matter is split off before Milkdown sees it and re-attached on
// write.

import { createEditor } from "/js/vendor/milkdown.bundle.js";
import { ensurePreviewStyleLoaded } from "/js/preview-style.js";

// Split leading YAML front matter from the body. `frontMatter` keeps its
// trailing newline; `frontMatter + "\n" + body` reproduces a blank-line
// separator (Milkdown's serializer would otherwise drop it).
export function splitFrontMatter(md) {
  const lines = md.split("\n");
  if (lines[0]?.trim() !== "---") return { frontMatter: "", body: md };
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      return {
        frontMatter: lines.slice(0, i + 1).join("\n") + "\n",
        body: lines
          .slice(i + 1)
          .join("\n")
          .replace(/^\n/, ""),
      };
    }
  }
  return { frontMatter: "", body: md };
}

export function isWysiwygActive(pane) {
  return !!pane._mkHandle;
}
export function isWysiwygBusy(pane) {
  return !!pane._mkBusy;
}

// Re-assert which view is showing. app.js flips `editor.style.display` on
// tab/media/graph switches; this keeps the textarea hidden behind Milkdown while
// rich-text mode is on. `visible` is false for media/graph tabs (neither shows).
export function setWysiwygViewVisible(pane, visible) {
  if (!pane || !pane._mkHandle) return;
  pane.editorEl.style.display = "none";
  if (pane._mkWrapEl) pane._mkWrapEl.style.display = visible ? "" : "none";
}

// Serialise the rich-text content back into the pane's textarea.
export function flushWysiwygToTextarea(pane) {
  if (!pane._mkHandle) return;
  const body = pane._mkHandle.getMarkdown();
  const fm = pane._mkFrontMatter || "";
  pane.editorEl.value = fm ? fm + "\n" + body : body;
}

// Push the textarea's current Markdown into the rich-text view (tab switches,
// external reloads). Guarded so the resulting change callback is ignored.
export function syncWysiwygFromTextarea(pane) {
  if (!pane._mkHandle) return;
  const { frontMatter, body } = splitFrontMatter(pane.editorEl.value);
  pane._mkFrontMatter = frontMatter;
  pane._mkHandle.setMarkdown(body, { silent: true });
  pane._mkHandle.renumberFootnotes();
}

// Mirrors the preview's `#hp-body.no-numbering` toggle (the "Number chapter
// and paragraph titles" setting, or a document's own front-matter override) so
// heading numbering matches between the two views.
export function setWysiwygNumberSections(pane, enabled) {
  const root = pane?._mkWrapEl?.querySelector(".editor");
  root?.classList.toggle("no-numbering", !enabled);
}

export function getWysiwygFootnotes(pane) {
  return pane._mkHandle ? pane._mkHandle.getFootnotes() : [];
}
export function setWysiwygFootnoteContent(pane, pos, content) {
  pane._mkHandle?.setFootnoteContent(pos, content);
}

export async function enableWysiwyg(pane, { onChange, onOpenWikilink, onFootnotesChanged }) {
  if (pane._mkHandle || pane._mkBusy) return;
  pane._mkBusy = true;
  ensurePreviewStyleLoaded(); // same visual language as the Markdown preview

  const { frontMatter, body } = splitFrontMatter(pane.editorEl.value);
  pane._mkFrontMatter = frontMatter;

  const wrap = document.createElement("div");
  wrap.className = "milkdown-wrap";
  pane.editorEl.insertAdjacentElement("afterend", wrap);
  pane.editorEl.style.display = "none";
  pane._mkWrapEl = wrap;

  try {
    const handle = await createEditor({
      root: wrap,
      value: body,
      onChange: () => {
        if (!pane._mkHandle) return; // torn down mid-flight
        flushWysiwygToTextarea(pane);
        pane._mkHandle.renumberFootnotes();
        onChange?.();
        onFootnotesChanged?.();
      },
    });

    // createEditor resolved after a possible disable() — bail cleanly.
    if (!pane._mkWrapEl) {
      await handle.destroy();
      return;
    }
    pane._mkHandle = handle;
    handle.renumberFootnotes();

    // Wikilink + footnote-marker clicks (delegated; atoms have no cursor).
    wrap.addEventListener("mousedown", (e) => {
      const wl = e.target.closest("a.wikilink");
      if (wl) {
        e.preventDefault();
        onOpenWikilink?.(wl.getAttribute("data-target") || wl.textContent || "");
        return;
      }
      const fn = e.target.closest("sup.footnote-ref");
      if (fn) {
        e.preventDefault();
        const num = parseInt(fn.getAttribute("data-num") || "0", 10);
        onFootnotesChanged?.(num); // app opens the Links panel + focuses field
      }
    });

    onFootnotesChanged?.();
  } finally {
    pane._mkBusy = false;
  }
}

export async function disableWysiwyg(pane) {
  const handle = pane._mkHandle;
  const wrap = pane._mkWrapEl;
  pane._mkHandle = null;
  pane._mkWrapEl = null;

  if (handle) {
    flushWysiwygToTextarea(pane);
    try {
      await handle.destroy();
    } catch {
      /* ignore */
    }
  }
  wrap?.remove();
  pane._mkFrontMatter = "";
  pane.editorEl.style.display = "block";
}
