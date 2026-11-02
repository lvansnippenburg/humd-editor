#!/usr/bin/env python3
"""The retrieval worker of the humd editor's LLM search and Suggest tags.

Finds the passages of a directory of markdown notes that best match a
question, and the notes most similar to a text. The editor's server
(server.py) sends the passages and notes to the AI model; this process never
talks to a model and never writes to the notes.

Usage:  python mdsearch.py --serve
        Reads JSON requests from stdin, one per line, and answers each with
        JSON events on stdout: any number of {"event": "status", "message"},
        then {"event": "result", …} or {"event": "error", "message"}.
          {"vault", "query"}  →  result {"passages": [{"file", "line", "text"}]}
          {"vault", "similar": {"text", "file"?, "candidates": [file]}}
                              →  result {"notes": [[file, score]]}
        (files relative to the vault; see Index.search and similar_notes).

Passages are found by keyword matching (BM25) fused with semantic matching
(a multilingual MiniLM model via fastembed). fastembed is installed
automatically into a private virtual environment (DEPS_VENV), so the system
Python is left untouched; without it only keyword matching is used, and no
similar notes are found.
"""
import hashlib
import importlib
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
from collections import Counter
from pathlib import Path

np = TextEmbedding = None  # set by load_semantic() when fastembed is available

EMBED_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
CACHE = Path.home() / ".cache" / "mdsearch" / "embeddings.npz"
DEPS_VENV = Path.home() / ".humd-editor" / "mdsearch-venv"
PACKAGES = [("fastembed", "fastembed")]  # (import name, pip name)
TOP_K = 8           # passages handed to the model
CHUNK_CHARS = 500   # passage size; MiniLM was trained on short inputs (~128 tokens)
POOL = 50           # candidates taken from each ranking before fusion
RRF_K = 60          # reciprocal rank fusion constant
SIMILAR_NOTES = 6   # similar notes returned (examples for tag suggestion)


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


def install_into_venv(report):
    """Create the private venv if needed and install the packages it lacks.
    Raises RuntimeError with what went wrong."""
    if not venv_python().exists():
        report(f"Creating Python environment for LLM search in {DEPS_VENV} …")
        r = subprocess.run([sys.executable, "-m", "venv", str(DEPS_VENV)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"Creating the virtual environment failed:\n{(r.stderr or r.stdout).strip()}")
    pkgs = venv_missing(PACKAGES)
    if pkgs:
        report(f"Installing {', '.join(pkgs)} for semantic search (one-time, may take a few minutes) …")
        r = subprocess.run(
            [str(venv_python()), "-m", "pip", "install", "--disable-pip-version-check", *pkgs],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            tail = "\n".join((r.stderr or r.stdout).strip().splitlines()[-6:])
            raise RuntimeError(f"pip install {' '.join(pkgs)} failed:\n{tail}")


def ensure_dependencies(report):
    """Make fastembed importable if possible: use the current interpreter when
    it has it, otherwise the private venv (installing into it first),
    re-executing this script there. Without it, only keyword search is used."""
    if not missing(PACKAGES):
        return
    if Path(sys.prefix).resolve() != DEPS_VENV.resolve():
        try:
            install_into_venv(report)
        except RuntimeError as e:
            venv = str(DEPS_VENV).replace(str(Path.home()), "~")
            report(
                f"Semantic search unavailable, using keyword search only. {e} "
                f"To install it by hand: python3 -m venv {venv} && "
                f"{venv}/bin/python -m pip install fastembed"
            )
            return
        # Same stdin/stdout, so the server's pipes carry over.
        os.execv(str(venv_python()), [str(venv_python()), *sys.argv])
    report("fastembed not installed: using keyword search only.")


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


def passages(lines, size=CHUNK_CHARS):
    """Yield (first line number, text) passages of about `size` characters."""
    buf, start, length = [], 1, 0
    for n, line in enumerate(lines, 1):
        if not buf:
            start = n
        buf.append(line)
        length += len(line)
        if length >= size or (not line.strip() and length >= size // 2):
            text = "\n".join(buf).strip()
            if text:
                yield start, text
            buf, length = [], 0
    text = "\n".join(buf).strip()
    if text:
        yield start, text


def chunks(root, size=CHUNK_CHARS):
    """Yield (relative path, first line number, text) passages from every .md file."""
    for p in md_files(root):
        rel = str(p.relative_to(root))
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for start, text in passages(lines, size):
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


# --- similar notes (tag suggestion) ------------------------------------------

def similar_notes(index, text, exclude, candidates, k=SIMILAR_NOTES):
    """The k notes in `candidates` (relative paths) most similar to `text`,
    as [(file, score)], best first. A note's score is how well its best
    passage matches each passage of `text`, averaged. Empty without
    embeddings (fastembed not installed)."""
    if index.vecs is None or not index.docs:
        return []
    query = [t for _, t in passages(text.splitlines())]
    if not query:
        return []
    sims = index.embed(query) @ index.vecs.T  # query passages x vault passages
    # Passages of a file are consecutive in index.docs.
    files, starts = [], []
    for i, (f, _, _) in enumerate(index.docs):
        if not files or files[-1] != f:
            files.append(f)
            starts.append(i)
    scores = np.maximum.reduceat(sims, starts, axis=1).mean(axis=0)
    ranked = sorted(
        ((float(s), f) for f, s in zip(files, scores) if f in candidates and f != exclude),
        reverse=True,
    )
    return [(f, s) for s, f in ranked[:k]]


# --- worker mode ---------------------------------------------------------------

def serve():
    out = sys.stdout

    def emit(event, **data):
        out.write(json.dumps({"event": event, **data}) + "\n")
        out.flush()

    def report(message):
        emit("status", message=message)

    # Before the redirect below: this may re-exec into the private venv, which
    # must inherit the real stdout (pip output is captured, so nothing leaks).
    ensure_dependencies(report)

    # Anything a library prints must not corrupt the JSON protocol on stdout:
    # keep a private handle on the real stdout and point fd 1 at stderr.
    out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    embed = None
    semantic = load_semantic()
    index = {"root": None, "sig": None, "index": None}

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            root = Path(req["vault"]).resolve()
            report("Reading notes …")
            sig = vault_signature(root)
            if index["root"] != root or index["sig"] != sig:
                idx = Index(root)
                if semantic:
                    if embed is None:
                        report("Loading the search model (the first run downloads it) …")
                        embed = make_embedder()
                    idx.add_embeddings(embed, report)
                index.update(root=root, sig=sig, index=idx)
            if "similar" in req:
                spec = req["similar"]
                notes = similar_notes(index["index"], spec["text"], spec.get("file"), set(spec["candidates"]))
                emit("result", notes=notes)
            else:
                hits = index["index"].search(req["query"])
                emit("result", passages=[{"file": f, "line": n, "text": t} for f, n, t in hits])
        except Exception as e:  # keep the worker alive for the next request
            emit("error", message=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    if sys.argv[1:] != ["--serve"]:
        sys.exit(__doc__)
    serve()
