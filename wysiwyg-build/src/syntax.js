// humd's humanities-flavoured Markdown, taught to Milkdown so it survives a
// full parse -> edit -> serialize round-trip through the rich-text editor.
//
//   ==highlight==   <->  <mark>            (ProseMirror mark)
//   ^superscript^   <->  <sup>            (ProseMirror mark)
//   ~subscript~     <->  <sub>            (ProseMirror mark)
//   [[wikilink]]    <->  <a class=wikilink href="file://…">   (inline atom node)
//   ^[footnote]     <->  <sup class=footnote-ref>             (inline atom node,
//                        content lives in an attribute, shown/edited in the
//                        sidebar, never inline)  — GFM [^id] references are
//                        folded into the same node.
//
// #tags are deliberately left as plain text (per project decision): `#tag`
// without a following space is never an ATX heading, so nothing to do.
//
// Parsing is done at the mdast level with `mdast-util-find-and-replace` (splits
// text nodes, skips links/code) plus a small visitor that folds GFM footnote
// references/definitions into our footnote node. Serialising is done with
// `toMarkdown` handlers registered on the same remark plugin.

import { findAndReplace } from "mdast-util-find-and-replace";
import { visit } from "unist-util-visit";
import { toString as mdastToString } from "mdast-util-to-string";
import { $remark, $markSchema, $nodeSchema } from "@milkdown/kit/utils";

// ---------------------------------------------------------------------------
// Tokenisers. Mirrors the rules in src/js/markdown.js so the WYSIWYG view and
// the Markdown preview agree on what counts as each construct.
// ---------------------------------------------------------------------------

// ==x== — no surrounding whitespace, `~~`/GFM strike already consumed upstream.
const HIGHLIGHT_RE = /==(?=\S)([\s\S]*?\S)==/g;
// ~x~ — a single tilde pair (GFM strikethrough is `~~` and is parsed first).
const SUB_RE = /~(?!~)(?=\S)([^~\n]+?)~(?!~)/g;
// ^x^ — not the opening of an inline footnote (`^[`) nor a ref (`[^`).
const SUP_RE = /(?<!\[)\^(?!\[)(?=\S)([^\^\n]+?)\^/g;
// ^[ ... ] — inline footnote; tolerates one level of nested [ ].
const INLINE_FOOTNOTE_RE = /\^\[((?:[^[\]]|\[[^\]]*\])*)\]/g;
// [[target]] or [[target|label]]
const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

const textChildren = (value) => [{ type: "text", value }];

// ---------------------------------------------------------------------------
// remark plugin: mdast <-> humd syntax
// ---------------------------------------------------------------------------

const remarkHumd = $remark("remarkHumdSyntax", () => () => (tree) => {
  // 1. Fold GFM footnotes ([^id] + [^id]: def) into inline `footnote` nodes,
  //    resolving each reference to its definition's text, then drop the
  //    now-orphaned definitions. A reference with no definition keeps its id
  //    as the content so nothing is silently lost.
  const defs = new Map();
  visit(tree, "footnoteDefinition", (node) => {
    defs.set(node.identifier, mdastToString(node).trim());
  });
  visit(tree, "footnoteReference", (node, index, parent) => {
    if (!parent || index == null) return;
    const content = defs.get(node.identifier) ?? node.label ?? node.identifier;
    parent.children[index] = { type: "footnote", content, children: [] };
  });
  // Remove footnoteDefinition blocks wholesale.
  const prune = (node) => {
    if (!node.children) return;
    node.children = node.children.filter((c) => c.type !== "footnoteDefinition");
    node.children.forEach(prune);
  };
  prune(tree);

  // 2. Inline text tokens. Order matters: `^[...]` before `^...^`.
  findAndReplace(tree, [
    [HIGHLIGHT_RE, (_m, inner) => ({ type: "highlight", children: textChildren(inner) })],
    [
      INLINE_FOOTNOTE_RE,
      (_m, inner) => ({ type: "footnote", content: inner.trim(), children: [] }),
    ],
    [SUP_RE, (_m, inner) => ({ type: "sup", children: textChildren(inner) })],
    [SUB_RE, (_m, inner) => ({ type: "sub", children: textChildren(inner) })],
    [
      WIKILINK_RE,
      (_m, target, label) => ({
        type: "wikilink",
        target: target.trim(),
        label: label ? label.trim() : null,
        children: [],
      }),
    ],
  ]);
});

// Serialisers: `toMarkdown` handlers registered on the remark instance so the
// `state.withMark` / `state.addNode` calls in the schema runners land as real
// Markdown. Modelled on mdast-util-gfm-strikethrough's handler.
const wrapHandler = (delim) => {
  const handle = (node, _parent, state, info) => {
    const tracker = state.createTracker(info);
    const exit = state.enter(node.type);
    let value = tracker.move(delim);
    value += state.containerPhrasing(node, {
      ...tracker.current(),
      before: value,
      after: delim[0],
    });
    value += tracker.move(delim);
    exit();
    return value;
  };
  handle.peek = () => delim[0];
  return handle;
};

const remarkHumdStringify = $remark("remarkHumdStringify", () => function () {
  const list = this.data("toMarkdownExtensions") || [];
  list.push({
    handlers: {
      highlight: wrapHandler("=="),
      sup: wrapHandler("^"),
      sub: wrapHandler("~"),
      wikilink: (node) =>
        node.label ? `[[${node.target}|${node.label}]]` : `[[${node.target}]]`,
      footnote: (node) => `^[${node.content ?? ""}]`,
    },
  });
  this.data("toMarkdownExtensions", list);
});

// ---------------------------------------------------------------------------
// ProseMirror schema: three marks + two inline atom nodes
// ---------------------------------------------------------------------------

const markRunner = (mdastType) => ({
  parseMarkdown: {
    match: (node) => node.type === mdastType,
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === mdastType,
    runner: (state, mark) => {
      state.withMark(mark, mdastType);
    },
  },
});

// Bare <mark>/<sup>/<sub> — no class of our own — so the app's shared
// preview.css (which styles those tags directly) renders them identically to
// the Markdown preview. See src/js/preview-style.js on the app side.
export const highlightSchema = $markSchema("highlight", () => ({
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0],
  ...markRunner("highlight"),
}));

