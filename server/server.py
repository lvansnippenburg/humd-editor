#!/usr/bin/env python3
"""humd-editor local server — pure Python standard library, no external deps."""

import argparse
import difflib
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SETTINGS_PATH = Path.home() / ".humd-editor" / "settings.json"
# When frozen by PyInstaller the bundled `src/` lives next to the unpacked code
# (sys._MEIPASS); otherwise it's the sibling folder in the source tree.
if getattr(sys, "frozen", False):
    SRC_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "src"
    PANDOC_ITEMS_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "pandoc items"
else:
    SRC_DIR = Path(__file__).parent.parent / "src"
    PANDOC_ITEMS_DIR = Path(__file__).parent.parent / "pandoc items"


def _compute_version() -> str:
    """A fingerprint of the code this process serves: backend source + every
    served asset + the build stamp. Two instances with different code produce
    different fingerprints, which lets a launching app detect a stale server and
    take over instead of blindly attaching to old code."""
    h = hashlib.sha1()
    try:
        h.update(Path(__file__).read_bytes())  # backend (dev mode)
    except Exception:
        pass
    try:
        for f in sorted(SRC_DIR.rglob("*")):
            if f.is_file() and f.suffix in (".html", ".js", ".css", ".txt"):
                try:
                    h.update(f.name.encode("utf-8"))
                    h.update(f.read_bytes())
                except OSError:
                    pass
    except Exception:
        pass
    return h.hexdigest()[:12]


SERVER_VERSION = _compute_version()

_lock = threading.Lock()

# Hosts we accept requests for. Anything else (a rebound DNS name pointing at
# 127.0.0.1) is rejected to defeat DNS-rebinding attacks from other tabs.
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


# ---------------------------------------------------------------------------
# Path confinement
# ---------------------------------------------------------------------------


def vault_root() -> Path | None:
    """Resolved path of the configured vault, or None if none is set yet."""
    vp = load_settings().get("vaultPath")
    if not vp:
        return None
    try:
        return Path(vp).resolve()
    except OSError:
        return None


def safe_path(p: str, *, must_exist: bool = False) -> Path:
    """Resolve `p` and ensure it lives inside the configured vault.

    Guards every filesystem endpoint against path traversal: even though the
    server only binds to localhost, a stray request must never be able to touch
    a file outside the user's vault folder.
    """
    root = vault_root()
    if root is None:
        raise PermissionError("No vault configured")
    resolved = Path(p).resolve()
    root_str = str(root)
    resolved_str = str(resolved)
    # Check if the path is the vault root or a descendant. Try is_relative_to
    # first (Python 3.9+), then fall back to string prefix matching for edge cases.
    try:
        is_inside = resolved == root or resolved.is_relative_to(root)
    except ValueError:
        is_inside = resolved_str.startswith(root_str + "/") or resolved_str == root_str
    if not is_inside:
        raise PermissionError("Path is outside the vault")
    if must_exist and not resolved.exists():
        raise FileNotFoundError(p)
    return resolved


def safe_path_home(p: str, *, must_exist: bool = False) -> Path:
    """Resolve `p` and ensure it's under the user's home directory.

    Used for reading bibliography/CSL files which are typically stored outside
    the vault. Still prevents path traversal by confirming the path is within
    the user's home directory.
    """
    resolved = Path(p).resolve()
    home = Path.home()
    home_str = str(home)
    resolved_str = str(resolved)

    # Check if the path is the home dir or a descendant.
    try:
        is_inside = resolved == home or resolved.is_relative_to(home)
    except ValueError:
        is_inside = resolved_str.startswith(home_str + "/") or resolved_str == home_str

    if not is_inside:
        raise PermissionError(f"Path is outside home directory: {p}")
    if must_exist and not resolved.exists():
        raise FileNotFoundError(p)
    return resolved


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------


def load_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_settings(data: dict) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(SETTINGS_PATH)


