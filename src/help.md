- [Shortcuts](#shortcuts)
- [Hints](#markdown)
- [Footnotes](#footnotes)
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


## Markdown

Most importantly: a single return has no value in markdown. To start a new paragraph, you'll have to hit the enter key twice.

### Formatting

There are three levels of headers, marked by 1,2, or 3 `#` characters, followed by a space and then the text of the headline.

Text between `**` will be rendered bold.

Text between `_` will be rendered italic.

Text between `^` will be rendered to superscript as in 2^nd^ (`2^nd^`).

Text between `~` will be rendered to subscript as in H~2~O (`H~2~O`).

Text between `==` will be rendered highlighted as in ==Highlighted== (`==Highlighted==`).

Text between \` (usually named backticks) will be rendered as is. It will be rendered as `code`. Some of these special characters will require a backslash if you want to use them individually, which is also true for the \* (type `\*`).

Text between `~~` (two tildes) will render as strike-through. Which is great to use if you make correction in someone else's text.

Underline is not directly supported in Markdown. However if needed you can put your text between `<u>` and '</u>`.

### Links

Creating a link to another Markdown document in the same vault van be done by typing `[[`, as a result a popup menu will appear where you can select the title of the document. To filter, just continue typing the name, use the up- or down-arrows of the keyboard and hit enter to select. Automatically the corresponding `]]` will be added.

Create a link to an external source (eg. a webpage) looks like `[my link description](https://link.to/external/source)`.

An internal link can be created using the headers of the document. By replacing the spaces in the headers with a dash ('the header' -> 'the-header') and adding a hash-sign in front, they become internal links. A link to the section on footnotes in this document would look like: `[About footnotes in Markdown](#footnote)`, which would render as [About footnotes in Markdown](#footnote)

### Images

Images are entered as links, but preceded by a `!`. For example: `[this is the logo of Humd Editor](assets/icon-32x32.png)`. Rendered this looks like: ![this is the logo of Humd Editor](assets/icon-32x32.png). There are options to format the image, [here](https://dzone.com/articles/how-to-style-images-with-markdown) are some suggestions and instructions. Remember however that the beauty of using Markdown is that you can concentrate on the text of your article, book, or thesis. Worry about the beauty later.

### Footnotes
There are two ways to insert a footnote. The preferred way in our opinion is:
`^[Here is the text of my footnote]`
This is by far the easiest method, and you can just keep on typing. The footnote number will be generated automatically.

The second way is to type `[^uniqueref]` at the sport where you want top create the footnote. Immediately under the paragraph, or anywhere you like you can the type the actual content of the footnote.
```[^uniqueref]: Here is the text of the footnote.``` 
You are responsible for the 'uniqueref', this can be a number or a text, as long as it is unique to this footnote. When rendered your reference will automagically be replaced by the correct number.

### Tips
