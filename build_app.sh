#!/bin/bash
# Build a standalone, self-contained "Humd Editor.app" with PyInstaller.
#
# The app bundles the Python interpreter, server/desktop.py + server.py, and the
# src/ assets, so it runs on a Mac with no Python install. It starts the local
# server and shows the editor in a native window. Output: dist/Humd Editor.app
#
# Requirements: macOS, plus PyInstaller AND pywebview in the same interpreter
#   (pip install pyinstaller pywebview). PyInstaller is found automatically on
#   any python3 that has it; otherwise an isolated build venv is created — note
#   that venv would also need pywebview, so installing both into one python3 is
#   simplest. Override with:  PYTHON=/path/to/python3 ./build_app.sh
# Override the interpreter with:  PYTHON=/path/to/python3 ./build_app.sh
# Note: PyInstaller is not a cross-compiler — build on the OS/arch you target.

set -e
cd "$(dirname "$0")"

APP_NAME="Humd Editor"

# Pick the first interpreter that has BOTH PyInstaller and pywebview. There may
# be several python3 installs (e.g. Homebrew vs python.org); only some qualify.
find_python() {
    for cand in "$PYTHON" python3 python3.14 python3.13 python3.12 python3.11 \
        /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
        /Library/Frameworks/Python.framework/Versions/3.14/bin/python3; do
        [ -n "$cand" ] || continue
        if command -v "$cand" >/dev/null 2>&1 && "$cand" -c "import PyInstaller, webview" >/dev/null 2>&1; then
            echo "$cand"
            return 0
        fi
    done
    return 1
}

PY="$(find_python || true)"

if [ -z "$PY" ]; then
    echo "PyInstaller+pywebview not found on any python3 — creating a build venv…"
    "${PYTHON:-python3}" -m venv .build-venv
    .build-venv/bin/python -m pip install --upgrade pip >/dev/null
    .build-venv/bin/python -m pip install pyinstaller pywebview
    PY=".build-venv/bin/python"
fi

echo "Using $("$PY" --version 2>&1) at: $PY"

# Stop any running instance first. A still-running old server holds port 8082,
# and a relaunch would just attach to it (via the already-running check) instead
# of picking up this fresh build.
if pkill -f "$APP_NAME.app/Contents/MacOS/$APP_NAME" 2>/dev/null; then
    echo "Stopped a running instance of $APP_NAME."
fi

"$PY" -m PyInstaller \
    --name "$APP_NAME" \
    --windowed \
    --noconfirm \
    --clean \
    --add-data "src:src" \
    --icon "src/assets/icon.icns" \
    --collect-all webview \
    server/desktop.py

echo
echo "Built: dist/$APP_NAME.app"
echo "Run it with:  open \"dist/$APP_NAME.app\""
