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

    def open_html_window(self, html, title="Preview"):
        """Show rendered HTML (Cmd+click on a file in the file tree) in its own
        scrollable, read-only window. Secondary windows get no `closing`
        handler, so closing them never triggers the quit flow."""
        width, height = 900, 1000
        pos = {}
        # Put it beside the main window (right of it if there's room, else
        # left), so the preview and the editor can be seen side by side.
        try:
            main = self._window
            screen = webview.screens[0]
            height = min(height, int(main.height))
            x = int(main.x) + int(main.width)
            if x + width > screen.width:
                x = max(0, int(main.x) - width)
            pos = dict(x=x, y=int(main.y))
        except Exception:
            pass
        webview.create_window(
            title, html=html, width=width, height=height, min_size=(400, 300), **pos
        )
        return True

    def choose_save_path(self, directory="", filename="", kind="md"):
        """Show the native Save dialog (File > Save As…, Export as PDF…).
        Returns the chosen path, or None when cancelled."""
        types = {"md": ("Markdown (*.md)",), "pdf": ("PDF (*.pdf)",)}.get(kind, ())
        try:
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE,
                directory=directory or "",
                save_filename=filename or "",
                file_types=types,
            )
        except Exception:
            # Some pywebview versions reject file_types in a Save dialog.
            result = self._window.create_file_dialog(
                webview.FileDialog.SAVE, directory=directory or "", save_filename=filename or ""
            )
        if not result:
            return None
        path = result if isinstance(result, str) else result[0]
        ext = "." + kind
        if kind in ("md", "pdf") and not path.lower().endswith(ext):
            path += ext
        return path

    def export_pdf(self, html, filename="document.pdf", directory=""):
        """File > Export as PDF…: ask where to save, then render the document
        (the same standalone HTML as Print) to a paginated PDF with WebKit's
        own print engine, saving to the file instead of printing. Page size
        and margins come from the document's CSS (@page in preview.css).
        Returns {"path"}, {"cancelled": True} or {"error"}."""
        path = self.choose_save_path(directory, filename, "pdf")
        if not path:
            return {"cancelled": True}
        try:
            from PyObjCTools import AppHelper
        except ImportError:
            return {"error": "PDF export needs macOS"}
        done = threading.Event()
        result = {}

        def finished(ok, error=None):
            result.update(ok=ok, error=error)
            done.set()

        AppHelper.callAfter(_render_pdf, html, path, finished)  # GUI thread
        if not done.wait(120):
            return {"error": "PDF export timed out"}
        if not result.get("ok"):
            return {"error": result.get("error") or "PDF export failed"}
        return {"path": path}


# PDF rendering (Api.export_pdf). Runs on the main (GUI) thread: the HTML is
# loaded into an off-screen WKWebView and printed with "save to file" as the
# print job's destination. WebKit only lays out pages for a print operation
# that runs modally for a window, hence the off-screen window. The objects are
# kept here until the job finishes.
_pdf_jobs = set()
_pdf_delegate_class = None


def _render_pdf(html, path, finished):
    try:
        _start_pdf_job(html, path, finished)
    except Exception as e:
        finished(False, str(e))


def _start_pdf_job(html, path, finished):
    global _pdf_delegate_class
    import AppKit
    import objc
    import WebKit
    from Foundation import NSURL, NSMakeRect, NSObject
    from PyObjCTools import AppHelper

    if _pdf_delegate_class is None:

        class HumdPdfJob(NSObject):
            def webView_didFinishNavigation_(self, web_view, navigation):
                # A moment for images and web fonts to arrive.
                AppHelper.callLater(0.5, self.printToFile)

            def webView_didFailNavigation_withError_(self, web_view, navigation, error):
                self.finish(False, str(error.localizedDescription()))

            def webView_didFailProvisionalNavigation_withError_(self, web_view, navigation, error):
                self.finish(False, str(error.localizedDescription()))

            @objc.python_method
            def printToFile(self):
                try:
                    info = AppKit.NSPrintInfo.sharedPrintInfo().copy()
                    settings = info.dictionary()
                    settings[AppKit.NSPrintJobDisposition] = AppKit.NSPrintSaveJob
                    settings[AppKit.NSPrintJobSavingURL] = NSURL.fileURLWithPath_(self.path)
                    info.setHorizontalPagination_(AppKit.NSPrintingPaginationModeFit)
                    info.setVerticalPagination_(AppKit.NSPrintingPaginationModeAutomatic)
                    op = self.webView.printOperationWithPrintInfo_(info)
                    op.setShowsPrintPanel_(False)
                    op.setShowsProgressPanel_(False)
                    size = info.paperSize()
                    op.view().setFrame_(NSMakeRect(0, 0, size.width, size.height))
                    op.runOperationModalForWindow_delegate_didRunSelector_contextInfo_(
                        self.window, self, b"printOperationDidRun:success:contextInfo:", None
                    )
                except Exception as e:
                    self.finish(False, str(e))

            @objc.typedSelector(b"v@:@Z^v")
            def printOperationDidRun_success_contextInfo_(self, op, success, context):
                ok = bool(success) and os.path.exists(self.path)
                # Clean up once the print session has ended: closing its
                # window from inside this callback blocks the run loop.
                AppHelper.callAfter(self.finish, ok, None if ok else "the PDF could not be written")

            @objc.python_method
            def finish(self, ok, error):
                if self not in _pdf_jobs:
                    return
                _pdf_jobs.discard(self)
                self.webView.setNavigationDelegate_(None)
                self.window.orderOut_(None)
                self.callback(ok, error)

        _pdf_delegate_class = HumdPdfJob

    job = _pdf_delegate_class.new()
    job.path = path
    job.callback = finished
    job.window = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        NSMakeRect(-10000, -10000, 800, 1000), AppKit.NSWindowStyleMaskBorderless, 2, False
    )
    job.window.setReleasedWhenClosed_(False)
    job.webView = WebKit.WKWebView.alloc().initWithFrame_configuration_(
        NSMakeRect(0, 0, 800, 1000), WebKit.WKWebViewConfiguration.new()
    )
    job.window.setContentView_(job.webView)
    job.window.orderBack_(None)
    job.webView.setNavigationDelegate_(job)
    _pdf_jobs.add(job)
    job.webView.loadHTMLString_baseURL_(html, None)


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


