#!/usr/bin/env python3
"""humd-editor local server — pure Python standard library, no external deps."""

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import signal
import subprocess
import sys
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
else:
    SRC_DIR = Path(__file__).parent.parent / "src"


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


# ---------------------------------------------------------------------------
# File tree helpers
# ---------------------------------------------------------------------------


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
            if is_root and not is_dir and not name.endswith(".md"):
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


_INLINE_TAG_RE = re.compile(r"(?<![\w&#])#([A-Za-z][\w/-]*)")


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
_PANDOC_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/local/bin",
    str(Path.home() / ".local" / "bin"),
    "/usr/bin",
]


def _find_pandoc() -> str:
    search = os.environ.get("PATH", "")
    for d in _PANDOC_DIRS:
        if d not in search.split(os.pathsep):
            search += os.pathsep + d
    found = shutil.which("pandoc", path=search)
    if not found:
        raise FileNotFoundError(
            "pandoc not found. Install it (e.g. `brew install pandoc`) or turn "
            "off Pandoc rendering in Settings."
        )
    return found


def render_pandoc(markdown: str, file_path: str | None) -> str:
    """Render markdown via system pandoc, return HTML body fragment."""
    result = subprocess.run(
        [
            _find_pandoc(),
            "--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+pipe_tables+lists_without_preceding_blankline+hard_line_breaks",
            "--to=html5",
            "--standalone=false",
        ],
        input=markdown.encode(),
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()


def export_docx(markdown: str) -> bytes:
    """Export markdown to DOCX via Pandoc with bibliography and reference doc.

    Uses settings for bibliography, CSL style, and reference document paths.
    Returns the binary DOCX file content.
    """
    settings = load_settings()
    bib_path = settings.get("cslJsonPath")
    csl_path = settings.get("cslStylePath")
    ref_doc_path = settings.get("pandocRefDocPath")

    if not bib_path:
        raise ValueError("Bibliography path not configured in settings")
    if not csl_path:
        raise ValueError("CSL style path not configured in settings")

    cmd = [
        _find_pandoc(),
        "-C",  # citeproc
        f"--bibliography={bib_path}",
        f"--csl={csl_path}",
        "--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+pipe_tables+lists_without_preceding_blankline+hard_line_breaks",
        "--to=docx",
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
    return result.stdout


# ---------------------------------------------------------------------------
# AI proofreading (Google Gemini)
# ---------------------------------------------------------------------------

PROOFREAD_SYSTEM = (
    "You are the editor of an academic historical magazine. Review the text for "
    "grammar, punctuation, clarity, and British spelling. Preserve the author's "
    "voice, long sentences when they work, and any deliberate archaic or "
    "period-appropriate terminology. "
    "The text is written in Markdown. Treat all Markdown syntax as correct "
    "formatting, not as errors: do NOT flag or comment on link syntax such as "
    "[text](url) or [[wikilinks]], footnote markers such as [^1] (including a "
    "footnote marker placed directly after a period or other punctuation), "
    "headings (#), emphasis (* or _), inline code or code fences, HTML comments, "
    "citations such as [@key], images, or list markers. Ignore the punctuation "
    "and spacing of the Markdown markup itself and review only the prose. "
    "Return a JSON array of specific, actionable "
    "suggestions. Each element is an object with three string fields: "
    "'original' — the exact passage to change, copied verbatim character-for-"
    "character from the input text (no paraphrasing, no added quotes or ellipses, "
    "and short enough to locate unambiguously); 'suggestion' — the corrected "
    "replacement for that passage; and 'comment' — a brief explanation of the "
    "issue. Do not include opinions, praise, or any text outside the JSON array. "
    "If the text needs no changes, return an empty array."
)

# Schema forcing Gemini to emit the structured suggestion list the client expects.
PROOFREAD_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "original": {"type": "STRING"},
            "suggestion": {"type": "STRING"},
            "comment": {"type": "STRING"},
        },
        "required": ["original", "suggestion", "comment"],
    },
}

