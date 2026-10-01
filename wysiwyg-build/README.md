# wysiwyg-build

Build tooling for the **rich-text (WYSIWYG) editor**, which is built on
[Milkdown](https://milkdown.dev/) (ProseMirror + remark).

The app itself has no bundler, so this folder produces a single vendored ESM
file that the app loads directly:

```
npm install        # once
npm run build      # -> ../src/js/vendor/milkdown.bundle.js  (committed)
npm test           # headless parse -> serialize round-trip check
```

`../src/js/vendor/milkdown.bundle.js` **is committed**. The desktop build
(`build_app.sh` / PyInstaller) just ships `src/`; it never runs Node. Re-run
`npm run build` and commit the result whenever anything in this folder changes.

## Files

| File | Purpose |
| --- | --- |
| `src/entry.js` | Public surface: `createEditor()` |
| `src/editor.js` | Milkdown factory + the get/set-markdown, footnote and renumber helpers the app calls |
| `src/syntax.js` | **The custom-syntax layer.** Teaches Milkdown humd's humanities Markdown so it survives parse → edit → serialize |
| `build.mjs` | esbuild config |
| `test-roundtrip.mjs` | jsdom round-trip assertions |

## Custom syntax (see `src/syntax.js`)

| Markdown | Editor | Notes |
| --- | --- | --- |
| `==highlight==` | `<mark>` | ProseMirror mark |
| `^superscript^` | `<sup>` | ProseMirror mark |
| `~subscript~` | `<sub>` | ProseMirror mark; GFM single-tilde strikethrough is disabled so `~x~` is subscript and only `~~x~~` is strikethrough — matching `src/js/markdown.js` |
| `[[target]]` / `[[target\|label]]` | `<a class="wikilink" href="file://…">` | inline atom node; click opens the note |
| `^[footnote]` | numbered `<sup class="footnote-ref">` marker | inline atom node; body lives in an attribute and is shown/edited in the **Links** sidebar panel, never inline |
| GFM `[^id]` + `[^id]: …` | same footnote node | folded to inline `^[…]` on the first serialize (documented one-way change; a footnote referenced more than once collapses to repeated inline notes) |
| `#tag` | plain text | left untouched by design |

YAML front matter is split off before Milkdown sees it and re-attached on write
(handled in `src/js/wysiwyg.js`, not here).