def open_settings_file() -> None:
    """Open the settings file in the system's default editor for it."""
    result = subprocess.run(
        ["open", str(SETTINGS_PATH)], capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Could not open the settings file")


# ---------------------------------------------------------------------------
# File tree helpers
# ---------------------------------------------------------------------------


# Non-markdown files that can be opened and viewed (images + PDF).
_VIEWABLE_EXTS = (".md", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf")


def list_dir_internal(dir_path: str, is_root: bool) -> list:
    p = Path(dir_path)
    if not p.is_dir():
        raise ValueError(f"{dir_path} is not a directory")

    entries = []
    try:
        for child in p.iterdir():
            name = child.name
            if name.startswith("."):
                continue
            is_dir = child.is_dir()
            if is_root and not is_dir and not name.lower().endswith(_VIEWABLE_EXTS):
                continue
            entries.append(
                {
                    "name": name,
                    "path": str(child),
                    "is_dir": is_dir,
                    "children": [] if is_dir else None,
                }
            )
    except PermissionError:
        pass

    entries.sort(key=lambda e: (0 if e["is_dir"] else 1, e["name"].lower()))
    return entries


# ---------------------------------------------------------------------------
# Vault hash (for change detection)
# ---------------------------------------------------------------------------


def collect_md_files(path: str) -> list:
    result = []
    try:
        for entry in os.scandir(path):
            if entry.name.startswith("."):
                continue
            if entry.is_dir(follow_symlinks=False):
                result.extend(collect_md_files(entry.path))
            elif entry.name.endswith(".md"):
                result.append(entry.path)
    except PermissionError:
        pass
    return result


def get_vault_hash(vault_path: str) -> str:
    """Compact digest of every note's path + mtime, for change detection.

    Returns a short hex digest instead of the full path:mtime string so the
    response (polled every few seconds) stays tiny regardless of vault size.
    """
    h = hashlib.sha1()
    for f in sorted(collect_md_files(vault_path)):
        try:
            mtime = os.path.getmtime(f)
        except OSError:
            continue
        h.update(f"{f}:{mtime:.3f};".encode("utf-8"))
    return h.hexdigest()


def get_vault_tree_hash(vault_path: str) -> str:
    """Digest of the vault's structure: the paths of all files and folders the
    file browser can show (hidden ones skipped, as in list_dir_internal). It
    changes when something is added, removed, renamed or moved, but not when
    a file is saved, so the browser only redraws when its contents change."""
    h = hashlib.sha1()
    for root, dirs, files in os.walk(vault_path):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        h.update(f"{root}/;".encode("utf-8"))
        for name in sorted(files):
            if not name.startswith("."):
                h.update(f"{name};".encode("utf-8"))
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Link index
# ---------------------------------------------------------------------------


def _clean_tag(t: str) -> str:
    return t.strip().strip("\"'").lstrip("#").strip()


def extract_yaml_tags(content: str) -> list:
    """Read the `tags:` field from YAML front matter.

    Handles all three common shapes:
        tags: [a, b]          (inline flow sequence)
        tags: a, b            (inline scalar / comma list)
        tags:                 (block sequence)
          - a
          - b
    """
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return []
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            end = i
            break
    if end is None:
        return []
    fm = lines[1:end]
    for i, line in enumerate(fm):
        if not re.match(r"^tags\s*:", line):
            continue
        remainder = line.split(":", 1)[1].strip()
        if remainder.startswith("["):
            m = re.search(r"\[([^\]]*)\]", remainder)
            inner = m.group(1) if m else ""
            return [_clean_tag(t) for t in inner.split(",") if _clean_tag(t)]
        if remainder:
            return [_clean_tag(t) for t in remainder.split(",") if _clean_tag(t)]
        # Block sequence: collect following "- tag" lines.
        out = []
        for bl in fm[i + 1 :]:
            m = re.match(r"^\s*-\s*(.+?)\s*$", bl)
            if not m:
                break
            cleaned = _clean_tag(m.group(1))
            if cleaned:
                out.append(cleaned)
        return out
    return []


# A `#` right after `(` is a link/anchor target — `[text](#links)` or "(#links)" —
# not a tag, so exclude it (matches the preview renderer's behaviour).
_INLINE_TAG_RE = re.compile(r"(?<![\w&#(])#([A-Za-z][\w/-]*)")


def extract_inline_tags(content: str) -> list:
    """Find #hashtag-style tags in note body, ignoring code and headings.

    Returns each occurrence (with repeats) so callers can count frequency.
    """
    # Strip fenced and inline code so things like `#include` or hex colours
    # ("#fff") inside code don't get picked up as tags.
    text = re.sub(r"```.*?```", "", content, flags=re.DOTALL)
    text = re.sub(r"`[^`]+`", "", text)
    # Strip URLs so fragment anchors ("…/page#section") aren't read as tags.
    text = re.sub(r"https?://\S+", "", text)
    # `#tag` (no space) never starts an ATX heading, so headings ("# Title")
    # are naturally excluded by requiring a letter immediately after the #.
    return _INLINE_TAG_RE.findall(text)


_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")

# Per-file parse cache: fpath -> {mtime, content, stem, yaml_tags, inline_tags,
# wikilinks}. Shared by the link index and full-text search so each file is read
# from disk at most once per change. Only mutated inside _refresh_file_cache,
# whose callers run under `_lock`.
_file_cache: dict = {}
# Last index JSON written per vault, to skip redundant disk writes.
_last_index_json: dict = {}
# Serialises all _file_cache access. Distinct from `_lock` (which guards settings
# and the index write) so a search and an index build can't corrupt the cache.
# Callers hold this across both the refresh and the subsequent reads.
_cache_lock = threading.Lock()


def _parse_md_file(fpath: str) -> dict:
    content = Path(fpath).read_text(encoding="utf-8")
    targets = []
    for m in _WIKILINK_RE.finditer(content):
        target = m.group(1).strip()
        if target:
            targets.append(target)
    return {
        "content": content,
        "stem": Path(fpath).stem,
        "yaml_tags": extract_yaml_tags(content),
        "inline_tags": extract_inline_tags(content),
        "wikilinks": targets,
    }


def _refresh_file_cache(vault_path: str) -> list:
    """Bring _file_cache up to date for the vault and return its .md file list.

    Only files whose mtime changed are re-read; vanished files are pruned.
    """
    files = collect_md_files(vault_path)
    file_set = set(files)

    for fpath in files:
        try:
            mtime = os.path.getmtime(fpath)
        except OSError:
            continue
        cached = _file_cache.get(fpath)
        if cached and cached["mtime"] == mtime:
            continue
        try:
            parsed = _parse_md_file(fpath)
        except OSError:
            continue
        parsed["mtime"] = mtime
        _file_cache[fpath] = parsed

    # Drop cache entries for files in this vault that no longer exist. Cache
    # keys come from collect_md_files (the literal vault_path), so match on that
    # prefix rather than a resolved path (/tmp vs /private/tmp on macOS).
    prefix = os.path.join(os.path.normpath(vault_path), "")
    for fpath in [f for f in _file_cache if f not in file_set and f.startswith(prefix)]:
        del _file_cache[fpath]

    return files


def build_link_index(vault_path: str) -> dict:
    # Refresh and snapshot under the cache lock; aggregate over the snapshot
    # afterwards (cache entries are replaced wholesale, never mutated in place,
    # so held references stay valid once the lock is released).
    with _cache_lock:
        files = _refresh_file_cache(vault_path)
        items = [(f, _file_cache[f]) for f in files if f in _file_cache]

    backlinks: dict = {}
    tags: dict = {}
    notes: dict = {}
    tag_index: dict = {}  # lowercased tag -> {name, count, files: [path]}
    tagged_files: set = set()

    def add_tag(raw: str, fpath: str) -> None:
        key = raw.lower()
        entry = tag_index.get(key)
        if entry is None:
            entry = {"name": raw, "count": 0, "files": []}
            tag_index[key] = entry
        entry["count"] += 1
        if fpath not in entry["files"]:
            entry["files"].append(fpath)
        tagged_files.add(fpath)

    for fpath, data in items:
        stem = data["stem"]
        # Map note name (lowercased stem) -> full path so wikilinks resolve
        # regardless of which folders the browser has expanded. First match
        # wins on duplicate names.
        notes.setdefault(stem.lower(), fpath)
        if data["yaml_tags"]:
            tags[fpath] = data["yaml_tags"]
        # Aggregate tags for the filter panel: YAML frontmatter tags (one each)
        # plus every inline #hashtag occurrence.
        for t in data["yaml_tags"]:
            add_tag(t, fpath)
        for t in data["inline_tags"]:
            add_tag(t, fpath)

        for target in data["wikilinks"]:
            if target and target != stem:
                backlinks.setdefault(target, [])
                if stem not in backlinks[target]:
                    backlinks[target].append(stem)

    for sources in backlinks.values():
        sources.sort()
    for entry in tag_index.values():
        entry["files"].sort()

    untagged = sorted(f for f in files if f not in tagged_files)

    index = {
        "backlinks": backlinks,
        "tags": tags,
        "notes": notes,
        "tag_index": tag_index,
        "untagged": untagged,
    }
    # Skip the disk write when the index is identical to the last one we wrote
    # (a save that didn't touch any links/tags still triggers a rebuild).
    serialized = json.dumps(index, ensure_ascii=False)
    if _last_index_json.get(vault_path) != serialized:
        index_path = Path(vault_path) / ".link-index.json"
        tmp = index_path.with_suffix(".tmp")
        tmp.write_text(serialized, encoding="utf-8")
        tmp.replace(index_path)
        _last_index_json[vault_path] = serialized
    return index


def get_link_index(vault_path: str) -> dict:
    index_path = Path(vault_path) / ".link-index.json"
    if index_path.exists():
        try:
            return json.loads(index_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"backlinks": {}, "tags": {}, "notes": {}, "tag_index": {}, "untagged": []}


# ---------------------------------------------------------------------------
# Full-text search
# ---------------------------------------------------------------------------


def search_vault(
    vault_path: str, query: str, max_files: int = 200, max_per_file: int = 5
) -> list:
    """Case-insensitive substring search over note contents.

    Returns [{path, name, matches: [{line, text}]}] sorted by note name.
    """
    q = query.strip().lower()
    if not q:
        return []
    # Reuse the shared file cache (same content the link index reads), so a
    # search only hits disk for files that changed since the last scan.
    with _cache_lock:
        files = _refresh_file_cache(vault_path)
        items = sorted(
            (f, _file_cache[f]["content"]) for f in files if f in _file_cache
        )
    results = []
    for fpath, content in items:
        if q not in content.lower():
            continue
        matches = []
        for n, line in enumerate(content.splitlines(), 1):
            low = line.lower()
            if q not in low:
                continue
            snippet = line.strip()
            if len(snippet) > 160:
                idx = low.find(q)
                start = max(0, idx - 40)
                snippet = (
                    ("…" if start > 0 else "") + line[start : start + 160].strip() + "…"
                )
            matches.append({"line": n, "text": snippet})
            if len(matches) >= max_per_file:
                break
        results.append({"path": fpath, "name": Path(fpath).stem, "matches": matches})
        if len(results) >= max_files:
            break
    return results


# ---------------------------------------------------------------------------
# The retrieval worker (server/mdsearch.py) and AI jobs
# ---------------------------------------------------------------------------
#
# LLM search and Suggest tags need the passages of the vault that match a
# question, and the notes most similar to a text. They're found with an
# embedding model (fastembed + numpy) in mdsearch.py, a long-lived worker
# process under a regular python3 (the bundled .app has no pip), which
# installs fastembed on first use. The AI model itself is called from here
# (see the AI section).
#
# One AI job runs at a time: a question (POST /api/llm-search), tag
# suggestions (POST /api/suggest-tags), or a proofread or translation (POST
# /api/proofread, /api/translate). The client polls GET /api/ai-status for
# its progress.

if getattr(sys, "frozen", False):
    MDSEARCH_PATH = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "server" / "mdsearch.py"
else:
    MDSEARCH_PATH = Path(__file__).parent / "mdsearch.py"

_PYTHON_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Library/Frameworks/Python.framework/Versions/Current/bin",
    str(Path.home() / ".local" / "bin"),
    "/usr/bin",
]


def _find_python() -> str:
    if not getattr(sys, "frozen", False):
        return sys.executable
    search = os.environ.get("PATH", "")
    for d in _PYTHON_DIRS:
        if d not in search.split(os.pathsep):
            search += os.pathsep + d
    found = shutil.which("python3", path=search)
    if not found:
        raise FileNotFoundError(
            "LLM search needs Python 3.9 or newer, which was not found. Install it "
            "from https://www.python.org or with `brew install python`, then try again."
        )
    return found


# The worker keeps the search model and the vault's index in memory between
# requests. After this many seconds without a request it is stopped, which
# frees that memory; the next request starts a new one.
WORKER_IDLE_TIMEOUT = 5 * 60


class RetrievalWorker:
    """mdsearch.py --serve. call() sends it one request and returns the
    result; requests are handled one at a time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.proc = None
        self.idle_timer = None

    def call(self, req: dict, on_status=None) -> dict:
        """The worker's result for `req` (see mdsearch.py). on_status gets its
        progress messages (e.g. while it installs fastembed)."""
        with self.lock:
            if self.idle_timer:
                self.idle_timer.cancel()
            if self.proc is None or self.proc.poll() is not None:
                if self.proc is not None:  # it stopped: close its pipes
                    self.proc.stdin.close()
                    self.proc.stdout.close()
                self.proc = subprocess.Popen(
                    [_find_python(), "-u", str(MDSEARCH_PATH), "--serve"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    bufsize=1,
                )
            proc = self.proc
            try:
                proc.stdin.write(json.dumps(req) + "\n")
                proc.stdin.flush()
                for line in proc.stdout:
                    try:
                        ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    kind = ev.pop("event", None)
                    if kind == "status" and on_status:
                        on_status(ev.get("message", ""))
                    elif kind == "result":
                        return ev
                    elif kind == "error":
                        raise RuntimeError(ev.get("message") or "Searching the notes failed.")
            except OSError:  # the worker is gone (broken pipe)
                pass
            finally:
                self.idle_timer = threading.Timer(WORKER_IDLE_TIMEOUT, self._stop, args=(proc,))
                self.idle_timer.daemon = True
                self.idle_timer.start()
            raise RuntimeError(f"The search process stopped unexpectedly (exit code {proc.wait()}).")

    def _stop(self, proc):
        with self.lock:
            if self.proc is not proc:
                return
            self.proc = None
        try:
            proc.stdin.close()  # the worker ends at end of input
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
        except Exception:
            pass
        proc.stdout.close()


retrieval_worker = RetrievalWorker()


class AiJobs:
    """The current AI job, as GET /api/ai-status reports it: {"id", "kind",
    "state" ("running" | "done" | "error"), "status", "error"?} and per kind
    "search": "query", "sources", "answer"; "tags": "results", "total";
    "proofread" and "translate": "step" (e.g. "paragraph 2 of 5"), "answer"
    (the model's answer so far)."""

    BUSY = {
        "search": "answering a question",
        "tags": "suggesting tags",
        "proofread": "proofreading",
        "translate": "translating",
    }

    def __init__(self):
        self.lock = threading.Lock()
        self.job = {"state": "idle"}
        self.last_id = 0

    def _begin(self, kind: str, fields: dict) -> dict:
        with self.lock:
            if self.job.get("state") == "running":
                raise RuntimeError(f"The AI is still {self.BUSY[self.job['kind']]} — please wait.")
            self.last_id += 1
            self.job = {"id": self.last_id, "kind": kind, "state": "running", "status": "Starting …", **fields}
            return self.job

    def _end(self, job: dict, error: Exception | None = None) -> None:
        with self.lock:
            job["state"] = "error" if error else "done"
            if error:
                job["error"] = str(error)

    def update(self, job: dict, **fields) -> None:
        with self.lock:
            job.update(fields)

    def append(self, job: dict, key: str, value) -> None:
        """Add to the job's text or list `key`."""
        with self.lock:
            job[key] = job[key] + value

    def run(self, kind: str, work, **fields):
        """Run work(job) as the current job, in this thread; returns its result."""
        job = self._begin(kind, fields)
        try:
            result = work(job)
        except Exception as e:
            self._end(job, e)
            raise
        self._end(job)
        return result

    def start(self, kind: str, work, **fields) -> int:
        """Run work(job) as the current job, in the background; returns its id."""
        job = self._begin(kind, fields)

        def go():
            try:
                work(job)
            except Exception as e:
                self._end(job, e)
            else:
                self._end(job)

        threading.Thread(target=go, daemon=True).start()
        return job["id"]

    def status(self) -> dict:
        with self.lock:
            return {k: list(v) if isinstance(v, list) else v for k, v in self.job.items()}


ai_jobs = AiJobs()


# The folders whose notes get tags suggested and are learnt from, unless
# "tagIncludedFolders" in the settings says otherwise. A name matches at any depth.
TAG_INCLUDED_FOLDERS = ["annotations", "thoughts"]


def tag_suggestion_request(vault: str, data: dict) -> tuple[list, dict]:
    """The targets and tagged notes for start_tag_suggestions, for POST
    /api/suggest-tags: {"text", "path"?} (a document, possibly unsaved) or
    {"paths": [...]} (saved notes, e.g. the untagged ones). Only notes in the
    included folders are used as tagged notes or as "paths" targets."""
    root = Path(vault)
    rel = lambda p: str(Path(p).resolve().relative_to(root.resolve()))
    note_tags: dict = {}
    with _lock:
        tag_index = build_link_index(vault)["tag_index"]
    folders = set(load_settings().get("tagIncludedFolders", TAG_INCLUDED_FOLDERS))
    included = lambda f: not folders.isdisjoint(Path(f).parts[:-1])
    for entry in tag_index.values():
        for f in entry["files"]:
            if included(rel(f)):
                note_tags.setdefault(rel(f), []).append(entry["name"])
    if not note_tags:
        raise ValueError(
            "No notes in the folders for tag suggestions have tags yet, so there are none to suggest"
        )
    if data.get("paths"):
        paths = [p for p in map(safe_path, data["paths"]) if included(rel(p))]
        targets = [
            {"file": rel(p), "text": p.read_text(encoding="utf-8", errors="replace")} for p in paths
        ]
    else:
        text = data.get("text") or ""
        if not text.strip():
            raise ValueError("Nothing to analyse")
        existing = extract_yaml_tags(text) + extract_inline_tags(text)
        targets = [{
            "file": rel(safe_path(data["path"])) if data.get("path") else None,
            "text": text,
            "existing": list(dict.fromkeys(existing)),
        }]
    return targets, note_tags


# ---------------------------------------------------------------------------
# ZotSeek: semantic search in the Zotero library
# ---------------------------------------------------------------------------
#
# ZotSeek (a Zotero plugin) serves an MCP endpoint inside Zotero's local HTTP
# server; its `search` tool returns papers with the best-matching passage. The
# results carry Zotero item keys, which Better BibTeX's JSON-RPC API turns into
# the citation keys used in documents ([@key]).

ZOTERO_BASE = "http://127.0.0.1:23119"


def _zotero_post(path: str, payload: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        ZOTERO_BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            # Zotero's server rejects a Content-Type with parameters (charset).
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
    # MCP servers may answer as a server-sent event stream; take its data line.
    if body.lstrip().startswith(("event:", "data:")):
        body = next(
            (l[5:].strip() for l in body.splitlines() if l.startswith("data:")), "{}"
        )
    return json.loads(body)


def _zotseek_call(tool: str, arguments: dict) -> dict:
    """Call a ZotSeek MCP tool; returns the tool's JSON result."""
    msg = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    try:
        data = _zotero_post("/zotseek/mcp", msg)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError(
                "ZotSeek was not found in Zotero. Install the ZotSeek plugin and "
                "enable its MCP server in ZotSeek's preferences."
            )
        raise RuntimeError(f"ZotSeek error {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
    except urllib.error.URLError:
        raise RuntimeError("Zotero is not running. Start Zotero (with ZotSeek) and try again.")
    if data.get("error"):
        raise RuntimeError(f"ZotSeek: {data['error'].get('message', data['error'])}")
    result = data.get("result") or {}
    text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
    if result.get("isError"):
        raise RuntimeError(f"ZotSeek: {text or 'search failed'}")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"Unexpected answer from ZotSeek: {text[:300]}")


def _bbt_citation_keys(item_keys: list) -> dict:
    """Map Zotero item keys to Better BibTeX citation keys (missing → absent)."""
    data = _zotero_post(
        "/better-bibtex/json-rpc",
        {"jsonrpc": "2.0", "method": "item.citationkey", "params": [item_keys], "id": 1},
        timeout=15,
    )
    return {k: v for k, v in (data.get("result") or {}).items() if v}


def zotero_reference_link(citekey: str, page: int | None = None) -> dict:
    """A zotero:// link for a cited reference: its PDF at `page` (the printed
    page number from the citation) if it has one, else the item itself.

    Zotero opens a PDF at a PDF page (index + 1), not at a printed page
    number. Where the item's annotations carry page labels, the difference
    between the two is applied; otherwise the number is used as is.
    Returns {url, note}; `note` says how good the page is."""
    select = {"url": f"zotero://select/items/@{citekey}", "note": "Selected in Zotero"}
    try:
        data = _zotero_post(
            "/better-bibtex/json-rpc",
            {"jsonrpc": "2.0", "method": "item.attachments", "params": [citekey], "id": 1},
            timeout=15,
        )
    except urllib.error.URLError:
        raise RuntimeError("Zotero is not running. Start Zotero (with Better BibTeX) and try again.")
    if data.get("error"):
        raise RuntimeError(f"@{citekey} was not found in Zotero (Better BibTeX).")
    if page is None:
        return select
    pdfs = [a for a in data.get("result") or [] if str(a.get("path", "")).lower().endswith(".pdf")]
    if not pdfs:
        return {**select, "note": "No PDF for this reference: selected it in Zotero"}
    pdf = pdfs[0]
    offsets = []
    for ann in pdf.get("annotations") or []:
        label = str(ann.get("annotationPageLabel") or "")
        pos = ann.get("annotationPosition")
        if isinstance(pos, str):
            try:
                pos = json.loads(pos)
            except json.JSONDecodeError:
                pos = None
        if label.isdigit() and isinstance(pos, dict) and isinstance(pos.get("pageIndex"), int):
            offsets.append(pos["pageIndex"] + 1 - int(label))
    offset = max(set(offsets), key=offsets.count) if offsets else 0
    known = any(o != 0 for o in offsets)
    note = (
        f"PDF opened at page {page}"
        + (f" (PDF page {page + offset})" if offset else "")
        + ("" if known else " — the printed page number may differ from the PDF page")
    )
    return {"url": f"{pdf['open']}?page={max(1, page + offset)}", "note": note}


def zotseek_search(query: str, max_results: int = 10) -> dict:
    found = _zotseek_call(
        "search", {"query": query, "max_results": max_results, "granularity": "papers"}
    )
    # ZotSeek ranks by `score` (semantic + keyword fused); it's rounded, so
    # break ties with the semantic similarity.
    results = sorted(
        found.get("results") or [],
        key=lambda r: (-(r.get("score") or 0), -(r.get("semanticScore") or 0)),
    )
    warning = None
    keys = [r["itemKey"] for r in results if r.get("itemKey")]
    try:
        citekeys = _bbt_citation_keys(keys) if keys else {}
    except Exception:
        citekeys = {}
        warning = "Better BibTeX not reachable: citation keys unavailable, so Cite is disabled."
    out = []
    for r in results:
        chunk = r.get("matchedChunk") or {}
        links = r.get("links") or {}
        out.append({
            "itemKey": r.get("itemKey"),
            "citekey": citekeys.get(r.get("itemKey")),
            "title": r.get("title") or "",
            "authors": r.get("authors") or "",
            "year": r.get("year"),
            "snippet": chunk.get("snippet") or "",
            "page": chunk.get("page"),
            "fromFullText": chunk.get("textSource") == "content",
            "similarity": r.get("semanticScore"),
            "keywordMatch": r.get("keywordScore") is not None,
            "selectUrl": links.get("select"),
            "pdfUrl": links.get("openPdf"),
        })
    return {"results": out, "warning": warning}


# ---------------------------------------------------------------------------
# Wikilink maintenance
# ---------------------------------------------------------------------------


def rename_wikilink_targets(vault_path: str, old_stem: str, new_stem: str) -> int:
    """Rewrite [[old_stem]] / [[old_stem|alias]] references across the vault.

    Keeps links working after a note is renamed. Returns the number of files
    changed. Matching is case-insensitive; the alias (text after |) is left
    untouched.
    """
    if not old_stem or old_stem == new_stem:
        return 0
    pattern = re.compile(
        r"(\[\[)\s*" + re.escape(old_stem) + r"\s*(\||\]\])",
        re.IGNORECASE,
    )
    changed = 0
    for fpath in collect_md_files(vault_path):
        try:
            content = Path(fpath).read_text(encoding="utf-8")
        except OSError:
            continue
        new_content, n = pattern.subn(
            lambda m: m.group(1) + new_stem + m.group(2), content
        )
        if n:
            try:
                Path(fpath).write_text(new_content, encoding="utf-8")
                changed += 1
            except OSError:
                pass
    return changed


# ---------------------------------------------------------------------------
# Markdown / Pandoc rendering
# ---------------------------------------------------------------------------

# Common install locations to check beyond PATH. A .app launched from Finder
# inherits a minimal PATH that omits Homebrew/MacPorts/~/.local, so we can't
# rely on PATH alone to locate pandoc.
_TOOL_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    str(Path.home() / ".local" / "bin"),
    "/usr/bin",
]


def _find_tool(name: str) -> str | None:
    """A command-line tool on PATH or in the usual install folders (an app
    started from Finder doesn't get the shell's PATH)."""
    search = os.environ.get("PATH", "")
    for d in _TOOL_DIRS:
        if d not in search.split(os.pathsep):
            search += os.pathsep + d
    return shutil.which(name, path=search)


def _find_pandoc() -> str:
    found = _find_tool("pandoc")
    if not found:
        raise FileNotFoundError(
            "pandoc not found. Install it (e.g. `brew install pandoc`) or turn "
            "off Pandoc rendering in Settings."
        )
    return found


# Matches only a front-matter block at the very start of the document. Used
# to strip a document's own front matter before handing it to Pandoc: Pandoc's
# yaml_metadata_block extension (part of its default "markdown" reader) will
# also try to parse any OTHER "---"-delimited block later in the body as YAML
# metadata if it's preceded by a blank line — which misfires on an ordinary
# horizontal-rule divider followed by prose/heading text, raising a parse
# error. We strip our own front matter ourselves and disable both
# yaml_metadata_block and multiline_tables in Pandoc's --from= extensions (see
# render_pandoc/export_docx): multiline_tables is also on by default and,
# separately, treats two "---"-only divider lines anywhere in the body as the
# start/end of a table, silently mangling everything between them.
_FRONTMATTER_RE = re.compile(r"\A---\n.*?\n(?:---|\.\.\.)[ \t]*\n?", re.DOTALL)


def render_pandoc(markdown: str, file_path: str | None, number_sections: bool = True) -> str:
    """Render markdown via system pandoc, return HTML body fragment."""
    markdown = _FRONTMATTER_RE.sub("", markdown)
    cmd = [
        _find_pandoc(),
        "--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+mark+pipe_tables+lists_without_preceding_blankline+hard_line_breaks-yaml_metadata_block-multiline_tables",
        "--to=html5",
        "--standalone=false",
    ]
    if number_sections:
        cmd.append("--number-sections")  # 1, 1.1, … (respects {-}/{.unnumbered})
    result = subprocess.run(
        cmd,
        input=markdown.encode(),
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()


# Code regions skipped during wikilink inlining, so an example [[link]] inside
# a fence or inline code span isn't replaced with a note body.
_CODE_SPAN_RE = re.compile(r"```.*?```|~~~.*?~~~|`[^`\n]+`", re.DOTALL)


def inline_wikilinks(
    markdown: str, vault_path: str, source_path: str | None = None
) -> str:
    """Replace each [[note]] / [[note|alias]] with the linked note's content.

    Used when exporting to DOCX so the output is self-contained; only the
    markdown string is transformed, notes on disk are never modified.
    Expansion is recursive (an imported note's own wikilinks are imported
    too); a link back to a note already being expanded is left as-is to break
    cycles, as are unresolvable links and links inside code. Front matter of
    imported notes is dropped. `source_path` is the note being exported, so a
    self-link doesn't import the document into itself.
    """
    # Note name (lowercased stem) -> path, first match wins on duplicates —
    # same resolution rule as the link index.
    notes: dict = {}
    for f in collect_md_files(vault_path):
        notes.setdefault(Path(f).stem.lower(), f)

    def expand(text: str, stack: frozenset) -> str:
        out = []
        pos = 0
        for m in _CODE_SPAN_RE.finditer(text):
            out.append(expand_segment(text[pos : m.start()], stack))
            out.append(m.group(0))
            pos = m.end()
        out.append(expand_segment(text[pos:], stack))
        return "".join(out)

    def expand_segment(segment: str, stack: frozenset) -> str:
        def repl(m):
            # An anchor ([[note#heading]]) imports the whole note; a pure
            # self-anchor ([[#heading]]) has no note to import.
            name = m.group(1).split("#")[0].strip().lower()
            fpath = notes.get(name)
            if not fpath or name in stack:
                return m.group(0)
            try:
                content = Path(fpath).read_text(encoding="utf-8")
            except OSError:
                return m.group(0)
            content = _FRONTMATTER_RE.sub("", content).strip()
            return expand(content, stack | {name})

        return _WIKILINK_RE.sub(repl, segment)

    stack = frozenset()
    if source_path:
        stack |= {Path(source_path).stem.lower()}
    return expand(markdown, stack)


def export_docx(markdown: str, source_path: str | None = None) -> bytes:
    """Export markdown to DOCX via Pandoc with bibliography and reference doc.

    Uses settings for bibliography, CSL style, and reference document paths.
    Wikilinked notes are inlined first (see inline_wikilinks) so the document
    is self-contained. Returns the binary DOCX file content.
    """
    settings = load_settings()
    bib_path = settings.get("cslJsonPath")
    csl_path = settings.get("cslStylePath")
    ref_doc_path = settings.get("pandocRefDocPath")

    if not bib_path:
        raise ValueError("Bibliography path not configured in settings")
    if not csl_path:
        raise ValueError("CSL style path not configured in settings")

    markdown = _FRONTMATTER_RE.sub("", markdown)
    vault = settings.get("vaultPath")
    if vault:
        markdown = inline_wikilinks(markdown, vault, source_path)
    # The command to export to docx. The DOCX goes to a temporary file rather
    # than stdout, because zotero.lua print()s status messages to stdout.
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "document.docx"
        # citeproc (-C) must run before zotero.lua: the filter uses each
        # citation's text as the field's placeholder until Zotero refreshes
        # it, so without citeproc Word shows the raw "[@key, 12]".
        cmd = [
            _find_pandoc(),
            "-C",  # citeproc
            f"--bibliography={bib_path}",
            f"--csl={csl_path}",
            f"--lua-filter={zotero_lua_path(csl_path)}",
            "--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+mark+pipe_tables+lists_without_preceding_blankline+hard_line_breaks-yaml_metadata_block-multiline_tables",
            "--to=docx",
            f"--output={out_path}",
        ]
        if ref_doc_path:
            cmd.append(f"--reference-doc={ref_doc_path}")

        result = subprocess.run(
            cmd,
            input=markdown.encode(),
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode())
        return out_path.read_bytes()


def zotero_lua_path(csl_path: str) -> Path:
    """The zotero.lua Pandoc filter for the Word export: the one next to the
    CSL style if there is one, otherwise the copy in `pandoc items/`."""
    beside_csl = Path(csl_path).expanduser().parent / "zotero.lua"
    if beside_csl.is_file():
        return beside_csl
    return PANDOC_ITEMS_DIR / "zotero.lua"


# ---------------------------------------------------------------------------
# AI: LLM search, tag suggestion, proofreading and translation
# ---------------------------------------------------------------------------

# The system prompts live in src/*.md so they can be edited without touching
# code; they're read on each request.
def _prompt(name: str) -> str:
    try:
        return (SRC_DIR / name).read_text(encoding="utf-8").strip()
    except OSError as e:
        raise RuntimeError(f"Could not read the prompt file {name}: {e}")


# Proofreading returns one list mixing three kinds of findings, told apart by
# `type`: language corrections, passive-voice warnings, and PEE (Point,
# Evidence, Explanation) paragraph-structure notes. Passive and structure items
# may have an empty `suggestion`: a warning without a ready-made rewrite.
PROOFREAD_TYPES = ["correction", "passive", "structure"]
PROOFREAD_JSON_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": PROOFREAD_TYPES},
            "original": {"type": "string"},
            "suggestion": {"type": "string"},
            "comment": {"type": "string"},
        },
        "required": ["type", "original", "suggestion", "comment"],
    },
}
# Translations are proofread items without `type`, so the client renders and
# applies them the same way.
_ITEM = PROOFREAD_JSON_SCHEMA["items"]
TRANSLATE_JSON_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {k: v for k, v in _ITEM["properties"].items() if k != "type"},
        "required": [k for k in _ITEM["required"] if k != "type"],
    },
}


