#!/usr/bin/env python3
"""Ask questions about a directory of markdown notes, answered by a local LLM.

Usage:  python mdsearch.py /path/to/notes [llm]
        llm = a Hugging Face repo id or a local folder (default below)
        python mdsearch.py --serve
        Worker mode for the humd editor's "LLM search": reads JSON requests
        ({"vault", "query", "model"?}) from stdin, one per line, and writes
        JSON events (status / sources / token / done / error) to stdout.
Needs:  Apple silicon Mac, Python 3.9+, and  pip install mlx-lm
Optional: pip install fastembed
        Adds semantic search (multilingual MiniLM) alongside keyword search.
        Without it the script uses keyword search (BM25) only.

Missing packages are installed automatically into a private virtual
environment (DEPS_VENV below), so the system Python is left untouched. If that
fails, the error explains how to install them by hand.

Passages are retrieved, the top ones are given to the model, and it must cite
them as [file:line]. Nothing is ever written to your notes.
"""
import hashlib
import importlib
import json
import math
import os
import platform
import re
import subprocess
import sys
import unicodedata
from collections import Counter
from pathlib import Path

np = TextEmbedding = None  # set by load_semantic() when fastembed is available

DEFAULT_LLM = "mlx-community/Qwen2.5-7B-Instruct-4bit"
EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
CACHE = Path.home() / ".cache" / "mdsearch" / "embeddings.npz"
DEPS_VENV = Path.home() / ".humd-editor" / "mdsearch-venv"
REQUIRED = [("mlx_lm", "mlx-lm")]          # (import name, pip name)
OPTIONAL = [("fastembed", "fastembed")]
MAX_TOKENS = 1024   # upper limit on answer length
TOP_K = 8           # passages handed to the model
CHUNK_CHARS = 500   # passage size; MiniLM was trained on short inputs (~128 tokens)
POOL = 50           # candidates taken from each ranking before fusion
RRF_K = 60          # reciprocal rank fusion constant

SYSTEM = (
    "You answer questions about a researcher's markdown notes using ONLY the "
    "excerpts provided. Cite every claim as [file:line]. If the excerpts do not "
    "contain the answer, say so plainly: that only means the retrieved passages "
    "lack it, not that the notes do. Never add facts from outside the excerpts."
)


class SetupError(Exception):
    """Dependencies are missing and couldn't be installed; message says what to do."""


# --- dependencies ------------------------------------------------------------

def missing(modules):
    importlib.invalidate_caches()
    out = []
    for mod, pip_name in modules:
        try:
            importlib.import_module(mod)
        except ImportError:
            out.append(pip_name)
    return out


def venv_python():
    return DEPS_VENV / "bin" / "python"


def venv_missing(modules):
    """Pip names of `modules` that the private venv can't import (all if no venv)."""
    py = venv_python()
    if not py.exists():
        return [pip_name for _, pip_name in modules]
    out = []
    for mod, pip_name in modules:
        r = subprocess.run([str(py), "-c", f"import {mod}"], capture_output=True)
        if r.returncode != 0:
            out.append(pip_name)
    return out


def manual_instructions(reason):
    venv = str(DEPS_VENV).replace(str(Path.home()), "~")
    return (
        f"LLM search could not install its Python packages automatically.\n\n"
        f"{reason}\n\n"
        f"Install them by hand in Terminal:\n\n"
        f"  python3 -m venv {venv}\n"
        f"  {venv}/bin/python -m pip install mlx-lm fastembed\n\n"
        f"Then search again. (fastembed is optional: without it only keyword "
        f"retrieval is used.) If python3 is missing, install it from "
        f"https://www.python.org or with `brew install python`."
    )


