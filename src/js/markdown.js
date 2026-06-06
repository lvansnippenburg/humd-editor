// Client-side Markdown rendering: front-matter stripping, custom inline
// preprocessing (footnotes, highlight/sub/sup, #tags, wikilinks), and the
// preview iframe HTML. Pure functions — no app state. `marked` is read from
// the global scope (loaded dynamically at startup).

function stripFrontMatter(md) {
  const lines = md.split("\n");
  if (!lines.length || !lines[0].trim().startsWith("---")) return md;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("---")) return lines.slice(i + 1).join("\n");
  }
  return md;
}

function preprocessInlineFootnotes(md) {
  let result = "";
  let footnotes = [];
  let counter = 0;
  let i = 0;
  while (i < md.length) {
    if (md[i] === "^" && md[i + 1] === "[") {
      let j = i + 2;
      let depth = 1;
      let content = "";
      while (j < md.length && depth > 0) {
        if (md[j] === "[") depth++;
        else if (md[j] === "]") {
          depth--;
          if (depth === 0) break;
        }
        if (depth > 0) content += md[j];
        j++;
      }
      if (depth === 0) {
        counter++;
        const id = `fn${counter}`;
        result += `[^${id}]`;
        footnotes.push(`[^${id}]: ${content}`);
        i = j + 1;
        continue;
      }
    }
    result += md[i];
    i++;
  }
  if (footnotes.length) result += "\n\n" + footnotes.join("\n");
  return result;
}

function preprocessInlineSpans(md) {
  const lines = md.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    out.push(applyInlineSpans(line));
  }
  return out.join("\n");
}

function applyInlineSpans(line) {
  let result = "";
  let i = 0;
  while (i < line.length) {
    // Skip inline code spans
    if (line[i] === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== "`") j++;
      result += line.slice(i, j < line.length ? j + 1 : j);
      i = j < line.length ? j + 1 : j;
      continue;
    }
    // ==highlight==
    if (line[i] === "=" && line[i + 1] === "=") {
      const end = line.indexOf("==", i + 2);
      if (end !== -1) {
        result += `<mark>${line.slice(i + 2, end)}</mark>`;
        i = end + 2;
        continue;
      }
    }
    // ~subscript~ (not ~~strikethrough~~)
    if (line[i] === "~" && line[i + 1] !== "~") {
      let j = i + 1;
      while (j < line.length && line[j] !== "~") j++;
      if (j < line.length) {
        result += `<sub>${line.slice(i + 1, j)}</sub>`;
        i = j + 1;
        continue;
      }
    }
    // ^superscript^ (skip [^ footnote refs and ^[ inline footnotes)
    if (line[i] === "^" && line[i - 1] !== "[" && line[i + 1] !== "[") {
      let j = i + 1;
      while (j < line.length && line[j] !== "^") j++;
      if (j < line.length && j > i + 1) {
        result += `<sup>${line.slice(i + 1, j)}</sup>`;
        i = j + 1;
        continue;
      }
    }
    // #tag → clickable link (mirrors the server's inline-tag rules: # at a
    // boundary, a letter next, no heading because a space after # won't match)
    if (line[i] === "#" && /[A-Za-z]/.test(line[i + 1] || "")) {
      const prev = line[i - 1];
      if (i === 0 || /[\s(>"']/.test(prev)) {
        let j = i + 1;
        while (j < line.length && /[\w/-]/.test(line[j])) j++;
        const tag = line.slice(i + 1, j);
        result += `<a class="tag-link" data-tag="${tag}" href="#">#${tag}</a>`;
        i = j;
        continue;
      }
    }
    result += line[i];
    i++;
  }
  return result;
}

function preprocessWikilinks(md) {
  // [[note-name|display text]] → [display text](./note-name.md)
  // [[note-name]] → [note-name](./note-name.md)
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, display) => {
    const text = display ? display.trim() : target.trim();
    return `[${text}](./${target.trim()}.md)`;
  });
}