# --- AI models (settings.json "aiModels") ----------------------------------
#
# Every AI model is reached through the OpenAI-compatible chat completions API
# of its service: {"url" (…/v1), "model", "apiKey" (if the service needs one),
# "small"}. "small" marks a small (local) model: Proofread and Translate then
# work one paragraph at a time, with simpler prompts (src/*_SMALL.md). The
# selected model, used by all AI functions, is "aiModel" (its ai_model_key).
# AI_PRESETS fill in the URL in the Add dialog; any other URL works too.
AI_PRESETS = [
    {"name": "Gemini", "url": "https://generativelanguage.googleapis.com/v1beta/openai", "example": "gemini-2.5-flash"},
    {"name": "OpenAI", "url": "https://api.openai.com/v1", "example": "gpt-5-mini"},
    {"name": "Mistral", "url": "https://api.mistral.ai/v1", "example": "mistral-small-latest"},
    {"name": "Anthropic", "url": "https://api.anthropic.com/v1", "example": "claude-sonnet-5-5"},
    {"name": "Local LLM", "url": "http://127.0.0.1:8000/v1", "example": "mlx-community/Qwen3-4B-Instruct-2507-4bit", "small": True},
    {"name": "Ollama", "url": "http://localhost:11434/v1", "example": "qwen3:4b", "small": True},
]


