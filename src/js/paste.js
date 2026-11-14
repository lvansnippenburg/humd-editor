// Pasting into the Markdown (source) editor.
//
// A textarea only ever receives the clipboard's plain text, so text copied
// from a web page, Word, Google Docs, Apple Notes, … loses its headings,
// emphasis, links and lists. `clipboardToMarkdown` looks at what the
// clipboard holds and decides what to insert:
//
// - Plain text that is already Markdown (copied from this app's formatted
//   view, another Markdown editor, VS Code, …) is pasted as is, even when the
//   clipboard also has an HTML version of it.
// - HTML is converted to Markdown. Elements that have a Markdown equivalent
//   (headings, paragraphs, bold/italic/strikethrough/highlight, sub- and
//   superscript, code, links, web images, lists, quotes, tables, rules) are
//   translated; every other tag is removed, keeping its text. Scripts, styles,
//   forms, media and hidden elements are dropped entirely.
// - Plain text that is HTML source (starts and ends with a tag) is converted
//   the same way.
// - Anything else (ordinary text) is left to the normal paste.
//
// Converting returns null when the normal paste should happen instead.

// Elements removed together with their content.
const DROP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE",
  "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO",
  "PICTURE", "SOURCE", "TRACK", "MAP", "BUTTON", "SELECT", "TEXTAREA",
  "OPTION", "DATALIST", "DIALOG",
]);

// Elements that start a new block (everything else is inline, or unknown and
// unwrapped).
const BLOCK = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BODY", "CENTER", "DD", "DETAILS",
  "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1",
  "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "HTML", "LI", "MAIN",
  "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "UL",
]);

const BLOCK_SELECTOR = [...BLOCK].join(",");

// An element that starts a block: a block element, or an inline one that
// contains blocks (<b> around a whole Google Docs document, <a> around a
// card), which is then treated as a container.
const startsBlock = (node) =>
  node.nodeType === 1 && (BLOCK.has(node.tagName.toUpperCase()) || !!node.querySelector(BLOCK_SELECTOR));

const isBold = (style) => /font-weight\s*:\s*(bold|bolder|[6-9]00)\b/i.test(style);
const isNotBold = (style) => /font-weight\s*:\s*(normal|lighter|[1-5]00)\b/i.test(style);
const isItalic = (style) => /font-style\s*:\s*(italic|oblique)/i.test(style);
const isStrike = (style) => /text-decoration[^;]*line-through/i.test(style);
const isSuper = (style) => /vertical-align\s*:\s*super/i.test(style);
const isSub = (style) => /vertical-align\s*:\s*sub/i.test(style);

// Word's list paragraphs (bullets/numbers are separate, ignorable spans).
const isWordListItem = (el) => /\bMsoListParagraph/i.test(el.className || "");

// ---- Escaping ----

