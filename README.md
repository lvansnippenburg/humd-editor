# humd-editor

Before using, copying, or modifying this code: **read the [LICENSE.md](LICENSE.md) file.**

A Markdown editor for the humanities. Includes inline footnotes and integration with Zotero (with a little help of BetterBibTex). It is not perfect, but it's the best possible solution if you want to use a plain text format for your writings.

See [Help.md](src/help.md) for information on using the application.

# Installation
The build is not yet code-signed or notarized. After installing the app, you must run the command below.
```
xattr -dr com.apple.quarantine /Applications/Humd Editor.app
```

To install Pandoc either go to https://pandoc.org/installing.html or use brew.
```
brew install pandoc
```