def ai_model_key(cfg: dict) -> str:
    return f"{cfg['model']} @ {cfg['url']}"


def ai_model_name(cfg: dict) -> str:
    """The service's name: its preset's, or the URL's host."""
    preset = next((p for p in AI_PRESETS if p["url"] == cfg["url"]), None)
    return preset["name"] if preset else (urlparse(cfg["url"]).netloc or cfg["url"])


def _is_local(url: str) -> bool:
    return (urlparse(url).hostname or "") in ("localhost", "127.0.0.1", "::1")


def load_ai_models(settings: dict | None = None) -> list[dict]:
    models = (settings if settings is not None else load_settings()).get("aiModels")
    if not isinstance(models, list):
        return []
    return [m for m in models if isinstance(m, dict) and m.get("url") and m.get("model")]


def add_ai_model(url: str, model: str, api_key: str = "", small: bool = False) -> dict:
    """Add a model, or replace the settings of the same model at the same URL."""
    entry = {"url": url.strip().rstrip("/"), "model": model.strip(), "apiKey": api_key.strip(), "small": bool(small)}
    if not re.match(r"https?://", entry["url"]):
        raise ValueError("Enter the service's URL (http://… or https://…)")
    if not entry["model"]:
        raise ValueError("A model name is required")
    with _lock:
        settings = load_settings()
        models = load_ai_models(settings)
        same = [i for i, m in enumerate(models) if ai_model_key(m) == ai_model_key(entry)]
        if same:
            models[same[0]] = entry
        else:
            models.append(entry)
        settings["aiModels"] = models
        save_settings(settings)
    return entry


