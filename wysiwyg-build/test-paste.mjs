// Headless checks for the source editor's paste conversion (src/js/paste.js).
// Run: npm run test:paste
import "global-jsdom/register";
import assert from "node:assert/strict";

const { htmlToMarkdown, clipboardToMarkdown, looksLikeMarkdown, markdownForRichTextPaste } = await import("../src/js/paste.js");

let failed = 0;
function check(name, actual, expected) {
  try {
    assert.equal(actual, expected);
    console.log(`ok   ${name}`);
  } catch {
    failed++;
    console.log(`FAIL ${name}\n--- expected:\n${expected}\n--- actual:\n${actual}\n`);
  }
}

// ---- HTML → Markdown ----

check(
  "headings, paragraphs, emphasis, links",
  htmlToMarkdown(
    `<h2>Title <a href="#x">¶</a></h2><p>Some <b>bold</b>, <em>italic</em> and <a href="https://ex.org/a b">a link</a>.</p>`
  ),
  "## Title ¶\n\nSome **bold**, *italic* and [a link](https://ex.org/a%20b)."
);

check(
  "unknown tags removed, text kept; scripts/styles dropped",
  htmlToMarkdown(
    `<style>p{color:red}</style><div class="x"><font color="red">Red</font> <u>under</u> <custom-el>custom</custom-el><script>alert(1)</script></div><button>Click</button>`
  ),
  "Red under custom"
);

check(
  "nested and ordered lists, task items",
  htmlToMarkdown(
    `<ul><li>One<ul><li>One.a</li></ul></li><li><input type="checkbox" checked> Done</li></ul><ol start="3"><li>Three</li><li>Four</li></ol>`
  ),
  "- One\n  - One.a\n- [x] Done\n\n3. Three\n4. Four"
);

check(
  "blockquote, code block, inline code, rule",
  htmlToMarkdown(
    `<blockquote><p>Quoted</p><p>Second</p></blockquote><pre><code class="language-js">let a = 1;\nlet b = 2;</code></pre><p>Use <code>a\`b</code></p><hr>`
  ),
  "> Quoted\n>\n> Second\n\n```js\nlet a = 1;\nlet b = 2;\n```\n\nUse ``a`b``\n\n---"
);

check(
  "table",
  htmlToMarkdown(
    `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1 | x</td><td><b>2</b></td></tr><tr><td>3</td></tr></tbody></table>`
  ),
  "| A | B |\n| --- | --- |\n| 1 \\| x | **2** |\n| 3 |  |"
);

check(
  "layout table (one column) becomes its content",
  htmlToMarkdown(`<table><tr><td><p>Just text</p></td></tr></table>`),
  "Just text"
);

check(
  "line breaks, highlight, sub/superscript, strikethrough",
  htmlToMarkdown(`<p>Line one<br>line two</p><p><mark>hi</mark> H<sub>2</sub>O E=mc<sup>2</sup> <del>old</del></p>`),
  "Line one\\\nline two\n\n==hi== H~2~O E=mc^2^ ~~old~~"
);

check(
  "images: web kept, data: dropped",
  htmlToMarkdown(`<p><img src="https://ex.org/a.png" alt="A pic"><img src="data:image/png;base64,AAAA" alt="x"></p>`),
  "![A pic](https://ex.org/a.png)"
);

check(
  "escaping of accidental Markdown",
  htmlToMarkdown(`<p>1. Not a list *really* and [@not a cite] but snake_case and a * b</p><p># not a heading</p>`),
  "1\\. Not a list \\*really\\* and \\[@not a cite] but snake_case and a * b\n\n\\# not a heading"
);

check(
  "heading text isn't escaped",
  htmlToMarkdown(`<h1>1. Introduction</h1>`),
  "# 1. Introduction"
);

check(
  "Google Docs (bold via style, wrapper <b> is not bold)",
  htmlToMarkdown(
    `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;">Plain </span><span style="font-weight:700;">bold</span><span style="font-style:italic;"> italic</span></p><br><p dir="ltr"><span>Next</span></p></b>`
  ),
  "Plain **bold** *italic*\n\nNext"
);

check(
  "Word list paragraphs and comments",
  htmlToMarkdown(
    `<!--StartFragment--><p class="MsoNormal">Intro<o:p></o:p></p><p class="MsoListParagraphCxSpFirst"><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span></span>First</p><p class="MsoListParagraphCxSpLast"><span style="mso-list:Ignore">·<span>&nbsp;</span></span>Second</p><!--EndFragment-->`
  ),
  "Intro\n\n- First\n- Second"
);

