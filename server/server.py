#!/usr/bin/env python3
"""humd-editor local server — pure Python standard library, no external deps."""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SETTINGS_PATH = Path.home() / ".humd-editor" / "settings.json"
SRC_DIR = Path(__file__).parent.parent / "src"

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
    if resolved != root and not resolved.is_relative_to(root):
        raise PermissionError("Path is outside the vault")
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
            entries.append({
                "name": name,
                "path": str(child),
                "is_dir": is_dir,
                "children": [] if is_dir else None,
            })
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
    files = sorted(collect_md_files(vault_path))
    parts = []
    for f in files:
        try:
            mtime = os.path.getmtime(f)
            parts.append(f"{f}:{mtime:.3f}")
        except OSError:
            pass
    return ";".join(parts)


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
        for bl in fm[i + 1:]:
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

# Per-file parse cache: fpath -> {mtime, stem, yaml_tags, inline_tags, wikilinks}.
# Lets build_link_index skip re-reading unchanged files. Only mutated inside
# build_link_index, which callers run under `_lock`.
_file_cache: dict = {}


def _parse_md_file(fpath: str) -> dict:
    content = Path(fpath).read_text(encoding="utf-8")
    targets = []
    for m in _WIKILINK_RE.finditer(content):
        target = m.group(1).strip()
        if target:
            targets.append(target)
    return {
        "stem": Path(fpath).stem,
        "yaml_tags": extract_yaml_tags(content),
        "inline_tags": extract_inline_tags(content),
        "wikilinks": targets,
    }


def build_link_index(vault_path: str) -> dict:
    files = collect_md_files(vault_path)
    file_set = set(files)

    # Incremental read: only (re)parse files whose mtime changed since last build.
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

    for fpath in files:
        data = _file_cache.get(fpath)
        if data is None:
            continue
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
    index_path = Path(vault_path) / ".link-index.json"
    tmp = index_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    tmp.replace(index_path)
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

def search_vault(vault_path: str, query: str, max_files: int = 200,
                 max_per_file: int = 5) -> list:
    """Case-insensitive substring search over note contents.

    Returns [{path, name, matches: [{line, text}]}] sorted by note name.
    """
    q = query.strip().lower()
    if not q:
        return []
    results = []
    for fpath in sorted(collect_md_files(vault_path)):
        try:
            content = Path(fpath).read_text(encoding="utf-8")
        except OSError:
            continue
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
                snippet = ("…" if start > 0 else "") + line[start:start + 160].strip() + "…"
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
        new_content, n = pattern.subn(lambda m: m.group(1) + new_stem + m.group(2), content)
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

def render_pandoc(markdown: str, file_path: str | None) -> str:
    """Render markdown via system pandoc, return HTML body fragment."""
    result = subprocess.run(
        ["pandoc",
         "--from=markdown+footnotes+wikilinks_title_after_pipe+strikeout+pipe_tables",
         "--to=html5",
         "--standalone=false"],
        input=markdown.encode(),
        capture_output=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode())
    return result.stdout.decode()


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
    r = subprocess.run(["osascript", "-e", script, prompt], capture_output=True, text=True)
    if r.returncode == 0:
        return r.stdout.strip().rstrip("/")
    return None


def pick_file(extensions: list, prompt: str = "Select a file") -> str | None:
    # Sanitise extensions (they come from the client) to a safe alphanumeric set
    # and pass the prompt as an argument to avoid AppleScript injection.
    safe_exts = [re.sub(r"[^A-Za-z0-9]", "", e) for e in extensions]
    safe_exts = [e for e in safe_exts if e]
    type_clause = ""
    if safe_exts:
        ext_list = ", ".join(f'"{e}"' for e in safe_exts)
        type_clause = f" of type {{{ext_list}}}"
    script = (
        "on run argv\n"
        f"  POSIX path of (choose file with prompt (item 1 of argv){type_clause})\n"
        "end run"
    )
    r = subprocess.run(["osascript", "-e", script, prompt], capture_output=True, text=True)
    if r.returncode == 0:
        return r.stdout.strip()
    return None


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    server_version = "humd-editor/1.0"

    def log_message(self, fmt, *args):
        pass  # suppress default request logging

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
        elif path == "/api/list-vault":
            vault_path = qs.get("path", [None])[0]
            if not vault_path:
                self.send_error_json("path required")
                return
            try:
                self.send_json(list_dir_internal(str(safe_path(vault_path)), is_root=True))
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/list-dir":
            dir_path = qs.get("path", [None])[0]
            if not dir_path:
                self.send_error_json("path required")
                return
            try:
                self.send_json(list_dir_internal(str(safe_path(dir_path)), is_root=False))
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/read-file":
            file_path = qs.get("path", [None])[0]
            if not file_path:
                self.send_error_json("path required")
                return
            try:
                content = safe_path(file_path, must_exist=True).read_text(encoding="utf-8")
                self.send_json({"content": content})
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/vault-hash":
            vault_path = qs.get("path", [None])[0]
            if not vault_path:
                self.send_error_json("path required")
                return
            self.send_json({"hash": get_vault_hash(vault_path)})
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
                old_path.rename(new_path)
                # Keep [[wikilinks]] pointing at the renamed note valid.
                root = vault_root()
                if root is not None:
                    with _lock:
                        rename_wikilink_targets(str(root), old_path.stem, new_path.stem)
                self.send_json({"path": str(new_path)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/move-file":
            try:
                data = self.read_body()
                src = safe_path(data["src_path"], must_exist=True)
                dest = safe_path(str(Path(data["dest_dir"]) / src.name))
                if dest.exists():
                    raise ValueError(f"'{src.name}' already exists in destination")
                src.rename(dest)
                self.send_json({"path": str(dest)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/trash-file":
            try:
                data = self.read_body()
                file_path = str(safe_path(data["path"], must_exist=True))
                # Pass the path as an argument so a crafted filename can't inject
                # AppleScript. Fall back to a plain delete if Finder declines.
                script = (
                    "on run argv\n"
                    "  tell application \"Finder\" to delete (POSIX file (item 1 of argv))\n"
                    "end run"
                )
                r = subprocess.run(
                    ["osascript", "-e", script, file_path],
                    capture_output=True,
                )
                if r.returncode != 0:
                    os.remove(file_path)
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

        elif path == "/api/shutdown":
            self.send_json({"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        else:
            self.send_error_json("Not found", 404)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8082)
    args = parser.parse_args()

    # Threaded: the Zotero CAYW proxy blocks while the picker is open, and a
    # single-threaded server would stall every other request meanwhile.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)

    def _shutdown(sig, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f"humd-editor server running on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
