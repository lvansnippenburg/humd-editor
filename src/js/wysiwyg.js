// Rich-text (WYSIWYG) editing layer, built on Milkdown (ProseMirror + remark).
//
// The pane's <textarea> stays the single source of truth: Milkdown is mounted
// over it, and every rich-text change is serialised straight back to Markdown
// and written into the textarea. The caller (app.js) then routes that through
// the textarea's normal `input` handling, so dirty-tracking, autosave, the
// outline and version control keep working unchanged.
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
import { mergeEdit } from "/js/source-merge.js";

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

// Remember the Markdown source the view was loaded from and Milkdown's own
// serialisation of it (see source-merge.js), right after (re)loading.
function rememberBaseline(pane, body) {
  pane._mkSource = body;
  pane._mkBase = pane._mkHandle.getMarkdown();
}

// Write edits made in the rich-text view back into the pane's textarea. Only
// the edited blocks are taken from Milkdown; the rest keeps its exact source
// (see source-merge.js). Returns whether the textarea changed.
export function flushWysiwygToTextarea(pane) {
  if (!pane._mkHandle) return false;
  const next = pane._mkHandle.getMarkdown();
  if (next === pane._mkBase) return false; // nothing edited since the last write-back
  // Merge into the textarea's current text, so anything the app changed
  // there directly is kept too.
  const { frontMatter, body: current } = splitFrontMatter(pane.editorEl.value);
  const body = mergeEdit(current, pane._mkBase, next);
  // The next edit is compared with this state, so only it gets replaced.
  pane._mkSource = body;
  pane._mkBase = next;
  const fm = frontMatter || pane._mkFrontMatter || "";
  const value = fm ? fm + "\n" + body : body;
  if (pane.editorEl.value === value) return false;
  pane.editorEl.value = value;
  return true;
}

// Push the textarea's current Markdown into the rich-text view (tab switches,
// external reloads). Guarded so the resulting change callback is ignored.
export function syncWysiwygFromTextarea(pane) {
  if (!pane._mkHandle) return;
  const { frontMatter, body } = splitFrontMatter(pane.editorEl.value);
  pane._mkFrontMatter = frontMatter;
  pane._mkHandle.setMarkdown(body, { silent: true });
  pane._mkHandle.renumberFootnotes();
  rememberBaseline(pane, body);
}

// The "Number chapter and paragraph titles" setting (or a document's own
// front-matter override): toggles `.no-numbering`, as on the printed page.
export function setWysiwygNumberSections(pane, enabled) {
  const root = pane?._mkWrapEl?.querySelector(".editor");
  root?.classList.toggle("no-numbering", !enabled);
}

// The editing operations of the formatted view (see wysiwyg-build/src/
// editor.js), or null when it isn't showing.
export function getWysiwygHandle(pane) {
  return pane?._mkHandle || null;
}

// The element holding the formatted document (headings, paragraphs, …).
export function getWysiwygRoot(pane) {
  return pane?._mkWrapEl?.querySelector(".editor") || null;
}

// Show HTML comments (<!-- … -->, used for review comments) as a small
// marker with the comment text as tooltip, instead of the raw markup.
function commentTooltip(value) {
  const inner = value.replace(/^<!--\s*/, "").replace(/\s*-->$/, "");
  try {
    const thread = JSON.parse(inner);
    if (Array.isArray(thread)) {
      return thread.map((c) => `${c.creator || "Comment"}: ${c.comment || ""}`).join("\n");
    }
  } catch {
    /* not a comment thread: show the text as is */
  }
  return inner;
}

function decorateComments(root) {
  for (const el of root.querySelectorAll('[data-type="html"]:not(.mk-comment)')) {
    const value = el.getAttribute("data-value") || "";
    if (!value.trimStart().startsWith("<!--")) continue;
    el.classList.add("mk-comment");
    el.title = commentTooltip(value);
  }
}

export function getWysiwygFootnotes(pane) {
  return pane._mkHandle ? pane._mkHandle.getFootnotes() : [];
}
export function setWysiwygFootnoteContent(pane, pos, content) {
  pane._mkHandle?.setFootnoteContent(pos, content);
}

// onRender(rootEl) runs after the content is (re)drawn, e.g. to point image
// paths at the server; onOpenUrl(href) for ⌘-clicked links; onOpenComment(el,
// value) for a clicked comment marker.
export async function enableWysiwyg(
  pane,
  { onChange, onOpenWikilink, onFootnotesChanged, onOpenUrl, onOpenComment, onRender },
) {
  if (pane._mkHandle || pane._mkBusy) return;
  pane._mkBusy = true;
  ensurePreviewStyleLoaded(); // same styling as the printed document

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
        // Programmatic changes (loading, footnote renumbering) serialise to
        // the baseline and don't touch the source or mark it edited.
        const changed = flushWysiwygToTextarea(pane);
        pane._mkHandle.renumberFootnotes();
        if (changed) onChange?.();
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
    rememberBaseline(pane, body);

    // Comment markers and resolved image paths, after every redraw. The
    // changed attributes are on leaf nodes (images, comments), which
    // ProseMirror ignores, so they never end up in the Markdown.
    let decorateQueued = false;
    const decorate = () => {
      decorateQueued = false;
      const root = wrap.querySelector(".editor");
      if (!root) return;
      decorateComments(root);
      onRender?.(root);
    };
    pane._mkObserver = new MutationObserver(() => {
      if (decorateQueued) return;
      decorateQueued = true;
      requestAnimationFrame(decorate);
    });
    pane._mkObserver.observe(wrap, { childList: true, subtree: true });
    decorate();

    // Wikilink, link, comment and footnote-marker clicks (delegated; atoms
    // have no cursor).
    wrap.addEventListener("mousedown", (e) => {
      const wl = e.target.closest("a.wikilink");
      if (wl) {
        e.preventDefault();
        onOpenWikilink?.(wl.getAttribute("data-target") || wl.textContent || "");
        return;
      }
      // Other links open with ⌘-click; a plain click places the cursor to edit.
      const link = e.target.closest("a[href]");
      if (link && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onOpenUrl?.(link.getAttribute("href"));
        return;
      }
      const comment = e.target.closest(".mk-comment");
      if (comment) {
        e.preventDefault();
        onOpenComment?.(comment, comment.getAttribute("data-value") || "");
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
  pane._mkObserver?.disconnect();
  pane._mkObserver = null;

  if (handle) {
    pane._mkHandle = handle; // flush needs it, once more
    flushWysiwygToTextarea(pane);
    pane._mkHandle = null;
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
