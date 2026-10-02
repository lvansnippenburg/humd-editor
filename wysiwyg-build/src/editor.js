// Thin factory around Milkdown. Returns a handle with just the operations the
// humd app needs; all Milkdown/ProseMirror types stay inside the bundle.

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  editorState,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm, remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { getMarkdown as getMarkdownAction, replaceAll, $remark } from "@milkdown/kit/utils";
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
      out.push({ pos, content: node.attrs.content || "" });
    }
  });
  return out;
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

    hasFocus() {
      return editor.action((ctx) => ctx.get(editorViewCtx).hasFocus());
    },

    destroy() {
      return editor.destroy();
    },
  };
}

export { editorState };