def run_pip(args):
    r = subprocess.run(
        [str(venv_python()), "-m", "pip", "install", "--disable-pip-version-check", *args],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        tail = "\n".join((r.stderr or r.stdout).strip().splitlines()[-6:])
        raise RuntimeError(f"pip install {' '.join(args)} failed:\n{tail}")


def install_into_venv(report):
    """Create the private venv if needed and install the packages it lacks.

    Required packages must succeed; optional ones may fail (reported, not fatal).
    """
    if not venv_python().exists():
        report(f"Creating Python environment for LLM search in {DEPS_VENV} …")
        r = subprocess.run([sys.executable, "-m", "venv", str(DEPS_VENV)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SetupError(manual_instructions(
                f"Creating the virtual environment failed:\n{(r.stderr or r.stdout).strip()}"))
    req = venv_missing(REQUIRED)
    if req:
        report(f"Installing {', '.join(req)} (one-time, may take a few minutes) …")
        try:
            run_pip(req)
        except RuntimeError as e:
            raise SetupError(manual_instructions(str(e)))
    opt = venv_missing(OPTIONAL)
    if opt:
        report(f"Installing {', '.join(opt)} for semantic search …")
        try:
            run_pip(opt)
        except RuntimeError as e:
            report(f"Semantic search unavailable (keyword retrieval only): {e}")


def ensure_dependencies(report):
    """Make mlx-lm (and if possible fastembed) importable.

    Uses the current interpreter when it already has everything; otherwise
    switches to the private venv (installing into it first), re-executing this
    script there. Raises SetupError with manual instructions when that fails.
    """
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SetupError(
            "LLM search runs the model locally with Apple's MLX, which needs a Mac "
            "with Apple silicon and an arm64 (not Rosetta/Intel) Python. "
            f"This Python reports {platform.system()} {platform.machine()}.")
    if not missing(REQUIRED) and not missing(OPTIONAL):
        return
    in_venv = Path(sys.prefix).resolve() == DEPS_VENV.resolve()
    if not in_venv:
        if venv_missing(REQUIRED) or venv_missing(OPTIONAL):
            try:
                install_into_venv(report)
            except SetupError:
                if not missing(REQUIRED):
                    report("Semantic search unavailable (fastembed not installed): "
                           "using keyword retrieval only.")
                    return  # this interpreter can still do keyword + LLM
                raise
        if not venv_missing(REQUIRED):
            # Same stdin/stdout, so the server's pipes carry over.
            os.execv(str(venv_python()), [str(venv_python()), *sys.argv])
    req = missing(REQUIRED)
    if req:
        raise SetupError(manual_instructions(
            f"Still missing after installation: {', '.join(req)}."))
    if missing(OPTIONAL):
        report("fastembed not installed: using keyword retrieval only.")


def load_semantic():
    """Import fastembed (+ numpy) if available; returns True on success."""
    global np, TextEmbedding
    try:
        import numpy
        from fastembed import TextEmbedding as TE
    except ImportError:
        return False
    np, TextEmbedding = numpy, TE
    return True


# --- retrieval ---------------------------------------------------------------

def tokens(text):
    """Lowercase, strip accents (helps with Italian/French/Dutch), split on words."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.findall(r"\w+", text)


def md_files(root):
    """Every .md file under root, skipping hidden files/folders (.git, .trash …)."""
    return sorted(
        p for p in root.rglob("*.md")
        if not any(part.startswith(".") for part in p.relative_to(root).parts)
    )


def chunks(root, size=CHUNK_CHARS):
    """Yield (relative path, first line number, text) passages from every .md file."""
    for p in md_files(root):
        rel = str(p.relative_to(root))
        buf, start, length = [], 1, 0
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for n, line in enumerate(lines, 1):
            if not buf:
                start = n
            buf.append(line)
            length += len(line)
            if length >= size or (not line.strip() and length >= size // 2):
                text = "\n".join(buf).strip()
                if text:
                    yield rel, start, text
                buf, length = [], 0
        text = "\n".join(buf).strip()
        if text:
            yield rel, start, text


def vault_signature(root):
    """Changes whenever a note is added, removed or modified."""
    h = hashlib.sha1()
    for p in md_files(root):
        try:
            st = p.stat()
        except OSError:
            continue
        h.update(f"{p}\0{st.st_mtime_ns}\0{st.st_size}\n".encode())
    return h.hexdigest()


# --- semantic search (optional) ----------------------------------------------

def make_embedder():
    """Return embed(list of str) -> normalised float32 matrix."""
    model = TextEmbedding(model_name=EMBED_MODEL)

    def embed(texts):
        v = np.array(list(model.embed(texts)), dtype=np.float32)
        return v / np.linalg.norm(v, axis=1, keepdims=True)
    return embed


def cache_key(text):
    return hashlib.sha1((EMBED_MODEL + text).encode()).hexdigest()


def load_cache():
    try:
        with np.load(CACHE) as z:
            return dict(zip(z["keys"].tolist(), z["vecs"]))
    except (OSError, ValueError, KeyError):
        return {}  # missing or unreadable: rebuild


def save_cache(entries):
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    keys = list(entries)
    np.savez(CACHE, keys=np.array(keys), vecs=np.stack([entries[k] for k in keys]))


# --- index -------------------------------------------------------------------

class Index:
    def __init__(self, root):
        self.docs = list(chunks(root))
        self.tf = [Counter(tokens(text)) for _, _, text in self.docs]
        self.len = [sum(c.values()) for c in self.tf]
        self.avg = (sum(self.len) / len(self.len)) if self.len else 1
        self.df = Counter(t for c in self.tf for t in c)
        self.vecs = None  # filled by add_embeddings()

    def add_embeddings(self, embed, report=print):
        """Embed all passages; vectors are cached so later runs only embed new text."""
        if not self.docs:
            return
        cache = load_cache()
        keys = [cache_key(text) for _, _, text in self.docs]
        missing_ = [i for i, k in enumerate(keys) if k not in cache]
        if missing_:
            report(f"Embedding {len(missing_)} passages (cached for next time) …")
            for i, v in zip(missing_, embed([self.docs[i][2] for i in missing_])):
                cache[keys[i]] = v
        self.embed = embed
        self.vecs = np.stack([cache[k] for k in keys])
        save_cache({k: cache[k] for k in keys})  # also drops entries no longer used

    def keyword_ranking(self, query, k1=1.5, b=0.75):
        """BM25: passage indices, best first. Good for names and exact terms."""
        n, scored = len(self.docs), []
        terms = set(tokens(query))
        for i, tf in enumerate(self.tf):
            score = 0.0
            for t in terms & tf.keys():
                idf = math.log(1 + (n - self.df[t] + 0.5) / (self.df[t] + 0.5))
                score += idf * tf[t] * (k1 + 1) / (
                    tf[t] + k1 * (1 - b + b * self.len[i] / self.avg))
            if score > 0:
                scored.append((score, i))
        return [i for _, i in sorted(scored, reverse=True)[:POOL]]

    def semantic_ranking(self, query):
        """Cosine similarity: passage indices, best first. Good for paraphrases."""
        sims = self.vecs @ self.embed([query])[0]
        return np.argsort(-sims)[:POOL].tolist()

    def search(self, query, k=TOP_K):
        """Fuse the available rankings with reciprocal rank fusion."""
        rankings = [self.keyword_ranking(query)]
        if self.vecs is not None:
            rankings.append(self.semantic_ranking(query))
        fused = Counter()
        for ranking in rankings:
            for rank, i in enumerate(ranking):
                fused[i] += 1 / (RRF_K + rank + 1)
        return [self.docs[i] for i, _ in fused.most_common(k)]


# --- answering ---------------------------------------------------------------

def build_prompt(tokenizer, q, hits):
    context = "\n\n".join(f"[{f}:{n}]\n{t}" for f, n, t in hits)
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"Excerpts:\n\n{context}\n\nQuestion: {q}"},
    ]
    return tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True)


def generate(model, tokenizer, prompt, sampler):
    """Yield the answer piece by piece."""
    from mlx_lm import stream_generate
    for r in stream_generate(model, tokenizer, prompt,
                             max_tokens=MAX_TOKENS, sampler=sampler):
        # newer mlx-lm yields response objects, older versions yield strings
        yield getattr(r, "text", r)


# --- worker mode (used by the humd editor server) ----------------------------

def serve():
    out = sys.stdout

    def emit(event, **data):
        out.write(json.dumps({"event": event, **data}) + "\n")
        out.flush()

    def report(message):
        emit("status", message=message)

    # Before the redirect below: this may re-exec into the private venv, which
    # must inherit the real stdout (pip output is captured, so nothing leaks).
    try:
        ensure_dependencies(report)
    except SetupError as e:
        emit("fatal", message=str(e))
        return

    # Anything a library prints must not corrupt the JSON protocol on stdout:
    # keep a private handle on the real stdout and point fd 1 at stderr.
    out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from mlx_lm import load
    from mlx_lm.sample_utils import make_sampler
    sampler = make_sampler(temp=0.2)
    embed = None
    semantic = load_semantic()
    llm = {"name": None, "model": None, "tokenizer": None}
    index = {"root": None, "sig": None, "index": None}

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            root = Path(req["vault"]).resolve()
            q = (req.get("query") or "").strip()
            name = req.get("model") or DEFAULT_LLM

            report("Reading notes …")
            sig = vault_signature(root)
            if index["root"] != root or index["sig"] != sig:
                idx = Index(root)
                if semantic:
                    if embed is None:
                        report("Loading embedding model (the first run downloads it) …")
                        embed = make_embedder()
                    idx.add_embeddings(embed, report)
                index.update(root=root, sig=sig, index=idx)
            hits = index["index"].search(q)
            emit("sources", sources=[{"file": f, "line": n, "text": t} for f, n, t in hits])
            if not hits:
                emit("done", answer="No matching passages found in your notes.")
                continue

            if llm["name"] != name:
                report(f"Loading {name} (the first run downloads several GB) …")
                llm["model"], llm["tokenizer"] = load(name)
                llm["name"] = name
            report("Answering …")
            prompt = build_prompt(llm["tokenizer"], q, hits)
            for piece in generate(llm["model"], llm["tokenizer"], prompt, sampler):
                emit("token", text=piece)
            emit("done")
        except Exception as e:  # keep the worker alive for the next question
            emit("error", message=f"{type(e).__name__}: {e}")


# --- command line ------------------------------------------------------------

def main():
    if sys.argv[1:] == ["--serve"]:
        serve()
        return
    if not 2 <= len(sys.argv) <= 3:
        sys.exit(__doc__)
    root = Path(sys.argv[1]).resolve()
    llm_name = sys.argv[2] if len(sys.argv) == 3 else DEFAULT_LLM

    try:
        ensure_dependencies(print)
    except SetupError as e:
        sys.exit(str(e))

    index = Index(root)
    if not index.docs:
        sys.exit(f"No markdown passages found in {root}")
    print(f"Indexed {len(index.docs)} passages from {root}")

    if load_semantic():
        print(f"Loading embedding model {EMBED_MODEL} (first run downloads it) ...")
        index.add_embeddings(make_embedder())
    else:
        print("fastembed not installed: using keyword search only.")

    from mlx_lm import load
    from mlx_lm.sample_utils import make_sampler

    print(f"Loading {llm_name} (the first run downloads it) ...")
    model, tokenizer = load(llm_name)
    sampler = make_sampler(temp=0.2)

    while True:
        try:
            q = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not q:
            continue
        hits = index.search(q)
        if not hits:
            print("No matching passages.")
            continue
        print("Sources:", ", ".join(f"{f}:{n}" for f, n, _ in hits))
        print()
        for piece in generate(model, tokenizer, build_prompt(tokenizer, q, hits), sampler):
            print(piece, end="", flush=True)
        print()


if __name__ == "__main__":
    main()