# Same schema in standard (lowercase) JSON Schema for Ollama's `format` field.
PROOFREAD_JSON_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "original": {"type": "string"},
            "suggestion": {"type": "string"},
            "comment": {"type": "string"},
        },
        "required": ["original", "suggestion", "comment"],
    },
}
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite"
DEFAULT_OLLAMA_URL = "http://localhost:11434"


class OllamaUnavailable(RuntimeError):
    """Raised when the local Ollama service can't be reached (not running)."""


# --- Generic provider plumbing (shared by proofreading and tag suggestion) ----


def _ai_complete(
    system: str, user: str, gemini_schema: dict, json_schema: dict, settings: dict
) -> tuple[str, str | None]:
    """Run one structured AI completion with the configured provider. Returns
    (raw_response, warning); raw_response is a JSON string matching the schema.
    When Ollama is selected but not running, transparently falls back to
    Gemini and reports it via the warning."""
    provider = settings.get("proofreadProvider") or "gemini"
    if provider == "ollama":
        try:
            return _ollama_complete(system, user, json_schema, settings), None
        except OllamaUnavailable:
            try:
                result = _gemini_complete(system, user, gemini_schema, settings)
            except Exception as ge:
                raise RuntimeError(
                    f"Ollama is not running, and the Gemini fallback failed: {ge}"
                )
            return result, "Ollama not running — used Gemini instead."
    return _gemini_complete(system, user, gemini_schema, settings), None


