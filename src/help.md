- [Shortcuts](#shortcuts)
- [Hints](#markdown)
- [Links](#links)
- [Footnotes](#footnotes)
- [Tables](#tables)
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
| `⌘F` | Search |
| `⌘H` | Search and replace |
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

## AI assistance

Two buttons in the toolbar use an AI model to help with the document you have open. The provider is configured under **Settings → Proofreading** — choose either **Google Gemini** (remote; needs a free API key) or **Ollama** (local; needs `ollama serve` running and a model pulled, so your text never leaves your machine). If Ollama is selected but not running, the app quietly falls back to Gemini and tells you so.

### Proofread

Click the **Proofread** button to review the whole document, or select some text first to review just that part. Suggestions appear in a side panel. Click a suggestion to highlight the passage it refers to in the editor, and click **Apply** to replace the original text with the correction. Markdown syntax (links, footnotes, citations, etc.) is left alone.

### Suggest tags

Click the **Suggest tags** button to have the model pick, from the tags already used elsewhere in your vault, the ones that best fit the current document. The chosen tags are added (as `#tags`) on a new line at the bottom of the document. Tags that are already present are skipped, and no new tags are invented.

## Version control

If your vault folder is a **Git repository**, Humd Editor keeps it in sync automatically. Your changes are committed and pushed to the remote:

- when the editor loses focus and something has changed,
- every 60 minutes, and
- after you rename, move, or delete a file (renames and moves use `git mv` so history is preserved).

Commit messages are generated from the changes. If a push fails — usually because credentials or a remote aren't set up yet — you'll get a brief notice; fix it by running `git push` once in a terminal (for a new branch, `git push -u origin <branch>`). Folders that are not Git repositories are left untouched.

### Tips

**Files and folders.** Use the **New file** and **New folder** buttons at the top of the Files panel to create items in the vault. Double-click (or simply rest the pointer on) a name to rename it. Drag a file or folder onto another folder to move it, or onto the trash to delete it. Dragging a note into the editor inserts a `[[wikilink]]` to it.

**Comments.** Press `⌘⇧M` to insert a comment. Comments are signed with the nickname you set under Settings, are shown as small markers in the margin of the preview, and never appear in exported documents.

**Citations.** With a bibliography configured in Settings, type `@` to open the Zotero (Better BibTeX) picker, or write citations like `[@key]` yourself. They are resolved in the preview and when you export to Word.

**Export.** Use the **Export to Word** button to produce a `.docx` (this uses Pandoc, with your chosen citation style and reference document if configured).