export const supSchema = $markSchema("sup", () => ({
  parseDOM: [{ tag: "sup" }],
  toDOM: () => ["sup", 0],
  ...markRunner("sup"),
}));

export const subSchema = $markSchema("sub", () => ({
  parseDOM: [{ tag: "sub" }],
  toDOM: () => ["sub", 0],
  ...markRunner("sub"),
}));

export const wikilinkSchema = $nodeSchema("wikilink", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  marks: "",
  attrs: {
    target: { default: "", validate: "string" },
    label: { default: null },
  },
  parseDOM: [
    {
      tag: "a.wikilink",
      getAttrs: (dom) => ({
        target: dom.getAttribute("data-target") || dom.textContent || "",
        label: dom.getAttribute("data-label") || null,
      }),
    },
  ],
  toDOM: (node) => {
    const { target, label } = node.attrs;
    return [
      "a",
      {
        class: "wikilink",
        href: "file://" + encodeURI(target),
        "data-target": target,
        ...(label ? { "data-label": label } : {}),
        title: target,
      },
      label || target,
    ];
  },
  parseMarkdown: {
    match: ({ type }) => type === "wikilink",
    runner: (state, node, type) => {
      state.addNode(type, { target: node.target, label: node.label ?? null });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "wikilink",
    runner: (state, node) => {
      state.addNode("wikilink", undefined, undefined, {
        target: node.attrs.target,
        label: node.attrs.label,
      });
    },
  },
}));

export const footnoteSchema = $nodeSchema("footnote", () => ({
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,
  marks: "",
  attrs: {
    content: { default: "", validate: "string" },
  },
  parseDOM: [
    {
      tag: "sup.footnote-ref",
      getAttrs: (dom) => ({ content: dom.getAttribute("data-content") || "" }),
    },
  ],
  toDOM: (node) => [
    "sup",
    {
      class: "footnote-ref",
      "data-content": node.attrs.content,
      // The number is filled in by a NodeView / decoration at runtime; a static
      // marker keeps it meaningful if styles fail to load.
      title: node.attrs.content,
    },
    "★",
  ],
  parseMarkdown: {
    match: ({ type }) => type === "footnote",
    runner: (state, node, type) => {
      state.addNode(type, { content: node.content ?? "" });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "footnote",
    runner: (state, node) => {
      state.addNode("footnote", undefined, undefined, {
        content: node.attrs.content,
      });
    },
  },
}));

// Everything the editor needs to `.use(...)`, in dependency order.
export const humdSyntaxPlugins = [
  remarkHumd,
  remarkHumdStringify,
  highlightSchema,
  supSchema,
  subSchema,
  wikilinkSchema,
  footnoteSchema,
].flat();
