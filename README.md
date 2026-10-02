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

## LLM search (optional)

The **LLM Search** option in the Search panel answers questions about your notes with a language model that runs locally (see [Help.md](src/help.md#llm-search) for how to use it). It is implemented by [`server/mdsearch.py`](server/mdsearch.py) and needs:

- a Mac with **Apple silicon** (it uses Apple's MLX), and
- **Python 3.9 or newer** (`python3`). From source the app uses the Python that runs the server; the bundled app looks for `python3` in the usual places (`/opt/homebrew/bin`, `/usr/local/bin`, python.org's framework). Get it from https://www.python.org or with `brew install python`.

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
Any MLX chat model on Hugging Face (or a local model folder) works; the default is `mlx-community/Qwen2.5-7B-Instruct-4bit`. Smaller models answer faster and use less memory, larger ones answer better.

**Command line.** The same search also works in Terminal, without the editor:
```
python3 server/mdsearch.py /path/to/notes [model]
```

**Removing it.** Delete `~/.humd-editor/mdsearch-venv`, `~/.cache/mdsearch`, and the downloaded models under `~/.cache/huggingface/hub`.

**Building the app.** `build_app.sh` bundles `mdsearch.py` into `Humd Editor.app`; the Python packages are not bundled and are installed on first use as described above.
