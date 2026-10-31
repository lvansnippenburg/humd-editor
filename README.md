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

## apfel: Apple's on-device model (optional)

Proofread and Translate can use the language model built into macOS, through [apfel](https://github.com/Arthur-Ficial/apfel). Your text never leaves your Mac, and no account or API key is needed. It requires:

- macOS 26 (Tahoe) or newer on a Mac with Apple silicon (M1 or later), and
- Apple Intelligence turned on (System Settings → Apple Intelligence & Siri).

Install apfel with Homebrew, and check that the model is available:
```
brew install apfel
apfel --model-info        # should show "available: yes"
```

Then add it in the editor: **Settings → Proofreading & translation → Provider → ➕ Add new LLM configuration…**, choose **apfel**, leave the URL empty, and click **Add Configuration**. Select it as the provider and save the settings.

**Starting apfel.** With the URL left empty, nothing has to be started: the editor runs the `apfel` command for each request (it looks in `/opt/homebrew/bin`, `/usr/local/bin` and your `PATH`). The model itself is kept loaded by macOS, so this is as fast as a server.

To use apfel as a server instead — for example on another Mac — start it and enter its URL in the configuration:
```
apfel --serve                     # in a Terminal window, until you close it
brew services start apfel         # or: in the background, also after a restart
brew services stop apfel          # stop the background server
```
The server listens on `http://127.0.0.1:11434/v1`, the port Ollama also uses; both can run side by side, as apfel only listens on `127.0.0.1`. To keep them apart, start apfel with `apfel --serve --port 11435` and use `http://127.0.0.1:11435/v1` as the URL. If no URL is set and the `apfel` command isn't found, the editor tries that default server address.

**Limits.** The model is small. It translates a few paragraphs well, but proofreading is weaker than with the remote providers. Each request — instructions, your text and the answer together — must fit in about 4,000 tokens (8,000 on macOS 27 with an M3 or newer and 12 GB of memory; `apfel --model-info` shows yours). For translation that is roughly 4,000 characters of text at a time; select a part of a longer document. If the text is too long, the editor says so.

**Updating and removing.** `brew upgrade apfel` updates it; `brew uninstall apfel` removes it (stop the background server first, if you started one).

## LLM search (optional)

The **LLM Search** option in the Search panel answers questions about your notes with a language model that runs locally (see [Help.md](src/help.md#llm-search) for how to use it). **Suggest tags** uses the same model and embeddings to pick tags from similar notes ([Help.md](src/help.md#suggest-tags)). It is implemented by [`server/mdsearch.py`](server/mdsearch.py) and needs:

- a Mac with **Apple silicon** (it uses Apple's MLX), and
- **Python 3.9 or newer** (`python3`), also when you use the app, because the app's built-in Python can't install packages. From source the editor uses the Python that runs the server; the app looks for `python3` in the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, python.org's framework). Get it from https://www.python.org or with `brew install python`.

On first use the required packages — `mlx-lm`, and `fastembed` for semantic matching — are installed automatically into a private environment at `~/.humd-editor/mdsearch-venv`, so your own Python installation is left untouched. If that fails, the app shows the error and these commands, which you can also run yourself:
```
python3 -m venv ~/.humd-editor/mdsearch-venv
~/.humd-editor/mdsearch-venv/bin/python -m pip install mlx-lm fastembed
```
`fastembed` is optional: without it only keyword matching is used to find passages. If your `python3` already has both packages, it is used directly and no environment is created.

The first question also downloads the language model (several GB) and a small embedding model; Hugging Face keeps them in `~/.cache/huggingface`. Passage embeddings are cached in `~/.cache/mdsearch`, so only new or changed notes are processed later.

**Settings.** The model can be changed by adding a key to `~/.humd-editor/settings.json` (there is no field for it in the Settings dialog yet):
```
"llmSearchModel": "mlx-community/Qwen2.5-3B-Instruct-4bit"
```
Any MLX chat model on Hugging Face (or a local model folder) works; the default is `mlx-community/Qwen2.5-7B-Instruct-4bit`. Smaller models answer faster and use less memory, larger ones answer better. The model stays in memory between questions and is unloaded after 5 minutes without one (`LLM_WORKER_IDLE_TIMEOUT` in `server/server.py`).

**Command line.** The same search also works in Terminal, without the editor:
```
python3 server/mdsearch.py /path/to/notes [model]
```

**Removing it.** Delete `~/.humd-editor/mdsearch-venv`, `~/.cache/mdsearch`, and the downloaded models under `~/.cache/huggingface/hub`.

**Building the app.** `build_app.sh` bundles `mdsearch.py` into `Humd Editor.app`; the Python packages are not bundled and are installed on first use as described above.