def remove_ai_model(key: str) -> None:
    """Remove a model, and the selection if it was the selected one."""
    with _lock:
        settings = load_settings()
        settings["aiModels"] = [m for m in load_ai_models(settings) if ai_model_key(m) != key]
        if settings.get("aiModel") == key:
            settings.pop("aiModel")
        save_settings(settings)


def selected_ai_model(settings: dict | None = None) -> dict:
    settings = settings if settings is not None else load_settings()
    models = load_ai_models(settings)
    if not models:
        raise RuntimeError("No AI model is set up. Add one under Settings → AI.")
    selected = settings.get("aiModel")
    cfg = next((m for m in models if ai_model_key(m) == selected), None)
    if cfg is None:
        if selected:
            raise RuntimeError(
                f"The selected AI model ({selected}) is not set up any more. "
                "Choose another one under Settings → AI."
            )
        cfg = models[0]
    return cfg


# --- Talking to the model ---------------------------------------------------

# A reasoning model's thoughts (Qwen3 and others), left out of answers.
THINK = re.compile(r"<think>.*?(</think>|\Z)", re.S)


def ai_chat(
    system: str,
    user: str,
    cfg: dict,
    *,
    json_schema: dict | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    on_text=None,
) -> str:
    """The answer of the model `cfg` to one prompt, without a reasoning
    model's thoughts. It is streamed: on_text gets each piece as it comes.

    json_schema asks for JSON of that shape, wrapped in an object as
    structured output requires one at the top level (parse_json_list unwraps
    it). A service that rejects one of the request's options (structured
    output, temperature, max_tokens) is asked again without it."""
    name = ai_model_name(cfg)
    body = {
        "model": cfg["model"],
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": True,
    }
    if max_tokens:
        body["max_tokens"] = max_tokens
    if temperature is not None:
        body["temperature"] = temperature
    if json_schema is not None:
        wrapped = {"type": "object", "properties": {"items": json_schema}, "required": ["items"]}
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "result", "schema": wrapped, "strict": False},
        }
    headers = {"Content-Type": "application/json"}
    if cfg.get("apiKey"):
        headers["Authorization"] = f"Bearer {cfg['apiKey']}"
    while True:
        req = urllib.request.Request(
            f"{cfg['url']}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        try:
            # Generous: a local server may first have to load the model.
            resp = urllib.request.urlopen(req, timeout=600)
            break
        except urllib.error.HTTPError as e:
            err = _api_error(name, e)
            if any(t in str(err) for t in ("context window", "context overflow", "context_length")):
                raise RuntimeError(
                    f"The text is too long for {name}'s model. Select a smaller part of the text and try again."
                )
            if e.code in (400, 422) and _relax_request(body, str(err)):
                continue
            if e.code == 404:
                raise RuntimeError(f"{err} Check the URL ({cfg['url']}) and the model name ('{cfg['model']}').")
            raise err
        except urllib.error.URLError as e:
            hint = " — is it running?" if _is_local(cfg["url"]) else ""
            raise RuntimeError(f"Could not reach {name} at {cfg['url']}{hint} ({e.reason})")

    parts, finish = [], None
    with resp:
        # Server-sent events: "data: {json}" lines, ending with "data: [DONE]".
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk, list) and chunk:  # Gemini wraps an error in a list
                chunk = chunk[0]
            if chunk.get("error"):
                err = chunk["error"]
                raise RuntimeError(f"{name}: {err.get('message', err) if isinstance(err, dict) else err}")
            for choice in chunk.get("choices") or []:
                finish = choice.get("finish_reason") or finish
                text = (choice.get("delta") or {}).get("content")
                if text:
                    parts.append(text)
                    if on_text:
                        on_text(text)
    if finish == "length":
        raise RuntimeError(
            f"{name}'s answer was cut off because it got too long. Select a smaller part of the text and try again."
        )
    answer = THINK.sub("", "".join(parts)).strip()
    if not answer:
        raise RuntimeError(f"{name} returned an empty answer.")
    return answer


def _relax_request(body: dict, message: str) -> bool:
    """Drop or replace the option of `body` the service rejected (going by its
    error message), or step down to a simpler response format; False if
    there's nothing left to try."""
    m = message.lower()
    if "max_tokens" in body and "max_tokens" in m:
        body["max_completion_tokens"] = body.pop("max_tokens")  # OpenAI's reasoning models
    elif "temperature" in body and "temperature" in m:
        del body["temperature"]
    elif body.get("response_format", {}).get("type") == "json_schema":
        body["response_format"] = {"type": "json_object"}
    elif "response_format" in body:
        del body["response_format"]
    else:
        return False
    return True


def _api_error(name: str, e: urllib.error.HTTPError) -> RuntimeError:
    """A readable error for a service's HTTP error: its own message rather
    than the raw JSON body, with a hint for the common cases."""
    body = e.read().decode("utf-8", "replace")
    e.close()
    message = body
    try:
        data = json.loads(body)
        if isinstance(data, list) and data:  # Gemini wraps its error in a list
            data = data[0]
        err = data.get("error", data)
        if isinstance(err, dict):
            message = err.get("message") or err.get("detail") or body
        elif isinstance(err, str):
            message = err
        elif data.get("message"):
            message = data["message"]
    except (json.JSONDecodeError, AttributeError):
        pass
    message = " ".join(str(message).split())[:400].rstrip()
    if message and message[-1] not in ".!?":
        message += "."
    hints = {
        401: "Check the API key.",
        403: "Check the API key, or choose a model your account can use.",
        429: "Rate limit or quota reached — wait a moment and try again.",
    }
    hint = hints.get(e.code) or ("The service has a problem; try again later." if e.code >= 500 else "")
    return RuntimeError(f"{name} error {e.code}: {message}" + (f" {hint}" if hint else ""))


# --- LLM search ---------------------------------------------------------------

SEARCH_MAX_TOKENS = 2048


def start_llm_search(vault: str, query: str) -> int:
    """Answer a question about the notes from the passages that match it."""
    cfg = selected_ai_model()

    def work(job):
        found = retrieval_worker.call({"vault": vault, "query": query}, lambda m: ai_jobs.update(job, status=m))
        passages = found["passages"]
        ai_jobs.update(job, sources=[{**p, "path": os.path.join(vault, p["file"])} for p in passages])
        if not passages:
            ai_jobs.update(job, answer="No matching passages found in your notes.")
            return
        ai_jobs.update(job, status=f"Answering with {ai_model_name(cfg)} …")
        context = "\n\n".join(f"[{p['file']}:{p['line']}]\n{p['text']}" for p in passages)
        answer = ai_chat(
            _prompt("SEARCH_SYSTEM.md"),
            f"Excerpts:\n\n{context}\n\nQuestion: {query}",
            cfg,
            max_tokens=SEARCH_MAX_TOKENS,
            temperature=0.2,
            on_text=lambda t: ai_jobs.append(job, "answer", t),
        )
        ai_jobs.update(job, answer=answer)

    return ai_jobs.start("search", work, query=query, sources=[], answer="")


# --- Tag suggestion -----------------------------------------------------------
#
# Tags for a note, from the vault's existing tags: the notes most similar in
# meaning that already have tags are found with the embeddings, and the model
# picks the tags, with those notes and their tags as examples. Tested on the
# vault's own tagged notes, the examples clearly help the model (and the model
# clearly beats just counting the neighbours' tags).

TAG_TEXT_CHARS = 2000  # start of the note given to the model
MAX_TAGS = 3
_INLINE_TAG_ANY = re.compile(r"(^|[^\w&#])#[\w/-]+")


def start_tag_suggestions(vault: str, targets: list, note_tags: dict) -> int:
    """Suggest tags for `targets` (see tag_suggestion_request): the job's
    "results" gets {"path", "tags", "evidence": {tag: [similar notes]}} per
    target."""
    cfg = selected_ai_model()
    allowed = sorted({t for tags in note_tags.values() for t in tags}, key=str.lower)

    def work(job):
        status = lambda m: ai_jobs.update(job, status=m)
        for n, target in enumerate(targets, 1):
            status(f"Choosing tags: note {n} of {len(targets)} …" if len(targets) > 1 else "Choosing tags …")
            text = _INLINE_TAG_ANY.sub(r"\1", target["text"]).strip()
            existing = target.get("existing") or []
            tags, notes = [], []
            if text:
                similar = {"text": text, "file": target.get("file"), "candidates": list(note_tags)}
                notes = [f for f, _ in retrieval_worker.call({"vault": vault, "similar": similar}, status)["notes"]]
                answer = ai_chat(
                    _prompt("SUGGEST_TAGS_SYSTEM.md"),
                    _tag_request(text, notes, note_tags, allowed, existing),
                    cfg,
                    max_tokens=200,
                    temperature=0,
                )
                tags = parse_tags(answer, allowed, existing)
            result = {
                "path": os.path.join(vault, target["file"]) if target.get("file") else None,
                "tags": tags,
                "evidence": {
                    t: [os.path.join(vault, f) for f in notes if t.lower() in {x.lower() for x in note_tags[f]}]
                    for t in tags
                },
            }
            ai_jobs.append(job, "results", [result])

    return ai_jobs.start("tags", work, results=[], total=len(targets))


def _tag_request(text: str, notes: list, note_tags: dict, allowed: list, existing: list) -> str:
    examples = "\n".join(f"- {Path(f).stem}: {', '.join(note_tags[f])}" for f in notes) or "(none)"
    user = f"Allowed tags: {', '.join(allowed)}\n\nSimilar notes and their tags:\n{examples}\n\n"
    if existing:
        user += f"The note already has these tags; don't repeat them: {', '.join(existing)}\n\n"
    return user + f"Note:\n{text[:TAG_TEXT_CHARS]}"


