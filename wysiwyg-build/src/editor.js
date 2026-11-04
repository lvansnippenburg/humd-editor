// Thin factory around Milkdown. Returns a handle with just the operations the
// humd app needs; all Milkdown/ProseMirror types stay inside the bundle.

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  editorState,
} from "@milkdown/kit/core";
import { commonmark, wrapInHeadingCommand } from "@milkdown/kit/preset/commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import {
  getMarkdown as getMarkdownAction,
  replaceAll,
  insert,
  callCommand,
  $remark,
} from "@milkdown/kit/utils";
import { TextSelection } from "@milkdown/kit/prose/state";
import { Slice } from "@milkdown/kit/prose/model";
import { toggleMark } from "@milkdown/kit/prose/commands";
import { closeHistory } from "@milkdown/kit/prose/history";
import remarkGfm from "remark-gfm";
import { humdSyntaxPlugins } from "./syntax.js";

// GFM's default single-tilde strikethrough (`~x~`) collides with Pandoc
// subscript, which humd uses. Swap Milkdown's bundled remark-gfm for one with
// `singleTilde: false`, so only `~~x~~` is strikethrough and single `~` is left
// for the subscript tokeniser in syntax.js — matching the Markdown preview.
const stripGfmRemark = new Set([remarkGFMPlugin].flat(Infinity));
const gfmWithoutRemark = [gfm].flat(Infinity).filter((p) => !stripGfmRemark.has(p));
const remarkGfmSingleTildeOff = $remark(
  "remarkGfmSingleTildeOff",
  () =>
    function () {
      return remarkGfm.call(this, { singleTilde: false });
    },
);

// Walk the doc, collecting footnote nodes in reading order.
function collectFootnotes(view) {
  const out = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "footnote") {
      out.push({ pos, content: node.attrs.content || "", id: node.attrs.id || null });
    }
  });
  return out;
}

// The text of a textblock with each inline leaf (wikilink, footnote marker,
// comment, image, line break) as one "\ufffc", so that character i is at
// document position blockPos + 1 + i.
function textblockText(node) {
  let text = "";
  node.forEach((child) => {
    text += child.isText ? child.text : "\ufffc";
  });
  return text;
}

