#!/usr/bin/env python3
"""Native-window launcher for humd-editor.

Starts the local HTTP server in a background thread and shows the editor in a
real desktop window (macOS WKWebView via pywebview) instead of a browser tab.
This is the entry point used by the packaged .app; the server itself stays a
stdlib-only HTTP server (see server.py) — pywebview is only needed here.

Window position/size are saved on quit and restored on next launch, but only
when the display layout is unchanged (so the window can't come back off-screen
after you unplug a monitor).

Text editing gets the macOS text services: spell checking while typing, the
full context menu (spelling suggestions, Writing Tools, Look Up, Translate,
Speech, Services, …) and Spelling/Substitutions/Speech in the Edit menu (see
_enable_text_services).

Quitting (red button or Cmd+Q) first asks the page whether documents have
unsaved changes; it then offers to save them (see Api.request_quit).
"""

import os
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

    # Quitting: the window's `closing` handler runs on the GUI thread and must
    # answer at once, so it cancels the first close and asks the page (from
    # another thread) via window.humdRequestQuit(). The page acknowledges
    # (quit_request_seen), saves or asks the user about unsaved documents, and
    # calls confirm_quit() to really quit. A page that doesn't answer in time
    # (not loaded, hung) can't keep the app from quitting.
    QUIT_ANSWER_TIMEOUT = 3.0

    def __init__(self):
        # Private (underscore) attributes: pywebview doesn't expose them to the page.
        self._window = None
        self._quit_confirmed = False
        self._quit_seen = threading.Event()

    def request_quit(self):
        """Called by the closing handler: ask the page in the background."""

        def ask():
            self._quit_seen.clear()
            try:
                asked = self._window.evaluate_js(
                    "typeof window.humdRequestQuit === 'function' && (window.humdRequestQuit(), true)"
                )
            except Exception:
                asked = False
            if not asked or not self._quit_seen.wait(self.QUIT_ANSWER_TIMEOUT):
                self.confirm_quit()

        threading.Thread(target=ask, daemon=True).start()

    def quit_request_seen(self):
        """The page got the quit request and handles it (it may show a dialog)."""
        self._quit_seen.set()
        return True

    def confirm_quit(self):
        """Quit for real: nothing (more) to save, or the user chose.

        The window is closed a moment later, after this call has returned:
        pywebview hands the return value back to the page, and doing that for
        a page that's already closed leaves its thread waiting forever."""
        self._quit_confirmed = True
        if self._window is not None:
            timer = threading.Timer(0.2, self._window.destroy)
            timer.daemon = True
            timer.start()
        return True

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


# Context-menu items that make no sense in the editor (it's one page, not a
# browser): reload/back/forward, opening or downloading in "a new window", and
# the inspector.
_HIDDEN_MENU_ITEMS = {
    "WKMenuItemIdentifierReload",
    "WKMenuItemIdentifierGoBack",
    "WKMenuItemIdentifierGoForward",
    "WKMenuItemIdentifierInspectElement",
    "WKMenuItemIdentifierOpenLinkInNewWindow",
    "WKMenuItemIdentifierOpenFrameInNewWindow",
    "WKMenuItemIdentifierOpenImageInNewWindow",
    "WKMenuItemIdentifierOpenMediaInNewWindow",
    "WKMenuItemIdentifierDownloadLinkedFile",
    "WKMenuItemIdentifierDownloadImage",
    "WKMenuItemIdentifierDownloadMedia",
}