def parse_tags(answer: str, allowed: list, existing: list) -> list:
    """The allowed tags in the model's answer (canonical spelling, at most
    MAX_TAGS), leaving out the ones the note already has."""
    canon = {t.lower(): t for t in allowed}
    skip = {t.lower() for t in existing}
    out = []
    for part in re.split(r"[,\n]", answer):
        key = part.strip().strip("*-.` ").lstrip("#").strip().lower()
        if key in canon and key not in skip and canon[key] not in out:
            out.append(canon[key])
    return out[:MAX_TAGS]


# --- Proofreading and translation ----------------------------------------------
#
# A large model gets the whole text at once, with the full prompt
# (src/PROOFREAD_SYSTEM.md, src/TRANSLATE_SYSTEM.md) and a JSON schema for its
# answer. A small one ("small" in its settings) gets simpler prompts
# (src/*_SMALL.md) and one paragraph at a time: it proofreads each with a short
# example, and translates each as plain text, from which the items are built
# here (so every 'original' is exact).

SMALL_MAX_TOKENS = 4096  # room for a long paragraph


def proofread_text(text: str) -> list:
    """Proofread `text`: a list of findings (PROOFREAD_JSON_SCHEMA items)."""
    cfg = selected_ai_model()

    def work(job):
        if not cfg.get("small"):
            ai_jobs.update(job, status=f"Waiting for {ai_model_name(cfg)} …")
            raw = ai_chat(
                _prompt("PROOFREAD_SYSTEM.md"), text, cfg,
                json_schema=PROOFREAD_JSON_SCHEMA, on_text=lambda t: ai_jobs.append(job, "answer", t),
            )
            return _parse_suggestions(raw)
        items: list = []
        for paragraph in _each_paragraph(job, text, cfg):
            raw = ai_chat(
                _prompt("PROOFREAD_SYSTEM_SMALL.md"), paragraph, cfg,
                max_tokens=SMALL_MAX_TOKENS, temperature=0.2, on_text=lambda t: ai_jobs.append(job, "answer", t),
            )
            for item in parse_json_list(raw) or []:
                # Only findings that can be found in the text.
                if not isinstance(item, dict) or not str(item.get("original") or "") in paragraph:
                    continue
                item = {k: str(item.get(k) or "") for k in ("type", "original", "suggestion", "comment")}
                if item["type"] not in PROOFREAD_TYPES:
                    item["type"] = "correction"
                # A "correction" that changes nothing ("No error") isn't one.
                no_change = item["type"] == "correction" and item["suggestion"] in ("", item["original"])
                # The same finding on a shorter or longer passage: keep the first.
                overlaps = any(
                    i["type"] == item["type"] and (i["original"] in item["original"] or item["original"] in i["original"])
                    for i in items
                )
                if item["original"].strip() and not no_change and not overlaps:
                    items.append(item)
        return items

    return ai_jobs.run("proofread", work, step=None, answer="")


def translate_text(text: str, target_lang: str) -> list:
    """Translate `text` into `target_lang` (the prompts' {{TARGET_LANGUAGE}}):
    a list of passages with their translations (TRANSLATE_JSON_SCHEMA items)."""
    target = (target_lang or "").strip() or "English"
    cfg = selected_ai_model()

    def work(job):
        if not cfg.get("small"):
            ai_jobs.update(job, status=f"Waiting for {ai_model_name(cfg)} …")
            system = _prompt("TRANSLATE_SYSTEM.md").replace("{{TARGET_LANGUAGE}}", target)
            raw = ai_chat(
                system, text, cfg,
                json_schema=TRANSLATE_JSON_SCHEMA, on_text=lambda t: ai_jobs.append(job, "answer", t),
            )
            return _parse_suggestions(raw)
        system = _prompt("TRANSLATE_SYSTEM_SMALL.md").replace("{{TARGET_LANGUAGE}}", target)
        items = []
        for paragraph in _each_paragraph(job, text, cfg):
            translation = ai_chat(
                system, paragraph, cfg,
                max_tokens=SMALL_MAX_TOKENS, temperature=0.2, on_text=lambda t: ai_jobs.append(job, "answer", t),
            )
            # (Nearly) unchanged: the paragraph is already in `target`.
            if difflib.SequenceMatcher(None, paragraph, translation).ratio() < 0.9:
                items.append({"original": paragraph, "suggestion": translation, "comment": ""})
        return items

    return ai_jobs.run("translate", work, step=None, answer="")


def _each_paragraph(job: dict, text: str, cfg: dict):
    """The prose paragraphs of `text`, keeping the job's progress up to date."""
    paragraphs = prose_paragraphs(text)
    for n, paragraph in enumerate(paragraphs, 1):
        ai_jobs.update(
            job,
            step=f"paragraph {n} of {len(paragraphs)}" if len(paragraphs) > 1 else None,
            status=f"Waiting for {ai_model_name(cfg)} …",
            answer="",
        )
        yield paragraph


def prose_paragraphs(text: str) -> list[str]:
    """The paragraphs of `text` (split at blank lines) that contain prose,
    for a small model: without frontmatter, code blocks, and paragraphs of
    only links, tags, citations or footnote markers."""
    body = re.sub(r"\A---\n.*?\n---[ \t]*(\n|\Z)", "", text, flags=re.S)
    out = []
    for paragraph in re.split(r"\n[ \t]*\n", body):
        paragraph = paragraph.strip()
        if not paragraph or paragraph.startswith(("```", "~~~")):
            continue
        prose = re.sub(
            r"\[\[[^\]]*\]\]|\]\([^)]*\)|(^|\s)#[\w/-]+|\[\^[^\]]*\]|\[@[^\]]*\]", " ", paragraph
        )
        if len(re.findall(r"[^\W\d_]{2,}", prose)) >= 3:
            out.append(paragraph)
    return out


def _parse_suggestions(raw: str) -> list:
    """The suggestions in a model's raw answer."""
    suggestions = parse_json_list(raw)
    if suggestions is None:
        start = " ".join(raw.split())[:200]
        raise RuntimeError(f"The AI's answer wasn't in the expected format: {start}")
    return suggestions


def parse_json_list(raw: str) -> list | None:
    """The JSON array in a model response, or None if there is none. Accepts
    a ```json fence, text around the array, and an array wrapped in an object
    ({"suggestions": [...]}) — what JSON mode returns, since it only allows
    objects at the top level."""
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end < start:
            return None
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    if isinstance(data, dict):
        lists = [v for v in data.values() if isinstance(v, list)]
        if len(lists) == 1:
            data = lists[0]
        elif not lists and {"original", "suggestion"} <= data.keys():
            data = [data]  # a single item instead of a list of one
    return data if isinstance(data, list) else None


# ---------------------------------------------------------------------------
# Git integration
# ---------------------------------------------------------------------------
#
# When the vault is a git working tree we keep it synced: changes are committed
# and pushed on focus loss, on a timer, and after renames/moves (which use
# `git mv` so history is preserved). All git invocations go through `_git`, which
# runs against the vault with a timeout and never raises for a non-zero exit —
# callers inspect returncode/stderr so auth failures can be surfaced to the user.


def _find_git() -> str | None:
    """Locate the git executable, checking common install dirs beyond PATH
    (a Finder-launched .app inherits a minimal PATH). None if not installed."""
    return _find_tool("git")


