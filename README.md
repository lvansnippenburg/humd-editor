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

## Python

**The app (`Humd Editor.app`) does not need Python:** it contains its own copy of Python. You only need to install Python yourself to run the editor from source, to build the app, or to use [LLM search](#llm-search-optional).

**Running from source** needs Python 3.10 or newer (from https://www.python.org or `brew install python`). The server only uses Python's standard library, so nothing else has to be installed. Start it with:
```
./run.sh            # serves the editor on http://127.0.0.1:8082 and opens it in your browser
./run.sh 8090       # same, on another port
```
To show the editor in its own window instead of a browser tab, install pywebview and start the desktop launcher:
```
python3 -m pip install pywebview
python3 server/desktop.py
```

**Building the app** needs PyInstaller and pywebview in the same Python; `./build_app.sh` finds a suitable Python or creates a build environment. See the comments at the top of `build_app.sh`.

## ZotSeek (optional)

The **ZotSeek** text action finds sources in your Zotero library for a selected sentence and inserts the citation (see [Help.md](src/help.md#zotseek-find-sources-in-zotero)). It needs, in Zotero:

- the ZotSeek plugin, with its library indexed and its MCP server enabled in ZotSeek's preferences (the editor calls `http://localhost:23119/zotseek/mcp`), and
- [Better BibTeX](https://retorque.re/zotero-better-bibtex/), which turns Zotero items into citation keys (also used by the `@` citation picker).

Nothing else has to be installed in the editor, and all searching happens locally in Zotero.

## AI (optional)

**LLM search**, **Suggest tags**, **Proofread** and **Translate** use an AI model of your choice (see [Help.md](src/help.md#ai-assistance)). Any service with an OpenAI-compatible chat API works: on the internet Gemini, OpenAI, Mistral or Anthropic (each needs an API key), or a model server on your Mac such as oMLX or [Ollama](https://ollama.com), which keeps your text on it. Add one under **Settings → AI → Model → ➕ Add a model…**: choose the service (which fills in its URL) or enter any URL, the model name and, if the service needs one, the API key. The selected model is used by all four functions.

For example, for oMLX: service **oMLX** (URL `http://127.0.0.1:8000/v1`), the model's name as oMLX lists it, its API key if you set one in oMLX, and **Small model** on.

**Small model.** Tick it for small local models (a few billion parameters). Proofread and Translate then work one paragraph at a time, with simpler prompts that such models handle well; large models get the whole selection at once, with the full prompts (which also check the paragraph structure). The prompts are the `src/*_SYSTEM.md` files (`*_SMALL.md` for small models), and can be edited.

The models are stored in `~/.humd-editor/settings.json` as `"aiModels"` (with their API keys), and the selected one as `"aiModel"`.

## LLM search (optional)

The **LLM Search** option in the Search panel answers questions about your notes ([Help.md](src/help.md#llm-search)): the passages that best match the question are found in your notes, and the AI model answers from them. **Suggest tags** finds the notes most similar to the one being tagged in the same way ([Help.md](src/help.md#suggest-tags)). Finding passages and similar notes is done by [`server/mdsearch.py`](server/mdsearch.py), which runs as a separate process and needs **Python 3.9 or newer** (`python3`), also when you use the app, because the app's built-in Python can't install packages. From source the editor uses the Python that runs the server; the app looks for `python3` in the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, python.org's framework). Get it from https://www.python.org or with `brew install python`.

Passages are found by keyword matching combined with *semantic* matching, which needs the `fastembed` package. On first use it is installed automatically into a private environment at `~/.humd-editor/mdsearch-venv`, so your own Python installation is left untouched, and a small multilingual search model is downloaded once. If that fails, only keyword matching is used (and Suggest tags gets no similar notes as examples); you can also install it yourself:
```
python3 -m venv ~/.humd-editor/mdsearch-venv
~/.humd-editor/mdsearch-venv/bin/python -m pip install fastembed
```
Passage embeddings are cached in `~/.cache/mdsearch`, so only new or changed notes are processed later. The process keeps the search model and the index in memory, and stops after 5 minutes without a request (`WORKER_IDLE_TIMEOUT` in `server/server.py`).

**Removing it.** Delete `~/.humd-editor/mdsearch-venv` and `~/.cache/mdsearch`.

**Building the app.** `build_app.sh` bundles `mdsearch.py` into `Humd Editor.app`; `fastembed` is not bundled and is installed on first use as described above.
