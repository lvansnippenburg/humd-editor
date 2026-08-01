#!/usr/bin/env python3
"""Native-window launcher for humd-editor.

Starts the local HTTP server in a background thread and shows the editor in a
real desktop window (macOS WKWebView via pywebview) instead of a browser tab.
This is the entry point used by the packaged .app; the server itself stays a
stdlib-only HTTP server (see server.py) — pywebview is only needed here.

Window position/size are saved on quit and restored on next launch, but only
when the display layout is unchanged (so the window can't come back off-screen
after you unplug a monitor).
"""

import subprocess
import tempfile
import threading

import webview

import server

DEFAULT_W, DEFAULT_H = 1280, 860


class Api:
    """Bridge exposed to the page as window.pywebview.api.

    External links can't open a new browser tab from inside a webview, so the
    frontend hands them here and we let the OS route them (http, mailto, and
    app schemes like zotero:// all go through `open`).
    """

    def open_external(self, url):
        try:
            subprocess.run(["open", url], check=False)
        except Exception:
            pass
        return True

    def print_preview(self, html):
        """Print the rendered preview.

        WKWebView only exposes window.print() on the top-level window, which
        would print the whole app chrome rather than just the preview, so
        instead the frontend hands us the preview's rendered HTML and we open
        it as a standalone page in the OS default browser, which prints it
        properly (the page auto-triggers window.print() once loaded).
        """
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix=".html",
                prefix="humd-editor-print-",
                delete=False,
                encoding="utf-8",
            ) as f:
                f.write(html)
                path = f.name
            subprocess.run(["open", path], check=False)
        except Exception:
            pass
        return True


def _screen_signature() -> str:
    """A stable fingerprint of the current display layout (sorted resolutions)."""
    try:
        return ";".join(
            sorted(f"{int(s.width)}x{int(s.height)}" for s in webview.screens)
        )
    except Exception:
        return ""


_save_timer = None
_save_timer_lock = threading.Lock()


def _load_window_geometry(signature: str):
    """Saved (x, y, width, height) if the display layout still matches, else (None, None, width, height)."""
    try:
        win = server.load_settings().get("window")
    except Exception:
        win = None
    if not win:
        return None

    try:
        w = int(win["width"])
        h = int(win["height"])
    except (KeyError, TypeError, ValueError):
        w, h = DEFAULT_W, DEFAULT_H

    if win.get("screens") != signature or not signature:
        return None, None, w, h

    try:
        return int(win["x"]), int(win["y"]), w, h
    except (KeyError, TypeError, ValueError):
        return None, None, w, h


def _save_window_geometry(state: dict, signature: str) -> None:
    if state.get("width") is None or state.get("x") is None:
        return
    try:
        # Same lock the server uses for settings writes (same process), so this
        # can't race with the frontend persisting its UI state.
        with server._lock:
            s = server.load_settings()
            s["window"] = {
                "x": int(state["x"]),
                "y": int(state["y"]),
                "width": int(state["width"]),
                "height": int(state["height"]),
                "screens": signature,
            }
            server.save_settings(s)
    except Exception:
        pass


def _debounced_save_geometry(state: dict, signature: str) -> None:
    global _save_timer
    with _save_timer_lock:
        if _save_timer is not None:
            _save_timer.cancel()
        # Debounce for 1 second before writing to file
        _save_timer = threading.Timer(
            1.0, _save_window_geometry, args=[state, signature]
        )
        _save_timer.start()


def main():
    # Reuse an identical running instance, but take over a stale one (different
    # code version) instead of attaching to its old server.
    srv, port = server.ensure_our_server(8082)
    if srv is not None:
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    signature = _screen_signature()
    saved = _load_window_geometry(signature)
    state = {"x": None, "y": None, "width": None, "height": None}

    kwargs = dict(width=DEFAULT_W, height=DEFAULT_H, min_size=(840, 600), js_api=Api())
    if saved:
        x, y, w, h = saved
        if x is not None and y is not None:
            kwargs.update(x=x, y=y, width=w, height=h)
            state.update(x=x, y=y, width=w, height=h)
        else:
            kwargs.update(width=w, height=h)
            state.update(width=w, height=h)
    else:
        state.update(width=DEFAULT_W, height=DEFAULT_H)

    window = webview.create_window("Humd Editor", f"http://127.0.0.1:{port}", **kwargs)

    # Track geometry continuously: seed from the real values once shown (this
    # captures a centered default's actual position), then follow move/resize.
    # We persist on `closed`, which fires for every close path (red button,
    # Cmd+Q, programmatic) — unlike `closing`. The window is gone by then, so we
    # save the tracked values rather than reading the dead window's attributes.
    def on_shown():
        try:
            state.update(
                x=int(window.x),
                y=int(window.y),
                width=int(window.width),
                height=int(window.height),
            )
        except Exception:
            pass

    def on_moved(x, y):
        state["x"], state["y"] = int(x), int(y)
        _debounced_save_geometry(state, signature)

    def on_resized(w, h):
        state["width"], state["height"] = int(w), int(h)
        _debounced_save_geometry(state, signature)

    def on_closed():
        global _save_timer
        with _save_timer_lock:
            if _save_timer is not None:
                _save_timer.cancel()
                _save_timer = None
        _save_window_geometry(state, signature)

    window.events.shown += on_shown
    window.events.moved += on_moved
    window.events.resized += on_resized
    window.events.closed += on_closed

    # Allow file downloads (e.g. "Export to Word"): WKWebView drops blob/
    # download-attribute clicks unless this is enabled, so exporting would
    # otherwise silently do nothing. With it on, the webview shows a native
    # save dialog. Harmless in the browser build, which never runs this file.
    webview.settings["ALLOW_DOWNLOADS"] = True

    # Blocks on the GUI loop (main thread, required on macOS); returns when the
    # window is closed, at which point the daemon server thread exits with us.
    webview.start()


if __name__ == "__main__":
    main()
