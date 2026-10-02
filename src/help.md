- [Shortcuts](#shortcuts)
- [Hints](#markdown)
- [Links](#links)
- [Footnotes](#footnotes)
- [Tables](#tables)
- [Rich-text editing](#rich-text-editing)
- [Searching](#searching)
- [AI assistance](#ai-assistance)
- [Version control](#version-control)
- [Tips](#tips)

## Shortcuts 

| Shortcut | Action |
| --- | --- |
| `⌘S` | Save the current file |
| `⌘E` | Toggle the preview pane |
| `⌘Z` | Undo ^[Note that undo is not reliable when "autosave" is activated in the settings]|
| `⌘Y` or `⌘⇧Z` | Redo |
| `⌘B` | Bold the selection (`**…**`) |
| `⌘I` | Italicise the selection (`_…_`) |
| `Ctrl 1` | Make the line a level-1 heading (`# `) |
| `Ctrl 2` | Make the line a level-2 heading (`## `) |
| `Ctrl 3` | Make the line a level-3 heading (`### `) |
| `\@` | Open the Zotero (Better BibTeX) citation picker |
| `⌘⇧M` | Insert a comment |
| `⌘⇧T` | Insert a table (choose rows, columns and column alignment) |
| `⌘⇧P` | Proofread (selection or whole document) |
| `⌘⇧L` | Translate (selection or whole document) |
| `⌘⇧G` | Suggest tags from the vault |
| `⌘F` | Search |
| `⌘H` | Search and replace |
| `↑` / `↓` in the file browser | Open the previous / next file |
| `[[` | Suggests note names (for linking) |
| `#` | suggests existing tags |
| `↑` / `↓` | Move through the suggestions |
| `Enter` or `Tab` | Accept the highlighted suggestion |
| `Esc` | Dismiss the popup |
| `Enter` | Confirm (rename, new file) |
| `Esc` | Cancel / close / Dismiss the popup (rename, new file, settings) |
| `⌘`-click (or `Ctrl`-click) | Open the URL under the cursor in the editor |


## Markdown

A single return (one press of the enter key) starts a new line in the preview. To start a new *paragraph* — with a little space above it — leave a blank line by hitting the enter key twice.
It is also possible to add a \\ before the return to add a blank line without breaking the paragraph flow.

### Formatting

There are three levels of headers, marked by 1,2, or 3 `#` characters, followed by a space and then the text of the headline. Default, headers will be numbered. To suppres the numbers for a header, make sure to put `{-}` at the end.

Text between `**` will be rendered bold.

Text between `_` or `*` will be rendered italic.

Text between `^` will be rendered to superscript as in 2^nd^ (`2^nd^`).

Text between `~` will be rendered to subscript as in H~2~O (`H~2~O`).

Text between `==` will be rendered highlighted as in ==Highlighted== (`==Highlighted==`).

Text between \` (usually named backticks) will be rendered as is. It will be rendered as `code`.

To use one of these special characters literally instead of as formatting, put a backslash in front of it. For example type `\*` for a literal `*`, and likewise `\~`, `\^`, or `\==` when you want a tilde, caret, or double-equals to show up as-is rather than turning text into subscript, superscript, or a highlight.

Text between `~~` (two tildes) will render as strike-through. Which is great to use if you make correction in someone else's text.

Underline is not directly supported in Markdown. However if needed you can put your text between `<u>` and '</u>`.

### Links

Creating a link to another Markdown document in the same vault van be done by typing `[[`, as a result a popup menu will appear where you can select the title of the document. To filter, just continue typing the name, use the up- or down-arrows of the keyboard and hit enter to select. Automatically the corresponding `]]` will be added.

Create a link to an external source (eg. a webpage) looks like `[my link description](https://link.to/external/source)`.

An internal link can be created using the headers of the document. By replacing the spaces in the headers with a dash ('the header' -> 'the-header') and adding a hash-sign in front, they become internal links. A link to the section on footnotes in this document would look like: `[About footnotes in Markdown](#footnote)`, which would render as [About footnotes in Markdown](#footnote)

You don't have to switch to the preview to follow a link: hold `⌘` (or `Ctrl`) and click a URL directly in the editor to open it in your browser or the matching app. This works for ordinary web links as well as app links such as `zotero://…`. (On macOS, `⌘`-click is the reliable gesture, since `Ctrl`-click is taken by the system menu.)

### Images

Images are entered as links, but preceded by a `!`. For example: `[this is the logo of Humd Editor](assets/icon-32x32.png)`. Rendered this looks like: ![this is the logo of Humd Editor](assets/icon-32x32.png). There are options to format the image, [here](https://dzone.com/articles/how-to-style-images-with-markdown) are some suggestions and instructions. Remember however that the beauty of using Markdown is that you can concentrate on the text of your article, book, or thesis. Worry about the beauty later.

### Footnotes
There are two ways to insert a footnote. The preferred way in our opinion is:
`^[Here is the text of my footnote]`
This is by far the easiest method, and you can just keep on typing. The footnote number will be generated automatically.

The second way is to type `[^uniqueref]` at the spot where you want to create the footnote. Immediately under the paragraph, or anywhere you like, you can then type the actual content of the footnote.
```[^uniqueref]: Here is the text of the footnote.``` 
You are responsible for the 'uniqueref', this can be a number or a text, as long as it is unique to this footnote. When rendered your reference will automagically be replaced by the correct number.

### Tables
Tables can be generated by using 'pipes':
```
| Right | Left | Default | Center |
|------:|:-----|---------|:------:|
|   12  |  12  |    12   |    12  |
|  123  |  123 |   123   |   123  |
|    1  |    1 |     1   |     1  |
```
This will render as:
| Right | Left | Default | Center |
|------:|:-----|---------|:------:|
|   12  |  12  |    12   |    12  |
|  123  |  123 |   123   |   123  |
|    1  |    1 |     1   |     1  |

## Rich-text editing

The **rich-text** button in the editor toolbar (just left of the preview toggle) swaps the Markdown source view for a **WYSIWYG** editor, where headings, bold, lists, quotes, tables, links and the humanities syntax below are shown formatted and edited directly. Click it again to return to the Markdown source. It is per editor pane.

The rich-text view uses the same styling as the preview — fonts, paragraph spacing, indentation of lists and quotes, and any CSS you entered under **Settings → Preview Styling** — so a document looks the same in both.

The Markdown file stays the single source of truth: every rich-text edit is written straight back to it, so the preview, saving, autosave, the outline and version control all keep working. YAML front matter is kept intact (hidden while you edit, re-attached automatically).

The custom syntax round-trips through the rich-text view:

| Syntax | In rich-text |
| --- | --- |
| `==highlight==` | highlighted text |
| `^superscript^`, `~subscript~` | raised / lowered text |
| `[[wikilink]]` | a link — click it to open the note |
| `^[footnote]` and `[^ref]` footnotes | a small numbered marker; the text is shown and edited in the **Links** panel in the sidebar, not inline |
| `#tags` | left as plain text |

Notes:

- Reference-style footnotes (`[^id]` with a matching `[^id]:` line) are converted to inline `^[…]` footnotes the first time you edit the document in rich-text mode.
- Switching to rich-text may lightly tidy Markdown (e.g. `*` vs `-` bullet markers). Meaning is unchanged.
- `<!-- comments -->` and the `[[`/`#`/`\@` autocomplete popups are available in source mode only.

## Searching

Open the **Search** panel in the sidebar. The two buttons at the top choose how to search.

### Words

Finds every note containing the text you type (case-insensitive), with the matching lines underneath. Results update as you type. Click a note name to open it, or a matching line to jump straight to that line.

### LLM search

Ask a question in your own words — for example *"Why did the glassmakers move to Murano?"* — and press `Enter`. A language model running **locally on your Mac** reads the passages from your notes that best match the question and writes an answer, citing its sources as `[note.md:12]`. Click a citation, or one of the **Sources** listed under the answer, to open the note at that line. Nothing leaves your computer and your notes are never changed.

How it finds passages: keyword matching (good for names and exact terms) combined with *semantic* matching, which also finds passages that say the same thing in other words, in several languages. The model only uses those passages: if they don't contain the answer, it says so — which means the retrieved passages lack it, not necessarily your notes.

Good to know:

- **Requirements:** a Mac with Apple silicon (M1 or later) and Python 3.9 or newer. See the README for details.
- **First use takes a while.** The needed Python packages are installed automatically (about a minute), and the language model (several GB) and a small search model are downloaded once. The panel shows what is happening. Later questions start much faster: the model stays loaded until you quit the app.
- **If installing fails**, the panel shows the error and the exact commands to install the packages by hand in Terminal.
- One question is answered at a time. You can switch back to **Words** while an answer is being written; switching to **LLM Search** again shows it.
- Notes in hidden folders (such as `.trash`) are not searched.
- **Choosing another model:** add `"llmSearchModel": "<model>"` to `~/.humd-editor/settings.json`, where `<model>` is an MLX model on Hugging Face (e.g. `mlx-community/Qwen2.5-3B-Instruct-4bit` for a smaller, faster one). It is used from the next question on. The default is `mlx-community/Qwen2.5-7B-Instruct-4bit`.

## AI assistance

Three buttons in the toolbar use an AI model to help with the document you have open. The provider is configured under **Settings → Proofreading & translation** — choose either **Mistral** (remote; needs an API key) or **Ollama** (local; needs `ollama serve` running and a model pulled, so your text never leaves your machine). If Ollama is selected but not running, the app quietly falls back to Mistral and tells you so.

### Proofread

Click the **Proofread** button (or press `⌘⇧P`) to review the whole document, or select some text first to review just that part. Suggestions appear in a side panel. Click a suggestion to highlight the passage it refers to in the editor, and click **Apply** to replace the original text with the correction. Markdown syntax (links, footnotes, citations, etc.) is left alone.

### Translate

Click the **Translate** button (or press `⌘⇧L`) to translate the whole document, or select some text first to translate just that part. The target language is set under **Settings → Proofreading & translation** (default English). Translations appear in the same side panel as proofread suggestions; click **Apply** to replace a passage with its translation, which closes the panel. Markdown syntax is left untranslated.

### Suggest tags

Click the **Suggest tags** button (or press `⌘⇧G`) to have the model pick, from the tags already used elsewhere in your vault, the ones that best fit the current document. The chosen tags are added (as `#tags`) on a new line at the bottom of the document. Tags that are already present are skipped, and no new tags are invented.

## Version control

If your vault folder is a **Git repository**, Humd Editor keeps it in sync automatically. Your changes are committed and pushed to the remote:

- when the editor loses focus and something has changed,
- every 60 minutes, and
- after you rename, move, or delete a file (renames and moves use `git mv` so history is preserved).

Commit messages are generated from the changes. If a push fails — usually because credentials or a remote aren't set up yet — you'll get a brief notice; fix it by running `git push` once in a terminal (for a new branch, `git push -u origin <branch>`). Folders that are not Git repositories are left untouched.

### Tips

**Files and folders.** Use the **New file** and **New folder** buttons at the top of the Files panel to create items in the vault. Double-click (or simply rest the pointer on) a name to rename it. Drag a file or folder onto another folder to move it, or onto the trash to delete it. Dragging a note into the editor inserts a `[[wikilink]]` to it.

**Browsing files.** Clicking a file in the Files panel opens it *in place of* the current tab if you haven't edited that document, so quickly looking through notes doesn't pile up tabs. A document you have edited — or one that was already open when the app started — keeps its tab, and the file opens in a new one. Images and PDFs you opened can't be edited, so they are always replaced (unless they were already open when the app started). After clicking in the Files panel you can also use `↑` / `↓` to open the previous or next file in the list (files inside collapsed folders are skipped).

**Comments.** Press `⌘⇧M` to insert a comment. Comments are signed with the nickname you set under Settings, are shown as small markers in the margin of the preview, and never appear in exported documents.

**Citations.** With a bibliography configured in Settings, type `@` to open the Zotero (Better BibTeX) picker, or write citations like `[@key]` yourself. They are resolved in the preview and when you export to Word.

**Export.** Use the **Export to Word** button to produce a `.docx` (this uses Pandoc, with your chosen citation style and reference document if configured).
