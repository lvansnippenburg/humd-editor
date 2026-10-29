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
