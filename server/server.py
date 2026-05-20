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
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SETTINGS_PATH = Path.home() / ".humd-editor" / "settings.json"
SRC_DIR = Path(__file__).parent.parent / "src"

_lock = threading.Lock()


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

def extract_yaml_tags(content: str) -> list:
    lines = content.splitlines()
    if not lines or not lines[0].strip().startswith("---"):
        return []
    end = None
    for i, line in enumerate(lines[1:], 1):
        if line.strip().startswith("---"):
            end = i
            break
    if end is None:
        return []
    for line in lines[1:end]:
        if line.startswith("tags:"):
            remainder = line[5:]
            m = re.search(r"\[([^\]]*)\]", remainder)
            if m:
                return [t.strip() for t in m.group(1).split(",") if t.strip()]
    return []


def build_link_index(vault_path: str) -> dict:
    backlinks: dict = {}
    tags: dict = {}
    files = collect_md_files(vault_path)

    wikilink_re = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")

    for fpath in files:
        try:
            content = Path(fpath).read_text(encoding="utf-8")
        except OSError:
            continue

        stem = Path(fpath).stem
        file_tags = extract_yaml_tags(content)
        if file_tags:
            tags[fpath] = file_tags

        for m in wikilink_re.finditer(content):
            target = m.group(1).strip()
            if target and target != stem:
                backlinks.setdefault(target, [])
                if stem not in backlinks[target]:
                    backlinks[target].append(stem)

    for sources in backlinks.values():
        sources.sort()

    index = {"backlinks": backlinks, "tags": tags}
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
    return {"backlinks": {}, "tags": {}}


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
    script = f'POSIX path of (choose folder with prompt "{prompt}")'
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if r.returncode == 0:
        return r.stdout.strip().rstrip("/")
    return None


def pick_file(extensions: list, prompt: str = "Select a file") -> str | None:
    ext_list = ", ".join(f'"{e}"' for e in extensions)
    script = (
        f'POSIX path of (choose file with prompt "{prompt}" '
        f"of type {{{ext_list}}})"
    )
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
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

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, msg, status=400):
        self.send_json({"error": msg}, status)

    def read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
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
                self.send_json(list_dir_internal(vault_path, is_root=True))
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/list-dir":
            dir_path = qs.get("path", [None])[0]
            if not dir_path:
                self.send_error_json("path required")
                return
            try:
                self.send_json(list_dir_internal(dir_path, is_root=False))
            except Exception as e:
                self.send_error_json(str(e))
        elif path == "/api/read-file":
            file_path = qs.get("path", [None])[0]
            if not file_path:
                self.send_error_json("path required")
                return
            try:
                content = Path(file_path).read_text(encoding="utf-8")
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
        else:
            # Serve static file
            super().do_GET()

    def do_POST(self):
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
                Path(data["path"]).write_text(data["content"], encoding="utf-8")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/create-file":
            try:
                data = self.read_body()
                name = data["name"]
                if not name.endswith(".md"):
                    name += ".md"
                file_path = Path(data["vault_path"]) / name
                file_path.write_text("", encoding="utf-8")
                self.send_json({"path": str(file_path)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/rename-file":
            try:
                data = self.read_body()
                old_path = Path(data["old_path"])
                new_name = data["new_name"]
                if "/" in new_name or "\\" in new_name:
                    raise ValueError("Name cannot contain path separators")
                new_path = old_path.parent / new_name
                if new_path.exists():
                    raise ValueError(f"'{new_name}' already exists")
                old_path.rename(new_path)
                self.send_json({"path": str(new_path)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/move-file":
            try:
                data = self.read_body()
                src = Path(data["src_path"])
                dest = Path(data["dest_dir"]) / src.name
                if dest.exists():
                    raise ValueError(f"'{src.name}' already exists in destination")
                src.rename(dest)
                self.send_json({"path": str(dest)})
            except Exception as e:
                self.send_error_json(str(e))

        elif path == "/api/trash-file":
            try:
                data = self.read_body()
                file_path = data["path"]
                # Try macOS trash first, fall back to delete
                r = subprocess.run(
                    ["osascript", "-e",
                     f'tell application "Finder" to delete POSIX file "{file_path}"'],
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
                    build_link_index(data["vault_path"])
                self.send_json({"ok": True})
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

    server = HTTPServer(("127.0.0.1", args.port), Handler)

    def _shutdown(sig, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(f"humd-editor server running on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
