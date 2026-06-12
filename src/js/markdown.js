// Client-side Markdown rendering: front-matter stripping, custom inline
// preprocessing (footnotes, highlight/sub/sup, #tags, wikilinks), and the
// preview iframe HTML. Pure functions — no app state. `marked` is read from
// the global scope (loaded dynamically at startup).

// Resolve a relative image path to an absolute path given the current file's
// directory. Used to convert ![alt](../images/foo.png) to a full path the
// server can serve.
function resolveImagePath(relPath, filePath) {
  if (!filePath || !relPath || relPath.startsWith("/") || relPath.startsWith("http")) {
    return relPath; // absolute or external, leave unchanged
  }
  // Split filePath into directory and filename.
  const lastSlash = filePath.lastIndexOf("/");
  const fileDir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : "/";
  // Resolve the relative path: ../images/foo.png from /vault/thesis/file.md
  // becomes /vault/images/foo.png
  const parts = (fileDir + "/" + relPath).split("/");
  const resolved = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      continue;
    } else if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return "/" + resolved.join("/");
}

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
    // BUT: skip if this is (#anchor) — part of a markdown link reference [text](#anchor)
    if (line[i] === "#" && /[A-Za-z]/.test(line[i + 1] || "")) {
      const prev = line[i - 1];
      const isLinkAnchor = prev === "(" && /[\w-]+\)/.test(line.slice(i + 1));
      if ((i === 0 || /[\s(>"']/.test(prev)) && !isLinkAnchor) {
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
// Move comment balloons to the gutter
function repositionComments() {
  var gutter = document.getElementById('preview-comment-gutter');
  var comments = document.querySelectorAll('.hp-comment');

  comments.forEach(function(cmt) {
    // Get the position of the comment relative to the viewport
    var rect = cmt.getBoundingClientRect();

    // Create a balloon in the gutter at the same vertical position
    var balloon = document.createElement('div');
    balloon.className = 'preview-comment-balloon';
    balloon.innerHTML = cmt.innerHTML;
    balloon.title = cmt.title;
    balloon.setAttribute('data-text', cmt.getAttribute('data-text'));
    balloon.style.position = 'absolute';
    // Position at the top of the line this comment is on, relative to the page
    balloon.style.top = (rect.top + window.scrollY) + 'px';
    balloon.style.left = '2px';
    balloon.style.pointerEvents = 'auto';

    balloon.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      const fullContent = balloon.getAttribute('data-text') || '';
      window.parent.postMessage({ type: 'comment', content: fullContent }, '*');
    });

    gutter.appendChild(balloon);
    cmt.remove();  // Remove the original inline comment
  });
}

window.addEventListener('load', repositionComments);
window.addEventListener('resize', repositionComments);

document.addEventListener('click', function(e) {
  var cmt = e.target.closest('.hp-comment');
  if (cmt) {
    e.preventDefault();
    const fullContent = cmt.getAttribute('data-text') || '';
    window.parent.postMessage({ type: 'comment', content: fullContent }, '*');
    return;
  }
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
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; padding: 20px; max-width: 800px; margin: 0 auto; color: #333; position: relative; }
#preview-comment-gutter { position: absolute; top: 0; left: 0; bottom: 0; width: 22px; pointer-events: none; overflow: hidden; }
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
.hp-comment { display: inline-block; color: #2563eb; opacity: 0.75; cursor: pointer; user-select: none; }
.preview-comment-balloon { display: inline-block; color: #2563eb; opacity: 0.75; user-select: none; }
.preview-comment-balloon:hover { opacity: 1; }
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
<div id="preview-comment-gutter"></div>
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
// Rewrite <img src="..."> tags in the rendered HTML to use the /api/image
// endpoint (for the sandboxed iframe to access vault images). Resolves relative
// paths using the current file's directory, then converts to API URLs.
export function rewriteImageSources(htmlElement, filePath) {
  if (!htmlElement) return;
  const imgs = htmlElement.querySelectorAll("img");
  const port = location.port || (location.protocol === "https:" ? 443 : 80);
  const apiBase = `http://127.0.0.1:${port}/api/image?path=`;
  for (const img of imgs) {
    const src = img.getAttribute("src") || "";
    // Only rewrite local file paths (not external URLs or data URIs).
    if (src && !src.startsWith("http") && !src.startsWith("data:")) {
      // Resolve relative paths using the current file's directory.
      const resolved = resolveImagePath(src, filePath);
      img.setAttribute("src", apiBase + encodeURIComponent(resolved));
    }
  }
}

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Parse comment thread from JSON or old format
function parseCommentThread(content) {
  try {
    const trimmed = content.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return JSON.parse(trimmed);
    }
  } catch (e) {
    // Fall back to old format
  }
  // Fallback for old format "nickname YYYY-MM-DD HH:MM: text"
  const dm = content.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\s*(.*)/s);
  if (dm) {
    return [{ creator: dm[1].trim(), timestamp: dm[2], comment: dm[3] }];
  }
  return [{ creator: "Comment", timestamp: "", comment: content }];
}

// Extract the author nickname from a comment thread (first creator)
export function commentNick(content) {
  const thread = parseCommentThread(content);
  return (thread && thread[0] ? thread[0].creator : "Comment") || "Comment";
}

// Inline SVG speech-bubble for comment balloons in both the editor gutter and
// the preview (an emoji glyph isn't reliably available across fonts).
export const COMMENT_BALLOON_SVG =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' +
  '<path fill="currentColor" d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6A1.5 1.5 0 0 1 13 ' +
  '11.5H7.2l-3 2.6a.5.5 0 0 1-.83-.38V11.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z"/>' +
  "</svg>";

// Replace HTML comments with plain alphanumeric tokens (HPCOMMENTn) so the
// markdown processor — marked or Pandoc — leaves them untouched, and return the
// balloon HTML for each so the caller can splice them back into the rendered
// output. Mirrors the citation-protection pattern; runs for both render paths.
export function extractComments(content) {
  const balloons = [];
  const text = content.replace(/<!--([\s\S]*?)-->/g, (_full, inner) => {
    const body = inner.trim();
    const nick = commentNick(body);
    const idx = balloons.length;
    balloons.push(
      `<span class="hp-comment" title="${escapeHtmlAttr(nick)}" ` +
        `data-text="${escapeHtmlAttr(body)}">${COMMENT_BALLOON_SVG}</span>`,
    );
    return `HPCOMMENT${idx}`;
  });
  return { text, balloons };
}

// Splice balloon HTML back in for the HPCOMMENTn tokens left by extractComments.
export function restoreComments(html, balloons) {
  if (!balloons || balloons.length === 0) return html;
  return html.replace(/HPCOMMENT(\d+)/g, (_, i) => balloons[Number(i)] || "");
}

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

// Store citations so they can be restored in the DOM after rendering.
window._citationsToRestore = [];

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

// A simple yet robust DOM-based HTML sanitizer to prevent XSS.
// It parses the HTML into a temporary document fragment, then traverses
// and cleans up illegal elements and attributes.
export function sanitizeHtml(html) {
  if (typeof document === "undefined") return html;
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const allowedTags = new Set([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "br",
    "hr",
    "pre",
    "code",
    "blockquote",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "a",
    "span",
    "img",
    "div",
    "em",
    "strong",
    "del",
    "s",
    "ins",
    "mark",
    "sub",
    "sup",
    "svg",
    "path",
  ]);

  const removeCompletelyTags = new Set(["script", "style", "iframe", "object", "embed", "form"]);

  const allowedAttributes = {
    a: ["href", "title", "class", "data-tag"],
    img: ["src", "alt", "title", "class", "style"],
    span: ["class", "style", "title", "data-text", "id"],
    div: ["class", "id", "style"],
    li: ["class"],
    pre: ["class"],
    code: ["class"],
    mark: ["class"],
    p: ["class", "style"],
    h1: ["id", "class"],
    h2: ["id", "class"],
    h3: ["id", "class"],
    h4: ["id", "class"],
    h5: ["id", "class"],
    h6: ["id", "class"],
    svg: ["viewbox", "width", "height", "aria-hidden", "class", "style"],
    path: ["fill", "d"],
  };

  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName.toLowerCase();
      if (removeCompletelyTags.has(tagName)) {
        node.remove();
        return;
      }
      if (!allowedTags.has(tagName)) {
        // Replace node with its children (unwrap it)
        const fragment = document.createDocumentFragment();
        while (node.firstChild) {
          fragment.appendChild(node.firstChild);
        }
        node.replaceWith(fragment);
        return;
      }

      // Check and sanitize attributes
      const allowedAttrs = allowedAttributes[tagName] || [];
      const attrs = Array.from(node.attributes);
      for (const attr of attrs) {
        const attrName = attr.name.toLowerCase();
        // Allow all data- attributes, or attributes in the allowed list
        if (!allowedAttrs.includes(attrName) && !attrName.startsWith("data-")) {
          node.removeAttribute(attr.name);
          continue;
        }

        // Additional URL/scheme sanitization for href and src
        if (attrName === "href" || attrName === "src") {
          const value = attr.value.trim().toLowerCase();
          if (value.startsWith("javascript:") || value.startsWith("data:text/html")) {
            node.removeAttribute(attr.name);
          }
        }
      }

      // Recursively sanitize children. Since we might modify the tree, use Array.from.
      const children = Array.from(node.childNodes);
      for (const child of children) {
        sanitizeNode(child);
      }
    }
  }

  // Sanitize from body
  const body = doc.body;
  const children = Array.from(body.childNodes);
  for (const child of children) {
    sanitizeNode(child);
  }

  return body.innerHTML;
}
