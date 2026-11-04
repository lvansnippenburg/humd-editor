- [Shortcuts](#shortcuts)
- [Hints](#markdown)
- [Links](#links)
- [Footnotes](#footnotes)
- [Tables](#tables)
- [Formatted view and Markdown](#formatted-view-and-markdown)
- [Searching](#searching)
- [AI assistance](#ai-assistance)
- [Graph](#graph)
- [Version control](#version-control)
- [Tips](#tips)

## Shortcuts 

All shortcuts work both in the formatted view and in the Markdown source (`⌘/` switches).

| Shortcut | Action |
| --- | --- |
| `⌘S` | Save the current file |
| `Ctrl Tab` | Go to the next open document (after the last one, back to the first) |
| `⌘/` | Switch between the formatted document and its Markdown source |
| `⌘Z` | Undo ^[Note that undo is not reliable when "autosave" is activated in the settings]|
| `⌘Y` or `⌘⇧Z` | Redo |
| `⌘B` | Bold the selection (`**…**`) |
| `⌘I` | Italicise the selection (`_…_`; the formatted view writes `*…*`) |
| `^` with text selected | Superscript the selection (`^…^`); again to undo |
| `~` with text selected | Subscript the selection (`~…~`); again to undo |
| `=` with text selected | Highlight the selection (`==…==`); again to undo |
| `⌘⇧X` | Strike the selection through (`~~…~~`); again to undo |
| `Ctrl 1` or `⌘1` | Make the line a level-1 heading (`# `) |
| `Ctrl 2` or `⌘2` | Make the line a level-2 heading (`## `) |
| `Ctrl 3` or `⌘3` | Make the line a level-3 heading (`### `) |
| `\@` | Open the Zotero (Better BibTeX) citation picker |
| `⌘⇧M` | Insert a comment |
| `⌘⇧T` | Insert a table (choose rows, columns and column alignment) |
| `⌘K` | Insert a link — to a heading of this note, or to an address (`https://…`, `zotero://…`) — around the selection |
| `⌘⇧N` | Insert a footnote with a unique code (`[^x7k2]`) |
| `⌘⇧P` | Proofread the selection — or the whole document if nothing is selected |
| `⌘⇧L` | Translate the selection — or the whole document if nothing is selected |
| `⌘⇧G` | Suggest tags from the vault |
| `⌘F` | Search (in the formatted view: the text as shown) |
| `⌘H` | Search and replace |
| `↑` / `↓` in the file browser | Open the previous / next file |
| `[[` | Suggests note names (for linking) |
| `#` | suggests existing tags |
| `↑` / `↓` | Move through the suggestions |
| `Enter` or `Tab` | Accept the highlighted suggestion |
| `Esc` | Dismiss the popup |
| `Enter` | Confirm (rename, new file) |
| `Esc` | Cancel / close / Dismiss the popup (rename, new file, settings) |
| `⌘`-click (or `Ctrl`-click) | Open the clicked link: a web or app link (`zotero://…`), or a `[[wikilink]]` in the Markdown view |
| `⌘`-click on the settings button | Open the settings file (`~/.humd-editor/settings.json`) in its default editor |


## Markdown

A single return (one press of the enter key) starts a new line in the formatted document. To start a new *paragraph* — with a little space above it — leave a blank line by hitting the enter key twice.
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

You don't have to type these markers yourself: select the text and press `^` (superscript), `~` (subscript) or `=` (highlight), or `⌘⇧X` (strike-through); press it again to remove it. This works in the formatted view and in the Markdown source. Superscript and subscript may not contain ordinary spaces (Pandoc, which prints and exports your documents, then leaves the markers as they are), so spaces in the selection are turned into non-breaking spaces, which look the same.

Underline is not directly supported in Markdown. However if needed you can put your text between `<u>` and '</u>`.

### Links

Creating a link to another Markdown document in the same vault van be done by typing `[[`, as a result a popup menu will appear where you can select the title of the document. To filter, just continue typing the name, use the up- or down-arrows of the keyboard and hit enter to select. Automatically the corresponding `]]` will be added.

Create a link to an external source (eg. a webpage) looks like `[my link description](https://link.to/external/source)`.

The easiest way to make a link is `⌘K`: select the text that should become the link (or not, and type it in the dialog), then choose a heading of this note from the list or enter an address — `https://…`, `zotero://…`, or any other; `www.example.org` gets its `https://` added. A heading link points to the heading's identifier as Pandoc makes it (`#économie-société`), so it also works in printed and exported documents; `⌘`-click it in the editor to go to the heading. With a complete link `[text](target)` selected in the Markdown view, `⌘K` edits it.

An internal link can be created using the headers of the document. By replacing the spaces in the headers with a dash ('the header' -> 'the-header') and adding a hash-sign in front, they become internal links. A link to the section on footnotes in this document would look like: `[About footnotes in Markdown](#footnote)`, which would render as [About footnotes in Markdown](#footnote)

To follow a link, hold `⌘` (or `Ctrl`) and click it to open it in your browser or the matching app. In the Markdown view you can click anywhere on a `[text](address)` link, its text included, or on a bare address; `⌘`-click a `[[wikilink]]` there to open the note. In the formatted view a `[[wikilink]]` opens with a plain click. This works for ordinary web links as well as app links such as `zotero://…`. (On macOS, `⌘`-click is the reliable gesture, since `Ctrl`-click is taken by the system menu.)

### Images

Images are entered as links, but preceded by a `!`. For example: `[this is the logo of Humd Editor](assets/icon-32x32.png)`. Rendered this looks like: ![this is the logo of Humd Editor](assets/icon-32x32.png). There are options to format the image, [here](https://dzone.com/articles/how-to-style-images-with-markdown) are some suggestions and instructions. Remember however that the beauty of using Markdown is that you can concentrate on the text of your article, book, or thesis. Worry about the beauty later.

### Footnotes
There are two ways to insert a footnote. The preferred way in our opinion is typing something like:
```
^[Here is the text of my footnote]
```

This is by far the easiest method, and you can just keep on typing. The footnote number will be generated automatically.

The second way is to press `⌘⇧N` where the footnote should go. This inserts a reference like `[^x7k2]` — a code of four random characters, never one already used in the note — and its definition `[^x7k2]:` directly under the paragraph. In the Markdown view the cursor moves to the definition, so you can type the note right away; in the formatted view you type it in the **Links** panel, which opens with the new footnote's field ready. (A footnote can't contain another footnote.)

You can also type `[^uniqueref]` yourself at the spot where you want to create the footnote. Immediately under the paragraph, or anywhere you like, you can then type the actual content of the footnote.
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

## Formatted view and Markdown

A document is shown **formatted** — headings, bold, lists, quotes, tables, images and links as they will look — and you can edit it right there. Press `⌘/` (or click the button at the right of the editor toolbar) to switch to its **Markdown source**, and again to switch back. The app remembers your choice for the next document and the next time you start it. The line at the bottom of the editor shows the number of words and characters, and which view you're in.

The formatted view uses the styling under **Settings → Preview Styling** — fonts, paragraph spacing, indentation of lists and quotes, heading numbers — the same styling used when printing.

The Markdown file stays the single source of truth: edits in the formatted view are written back to it, so saving, autosave, the outline and version control all keep working. YAML front matter is kept intact (hidden in the formatted view). Only the paragraphs you edit are rewritten: the rest of the file keeps exactly the Markdown you wrote, and Pandoc citations (`[@key]`) and spans (`[text]{.smallcaps}`) stay as they are.

The custom syntax in the formatted view:

| Syntax | In the formatted view |
| --- | --- |
| `==highlight==` | highlighted text |
| `^superscript^`, `~subscript~` | raised / lowered text |
| `[[wikilink]]` | a link — click it to open the note |
| `^[footnote]` and `[^ref]` footnotes | a small numbered marker; the text is shown and edited in the **Links** panel in the sidebar. A `[^ref]` footnote stays a reference footnote with its code, and editing its text there updates its `[^ref]:` definition |
| `[@key, p. 4]` citations | shown as (author, year, page), e.g. (Abulafia, 2014, p. 12); click one to edit its Pandoc text. Fully formatted in your citation style when you print or export to Word |
| `<!-- comments -->` | a small comment marker; point at it to read the comment, click it to open it |
| `#tags` | plain text |

Notes:

- When you edit a paragraph in the formatted view, Milkdown (the editor behind it) writes that paragraph in its own style: `*` and `-` list markers or escaping may change, and inline HTML such as `<br>` is dropped. The meaning stays the same. Paragraphs you don't touch are left exactly as they were — use the Markdown view for anything that must stay character for character.
- Smart quotes (Settings) and the protection of `--` against the Mac's automatic dashes apply when typing in the Markdown view.
- **Spelling** is checked as you type in both views (the Mac's own spell checker, in the languages set under System Settings → Keyboard → Text Input); misspellings are underlined in red. Turn it off with **Enable spell check** in Settings. Text that was already there is checked as the cursor moves through it, or all at once with Edit → Spelling and Grammar → Check Document Now (`⌘;`).
- **Ctrl-click** (or right-click) a word or a selection for the Mac's text menu: spelling suggestions, Look Up, Translate, Writing Tools (Proofread, Rewrite, …), Substitutions, Transformations and Speech. The same items are in the **Edit** menu, where you can also switch on grammar checking (off by default) or automatic spelling correction (follows your Mac's setting). The Mac's smart quotes and dashes are off by default, since the editor has its own smart quotes and Markdown needs straight ones.
- **Print** (the printer button in the toolbar) produces the fully formatted document, with numbered citations and bibliography, through Pandoc.

## Searching

Open the **Search** panel in the sidebar. The two buttons at the top choose how to search.

### Words

Finds every note in your vault containing the text you type (case-insensitive), with the matching lines underneath. Only your Markdown notes are searched, not Zotero. Results update as you type. Click a note name to open it, or a matching line to jump straight to that line.

### LLM search

Ask a question in your own words — for example *"Why did the glassmakers move to Murano?"* — and press `Enter`. The passages from your notes that best match the question are found, and the [AI model](#ai-assistance) reads them and writes an answer, citing its sources as `[note.md:12]`. Click a citation, or one of the **Sources** listed under the answer, to open the note at that line. Your notes are never changed. With a model server on your Mac (oMLX, Ollama) nothing leaves your computer; with a service on the internet, the matching passages are sent to it.

**Also search Zotero (ZotSeek)**, the option under the buttons, sends the same question to your Zotero library as well (see [ZotSeek](#zotseek-find-sources-in-zotero)). The matching publications are listed under **Zotero (ZotSeek)**, below the answer; they appear even when the AI model isn't available. Their **Cite** button inserts the citation at the cursor in the editor. Turn the option off to search only your notes; the choice is remembered.

How it finds passages: keyword matching (good for names and exact terms) combined with *semantic* matching, which also finds passages that say the same thing in other words, in several languages. The model only uses those passages: if they don't contain the answer, it says so — which means the retrieved passages lack it, not necessarily your notes.

Good to know:

- **Requirements:** an AI model (see [AI assistance](#ai-assistance)) and Python 3.9 or newer, for finding the passages. See the README for details.
- **The first question takes a while.** The package for semantic matching is installed automatically (about a minute), and a small search model is downloaded once. The panel shows what is happening. The search model and the index of your notes then stay in memory until 5 minutes after the last question.
- **If installing fails**, only keyword matching is used, and the README explains how to install the package by hand.
- One question is answered at a time. You can switch back to **Words** while an answer is being written; switching to **LLM Search** again shows it.
- Notes in hidden folders (such as `.trash`) are not searched.

## AI assistance

LLM search, Proofread, Translate and Suggest tags use an AI model of your choice, set under **Settings → AI → Model**. Any service with an OpenAI-compatible API works:

- **on the internet**: Gemini, OpenAI, Mistral or Anthropic. These are large models, good at everything below; each needs an account and an API key, and your text is sent to the service.
- **on your Mac**: a model server such as oMLX or Ollama, with a model you have downloaded in it. Your text never leaves your Mac and no account is needed, but the models are smaller. The server has to be running.

Add a model with **➕ Add a model…** at the bottom of the list: choose the service, which fills in its URL (or choose **Other** and enter the URL of any server with the same API, e.g. LM Studio), enter the model name and, if the service needs one, the API key. Adding the same model at the same URL again replaces its settings; **Remove** deletes the selected one. Select the model to use and click **Save**.

**Small model**: tick it in the Add dialog for small models (a few billion parameters, as usually run on a Mac). Proofread and Translate then work one paragraph at a time, with simpler instructions; the side panel shows how far they have got. Such a model is good at spelling and grammar, but weaker at style and translation, and doesn't check the paragraph structure (PEE). Without it, the whole text is sent at once, with the full instructions.

Only one AI task runs at a time: a question, a proofread, a translation or tag suggestions.

### Proofread

Click the **Proofread** button (or press `⌘⇧P`) to review the whole document, or select some text first to review just that part. Suggestions appear in a side panel, in the order of the text. Click a suggestion to highlight the passage it refers to in the editor, and click **Apply** to replace the original text with the suggestion. Markdown syntax (links, footnotes, citations, etc.) is left alone.

Each suggestion is labelled with what kind of finding it is:

- **Language** — grammar, punctuation, spelling (British), clarity and academic tone.
- **Passive voice** — a clause in the passive ("the treaty was signed"). When the text makes clear who acted, an active rewrite is offered that you can apply. Otherwise it is a warning only (no **Apply**): the comment says whether the passive is acceptable here — for example because the actor is unknown — or hides who is responsible.
- **Structure (PEE)** — a paragraph that doesn't follow the order **P**oint (its claim), **E**vidence (sources, quotations, citations, examples), **E**xplanation (what the evidence shows and how it supports the point), or in which one of these is missing or weak. The comment names what is missing or weak and the most important fix. Clicking it highlights the start of the paragraph; there is nothing to apply, as the fix is yours to write. Paragraphs with a sound structure, headings, lists, quotes and footnotes are not reported.

The instructions given to the model are in `PROOFREAD_SYSTEM.md` (`PROOFREAD_SYSTEM_SMALL.md` for a small model), in the app's `src` folder, and can be adjusted to your own house style.

### Translate

Click the **Translate** button (or press `⌘⇧L`) to translate the whole document, or select some text first to translate just that part. The target language is set under **Settings → AI** (default English). Translations appear in the same side panel as proofread suggestions; click **Apply** to replace a passage with its translation, which closes the panel. Markdown syntax is left untranslated.

### Suggest tags

Click the **Suggest tags** button (or press `⌘⇧G`) to get tags for the current document, chosen from the tags already used in your vault. The notes most similar in meaning that already have tags are found (as in [LLM search](#llm-search), with the same requirements), and the AI model picks the tags that fit, with those notes and their tags as examples. No new tags are invented, and tags the document already has are skipped.

The suggestions appear in the side panel, with the similar notes behind each tag. Click a tag to leave it out, then **Add** to put the tags (as `#tags`) on a new line at the bottom of the document; `⌘Z` undoes it.

**Untagged notes:** in the **Tags** panel, open **#notag** and click **Suggest tags for these notes…** to get suggestions for all of them at once. They appear one note at a time (a few seconds each); click a note's name to open it, and **Add** to write its tags into the note. A note that is open in a tab is left alone: add its tags there, or close the tab first.

**Which notes:** tags are learnt from all notes in the vault's folders, but not from notes directly in its top folder. Only untagged notes in the folders listed as `"tagIncludedFolders"` in the settings file (`~/.humd-editor/settings.json`) appear under **#notag**, for example `"tagIncludedFolders": ["annotations", "thoughts"]`. These two are also the default, and a name matches at any depth. There is no control for this in the Settings dialog: `⌘`-click the settings button to open the file. The **#notag** list follows a change after the next save, or when you reopen the app. The lists of the other tags always show all notes.

The first suggestion can take a minute, while the search model loads.

## Graph

The graph shows your notes and tags, and the links between them; notes directly in the vault's top folder are left out. An arrow goes from a note to a note it links to; a dashed line connects a note to one of its tags. Hover over a note for a preview: its file name and first 5 sentences. Hover over a tag to see its name. Hovering also fades everything that isn't connected to the circle. Double-click a note (or `⌘`-click it) to open it.

Choose a tag in the menu at the top to put it in the middle and show only what is related to it. **Steps** sets how far that goes (2 by default): 1 shows the notes with this tag, 2 also the other tags of those notes and the notes they link to or are linked from, and so on. **All notes** shows the whole graph again.

## Version control

If your vault folder is a **Git repository**, Humd Editor keeps it in sync automatically. Your changes are committed and pushed to the remote:

- when the editor loses focus and something has changed,
- every 60 minutes, and
- after you rename, move, or delete a file (renames and moves use `git mv` so history is preserved).

Commit messages are generated from the changes. If a push fails — usually because credentials or a remote aren't set up yet — you'll get a brief notice; fix it by running `git push` once in a terminal (for a new branch, `git push -u origin <branch>`). Folders that are not Git repositories are left untouched.

### Tips

**Files and folders.** Use the **New file** and **New folder** buttons at the top of the Files panel to create items in the vault. Double-click (or move the pointer onto a name and let it rest there for a second) to rename it; if you leave out the extension, it is kept (`chapter` renames `notes.md` to `chapter.md`). Drag a file or folder onto another folder (or onto a file inside it) to move it, onto an empty part of the panel to move it to the top level, or onto the trash to move it to the macOS Trash. Press `Esc` while dragging to cancel. Open folders stay open when files change, and changes made outside the app (in Finder, for example) appear by themselves within a few seconds. Dragging a note into the editor inserts a `[[wikilink]]` to it.

**Quitting with unsaved changes.** When you quit (`⌘Q` or the window's close button) while documents have changes that aren't saved yet — in any tab — the app lists them and asks: **Save All** (or **Save** for one document), **Don't Save**, or **Cancel** to keep working. If something can't be saved, the app stays open. In a browser tab, the browser's own "Leave site?" warning appears instead.

**Browsing files.** Clicking a file in the Files panel opens it *in place of* the current tab if you haven't edited that document, so quickly looking through notes doesn't pile up tabs. A document you have edited — or one that was already open when the app started — keeps its tab, and the file opens in a new one. Images and PDFs you opened can't be edited, so they are always replaced (unless they were already open when the app started). After clicking in the Files panel you can also use `↑` / `↓` to open the previous or next file in the list (files inside collapsed folders are skipped).

**Comments.** Press `⌘⇧M` to insert a comment. Comments are signed with the nickname you set under Settings, are shown as small markers in the margin of the Markdown view and in the text of the formatted view, and never appear in exported documents.

**Citations.** With a bibliography configured in Settings, type `\@` to open the Zotero (Better BibTeX) picker, or write citations yourself in Pandoc's form: `[@key]`, `[@key, p. 12]`, `[see @key, chap. 3; @other]`, or `[-@key]` to leave out the author. In the formatted view they show as (author, year, page) — a key that isn't in your bibliography shows as (@key) in red — and the Markdown keeps the Pandoc citation exactly as written. They are fully formatted, in your citation style, when you print and when you export to Word. The **Links** panel lists the references the note cites, each with how it is cited (`p. 12 · see, chap. 3`). Click one to open the reference in Zotero: with a page number, its PDF opens at that page; otherwise (or without a PDF) the item is selected in your library. Zotero (with Better BibTeX) has to be running. `⌥`-click instead goes to that citation in the note.

Zotero opens a PDF at a *PDF* page, while a citation gives the *printed* page number; in a book these usually differ by the pages before the text starts. If you have annotated the PDF and Zotero knows its page numbers, the difference is taken into account; otherwise the PDF may open a few pages off.

**Export.** Use the **Export to Word** button to produce a `.docx` (this uses Pandoc, with your chosen citation style and reference document if configured). Citations become live Zotero citations through Better BibTeX's `zotero.lua` filter: with Zotero running, press **Refresh** in Word's Zotero tab to finish them, and use **Add/Edit Bibliography** there to insert the bibliography (the export doesn't add one). The editor uses the `zotero.lua` in the same folder as your citation style, or its own copy if there is none there.