def _git(args: list, vault: Path, timeout: int = 60) -> subprocess.CompletedProcess:
    """Run `git <args>` inside `vault`. Returns the completed process (text mode);
    a fake returncode-127 result if git isn't installed."""
    git = _find_git()
    if not git:
        return subprocess.CompletedProcess(args, 127, "", "git not found")
    return subprocess.run(
        [git, "-C", str(vault), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def is_git_repo(vault: Path) -> bool:
    r = _git(["rev-parse", "--is-inside-work-tree"], vault, timeout=10)
    return r.returncode == 0 and r.stdout.strip() == "true"


def git_has_remote(vault: Path) -> bool:
    r = _git(["remote"], vault, timeout=10)
    return r.returncode == 0 and bool(r.stdout.strip())


def _commit_message(vault: Path) -> str:
    """Build a concise commit message from the staged changes."""
    r = _git(["diff", "--cached", "--name-status"], vault, timeout=30)
    entries = []  # (code, path, old_path|None)
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        code = parts[0][0]  # first letter: A/M/D/R/C/...
        if code == "R" and len(parts) >= 3:
            entries.append((code, parts[2], parts[1]))
        else:
            entries.append((code, parts[1], None))

    verb = {"A": "Add", "M": "Update", "D": "Delete", "R": "Rename", "C": "Copy"}
    if not entries:
        return "Update vault"
    if len(entries) == 1:
        code, path, old = entries[0]
        if code == "R":
            return f"Rename {old} → {path}"
        return f"{verb.get(code, 'Update')} {path}"
    # Multiple files: one-line summary + a short body listing each change.
    header = f"Update {len(entries)} files"
    body = "\n".join(
        (f"R {old} → {path}" if code == "R" else f"{code} {path}")
        for code, path, old in entries
    )
    return f"{header}\n\n{body}"


def git_commit_all(vault: Path, message: str | None = None) -> dict:
    """Stage everything, commit (if there is anything to commit), and push.

    Returns a dict the client can act on. Never raises for git-level failures;
    push errors (typically missing credentials) come back as needs_auth so the
    user can be told to fix them in a terminal.
    """
    if not is_git_repo(vault):
        return {"is_repo": False}

    add = _git(["add", "-A"], vault)
    if add.returncode != 0:
        return {"is_repo": True, "committed": False, "error": add.stderr.strip()}

    # Anything staged? `diff --cached --quiet` exits 1 when there are changes.
    if _git(["diff", "--cached", "--quiet"], vault).returncode == 0:
        return {"is_repo": True, "committed": False, "reason": "clean"}

    msg = message or _commit_message(vault)
    commit = _git(["commit", "-m", msg], vault)
    if commit.returncode != 0:
        return {"is_repo": True, "committed": False, "error": commit.stderr.strip()}

    result = {"is_repo": True, "committed": True, "message": msg.splitlines()[0]}

    if not git_has_remote(vault):
        result["pushed"] = False
        result["reason"] = "no-remote"
        return result

    push = _git(["push"], vault, timeout=120)
    if push.returncode != 0:
        result["pushed"] = False
        result["error"] = push.stderr.strip() or push.stdout.strip()
        result["needs_auth"] = True
    else:
        result["pushed"] = True
    return result


# ---------------------------------------------------------------------------
# Folder / file picker (macOS osascript)
# ---------------------------------------------------------------------------


def pick_folder(prompt: str = "Select your Markdown vault folder") -> str | None:
    # Pass the prompt as an argument rather than interpolating it into the
    # script source, so a prompt containing quotes can't inject AppleScript.
    script = (
        "on run argv\n"
        "  POSIX path of (choose folder with prompt (item 1 of argv))\n"
        "end run"
    )
    r = subprocess.run(
        ["osascript", "-e", script, prompt], capture_output=True, text=True
    )
    if r.returncode == 0:
        return r.stdout.strip().rstrip("/")
    return None


def pick_file(extensions: list, prompt: str = "Select a file") -> str | None:
    # Sanitise extensions (they come from the client) to a safe alphanumeric set
    # and pass the prompt as an argument to avoid AppleScript injection.
    # Convert extensions to macOS UTIs for proper file filtering.
    ext_to_uti = {
        "json": "public.json",
        "bib": "public.plain-text",
        "csl": "public.item",
        "docx": "org.openxmlformats.wordprocessingml.document",
        "xml": "public.xml",
    }
    safe_exts = [re.sub(r"[^A-Za-z0-9]", "", e).lower() for e in extensions]
    safe_exts = [e for e in safe_exts if e]
    utis = [ext_to_uti.get(e, f"public.{e}") for e in safe_exts]
    type_clause = ""
    if utis:
        uti_list = ", ".join(f'"{u}"' for u in utis)
        type_clause = f" of type {{{uti_list}}}"
    script = (
        "on run argv\n"
        f"  POSIX path of (choose file with prompt (item 1 of argv){type_clause})\n"
        "end run"
    )
    r = subprocess.run(
        ["osascript", "-e", script, prompt], capture_output=True, text=True
    )
    if r.returncode == 0:
        return r.stdout.strip()
    return None


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------


class Handler(SimpleHTTPRequestHandler):
    server_version = "humd-editor/1.0"

    def log_message(self, format, *args):
        pass  # suppress default request logging

    def end_headers(self):
        # Dev server with no build step: the loop is "edit a file, reload the
        # browser". Tell the browser to always revalidate static assets so it
        # can't link a fresh app.js against a stale, cached ES module (which
        # surfaces as "Importing binding name '…' is not found"). API responses
        # set their own caching (e.g. /api/image), so leave those alone.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def translate_path(self, path):
        # Serve static files from src/
        parsed = urlparse(path)
        rel = parsed.path.lstrip("/")
        return str(SRC_DIR / rel) if rel else str(SRC_DIR / "index.html")

    def request_allowed(self) -> bool:
        """Reject requests not clearly originating from the local editor.

        The frontend is same-origin, so it never needs CORS. We refuse any
        request whose Host isn't localhost (blocks DNS-rebinding) or whose
        Origin, when present, points elsewhere (blocks other tabs poking the
        API). This is what keeps arbitrary websites from reading/writing files.
        """
        host = self.headers.get("Host", "")
        hostname = host.rsplit(":", 1)[0] if host else ""
        if hostname not in ALLOWED_HOSTS:
            return False
        origin = self.headers.get("Origin")
        if origin:
            o = urlparse(origin).hostname
            if o not in ALLOWED_HOSTS and o not in ("::1",):
                return False
        return True

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, msg, status=400):
        self.send_json({"error": msg}, status)

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    def do_GET(self):
        if not self.request_allowed():
            self.send_error_json("Forbidden", 403)
            return
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path == "/api/ai-models":
            try:
                settings = load_settings()
                self.send_json({
                    "models": [
                        {**m, "key": ai_model_key(m), "name": ai_model_name(m)} for m in load_ai_models(settings)
                    ],
                    "selected": settings.get("aiModel") or "",
                    "presets": AI_PRESETS,
                })
            except Exception as e:
                self.send_error_json(str(e))
                return
        elif path == "/api/settings":
            self.send_json(load_settings())
        elif path == "/api/version":
            self.send_json({"version": SERVER_VERSION})
        elif path == "/api/list-vault":
            vault_path = qs.get("path", [None])[0]
            if not vault_path:
                self.send_error_json("path required")
                return
            try:
                self.send_json(
                    list_dir_internal(str(safe_path(vault_path)), is_root=True)
                )
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/list-dir":
            dir_path = qs.get("path", [None])[0]
            if not dir_path:
                self.send_error_json("path required")
                return
            try:
                self.send_json(
                    list_dir_internal(str(safe_path(dir_path)), is_root=False)
                )
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/read-file":
            file_path = qs.get("path", [None])[0]
            if not file_path:
                self.send_error_json("path required")
                return
            try:
                # Try vault path first. If it's outside the vault, allow it if
                # it's in the home directory (for bibliography/CSL files).
                try:
                    fpath = safe_path(file_path, must_exist=True)
                except PermissionError as e:
                    if "outside the vault" in str(e):
                        fpath = safe_path_home(file_path, must_exist=True)
                    else:
                        raise
                content = fpath.read_text(encoding="utf-8")
                self.send_json({"content": content})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/image":
            file_path = qs.get("path", [None])[0]
            if not file_path:
                self.send_error_json("path required")
                return
            try:
                fpath = safe_path(file_path, must_exist=True)
                data = fpath.read_bytes()
                mime, _ = mimetypes.guess_type(str(fpath))
                mime = mime or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=3600")
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/vault-hash":
            vault_path = qs.get("path", [None])[0]
            if not vault_path:
                self.send_error_json("path required")
                return
            # "hash" changes when a note is saved (reload its tab, re-index
            # links); "tree" only when the file browser's contents change.
            self.send_json(
                {"hash": get_vault_hash(vault_path), "tree": get_vault_tree_hash(vault_path)}
            )
        elif path == "/api/git-info":
            # Whether the current vault is a git working tree (and has a remote).
            try:
                root = vault_root()
                if root is None or not is_git_repo(root):
                    self.send_json({"is_repo": False})
                else:
                    self.send_json(
                        {"is_repo": True, "has_remote": git_has_remote(root)}
                    )
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/tags":
            vault_path = qs.get("vault_path", [None])[0]
            note_path = qs.get("note_path", [None])[0]
            if not vault_path or not note_path:
                self.send_json([])
                return
            index = get_link_index(vault_path)
            self.send_json(index.get("tags", {}).get(note_path, []))
        elif path == "/api/link-index":
            vault_path = qs.get("path", [None])[0]
            if not vault_path:
                self.send_error_json("path required")
                return
            self.send_json(get_link_index(vault_path))
        elif path == "/api/search":
            vault_path = qs.get("vault_path", [None])[0]
            query = qs.get("q", [""])[0]
            if not vault_path:
                self.send_error_json("vault_path required")
                return
            try:
                self.send_json(search_vault(str(safe_path(vault_path)), query))
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/ai-status":
            self.send_json(ai_jobs.status())
        elif path == "/api/zotero-cayw":
            # Proxy the Better BibTeX "cite as you write" picker. Doing this
            # server-side avoids the browser's flaky cross-origin long-poll to
            # Zotero (Safari drops it as "network connection lost"). The request
            # blocks until the user picks a citation or cancels the popup.
            fmt = qs.get("format", ["pandoc"])[0]
            url = f"http://127.0.0.1:23119/better-bibtex/cayw?format={fmt}"
            try:
                with urllib.request.urlopen(url, timeout=300) as resp:
                    body = resp.read().decode("utf-8")
                self.send_json({"citation": body})
            except Exception as e:
                self.send_error_json(f"Zotero not available: {e}", 502)
        else:
            # Serve static file
            super().do_GET()

    def do_POST(self):
        if not self.request_allowed():
            self.send_error_json("Forbidden", 403)
            return
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/add-ai-model":
            try:
                data = self.read_body()
                entry = add_ai_model(
                    data.get("url") or "", data.get("model") or "", data.get("apiKey") or "", data.get("small")
                )
                self.send_json({"key": ai_model_key(entry)})
            except Exception as e:
                self.send_error_json(str(e))
                return
        elif path == "/api/remove-ai-model":
            try:
                data = self.read_body()
                remove_ai_model(data.get("key") or "")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_error_json(str(e))
                return
        elif path == "/api/settings":
            try:
                data = self.read_body()
                with _lock:
                    existing = load_settings()
                    existing.update(data)
                    save_settings(existing)
                self.send_json({"ok": True})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/open-settings-file":
            try:
                open_settings_file()
                self.send_json({"ok": True})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/write-file":
            try:
                data = self.read_body()
                safe_path(data["path"]).write_text(data["content"], encoding="utf-8")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/create-file":
            try:
                data = self.read_body()
                name = data["name"]
                if "/" in name or "\\" in name:
                    raise ValueError("Name cannot contain path separators")
                if not name.endswith(".md"):
                    name += ".md"
                file_path = safe_path(str(Path(data["vault_path"]) / name))
                file_path.write_text("", encoding="utf-8")
                self.send_json({"path": str(file_path)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/create-folder":
            try:
                data = self.read_body()
                name = data["name"]
                if "/" in name or "\\" in name:
                    raise ValueError("Name cannot contain path separators")
                parent = data.get("parent_path") or data["vault_path"]
                dir_path = safe_path(str(Path(parent) / name))
                if dir_path.exists():
                    raise ValueError(f"'{name}' already exists")
                dir_path.mkdir(parents=False)
                self.send_json({"path": str(dir_path)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/git-commit":
            # Commit all changes in the vault and push. No-op (committed:false)
            # when not a repo or nothing changed. Serialised so overlapping
            # triggers (blur + timer) can't run git concurrently.
            try:
                root = vault_root()
                if root is None:
                    self.send_json({"is_repo": False})
                else:
                    with _lock:
                        self.send_json(git_commit_all(root))
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/rename-file":
            try:
                data = self.read_body()
                old_path = safe_path(data["old_path"], must_exist=True)
                new_name = data["new_name"]
                if "/" in new_name or "\\" in new_name:
                    raise ValueError("Name cannot contain path separators")
                new_path = safe_path(str(old_path.parent / new_name))
                # On a case-insensitive disk (the macOS default) a case-only
                # rename (note.md → Note.md) "exists" as the same file.
                if new_path.exists() and not (
                    new_name.lower() == old_path.name.lower() and new_path.samefile(old_path)
                ):
                    raise ValueError(f"'{new_name}' already exists")
                root = vault_root()
                repo = root is not None and is_git_repo(root)
                if repo:
                    # `git mv` keeps history; fall back to a plain rename when the
                    # file isn't tracked yet (git mv refuses untracked files).
                    if _git(["mv", str(old_path), str(new_path)], root).returncode != 0:
                        old_path.rename(new_path)
                else:
                    old_path.rename(new_path)
                # Keep [[wikilinks]] pointing at the renamed note valid. Only for
                # markdown files — a folder's name isn't a wikilink target.
                if root is not None and new_path.is_file() and new_path.suffix == ".md":
                    with _lock:
                        rename_wikilink_targets(str(root), old_path.stem, new_path.stem)
                resp = {"path": str(new_path)}
                if repo:
                    resp["git"] = git_commit_all(
                        root, f"Rename {old_path.name} → {new_path.name}"
                    )
                self.send_json(resp)
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/move-file":
            try:
                data = self.read_body()
                src = safe_path(data["src_path"], must_exist=True)
                dest = safe_path(str(Path(data["dest_dir"]) / src.name))
                if dest.exists():
                    raise ValueError(f"'{src.name}' already exists in destination")
                # Moving a folder into itself or one of its descendants is invalid.
                if src.is_dir() and (dest == src or src in dest.parents):
                    raise ValueError("Cannot move a folder into itself")
                root = vault_root()
                repo = root is not None and is_git_repo(root)
                if repo:
                    if _git(["mv", str(src), str(dest)], root).returncode != 0:
                        src.rename(dest)
                else:
                    src.rename(dest)
                resp = {"path": str(dest)}
                if repo:
                    resp["git"] = git_commit_all(
                        root, f"Move {src.name} to {dest.parent.name}/"
                    )
                self.send_json(resp)
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/trash-file":
            try:
                data = self.read_body()
                file_path = str(safe_path(data["path"], must_exist=True))
                # Move to the system Trash (recoverable), never a hard delete.
                # JXA calls Foundation's -trashItemAtURL:, the same API Finder
                # uses; it doesn't need Finder automation permissions. The path
                # comes in as argv so a crafted filename can't inject script.
                script = (
                    "function run(argv) {\n"
                    "  ObjC.import('Foundation');\n"
                    "  var fm = $.NSFileManager.defaultManager;\n"
                    "  var url = $.NSURL.fileURLWithPath(argv[0]);\n"
                    "  var err = Ref();\n"
                    "  var ok = fm.trashItemAtURLResultingItemURLError(url, null, err);\n"
                    "  if (!ok) {\n"
                    "    throw new Error(ObjC.unwrap(err[0].localizedDescription) || 'trash failed');\n"
                    "  }\n"
                    "}\n"
                )
                r = subprocess.run(
                    ["osascript", "-l", "JavaScript", "-e", script, file_path],
                    capture_output=True,
                    text=True,
                )
                if r.returncode != 0:
                    # Do NOT fall back to os.remove — a failure must leave the
                    # file in place rather than destroy it.
                    raise RuntimeError(
                        r.stderr.strip() or "Could not move file to Trash"
                    )
                self.send_json({"ok": True})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/build-link-index":
            try:
                data = self.read_body()
                with _lock:
                    index = build_link_index(data["vault_path"])
                self.send_json(index)
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/pick-folder":
            try:
                data = self.read_body()
                prompt = data.get("prompt", "Select your Markdown vault folder")
                folder = pick_folder(prompt)
                self.send_json({"path": folder})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/pick-file":
            try:
                data = self.read_body()
                extensions = data.get("extensions", [])
                prompt = data.get("prompt", "Select a file")
                fpath = pick_file(extensions, prompt)
                self.send_json({"path": fpath})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/pandoc":
            try:
                data = self.read_body()
                markdown = data["markdown"]
                if data.get("inline_wikilinks"):
                    vault = load_settings().get("vaultPath")
                    if vault:
                        markdown = inline_wikilinks(markdown, vault, data.get("file_path"))
                html = render_pandoc(
                    markdown,
                    data.get("file_path"),
                    data.get("number_sections", True),
                )
                self.send_json({"html": html})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/export-docx":
            try:
                data = self.read_body()
                markdown = data.get("markdown", "")
                if not markdown:
                    raise ValueError("No markdown content provided")
                docx_bytes = export_docx(markdown, data.get("file_path"))
                # Send as binary attachment
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                self.send_header(
                    "Content-Disposition", 'attachment; filename="document.docx"'
                )
                self.send_header("Content-Length", str(len(docx_bytes)))
                self.end_headers()
                self.wfile.write(docx_bytes)
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/llm-search":
            try:
                data = self.read_body()
                query = (data.get("q") or "").strip()
                if not query:
                    raise ValueError("Type a question first")
                vault = str(safe_path(data.get("vault_path") or ""))
                self.send_json({"id": start_llm_search(vault, query)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/zotero-reference-link":
            try:
                data = self.read_body()
                citekey = (data.get("citekey") or "").strip()
                if not citekey:
                    raise ValueError("No citation key")
                page = data.get("page")
                self.send_json(zotero_reference_link(citekey, int(page) if page else None))
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/zotseek-search":
            try:
                data = self.read_body()
                query = (data.get("query") or "").strip()
                if not query:
                    raise ValueError("Select a sentence to search for")
                self.send_json(zotseek_search(query))
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/proofread":
            try:
                data = self.read_body()
                text = (data.get("text") or "").strip()
                if not text:
                    raise ValueError("Nothing to proofread")
                self.send_json({"suggestions": proofread_text(text)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/translate":
            try:
                data = self.read_body()
                text = (data.get("text") or "").strip()
                if not text:
                    raise ValueError("Nothing to translate")
                # Target language is a vault setting; the client passes it, but
                # fall back to the stored setting (then English) if it doesn't.
                target_lang = (
                    data.get("target_lang")
                    or load_settings().get("documentLanguage")
                    or "English"
                ).strip()
                self.send_json({"suggestions": translate_text(text, target_lang)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/suggest-tags":
            try:
                data = self.read_body()
                vault = str(safe_path(data.get("vault_path") or ""))
                targets, note_tags = tag_suggestion_request(vault, data)
                self.send_json({"id": start_tag_suggestions(vault, targets, note_tags)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/shutdown":
            self.send_json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        elif path == "/api/quit":
            # Hard-exit the whole process (frees the port even when a webview
            # keeps the main thread alive). Used when a newer build takes over.
            self.send_json({"ok": True})
            threading.Timer(0.1, lambda: os._exit(0)).start()

        else:
            self.send_error_json("Not found", 404)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def _server_already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/settings", timeout=0.5
        ):
            return True
    except Exception:
        return False


def _running_server_version(port: int) -> str | None:
    """Version reported by a server on `port`, or None (unreachable / too old
    to have the /api/version endpoint)."""
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/version", timeout=0.5
        ) as r:
            return json.loads(r.read().decode("utf-8")).get("version")
    except Exception:
        return None


def _shutdown_running(port: int) -> bool:
    """Tell the server on `port` to quit and wait for it to release the socket.

    Tries /api/quit (hard process exit — frees the port even for a desktop app
    whose window keeps the process alive), then /api/shutdown for older servers
    that lack it. Returns True once the port is free."""
    for endpoint in ("/api/quit", "/api/shutdown"):
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}{endpoint}",
                data=b"{}",
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass
        for _ in range(30):  # up to ~3s per endpoint
            if not _server_already_running(port):
                return True
            time.sleep(0.1)
    return not _server_already_running(port)


def _make_server(preferred_port: int):
    """Bind the preferred port, or fall back to a free one if it's taken."""
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", preferred_port), Handler)
        return srv, preferred_port
    except OSError:
        srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        return srv, srv.server_address[1]


def ensure_our_server(preferred_port: int):
    """Decide how to serve on `preferred_port`.

    - If a server with our exact version already runs there → reuse it
      (returns (None, port)).
    - If a *different* version runs there → shut it down and take over.
    - Otherwise → start fresh.

    Returns (server_or_None, port). A None server means "reuse the one already
    running on the returned port".
    """
    if _server_already_running(preferred_port):
        if _running_server_version(preferred_port) == SERVER_VERSION:
            return None, preferred_port
        # Stale / different code is holding the port — replace it.
        _shutdown_running(preferred_port)
    return _make_server(preferred_port)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8082)
    parser.add_argument(
        "--open",
        action="store_true",
        help="open the editor in the browser once the server is up",
    )
    # parse_known_args so a macOS app-launch arg (e.g. -psn_…) doesn't crash us.
    args, _ = parser.parse_known_args()

    # The bundled .app has no run.sh wrapper, so open the browser itself.
    open_browser = args.open or getattr(sys, "frozen", False)

    # Reuse an identical running instance; take over a stale (different-version)
    # one rather than attaching to its old code.
    # Threaded: the Zotero CAYW proxy blocks while the picker is open, and a
    # single-threaded server would stall every other request meanwhile.
    server, port = ensure_our_server(args.port)
    if server is None:
        if open_browser:
            webbrowser.open(f"http://127.0.0.1:{port}")
        return

    def _shutdown(sig, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f"humd-editor server running on http://127.0.0.1:{port}", flush=True)
    if open_browser:
        threading.Timer(
            0.3, lambda: webbrowser.open(f"http://127.0.0.1:{port}")
        ).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