def _gemini_complete(system: str, user: str, schema: dict, settings: dict) -> str:
    """One structured completion via the Google Gemini REST API."""
    api_key = settings.get("geminiApiKey")
    if not api_key:
        raise RuntimeError(
            "No Gemini API key set. Add one under Settings → Proofreading."
        )
    model = settings.get("geminiModel") or DEFAULT_GEMINI_MODEL
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent"
    )
    payload = json.dumps(
        {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": schema,
            },
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Gemini API error {e.code}: {detail[:500]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach Gemini: {e.reason}")

    candidates = data.get("candidates") or []
    if not candidates:
        # Often a safety block or empty response; surface what we can.
        raise RuntimeError(f"Gemini returned no result: {json.dumps(data)[:400]}")
    parts = candidates[0].get("content", {}).get("parts", [])
    out = "".join(p.get("text", "") for p in parts).strip()
    if not out:
        raise RuntimeError("Gemini returned an empty response.")
    return out


def _ollama_complete(system: str, user: str, json_schema: dict, settings: dict) -> str:
    """One structured completion via a local Ollama /api/chat call."""
    model = settings.get("ollamaModel")
    if not model:
        raise RuntimeError(
            "No Ollama model set. Add one under Settings → Proofreading."
        )
    base = (settings.get("ollamaUrl") or DEFAULT_OLLAMA_URL).rstrip("/")
    url = f"{base}/api/chat"
    payload = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "format": json_schema,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"Ollama API error {e.code}: {detail[:500]}")
    except urllib.error.URLError as e:
        raise OllamaUnavailable(
            f"Could not reach Ollama at {base} — is `ollama serve` running? ({e.reason})"
        )

    out = (data.get("message", {}).get("content") or "").strip()
    if not out:
        raise RuntimeError("Ollama returned an empty response.")
    return out


def proofread_text(text: str) -> tuple[str, str | None]:
    """Proofread `text` with the configured provider. Returns (raw, warning);
    raw is the JSON-array string the /api/proofread handler parses."""
    return _ai_complete(
        PROOFREAD_SYSTEM, text, PROOFREAD_SCHEMA, PROOFREAD_JSON_SCHEMA, load_settings()
    )


SUGGEST_TAGS_SYSTEM = (
    "You are a librarian tagging an article for a personal notes vault. You are "
    "given the document text and a list of tags already used elsewhere in the "
    "vault. Choose the tags from that list that best describe this document. "
    "Only return tags that appear verbatim in the provided list — never invent "
    "new tags. Return a JSON array of tag strings (without a leading '#'), most "
    "relevant first, at most 3. If none of the existing tags fit, return an "
    "empty array."
)
TAGS_SCHEMA = {"type": "ARRAY", "items": {"type": "STRING"}}
TAGS_JSON_SCHEMA = {"type": "array", "items": {"type": "string"}}


def suggest_tags_text(text: str, existing_tags: list) -> tuple[str, str | None]:
    """Ask the configured provider which existing tags fit `text`. Returns
    (raw, warning); raw is a JSON array of tag strings."""
    tag_list = ", ".join(existing_tags) if existing_tags else "(none)"
    user = f"Existing tags:\n{tag_list}\n\n---\n\nDocument:\n{text}"
    return _ai_complete(
        SUGGEST_TAGS_SYSTEM, user, TAGS_SCHEMA, TAGS_JSON_SCHEMA, load_settings()
    )


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
    search = os.environ.get("PATH", "")
    for d in _PANDOC_DIRS:
        if d not in search.split(os.pathsep):
            search += os.pathsep + d
    return shutil.which("git", path=search)


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

        if path == "/api/settings":
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
            self.send_json({"hash": get_vault_hash(vault_path)})
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

        if path == "/api/settings":
            try:
                data = self.read_body()
                with _lock:
                    existing = load_settings()
                    existing.update(data)
                    save_settings(existing)
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
                if new_path.exists():
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
                html = render_pandoc(data["markdown"], data.get("file_path"))
                self.send_json({"html": html})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/export-docx":
            try:
                data = self.read_body()
                markdown = data.get("markdown", "")
                if not markdown:
                    raise ValueError("No markdown content provided")
                docx_bytes = export_docx(markdown)
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

        elif path == "/api/proofread":
            try:
                data = self.read_body()
                text = (data.get("text") or "").strip()
                if not text:
                    raise ValueError("Nothing to proofread")
                raw, warning = proofread_text(text)
                # The model is asked for a JSON array of suggestions. Parse it so
                # the client gets structured data; fall back to the raw string if
                # the response isn't valid JSON (so something is still shown).
                stripped = raw.strip()
                if stripped.startswith("```"):
                    # Strip a ```json … ``` fence the model occasionally adds.
                    stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
                    stripped = re.sub(r"\n?```$", "", stripped).strip()
                try:
                    suggestions = json.loads(stripped)
                    if not isinstance(suggestions, list):
                        raise ValueError("not a list")
                    resp = {"suggestions": suggestions}
                except (json.JSONDecodeError, ValueError):
                    resp = {"result": raw}
                if warning:
                    resp["warning"] = warning
                self.send_json(resp)
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/suggest-tags":
            try:
                data = self.read_body()
                text = (data.get("text") or "").strip()
                if not text:
                    raise ValueError("Nothing to analyse")
                existing = data.get("existing_tags") or []
                raw, warning = suggest_tags_text(text, existing)
                stripped = raw.strip()
                if stripped.startswith("```"):
                    stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
                    stripped = re.sub(r"\n?```$", "", stripped).strip()
                try:
                    parsed = json.loads(stripped)
                    if not isinstance(parsed, list):
                        raise ValueError("not a list")
                except (json.JSONDecodeError, ValueError):
                    parsed = []
                # Constrain to the existing tags (case-insensitive) so a model
                # can't introduce new ones, and return their canonical spelling.
                canon = {
                    str(t).lstrip("#").lower(): str(t).lstrip("#") for t in existing
                }
                seen = set()
                tags = []
                for t in parsed:
                    key = str(t).lstrip("#").lower()
                    if key in canon and key not in seen:
                        seen.add(key)
                        tags.append(canon[key])
                resp = {"tags": tags}
                if warning:
                    resp["warning"] = warning
                self.send_json(resp)
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
