// Makes the rich-text (WYSIWYG) editor render with the exact same styling as
// the Markdown preview: fetches preview.css + the user's custom "Preview
// Styling" CSS (Settings) and re-injects them, scoped to the WYSIWYG editor's
// container, via the native CSS `@scope` at-rule. One shared file, one visual
// language — editing a document should look like the document.
//
// preview.css is written for the preview iframe, where the whole document is
// literally `<body>` and content is rendered into `<div id="hp-body">`. The
// WYSIWYG editor lives inline in the app (no `<body>`/`#hp-body` of its own),
// so those two selectors are rewritten to the editor's own root before the
// text is scoped — everything else (img, table, code, mark, footnotes,
// citations, the user's own rules, …) is used completely unmodified.
//
// If `@scope` isn't supported, the browser drops the whole (unrecognised)
// at-rule — the editor just renders unstyled prose rather than leaking these
// rules onto the rest of the app.

const SCOPE_ROOT = ".milkdown-wrap";
// Deliberately NOT prefixed with SCOPE_ROOT again: `@scope` already restricts
// every selector below to inside .milkdown-wrap, and re-mentioning the scope
// root in the selector text (`.milkdown-wrap .editor`) measurably lowers its
// scoping proximity below a bare `*` from the user's custom CSS — losing to it
// regardless of specificity. A bare `.editor` here cascades exactly like
// preview.css's `body` does in the real preview iframe.
const EDITOR_ROOT = ".editor";
const STYLE_EL_ID = "milkdown-preview-style";

let previewCssText = null; // cached fetch of /css/preview.css
let currentUserCss = "";

function rewriteForEditorRoot(css) {
  return css
    .replace(/(^|\n)\s*body\s*\{/g, `$1${EDITOR_ROOT} {`)
    .replaceAll("#hp-body", EDITOR_ROOT);
}

function render() {
  if (previewCssText == null) return; // fetch still in flight
  const el =
    document.getElementById(STYLE_EL_ID) ||
    (() => {
      const s = document.createElement("style");
      s.id = STYLE_EL_ID;
      document.head.appendChild(s);
      return s;
    })();
  const scoped = [rewriteForEditorRoot(previewCssText), rewriteForEditorRoot(currentUserCss)].join(
    "\n",
  );
  el.textContent = `@scope (${SCOPE_ROOT}) {\n${scoped}\n}`;
}

let fetchStarted = false;
function ensureLoaded() {
  if (fetchStarted) return;
  fetchStarted = true;
  fetch("/css/preview.css")
    .then((r) => r.text())
    .then((text) => {
      previewCssText = text;
      render();
    })
    .catch(() => {
      previewCssText = ""; // give up quietly; editor falls back to plain prose
    });
}

// Call once eagerly (e.g. on app init) and again whenever the user saves new
// "Preview Styling" CSS in Settings, so any already-open WYSIWYG view picks it
// up live.
export function setPreviewStyleUserCss(userCss) {
  currentUserCss = userCss || "";
  ensureLoaded();
  render();
}

// Call before/when mounting a WYSIWYG editor, to make sure the stylesheet
// exists even if setPreviewStyleUserCss was never called yet this session.
export function ensurePreviewStyleLoaded() {
  ensureLoaded();
}
