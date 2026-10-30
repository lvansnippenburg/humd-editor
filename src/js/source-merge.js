// Write edits made in the formatted (Milkdown) view back into the Markdown
// source without rewriting the rest of the document.
//
// Milkdown can only produce Markdown by serialising its whole document, and
// that output differs from what the author wrote: list markers, escaped
// characters, reference footnotes turned inline, inline HTML dropped — and
// Pandoc syntax escaped so it stops working (`[@key]` becomes `\[@key]`).
// So the serialised text is never written back as a whole. Instead:
//   - `base` is Milkdown's serialisation of the document as loaded, `next`
//     its serialisation now. If they are equal nothing was edited.
//   - Otherwise only the blocks (paragraphs, list items, …) between the first
//     and last changed block are replaced by Milkdown's version of them;
//     everything before and after keeps the author's exact source text.
//   - In the replaced blocks, escapes Milkdown adds to Pandoc citations and
//     bracketed spans are undone.
//   - Footnote definitions ([^id]: …) aren't part of Milkdown's document, so
//     those in the replaced region are kept; reconcileFootnoteDefinitions
//     then brings them in line with the footnotes in the formatted view.

// Split Markdown into blocks separated by blank lines; a fenced code block
// (``` or ~~~) is one block even if it contains blank lines.
export function splitBlocks(md) {
  const blocks = [];
  let pos = 0;
  let cur = null;
  let fence = null;
  for (const line of md.split("\n")) {
    const end = pos + line.length;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      cur.end = end;
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
    } else if (line.trim() === "") {
      if (cur) blocks.push(cur);
      cur = null;
    } else {
      if (cur) cur.end = end;
      else cur = { start: pos, end };
      if (fenceMatch) fence = fenceMatch[1];
    }
    pos = end + 1;
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ ...b, text: md.slice(b.start, b.end) }));
}

// A block's content with the differences Milkdown introduces evened out
// (escapes, list/emphasis markers, table rules, spacing), to recognise the
// same block in the source and in the serialisation.
function blockKey(text) {
  return text.replace(/\\/g, "").replace(/[\s*_+\-|:]/g, "");
}

// For each block of `serialised`, the index of the same block in `source`
// (or undefined). Both are in document order; the source may have extra
// blocks Milkdown drops (e.g. reference footnote definitions), so each block
// is looked for a few blocks ahead.
function alignBlocks(serialised, source) {
  const map = [];
  let t = 0;
  for (let s = 0; s < serialised.length; s++) {
    const key = blockKey(serialised[s].text);
    for (let k = t; k < Math.min(source.length, t + 8); k++) {
      if (blockKey(source[k].text) === key) {
        map[s] = k;
        t = k + 1;
        break;
      }
    }
  }
  return map;
}

// Undo the escapes Milkdown's serialiser adds to Pandoc syntax:
// citations `\[@key, p. 4]`, `\[-\@key]`, `\[see @key]`, and bracketed spans
// `\[text]{.smallcaps}`.
export function unescapePandoc(text) {
  return text
    .replace(/\\\[([^\]\n]*?@[^\]\n]*)\]/g, (_, inner) => `[${inner.replace(/\\@/g, "@")}]`)
    .replace(/\\\[([^\]\n]*)\]\{/g, "[$1]{");
}

// The source with the edit (base → next) applied; see the comment at the top.
export function mergeEdit(source, base, next) {
  if (next === base) return source;
  const S0 = splitBlocks(base);
  const S1 = splitBlocks(next);
  const T = splitBlocks(source);

  // Blocks unchanged at the start and the end of the document.
  let head = 0;
  while (head < S0.length && head < S1.length && S0[head].text === S1[head].text) head++;
  let tail = 0;
  while (
    tail < S0.length - head &&
    tail < S1.length - head &&
    S0[S0.length - 1 - tail].text === S1[S1.length - 1 - tail].text
  ) {
    tail++;
  }

  // Place the edit in the source between the nearest untouched blocks that
  // can be found there. Blocks Milkdown changed beyond recognition (e.g. one
  // with inline HTML, or a reference footnote) can't be: if one borders the
  // edit, it is replaced too, by Milkdown's (equivalent) version of it.
  const map = alignBlocks(S0, T);
  while (head > 0 && map[head - 1] === undefined) head--;
  while (tail > 0 && map[S0.length - tail] === undefined) tail--;
  const before = head > 0 ? map[head - 1] : -1; // last untouched source block before the edit
  const after = tail > 0 ? map[S0.length - tail] : T.length; // first untouched one after it
  const replacement = S1.slice(head, S1.length - tail).map((b) => unescapePandoc(b.text));
  if (after <= before) return unescapePandoc(next); // can't place it: Milkdown's whole text

  // Footnote definitions in the replaced region stay (Milkdown drops them).
  for (let k = before + 1; k < after; k++) {
    if (isDefinitionBlock(T[k].text) || (isIndented(T[k].text) && k > before + 1 && isDefinitionBlock(T[k - 1].text))) {
      replacement.push(T[k].text);
    }
  }

  const startPos = before >= 0 ? T[before].end : 0;
  const endPos = after < T.length ? T[after].start : source.length;
  const parts = [source.slice(0, startPos), replacement.join("\n\n"), source.slice(endPos)];
  if (after === T.length) parts[2] = ""; // re-add the file's trailing newline(s) below
  let result = parts
    .map((p, i) => (i === 0 ? p.replace(/\n+$/, "") : i === 2 ? p.replace(/^\n+/, "") : p))
    .filter((p) => p !== "")
    .join("\n\n");
  if (after === T.length) result += source.match(/\n*$/)[0] || "";
  return result;
}