check(
  "link whose text is the URL",
  htmlToMarkdown(`<p>See <a href="https://ex.org">https://ex.org</a></p>`),
  "See <https://ex.org>"
);

// ---- Choosing what to paste ----

check(
  "Markdown in text/plain wins over its HTML (e.g. copied from the formatted view)",
  clipboardToMarkdown(`<p><strong>Bold</strong> and <a href="x">link</a></p>`, "**Bold** and [link](x)"),
  null
);

check(
  "web page HTML is converted",
  clipboardToMarkdown(`<h1>Head</h1><p>Text with <i>style</i></p>`, "Head\nText with style"),
  "# Head\n\nText with *style*"
);

check(
  "numbered headings on a page are not mistaken for a Markdown list",
  looksLikeMarkdown("1. Intro\n2. Method", "<h2>1. Intro</h2><h2>2. Method</h2>".replace(/<[^>]+>/g, " ")),
  false
);

check("VS Code copy stays plain", clipboardToMarkdown(`<div><span>code</span></div>`, "code", ["vscode-editor-data"]), null);

check(
  "HTML source pasted as text is converted",
  clipboardToMarkdown("", `<p>Hello <strong>world</strong></p>`),
  "Hello **world**"
);

check("ordinary text: normal paste", clipboardToMarkdown("", "Just some text <3"), null);

check("plain-text Markdown: normal paste", clipboardToMarkdown("", "# Title\n\n- a\n- b"), null);

// ---- Pasting into the formatted (WYSIWYG) view ----

check(
  "rich text: Markdown with an HTML copy → the Markdown",
  markdownForRichTextPaste("<p>**b** and [l](x)</p>", "**b** and [l](x)"),
  "**b** and [l](x)"
);
check("rich text: VS Code Markdown → Markdown", markdownForRichTextPaste("<div>x</div>", "# T", '{"mode":"markdown"}'), "# T");
check("rich text: VS Code code → Milkdown's code block", markdownForRichTextPaste("<div>x</div>", "let a", '{"mode":"javascript"}'), null);
check("rich text: web page → Milkdown's HTML paste", markdownForRichTextPaste("<h1>Head</h1><p>Text</p>", "Head\nText"), null);

// The real editor (the built bundle), with a synthetic paste event.
for (const k of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  if (typeof globalThis[k] !== "function") globalThis[k] = window[k].bind(window);
}
for (const k of ["Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "InputEvent", "UIEvent", "FocusEvent", "ClipboardEvent", "DragEvent"]) {
  if (window[k]) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
}
if (!globalThis.matchMedia && !window.matchMedia) {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
// jsdom has no layout; ProseMirror measures when scrolling the selection into view.
const noRect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
for (const proto of [window.Element.prototype, window.Range.prototype]) {
  proto.getClientRects = () => [noRect];
  proto.getBoundingClientRect = () => noRect;
}
const { createEditor } = await import("../src/js/vendor/milkdown.bundle.js");

async function pasteInto(value, caret, data) {
  document.body.innerHTML = "<div id=root></div>";
  const h = await createEditor({ root: document.getElementById("root"), value, onChange() {} });
  const view = document.querySelector(".ProseMirror");
  // `caret`: a text offset in the first paragraph (document position - 1).
  if (caret !== null) h.selectRange(caret + 1, caret + 1);
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  ev.clipboardData = { types: Object.keys(data), getData: (t) => data[t] ?? "" };
  view.dispatchEvent(ev);
  const md = h.getMarkdown().trim();
  await h.destroy();
  return md;
}

const md = "# Title\n\nSome **bold** with [link](https://x.org) and [@key, p. 3].\n\n* one\n* two";
const asHtml = "<meta charset='utf-8'><p>" + md.replace(/\n/g, "<br>") + "</p>";
check("editor: Markdown + HTML (TextEdit, Notes, browser)", await pasteInto("", null, { "text/plain": md, "text/html": asHtml }), md);
check(
  "editor: Markdown from VS Code",
  await pasteInto("", null, { "text/plain": md, "text/html": "<div>x</div>", "vscode-editor-data": '{"mode":"markdown"}' }),
  md
);
check(
  "editor: inline Markdown in the middle of a sentence",
  await pasteInto("Before after.", 7, { "text/plain": "**new** [[Note]]", "text/html": "<span>**new** [[Note]]</span>" }),
  "Before **new** [[Note]]after."
);
check(
  "editor: formatted web text still pasted as formatting",
  await pasteInto("", null, { "text/plain": "Head\nText", "text/html": "<h2>Head</h2><p>Text <b>bold</b></p>" }),
  "## Head\n\nText **bold**"
);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