def _disable_window_tabbing():
    """Keep every window a real, separate window.

    With macOS's "Prefer tabs when opening documents" setting (or in
    full-screen), new windows are merged as tabs into the frontmost one, so an
    HTML preview window (Api.open_html_window) couldn't be placed side by side
    with the editor. It must be set before any window is shown.
    """
    try:
        import AppKit
    except ImportError:  # not macOS
        return
    AppKit.NSWindow.setAllowsAutomaticWindowTabbing_(False)


# File menu: (title, command, key, modifiers). The command is run by the page
# (window.humdFileCommand in app.js), which also handles the same shortcuts
# itself, so they work in the browser too. A key the page handles never
# reaches the menu (WebKit only passes unhandled keys on), so nothing runs
# twice. None is a separator; "quit" is the app's own Quit.
_CMD, _SHIFT, _OPT = 1 << 20, 1 << 17, 1 << 19
FILE_MENU = [
    ("New File", "new-file", "n", _CMD),
    ("New Folder", "new-folder", "n", _CMD | _OPT),
    ("Open…", "open", "o", _CMD),
    ("Open Vault Folder…", "open-vault", "o", _CMD | _SHIFT),
    None,
    ("Close File", "close", "w", _CMD),
    ("Save", "save", "s", _CMD),
    ("Save As…", "save-as", "s", _CMD | _SHIFT),
    ("Revert to Saved", "revert", "", 0),
    None,
    ("Rename…", "rename", "", 0),
    ("Reveal in Finder", "reveal", "", 0),
    ("Move to Trash", "trash", "", 0),
    None,
    ("Export as PDF…", "export-pdf", "", 0),
    ("Export as Word…", "export-word", "", 0),
    None,
    ("Print…", "print", "p", _CMD),
    None,
    ("Quit Humd Editor", "quit", "q", _CMD),
]


def _add_file_menu(api):
    """Add the File menu (see FILE_MENU) after the app menu.

    Menu clicks are passed to the page from a background thread
    (evaluate_js waits for the page, so it can't run on the GUI thread).
    In an HTML preview window (Cmd+click in the file tree), Close File closes
    that window; other commands act on the editor window, which is brought
    to the front. Quit uses the app menu's own Quit item (with the unsaved-
    changes check)."""
    try:
        import json

        import AppKit
        from Foundation import NSObject
        from webview.platforms import cocoa
    except ImportError:  # not macOS
        return

    class HumdFileMenuTarget(NSObject):
        def fileCommand_(self, sender):
            command = sender.representedObject()
            main = getattr(api._window, "native", None) if api._window else None
            key = AppKit.NSApp.keyWindow()
            if main is not None and key is not None and key != main:
                if command == "close":
                    key.performClose_(None)
                    return
                main.makeKeyAndOrderFront_(None)
            script = f"window.humdFileCommand && window.humdFileCommand({json.dumps(command)})"

            def run():
                try:
                    api._window.evaluate_js(script)
                except Exception:
                    pass

            threading.Thread(target=run, daemon=True).start()

    target = HumdFileMenuTarget.new()
    recreate_menus = cocoa.BrowserView._recreate_menus

    def _recreate_menus(self, user_menu):
        main_menu = recreate_menus(self, user_menu)
        app_menu = main_menu.itemAtIndex_(0).submenu()
        quit_item = next(
            (it for it in (app_menu.itemArray() if app_menu else []) if it.keyEquivalent() == "q"),
            None,
        )
        menu = AppKit.NSMenu.alloc().initWithTitle_("File")
        for entry in FILE_MENU:
            if entry is None:
                menu.addItem_(AppKit.NSMenuItem.separatorItem())
                continue
            title, command, key, mask = entry
            if command == "quit":
                if quit_item is None:
                    continue
                item = menu.addItemWithTitle_action_keyEquivalent_(title, quit_item.action(), key)
                item.setTarget_(quit_item.target())
            else:
                item = menu.addItemWithTitle_action_keyEquivalent_(title, "fileCommand:", key)
                item.setTarget_(target)
                item.setRepresentedObject_(command)
            if key:
                item.setKeyEquivalentModifierMask_(mask)
        while menu.numberOfItems() and menu.itemAtIndex_(menu.numberOfItems() - 1).isSeparatorItem():
            menu.removeItemAtIndex_(menu.numberOfItems() - 1)
        file_item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("File", None, "")
        file_item.setSubmenu_(menu)
        main_menu.insertItem_atIndex_(file_item, 1)
        return main_menu

    cocoa.BrowserView._recreate_menus = _recreate_menus