// ---- Reference footnotes: [^id] in the text, "[^id]: text" definitions ----

const DEFINITION_RE = /^\[\^([^\]\s]+)\]:/;
const isDefinitionBlock = (text) => DEFINITION_RE.test(text);
const isIndented = (text) => /^( {4}|\t)/.test(text);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The definitions in `text`: [{ id, start, end, content }], where a
// definition continues with indented paragraphs after it. `content` is
// normalised like the Milkdown bundle does (continuation lines un-indented).
export function findDefinitions(text) {
  const blocks = splitBlocks(text);
  const defs = [];
  for (let i = 0; i < blocks.length; i++) {
    const m = blocks[i].text.match(DEFINITION_RE);
    if (!m) continue;
    const start = blocks[i].start;
    let end = blocks[i].end;
    while (i + 1 < blocks.length && isIndented(blocks[i + 1].text)) end = blocks[++i].end;
    const content = text
      .slice(start + m[0].length, end)
      .replace(/\n {1,4}/g, "\n")
      .trim();
    defs.push({ id: m[1], start, end, content });
  }
  return defs;
}

// "[^id]: first line", further lines indented by four spaces.
export function formatDefinition(id, content) {
  return content
    .split("\n")
    .map((line, i) => (i === 0 ? `[^${id}]: ${line}`.trimEnd() : line ? `    ${line}` : ""))
    .join("\n");
}

// Where a new definition for [^id] goes: after the paragraph with the
// reference, below any definitions already following it; else at the end.
function definitionInsertPos(text, id) {
  const ref = new RegExp(`\\[\\^${escapeRe(id)}\\](?!:)`).exec(text);
  const blocks = splitBlocks(text);
  if (!ref) return text.length;
  let i = blocks.findIndex((b) => b.start <= ref.index && ref.index <= b.end);
  if (i < 0) return text.length;
  while (i + 1 < blocks.length && (isDefinitionBlock(blocks[i + 1].text) || isIndented(blocks[i + 1].text))) i++;
  return blocks[i].end;
}

// Insert "[^id]: content" as its own block; returns { text, cursor } with
// the cursor at the end of the new definition.
export function addFootnoteDefinition(text, id, content = "") {
  const pos = definitionInsertPos(text, id);
  const def = formatDefinition(id, content);
  const before = text.slice(0, pos).replace(/\n*$/, "");
  const after = text.slice(pos).replace(/^\n*/, "");
  const lead = before ? `${before}\n\n` : "";
  const result = lead + def + (after ? `\n\n${after}` : "\n");
  return { text: result, cursor: lead.length + def.length };
}

// Make the definitions match the reference footnotes in the formatted view
// ([{ id, content }]): update changed ones, add missing ones, and remove
// those whose reference is gone from the text.
export function reconcileFootnoteDefinitions(text, footnotes) {
  let out = text;
  for (const fn of footnotes.filter((f) => f.id)) {
    const def = findDefinitions(out).find((d) => d.id === fn.id);
    if (!def) out = addFootnoteDefinition(out, fn.id, fn.content).text;
    else if (def.content !== fn.content.trim()) {
      out = out.slice(0, def.start) + formatDefinition(fn.id, fn.content) + out.slice(def.end);
    }
  }
  for (const def of findDefinitions(out).reverse()) {
    const referenced = new RegExp(`\\[\\^${escapeRe(def.id)}\\](?!:)`).test(out);
    if (!referenced) {
      out = (out.slice(0, def.start).replace(/\n+$/, "") + "\n\n" + out.slice(def.end).replace(/^\n+/, "")).replace(/^\n\n/, "");
    }
  }
  return out;
}

// A footnote code not used in `text`: 4 random letters/digits.
export function uniqueFootnoteId(text) {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no look-alikes (l/1, o/0)
  for (;;) {
    let id = "";
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!text.includes(`[^${id}]`)) return id;
  }
}

