// Headless parse -> (no edit) -> serialize check for the custom syntax.
import "global-jsdom/register";

// Milkdown/ProseMirror call bare `addEventListener`/`dispatchEvent`; in a browser
// those resolve on the global, jsdom only puts them on `window`.
for (const k of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
  if (typeof globalThis[k] !== "function") globalThis[k] = window[k].bind(window);
}
// Node 24 ships its own global Event/*Event; force jsdom's so instanceof checks
// inside jsdom's dispatchEvent pass.
for (const k of ["Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "InputEvent", "UIEvent", "FocusEvent", "ClipboardEvent", "DragEvent"]) {
  if (window[k]) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
}
if (!globalThis.matchMedia && !window.matchMedia) {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}

const { createEditor } = await import("../src/js/vendor/milkdown.bundle.js");

const samples = [
  "Text with ==highlight== inside.",
  "Water is H~2~O and E = mc^2^ squared.",
  "A [[Wiki Page]] and a [[target|shown label]] link.",
  "A claim.^[This is the footnote text.] And more.",
  "GFM ref style.[^a]\n\n[^a]: Reference footnote body.",
  "Mixed: ==marked== then ^sup^ and ~sub~ near #tag stays.",
  "| A | B |\n| - | - |\n| 1 | 2 |",
  "- [ ] task\n- [x] done",
  "**bold** and _em_ and `code` and ~~strike~~ unchanged.",
];

let pass = 0,
  fail = 0;
for (const src of samples) {
  document.body.innerHTML = "<div id=root></div>";
  const root = document.getElementById("root");
  const h = await createEditor({ root, value: src, onChange: () => {} });
  const out = h.getMarkdown().trim();
  const fns = h.getFootnotes();
  await h.destroy();
  const ok = normalise(out) === normalise(src) || acceptable(src, out);
  console.log(ok ? "  ok   " : " FAIL  ", JSON.stringify(src));
  if (!ok) console.log("         got:", JSON.stringify(out));
  if (fns.length) console.log("         footnotes:", JSON.stringify(fns.map((f) => f.content)));
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function normalise(s) {
  return s.replace(/\s+/g, " ").trim();
}
function acceptable(src, out) {
  if (src.includes("[^a]")) return out.includes("^[Reference footnote body.]") && !out.includes("[^a]");
  if (src.includes("- [ ] task")) return /[-*]\s*\[ \]\s*task/.test(out) && /[-*]\s*\[x\]\s*done/i.test(out);
  if (src.includes("| A | B |")) return out.includes("| A") && out.includes("B |") && out.includes("1") && out.includes("2");
  if (src.includes("_em_")) return /\bbold\b/.test(out) && /\bem\b/.test(out) && out.includes("`code`") && out.includes("~~strike~~");
  return false;
}