export function buildPreviewShell(userCss) {
  const clickIntercept = `<script>
document.addEventListener('click', function(e) {
  var a = e.target.closest('a');
  if (!a) return;
  var href = a.getAttribute('href') || '';
  e.preventDefault();
  if (a.dataset && a.dataset.tag) {
    window.parent.postMessage({ type: 'open-tag', tag: a.dataset.tag }, '*');
    return;
  }
  if (!href) return;
  if (href.charAt(0) === '#') {
    var target = document.getElementById(href.slice(1));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    // Any href with a URL scheme (http, https, mailto, zotero, file, obsidian, …)
    // is an external/app link, not a wikilink.
    window.parent.postMessage({ type: 'open-url', href: href }, '*');
  } else {
    window.parent.postMessage({ type: 'wikilink', href: href }, '*');
  }
});
var _scrollSyncTimer = null;
var _ignoringScroll = false;
function _getScrollInfo() {
  var headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  var scrollTop = window.scrollY;
  var scrollHeight = document.documentElement.scrollHeight;
  var clientHeight = document.documentElement.clientHeight;
  var maxScroll = Math.max(1, scrollHeight - clientHeight);
  if (headings.length === 0) return { currentId: null, nextId: null, fraction: scrollTop / maxScroll };
  var curIdx = -1;
  for (var i = 0; i < headings.length; i++) { if (headings[i].offsetTop <= scrollTop + 2) curIdx = i; }
  if (curIdx === -1) {
    var firstTop = headings[0].offsetTop;
    return { currentId: null, nextId: headings[0].id, fraction: firstTop > 0 ? Math.min(1, scrollTop / firstTop) : 0 };
  }
  var cur = headings[curIdx]; var nxt = headings[curIdx + 1] || null; var fraction;
  if (nxt) { var range = nxt.offsetTop - cur.offsetTop; fraction = range > 0 ? (scrollTop - cur.offsetTop) / range : 0; }
  else { var tail = scrollHeight - cur.offsetTop; fraction = tail > 0 ? (scrollTop - cur.offsetTop) / tail : 0; }
  return { currentId: cur.id, nextId: nxt ? nxt.id : null, fraction: Math.max(0, Math.min(1, fraction)) };
}
window.addEventListener('scroll', function() {
  if (_ignoringScroll) return;
  clearTimeout(_scrollSyncTimer);
  _scrollSyncTimer = setTimeout(function() {
    var info = _getScrollInfo();
    window.parent.postMessage({ type: 'preview-scroll', currentId: info.currentId, nextId: info.nextId, fraction: info.fraction }, '*');
  }, 50);
}, { passive: true });
window.addEventListener('message', function(e) {
  if (!e.data) return;
  if (e.data.type === 'scroll-to-heading') { var el = document.getElementById(e.data.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (e.data.type === 'scroll-to-fraction') {
    _ignoringScroll = true;
    var scrollHeight = document.documentElement.scrollHeight;
    var clientHeight = document.documentElement.clientHeight;
    var maxScroll = Math.max(0, scrollHeight - clientHeight);
    var cur = e.data.currentId ? document.getElementById(e.data.currentId) : null;
    var nxt = e.data.nextId ? document.getElementById(e.data.nextId) : null;
    var targetY;
    if (!cur && !nxt) { targetY = e.data.fraction * maxScroll; }
    else if (cur && nxt) { targetY = cur.offsetTop + e.data.fraction * (nxt.offsetTop - cur.offsetTop); }
    else if (cur) { targetY = cur.offsetTop + e.data.fraction * (scrollHeight - cur.offsetTop); }
    else { targetY = e.data.fraction * nxt.offsetTop; }
    window.scrollTo(0, Math.max(0, Math.min(maxScroll, targetY)));
    setTimeout(function() { _ignoringScroll = false; }, 150);
  }
});
<\/script>`;

  const hlCss = `<link rel="stylesheet" href="/assets/hljs-github.min.css" media="(prefers-color-scheme: light)">
<link rel="stylesheet" href="/assets/hljs-github-dark.min.css" media="(prefers-color-scheme: dark)">`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
${hlCss}
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; color: #333; }
img { max-width: 100%; height: auto; }
pre { border-radius: 5px; overflow-x: auto; padding: 12px 16px; font-size: 0.9em; }
pre code { background: none; padding: 0; font-size: inherit; }
code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
mark { background-color: #fff176; color: inherit; padding: 1px 2px; border-radius: 2px; }
.task-list-item { list-style-type: none; margin-left: -20px; }
.task-list-item input[type="checkbox"] { margin-right: 6px; vertical-align: middle; }
dt { font-weight: 600; margin-top: 10px; }
dd { margin-left: 24px; color: #555; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #ddd; padding: 6px 12px; text-align: left; }
th { background: #f5f5f5; font-weight: 600; }
tr:nth-child(even) { background: #fafafa; }
a.footnote-ref { font-size: 0.8em; vertical-align: super; }
sup.footnote-ref { font-size: 0.75em; }
sup.footnote-ref a { text-decoration: none; }
a.footnote-back { text-decoration: none; margin-left: 4px; }
a.tag-link { color: #5a6e8c; background: #eef1f6; padding: 0 5px; border-radius: 8px; font-size: 0.85em; text-decoration: none; white-space: nowrap; }
a.tag-link:hover { background: #dde3ee; }
section.footnotes { margin-top: 2em; border-top: 1px solid #ddd; padding-top: 1em; font-size: 0.9em; }
section.footnotes ol { padding-left: 1.5em; }
section.footnotes li { margin: 0.25em 0; }
@media (prefers-color-scheme: dark) {
  body { background-color: #1e1e1e; color: #e0e0e0; }
  a { color: #6da3f5; }
  code { background: #2d2d2d; }
  mark { background-color: #7a6a00; color: #fff176; }
  dd { color: #aaa; }
  th { background: #2a2a2a; }
  tr:nth-child(even) { background: #242424; }
  th, td { border-color: #444; }
  section.footnotes { border-color: #444; }
  a.tag-link { color: #9bb3d4; background: #2a3344; }
  a.tag-link:hover { background: #34405680; }
}
${userCss}
</style>
</head>
<body>
<div id="hp-body"></div>
${clickIntercept}
<script src="/js/highlight.min.js"><\/script>
</body>
</html>`;
}

function fnSlug(id) {
  return id.replace(/[^\w-]/g, "_");
}

function renderInline(md) {
  if (typeof marked === "undefined") return md;
  return marked.parseInline ? marked.parseInline(md) : marked.parse(md);
}

// marked has no footnote support, so we handle [^id] references and their
// [^id]: definitions ourselves. Definitions are pulled out of the body, each
// reference becomes a numbered superscript link, and a footnotes section is
// returned to append after the rendered body. Run this AFTER the inline/wikilink
// preprocessors so footnote text gets the same treatment and the injected HTML
// (hrefs like #fn-…) isn't itself reprocessed.
function extractFootnotes(md) {
  const lines = md.split("\n");
  const defs = {};
  const kept = [];
  const defRe = /^\[\^([^\]]+)\]:\s?(.*)$/;
  for (let i = 0; i < lines.length; ) {
    const m = lines[i].match(defRe);
    if (m) {
      let content = m[2];
      i++;
      // Absorb indented continuation lines (4 spaces or a tab).
      while (i < lines.length && /^(?:\t| {4})/.test(lines[i])) {
        content += "\n" + lines[i].replace(/^(?:\t| {4})/, "");
        i++;
      }
      defs[m[1]] = content.trim();
    } else {
      kept.push(lines[i]);
      i++;
    }
  }

  const order = [];
  const numById = {};
  const refSeen = {};
  let body = kept.join("\n").replace(/\[\^([^\]]+)\]/g, (full, id) => {
    if (!(id in defs)) return full; // no definition → not a footnote
    if (!(id in numById)) {
      order.push(id);
      numById[id] = order.length;
    }
    const sid = fnSlug(id);
    // Only the first reference carries the back-link anchor id (ids are unique).
    const idAttr = refSeen[id] ? "" : ` id="fnref-${sid}"`;
    refSeen[id] = true;
    return `<sup class="footnote-ref"${idAttr}><a href="#fn-${sid}">${numById[id]}</a></sup>`;
  });

  if (order.length === 0) return { body, footnotesHtml: "" };

  const items = order
    .map((id) => {
      const sid = fnSlug(id);
      return (
        `<li id="fn-${sid}">${renderInline(defs[id])} ` +
        `<a href="#fnref-${sid}" class="footnote-back" aria-label="Back to reference">↩</a></li>`
      );
    })
    .join("");
  return { body, footnotesHtml: `<section class="footnotes"><ol>${items}</ol></section>` };
}

// Render markdown to a body-HTML fragment (no document shell). The shell is
// built once by buildPreviewShell; only this fragment changes per edit.
export function renderMarkdownBody(content) {
  let md = stripFrontMatter(content);
  md = preprocessInlineFootnotes(md);
  md = preprocessInlineSpans(md);
  md = preprocessWikilinks(md);
  const { body, footnotesHtml } = extractFootnotes(md);
  if (typeof marked !== "undefined") return marked.parse(body) + footnotesHtml;
  // Fallback: show raw markdown if marked.js hasn't loaded yet.
  return `<pre>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
}

export function configureMarked() {
  if (typeof marked === "undefined") return;

  const renderer = new marked.Renderer();

  // Give headings slug IDs for scroll sync
  renderer.heading = function (text, level, raw) {
    const slug = raw
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    return `<h${level} id="${slug}">${text}</h${level}>\n`;
  };

  // Checkbox tasks
  renderer.listitem = function (text, task, checked) {
    if (task) {
      return `<li class="task-list-item"><input type="checkbox" disabled${checked ? " checked" : ""}> ${text}</li>\n`;
    }
    return `<li>${text}</li>\n`;
  };

  marked.setOptions({
    renderer,
    gfm: true,
    breaks: false,
    pedantic: false,
  });
}