// Escape text so it doesn't turn into Markdown syntax by accident. Kept
// minimal: only what would really change meaning, so ordinary text stays
// readable ("snake_case", "[1]", "a * b" are left alone).
function escapeText(s) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\*/g, (m, i, str) => (/\s/.test(str[i - 1] || " ") && /\s/.test(str[i + 1] || " ") ? m : "\\*"))
    .replace(/(^|[^\p{L}\p{N}])_|_(?=[^\p{L}\p{N}]|$)/gu, (m) => m.replace("_", "\\_"))
    .replace(/\[(?=[@^[])/g, "\\[") // [@cite, [^note, [[wikilink
    .replace(/\](?=[([])/g, "\\]") // [text](url), [text][ref]
    .replace(/==/g, "=\\=")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<");
}

// Text at the start of a line that Markdown would read as a block marker.
function escapeLineStarts(s) {
  return s.replace(/^( {0,3})(#{1,6}(?=\s|$)|>|[-+*](?=\s)|\d+(?=[.)]\s)|(?:-\s*){3,}$|(?:=\s*){3,}$)/gm, (m, sp, mark) =>
    /^\d/.test(mark) ? `${sp}${mark}\\` : `${sp}\\${mark}`
  );
}

// ---- Inline content ----

// Wrap `content` in `mark`, keeping surrounding whitespace outside it
// ("** bold**" isn't bold in Markdown).
function wrap(content, mark, close = mark) {
  const m = content.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m[2]) return content;
  return `${m[1]}${mark}${m[2]}${close}${m[3]}`;
}

function codeSpan(text) {
  text = text.replace(/\s+/g, " ");
  if (!text.trim()) return text;
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function safeUrl(url) {
  return url.trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function inline(node, ctx) {
  let out = "";
  for (const child of node.childNodes) out += inlineNode(child, ctx);
  return out;
}

function inlineNode(node, ctx) {
  if (node.nodeType === 3) {
    const text = node.nodeValue.replace(/[ \t\r\n\f]+/g, " ");
    return ctx.code ? text : escapeText(text);
  }
  if (node.nodeType !== 1) return "";
  const el = node;
  const tag = el.tagName.toUpperCase();
  const style = el.getAttribute("style") || "";

  switch (tag) {
    case "BR":
      return "\\\n";
    case "IMG": {
      const src = el.getAttribute("src") || "";
      // Only web images: data:/blob:/file: URLs are huge or don't resolve.
      if (!/^https?:\/\//i.test(src)) return "";
      const alt = (el.getAttribute("alt") || "").replace(/[[\]\n]/g, " ").trim();
      return `![${alt}](${safeUrl(src)})`;
    }
    case "INPUT":
      return ""; // task-list checkboxes are handled by the list item
    case "A": {
      const href = (el.getAttribute("href") || "").trim();
      const text = inline(el, ctx).replace(/\\\n/g, " ");
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return text;
      if (!text.trim()) return "";
      const plain = el.textContent.trim();
      if (plain === href || `mailto:${plain}` === href) return `<${href}>`;
      return wrap(text, "[", `](${safeUrl(href)})`);
    }
    case "CODE":
    case "KBD":
    case "SAMP":
    case "TT":
      return ctx.code ? el.textContent : codeSpan(el.textContent);
  }

  // Formatting, from the tag or (Google Docs, Word) from inline styles.
  // Google Docs wraps everything in <b style="font-weight:normal">.
  const bold = (["B", "STRONG"].includes(tag) && !isNotBold(style)) || isBold(style);
  let content = inline(el, {
    ...ctx,
    bold: ctx.bold || bold,
    italic: ctx.italic || ["I", "EM", "CITE", "DFN", "VAR"].includes(tag) || isItalic(style),
    strike: ctx.strike || ["DEL", "S", "STRIKE"].includes(tag) || isStrike(style),
  });
  if (!ctx.strike && (["DEL", "S", "STRIKE"].includes(tag) || isStrike(style))) content = wrap(content, "~~");
  if (!ctx.italic && (["I", "EM", "CITE", "DFN", "VAR"].includes(tag) || isItalic(style))) content = wrap(content, "*");
  if (!ctx.bold && bold) content = wrap(content, "**");
  if (tag === "MARK") content = wrap(content, "==");
  // Pandoc's ^sup^ / ~sub~ can't contain spaces: keep the text plain then.
  if ((tag === "SUP" || isSuper(style)) && content.trim() && !/\s/.test(content)) content = `^${content}^`;
  if ((tag === "SUB" || isSub(style)) && content.trim() && !/\s/.test(content)) content = `~${content}~`;
  if (tag === "Q") content = `“${content}”`;
  if (BLOCK.has(tag)) content = ` ${content} `; // a block inside inline content: keep words apart
  return content;
}

// Inline content as one paragraph's text.
function paragraphText(node, ctx) {
  return finishInline(inline(node, ctx));
}

// `lineStarts`: escape block markers at line starts (not needed where the
// text can't start a block: headings, table cells).
function finishInline(s, lineStarts = true) {
  s = s
    .replace(/ {2,}/g, " ")
    .replace(/ *\\\n */g, "\\\n")
    .replace(/^(\\\n|\s)+|(\\\n|\s)+$/g, "");
  return lineStarts ? escapeLineStarts(s) : s;
}

// ---- Blocks ----

// The blocks of a container, as Markdown strings. Inline children between
// blocks form paragraphs; Word's list paragraphs are gathered into lists.
function blocks(node, ctx) {
  const out = [];
  let run = [];
  let wordList = [];
  const flushRun = () => {
    if (!run.length) return;
    const span = node.ownerDocument.createElement("span");
    for (const n of run) span.appendChild(n.cloneNode(true));
    const text = paragraphText(span, ctx);
    if (text) out.push(text);
    run = [];
  };
  const flushWordList = () => {
    if (wordList.length) out.push(wordList.join("\n"));
    wordList = [];
  };
  for (const child of node.childNodes) {
    if (!startsBlock(child)) {
      if (child.nodeType === 3 && !child.nodeValue.trim() && !run.length) continue;
      flushWordList();
      run.push(child);
      continue;
    }
    flushRun();
    if (isWordListItem(child)) {
      const text = paragraphText(child, ctx);
      if (text) wordList.push(`- ${text}`);
      continue;
    }
    flushWordList();
    const md = block(child, ctx);
    if (md && md.trim()) out.push(md);
  }
  flushRun();
  flushWordList();
  return out;
}

function block(el, ctx) {
  const tag = el.tagName.toUpperCase();
  switch (tag) {
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6": {
      const text = finishInline(inline(el, ctx).replace(/\\\n/g, " "), false);
      return text ? `${"#".repeat(+tag[1])} ${text}` : "";
    }
    case "P":
    case "DD":
    case "FIGCAPTION":
    case "SUMMARY":
      return paragraphText(el, ctx);
    case "DT": {
      const text = paragraphText(el, ctx);
      return text ? wrap(text, "**") : "";
    }
    case "HR":
      return "---";
    case "BLOCKQUOTE":
      return blocks(el, ctx)
        .join("\n\n")
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "PRE":
      return codeBlock(el);
    case "UL":
    case "OL":
      return list(el, ctx);
    case "LI":
      return listItem(el, "-", ctx);
    case "TABLE":
      return table(el, ctx);
    default:
      // Containers (div, section, …): their blocks, in order.
      return blocks(el, ctx).join("\n\n");
  }
}

function codeBlock(pre) {
  const copy = pre.cloneNode(true);
  for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
  const text = copy.textContent.replace(/\n$/, "");
  const classes = [pre, pre.querySelector("code"), pre.parentElement]
    .map((e) => (e && e.className) || "")
    .join(" ");
  const lang = (classes.match(/(?:language|lang|highlight-source)-([\w+#-]+)/) || [])[1] || "";
  const longest = Math.max(0, ...(text.match(/^`{3,}/gm) || []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

function list(el, ctx) {
  const ordered = el.tagName.toUpperCase() === "OL";
  let n = parseInt(el.getAttribute("start"), 10);
  if (!Number.isFinite(n)) n = 1;
  const items = [];
  for (const child of el.children) {
    const tag = child.tagName.toUpperCase();
    if (tag === "LI") {
      items.push(listItem(child, ordered ? `${n++}.` : "-", ctx));
    } else if ((tag === "UL" || tag === "OL") && items.length) {
      // A list directly inside a list (invalid, but common): nest it.
      const indent = " ".repeat((ordered ? `${n - 1}.` : "-").length + 1);
      items[items.length - 1] += "\n" + indentLines(list(child, ctx), indent);
    } else {
      const md = block(child, ctx);
      if (md) items.push(md);
    }
  }
  return items.join("\n");
}

function listItem(li, marker, ctx) {
  const box = li.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
  const task = box ? (box.checked || box.hasAttribute("checked") ? "[x] " : "[ ] ") : "";
  const parts = blocks(li, ctx);
  let body = "";
  parts.forEach((part, i) => {
    if (i === 0) body = part;
    else body += (/^([-+*]|\d+[.)]) /.test(part) ? "\n" : "\n\n") + part;
  });
  const indent = " ".repeat(marker.length + 1);
  const lines = indentLines(body, indent).replace(/^ +/, "");
  return `${marker} ${task}${lines}`.trimEnd();
}

function indentLines(text, indent) {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
}

function table(el, ctx) {
  const rows = [...el.querySelectorAll("tr")].filter((tr) => tr.closest("table") === el);
  const grid = rows
    .map((tr) =>
      [...tr.children]
        .filter((c) => /^T[HD]$/i.test(c.tagName))
        .map((cell) =>
          finishInline(inline(cell, ctx).replace(/\\\n/g, " "), false)
            .replace(/\n/g, " ")
            .replace(/\|/g, "\\|")
        )
    )
    .filter((cells) => cells.length);
  const cols = Math.max(0, ...grid.map((r) => r.length));
  // A layout table (one cell or one column): just its content.
  if (grid.length === 0 || cols < 2) return blocks(el, ctx).join("\n\n");
  const pad = (r) => [...r, ...Array(cols - r.length).fill("")];
  const line = (r) => `| ${pad(r).join(" | ")} |`;
  return [line(grid[0]), line(Array(cols).fill("---")), ...grid.slice(1).map(line)].join("\n");
}

// ---- Clean-up before converting ----

function clean(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 0x80 /* SHOW_COMMENT */);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());

  for (const el of [...root.querySelectorAll("*")]) {
    if (!el.isConnected) continue;
    const tag = el.tagName.toUpperCase();
    const style = el.getAttribute("style") || "";
    if (
      DROP.has(tag) ||
      (tag === "INPUT" && el.type !== "checkbox") ||
      el.hasAttribute("hidden") ||
      /display\s*:\s*none/i.test(style) ||
      /mso-list\s*:\s*Ignore/i.test(style) || // Word's bullet/number glyphs
      el.classList.contains("Apple-interchange-newline")
    ) {
      el.remove();
    }
  }
}

// ---- Public API ----

export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  clean(doc.body);
  return blocks(doc.body, {})
    .join("\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Markdown syntax that copied plain text wouldn't contain unless it's
// Markdown source.
const MARKDOWN_SIGNS = [
  /^#{1,6}\s+\S/m, // heading
  /\*\*[^*\n]+\*\*/, // bold
  /\[[^\]\n]+\]\([^)\s]+\)/, // link / image
  /\[\[[^\]\n]+\]\]/, // wikilink
  /\[@[^\]\s]+/, // citation
  /\^\[[^\]]+\]|\[\^[^\]\s]+\]/, // footnote
  /^```/m, // code fence
  /==[^=\n]+==/, // highlight
  /^\|.*\|\s*\n\|\s*:?-{2,}/m, // table
];

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S.*$/gm;

// Is the plain text Markdown source? List lines only count when the HTML
// doesn't show the same marker (a web page with "1. Introduction" isn't).
export function looksLikeMarkdown(text, htmlText = "") {
  if (MARKDOWN_SIGNS.some((re) => re.test(text))) return true;
  const squash = (s) => s.replace(/\s+/g, " ").trim();
  const shown = squash(htmlText);
  const lists = text.match(LIST_LINE) || [];
  return lists.length >= 2 && lists.some((line) => !shown.includes(squash(line)));
}

// Plain text that is a piece of HTML source: starts and ends with a tag.
export function looksLikeHtmlSource(text) {
  const t = text.trim();
  return (
    /^<(!doctype\s+html|html|head|body|div|p|h[1-6]|ul|ol|li|table|blockquote|pre|span|a|b|strong|em|i|section|article|main|br|img|hr)[\s>/]/i.test(t) &&
    /<\/?[a-z][^>]*>$/i.test(t)
  );
}

// Pasting into the formatted (WYSIWYG) view: the Markdown to parse and insert,
// or null to let Milkdown's own paste handle it (HTML through the editor's
// schema, plain text as Markdown). Milkdown prefers the HTML whenever there is
// any, which turns Markdown copied from TextEdit, Notes, a browser, … into
// literal, escaped text, and pastes VS Code's copy as a code block; here the
// plain text wins whenever it's Markdown. `vscodeData` is VS Code's
// "vscode-editor-data" clipboard entry (JSON with the language "mode").
export function markdownForRichTextPaste(html, text, vscodeData = "") {
  if (!text || !text.trim()) return null;
  if (vscodeData) {
    let mode = "";
    try {
      mode = JSON.parse(vscodeData)?.mode || "";
    } catch {}
    return mode === "markdown" ? text : null; // other languages: a code block
  }
  const htmlText = html ? new DOMParser().parseFromString(html, "text/html").body.textContent : "";
  if (looksLikeMarkdown(text, htmlText)) return text;
  if (!html && looksLikeHtmlSource(text)) return htmlToMarkdown(text) || null;
  return null;
}

// What to insert for a paste, as Markdown; null to let the normal paste
// insert the plain text. `types` are the clipboard's data types.
export function clipboardToMarkdown(html, text, types = []) {
  if (html && html.trim()) {
    // A code editor's copy (VS Code; others style it with white-space: pre)
    // is code, not formatted text.
    if (types.includes("vscode-editor-data")) return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (text && looksLikeMarkdown(text, doc.body.textContent)) return null;
    if (/white-space\s*:\s*pre/i.test(html) && !doc.body.querySelector("p, h1, h2, h3, h4, h5, h6, li, table")) {
      return null;
    }
    const md = htmlToMarkdown(html);
    if (!md || md === text) return null;
    return md;
  }
  if (text && looksLikeHtmlSource(text)) {
    const md = htmlToMarkdown(text);
    return md || null;
  }
  return null;
}