def _enable_text_services():
    """Give the webview the macOS text services pywebview leaves out.

    - Spell checking while typing is off in a WKWebView unless the app's
      defaults say otherwise. Registered defaults only apply until the user
      changes a setting (Edit > Spelling and Grammar / Substitutions), which
      macOS then remembers. Smart quotes/dashes stay off by default: the
      editor has its own smart quotes, and Markdown needs straight ones.
    - pywebview empties the context menu (except in debug mode); keep the
      native one, minus the browser-only items above.
    - pywebview's Edit menu has only Cut/Copy/Paste/Select All; add the
      standard Spelling and Grammar, Substitutions, Transformations and
      Speech submenus (macOS adds Writing Tools, AutoFill, Dictation and
      Emoji & Symbols to it itself).
    The editors' own spellcheck setting (Settings) still decides whether
    misspellings are underlined.
    """
    try:
        import AppKit
        import objc
        from webview.platforms import cocoa
    except ImportError:  # not macOS
        return

    AppKit.NSUserDefaults.standardUserDefaults().registerDefaults_(
        {
            "WebContinuousSpellCheckingEnabled": True,
            "WebAutomaticQuoteSubstitutionEnabled": False,
            "WebAutomaticDashSubstitutionEnabled": False,
        }
    )

    def willOpenMenu_withEvent_(self, menu, event):
        if cocoa._state["debug"]:
            return
        for item in list(menu.itemArray()):
            if item.identifier() in _HIDDEN_MENU_ITEMS:
                menu.removeItem_(item)
        # Tidy separators left at the ends or doubled; an empty menu isn't shown.
        items = list(menu.itemArray())
        previous_separator = True
        for item in items:
            if item.isSeparatorItem() and previous_separator:
                menu.removeItem_(item)
            else:
                previous_separator = item.isSeparatorItem()
        while menu.numberOfItems() and menu.itemAtIndex_(menu.numberOfItems() - 1).isSeparatorItem():
            menu.removeItemAtIndex_(menu.numberOfItems() - 1)

    objc.classAddMethods(cocoa.BrowserView.WebKitHost, [willOpenMenu_withEvent_])

    add_edit_menu = cocoa.BrowserView._add_edit_menu

    def _add_edit_menu(self, mainMenu):
        add_edit_menu(self, mainMenu)
        edit_menu = mainMenu.itemAtIndex_(1).submenu()

        def submenu(title, entries):
            menu = AppKit.NSMenu.alloc().initWithTitle_(title)
            for entry in entries:
                if entry is None:
                    menu.addItem_(AppKit.NSMenuItem.separatorItem())
                    continue
                item_title, action, key, *mask = entry
                item = menu.addItemWithTitle_action_keyEquivalent_(item_title, action, key)
                if mask:
                    item.setKeyEquivalentModifierMask_(mask[0])
            item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, None, "")
            item.setSubmenu_(menu)
            edit_menu.addItem_(item)

        edit_menu.addItem_(AppKit.NSMenuItem.separatorItem())
        submenu(
            "Spelling and Grammar",
            [
                ("Show Spelling and Grammar", "showGuessPanel:", ":"),
                ("Check Document Now", "checkSpelling:", ";"),
                None,
                ("Check Spelling While Typing", "toggleContinuousSpellChecking:", ""),
                ("Check Grammar With Spelling", "toggleGrammarChecking:", ""),
                ("Correct Spelling Automatically", "toggleAutomaticSpellingCorrection:", ""),
            ],
        )
        submenu(
            "Substitutions",
            [
                ("Show Substitutions", "orderFrontSubstitutionsPanel:", ""),
                None,
                ("Smart Copy/Paste", "toggleSmartInsertDelete:", ""),
                ("Smart Quotes", "toggleAutomaticQuoteSubstitution:", ""),
                ("Smart Dashes", "toggleAutomaticDashSubstitution:", ""),
                ("Text Replacement", "toggleAutomaticTextReplacement:", ""),
            ],
        )
        submenu(
            "Transformations",
            [
                ("Make Upper Case", "uppercaseWord:", ""),
                ("Make Lower Case", "lowercaseWord:", ""),
                ("Capitalize", "capitalizeWord:", ""),
            ],
        )
        submenu(
            "Speech",
            [
                ("Start Speaking", "startSpeaking:", ""),
                ("Stop Speaking", "stopSpeaking:", ""),
            ],
        )

    cocoa.BrowserView._add_edit_menu = _add_edit_menu


def _remove_duplicate_menu_items():
    """pywebview builds the menu bar more than once, and macOS adds Dictation,
    Emoji & Symbols and Enter Full Screen to it each time; keep one of each."""
    try:
        import AppKit
        from PyObjCTools import AppHelper
    except ImportError:
        return

    def dedupe():
        main_menu = AppKit.NSApp.mainMenu()
        for i in range(main_menu.numberOfItems()):
            menu = main_menu.itemAtIndex_(i).submenu()
            seen = set()
            for item in list(menu.itemArray() if menu else []):
                if item.isSeparatorItem():
                    continue
                key = (item.title(), item.action())
                if key in seen:
                    menu.removeItem_(item)
                seen.add(key)

    AppHelper.callAfter(dedupe)


def main():
    # Reuse an identical running instance, but take over a stale one (different
    # code version) instead of attaching to its old server.
    srv, port = server.ensure_our_server(8082)
    if srv is not None:
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    signature = _screen_signature()
    saved = _load_window_geometry(signature)
    state = {"x": None, "y": None, "width": None, "height": None}

    api = Api()
    kwargs = dict(width=DEFAULT_W, height=DEFAULT_H, min_size=(840, 600), js_api=api)
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
    api._window = window

    # Red button and Cmd+Q both come here. Returning False cancels; the page is
    # then asked about unsaved documents and quits via api.confirm_quit().
    def on_closing():
        if api._quit_confirmed:
            return True
        api.request_quit()
        return False

    # Track geometry continuously: seed from the real values once shown (this
    # captures a centered default's actual position), then follow move/resize.
    # We persist on `closed`, which fires for every close path (red button,
    # Cmd+Q, programmatic) — unlike `closing`. The window is gone by then, so we
    # save the tracked values rather than reading the dead window's attributes.
    def on_shown():
        _remove_duplicate_menu_items()
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

    geometry_saved = threading.Event()

    def on_closed():
        global _save_timer
        try:
            with _save_timer_lock:
                if _save_timer is not None:
                    _save_timer.cancel()
                    _save_timer = None
            _save_window_geometry(state, signature)
        finally:
            geometry_saved.set()

    window.events.shown += on_shown
    window.events.moved += on_moved
    window.events.resized += on_resized
    window.events.closed += on_closed
    window.events.closing += on_closing

    # Allow file downloads (e.g. "Export to Word"): WKWebView drops blob/
    # download-attribute clicks unless this is enabled, so exporting would
    # otherwise silently do nothing. With it on, the webview shows a native
    # save dialog. Harmless in the browser build, which never runs this file.
    webview.settings["ALLOW_DOWNLOADS"] = True
    _enable_text_services()

    # Blocks on the GUI loop (main thread, required on macOS); returns when the
    # window is closed.
    webview.start()

    # End the process explicitly: a thread left waiting on the closed page
    # (e.g. one of pywebview's JS-bridge threads) would otherwise keep the app
    # running in the Dock until it's force-quit. The `closed` handler saves the
    # window geometry in its own thread, so wait (briefly) for that first.
    geometry_saved.wait(2)
    os._exit(0)


if __name__ == "__main__":
    main()