def _add_window_menu():
    """Add the standard macOS Window menu to the menu bar.

    We only provide the classic items (Minimize, Zoom, Bring All to Front)
    and register the menu as NSApp's windowsMenu. AppKit then fills in the
    rest itself, following the current macOS conventions and the system
    language: Minimize All / Zoom All (with Option), Fill, Center, Full
    Screen, Move & Resize (halves, quarters, arrangements, Return to Previous
    Size), Full Screen Tile, Move to <other display>, Stage Manager items
    and the list of open windows (editor + HTML preview windows) to switch
    between. ⌘` cycles through the windows as in any Mac app.

    pywebview rebuilds the menu bar each time a window becomes key, so the
    menu is added in a wrapper around its _recreate_menus. The same NSMenu is
    reused every time: AppKit keeps the window list only in the menu that was
    registered, and registering it again would add a separator each time.
    """
    try:
        import AppKit
        from webview.platforms import cocoa
    except ImportError:  # not macOS
        return

    recreate_menus = cocoa.BrowserView._recreate_menus
    window_menu = None

    def _recreate_menus(self, user_menu):
        nonlocal window_menu
        main_menu = recreate_menus(self, user_menu)
        if window_menu is None:
            window_menu = AppKit.NSMenu.alloc().initWithTitle_("Window")
            window_menu.addItemWithTitle_action_keyEquivalent_(
                "Minimize", "performMiniaturize:", "m"
            )
            window_menu.addItemWithTitle_action_keyEquivalent_("Zoom", "performZoom:", "")
            window_menu.addItem_(AppKit.NSMenuItem.separatorItem())
            window_menu.addItemWithTitle_action_keyEquivalent_(
                "Bring All to Front", "arrangeInFront:", ""
            )
        # pywebview empties the previous menu bar, which detaches our menu;
        # guard anyway, as a menu can only belong to one menu item.
        if window_menu.supermenu() is not None:
            parent = window_menu.supermenu()
            parent.removeItemAtIndex_(parent.indexOfItemWithSubmenu_(window_menu))
        item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("Window", None, "")
        item.setSubmenu_(window_menu)
        main_menu.addItem_(item)
        if AppKit.NSApp.windowsMenu() is not window_menu:
            AppKit.NSApp.setWindowsMenu_(window_menu)
        return main_menu

    cocoa.BrowserView._recreate_menus = _recreate_menus


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

        # Paste and Match Style (⌥⇧⌘V) after Paste: the Markdown editor
        # converts pasted HTML to Markdown; this pastes the plain text as is.
        paste_index = next(
            (i for i, it in enumerate(edit_menu.itemArray()) if it.action() == "paste:"), None
        )
        if paste_index is not None:
            item = AppKit.NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(
                "Paste and Match Style", "pasteAsPlainText:", "v"
            )
            item.setKeyEquivalentModifierMask_(
                AppKit.NSEventModifierFlagCommand
                | AppKit.NSEventModifierFlagShift
                | AppKit.NSEventModifierFlagOption
            )
            edit_menu.insertItem_atIndex_(item, paste_index + 1)

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
            # The Window menu is managed by AppKit (see _add_window_menu); its
            # window list may legitimately hold equal titles (same file twice).
            if menu is not None and menu is AppKit.NSApp.windowsMenu():
                continue
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
            # webview.start() only returns once every window is gone, so close
            # any open HTML preview windows (Api.open_html_window) as well.
            for w in [w for w in webview.windows if w is not window]:
                try:
                    w.destroy()
                except Exception:
                    pass

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
    _disable_window_tabbing()
    _add_window_menu()
    _add_file_menu(api)

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