export async function createEditor({ root, value, onChange }) {
  let lastMarkdown = value ?? "";

  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, value ?? "");
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (markdown === lastMarkdown) return;
        lastMarkdown = markdown;
        onChange?.(markdown);
      });
    })
    .use(commonmark)
    .use(gfmWithoutRemark)
    .use(remarkGfmSingleTildeOff)
    .use(history)
    .use(clipboard)
    .use(listener)
    .use(humdSyntaxPlugins)
    .create();

  const withView = (fn) => editor.action((ctx) => fn(ctx.get(editorViewCtx)));

  return {
    editor,

    getMarkdown() {
      lastMarkdown = editor.action(getMarkdownAction());
      return lastMarkdown;
    },

    // Replace the whole document. `silent` suppresses the resulting change
    // callback (used when the app pushes an external edit in).
    setMarkdown(markdown, { silent = true } = {}) {
      if (silent) lastMarkdown = markdown;
      editor.action(replaceAll(markdown));
    },

    getFootnotes() {
      return withView((view) => collectFootnotes(view));
    },

    setFootnoteContent(pos, content) {
      withView((view) => {
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type.name !== "footnote") return;
        const tr = view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          content,
        });
        tr.setMeta("addToHistory", true);
        view.dispatch(tr);
      });
    },

    // Renumber the .footnote-ref markers in the DOM (1-based, document order).
    renumberFootnotes() {
      withView((view) => {
        const refs = view.dom.querySelectorAll("sup.footnote-ref");
        refs.forEach((el, i) => {
          el.setAttribute("data-num", String(i + 1));
          el.textContent = String(i + 1);
        });
      });
    },

    focus() {
      withView((view) => view.focus());
    },

    // ---- Editing operations for the app's shortcuts ----

    // Make the block(s) at the cursor a heading of `level` (0: paragraph).
    setHeading(level) {
      editor.action(callCommand(wrapInHeadingCommand.key, level));
    },

    // Insert Markdown at the cursor (replacing the selection), parsed into
    // formatted content; `inline` keeps it inside the current paragraph.
    insertMarkdown(markdown, inline = false) {
      if (!inline) {
        editor.action(insert(markdown));
        return;
      }
      // Inline: insert the parsed paragraph's content as is. (Milkdown's own
      // inline insert goes through HTML, where a wikilink comes back as an
      // ordinary link.)
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const doc = ctx.get(parserCtx)(markdown);
        if (!doc) return;
        const content =
          doc.childCount === 1 && doc.firstChild.isTextblock ? doc.firstChild.content : doc.content;
        view.dispatch(view.state.tr.replaceSelection(new Slice(content, 0, 0)).scrollIntoView());
      });
    },

    // Where a file dragged to the screen point (x, y) lands: { pos, rect }. A
    // block goes before or after the top-level node there, whichever half the
    // point is in, and `rect` is the line between the nodes; otherwise `pos`
    // is the text position at the point and `rect` the caret there.
    dropTarget(x, y, block = false) {
      return withView((view) => {
        const { doc } = view.state;
        const box = view.dom.getBoundingClientRect();
        const left = Math.min(Math.max(x, box.left + 1), box.right - 1);
        const top = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
        const pos = view.posAtCoords({ left, top })?.pos ?? doc.content.size;
        if (!block) return { pos, rect: view.coordsAtPos(pos) };

        const $pos = doc.resolve(pos);
        const start = $pos.depth ? $pos.before(1) : $pos.nodeAfter ? pos : pos - $pos.nodeBefore.nodeSize;
        const r = view.nodeDOM(start).getBoundingClientRect();
        const target = top > (r.top + r.bottom) / 2 ? start + doc.nodeAt(start).nodeSize : start;

        const $target = doc.resolve(target);
        const above = $target.nodeBefore && view.nodeDOM(target - $target.nodeBefore.nodeSize).getBoundingClientRect();
        const below = $target.nodeAfter && view.nodeDOM(target).getBoundingClientRect();
        const line = above && below ? (above.bottom + below.top) / 2 : above ? above.bottom : below.top;
        return { pos: target, rect: { left: r.left, right: r.right, top: line, bottom: line } };
      });
    },

    // Insert Markdown at a position from dropTarget, as one undoable step, and
    // put the cursor after it.
    insertAt(pos, markdown, block = false) {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parsed = ctx.get(parserCtx)(markdown);
        if (!parsed) return;
        const { doc } = view.state;
        const tr = view.state.tr;
        if (block) {
          // An empty document is one empty paragraph: replace it.
          const blank = doc.childCount === 1 && doc.firstChild.isTextblock && !doc.firstChild.content.size;
          if (blank) tr.replaceWith(0, doc.content.size, parsed.content);
          else tr.insert(pos, parsed.content);
        } else {
          const content =
            parsed.childCount === 1 && parsed.firstChild.isTextblock ? parsed.firstChild.content : parsed.content;
          tr.replaceRange(pos, pos, new Slice(content, 0, 0));
        }
        tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(pos)), -1));
        view.dispatch(closeHistory(tr));
      });
    },

    // Change the citation shown by `dom` (a .citation-ref element) to the
    // Pandoc text `raw` (without brackets); an empty `raw` removes it.
    setCitation(dom, raw) {
      withView((view) => {
        let pos = view.posAtDOM(dom, 0);
        let node = view.state.doc.nodeAt(pos);
        if (node?.type.name !== "citation") node = view.state.doc.nodeAt(--pos);
        if (node?.type.name !== "citation") return;
        const tr = raw
          ? view.state.tr.setNodeMarkup(pos, undefined, { raw })
          : view.state.tr.delete(pos, pos + node.nodeSize);
        view.dispatch(tr);
      });
    },

    // Insert a reference footnote [^id] at the cursor; its definition is
    // added to the source by the app.
    insertFootnote(id, content = "") {
      withView((view) => {
        const node = view.state.schema.nodes.footnote.create({ id, content });
        view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
      });
    },

    // Whether text is selected.
    hasSelection() {
      return withView((view) => !view.state.selection.empty);
    },

    // Switch a formatting mark ("sup", "sub", "highlight", "strike_through",
    // "strong", "emphasis", …) on or off for the selection; it stays selected.
    toggleMark(name) {
      return withView((view) => {
        const type = view.state.schema.marks[name];
        return type ? toggleMark(type)(view.state, view.dispatch) : false;
      });
    },

    // Insert literal text at the cursor (replacing the selection).
    insertText(text) {
      withView((view) => view.dispatch(view.state.tr.insertText(text).scrollIntoView()));
    },

    // Text of the current paragraph before the cursor ("" with a selection).
    textBeforeCursor() {
      return withView((view) => {
        const { $from, empty } = view.state.selection;
        if (!empty || !$from.parent.isTextblock) return "";
        return textblockText($from.parent).slice(0, $from.parentOffset);
      });
    },

    // Delete `count` characters before the cursor.
    deleteBeforeCursor(count) {
      withView((view) => {
        const { from } = view.state.selection;
        view.dispatch(view.state.tr.delete(Math.max(0, from - count), from));
      });
    },

    // The selected text (paragraphs separated by blank lines).
    selectedText() {
      return withView((view) => {
        const { from, to } = view.state.selection;
        return view.state.doc.textBetween(from, to, "\n\n", "");
      });
    },

    // The selected text and the document's text before it (atoms such as
    // citations and footnote markers count as no text), to find the
    // selection in the Markdown source.
    selectionContext() {
      return withView((view) => {
        const { from, to, $from, $to, empty } = view.state.selection;
        const doc = view.state.doc;
        return {
          text: doc.textBetween(from, to, "\n\n", ""),
          before: doc.textBetween(0, from, "\n\n", ""),
          // From the start of a paragraph to the end of one (or the start of
          // the next, as a triple-click selects): whole paragraphs.
          wholeBlocks:
            !empty &&
            $from.parentOffset === 0 &&
            ($to.parentOffset === $to.parent.content.size || ($to.parentOffset === 0 && to > from)),
        };
      });
    },

    // Texts of the first and last paragraph (textblock) the selection
    // touches, to find the selection in the Markdown source.
    selectionBlocks() {
      return withView((view) => {
        const { $from, $to } = view.state.selection;
        return { first: $from.parent.textContent, last: $to.parent.textContent };
      });
    },

    // Screen position of the cursor: { left, top, bottom }.
    cursorCoords() {
      return withView((view) => view.coordsAtPos(view.state.selection.from));
    },

    // All occurrences of `query` (case-insensitive) in the text, as
    // [{ from, to }] document ranges, in reading order.
    findText(query) {
      return withView((view) => {
        const q = query.toLowerCase();
        const ranges = [];
        if (!q) return ranges;
        view.state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          const text = textblockText(node).toLowerCase();
          for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
            ranges.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
          }
          return false;
        });
        return ranges;
      });
    },

    // Select a range and scroll it into view.
    selectRange(from, to) {
      withView((view) => {
        const sel = TextSelection.create(view.state.doc, from, to);
        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
      });
    },

    // Replace the given ranges by `text`, in one undoable step.
    replaceRanges(ranges, text) {
      withView((view) => {
        const tr = view.state.tr;
        [...ranges].sort((a, b) => b.from - a.from).forEach((r) => tr.insertText(text, r.from, r.to));
        view.dispatch(tr.scrollIntoView());
      });
    },

    hasFocus() {
      return editor.action((ctx) => ctx.get(editorViewCtx).hasFocus());
    },

    destroy() {
      return editor.destroy();
    },
  };
}

export { editorState };
