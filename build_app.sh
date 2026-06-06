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
# Note: PyInstaller is not a cross-compiler — build on the OS/arch you target.
#
# Code signing + notarization (optional, for distributing to other Macs):
#   Set SIGN_IDENTITY to sign, and additionally NOTARY_PROFILE to notarize:
#
#     SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#     NOTARY_PROFILE="humd-notary" ./build_app.sh
#
#   One-time setup:
#     * A "Developer ID Application" cert in your keychain (Apple Developer
#       account). List candidates with:
#         security find-identity -v -p codesigning
#     * A stored notarytool credential profile:
#         xcrun notarytool store-credentials "humd-notary" \
#           --apple-id you@example.com --team-id TEAMID \
#           --password <app-specific-password>
#   Without these vars the app is left ad-hoc signed (runs on this machine only).

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

APP="dist/$APP_NAME.app"
echo
echo "Built: $APP"

# --- Optional: code signing + notarization for distribution ----------------
if [ -n "$SIGN_IDENTITY" ]; then
    echo "Signing with hardened runtime: $SIGN_IDENTITY"
    # --deep applies the identity + entitlements to every nested binary/dylib;
    # --options runtime enables the hardened runtime that notarization requires.
    codesign --force --deep --options runtime --timestamp \
        --entitlements entitlements.plist \
        --sign "$SIGN_IDENTITY" "$APP"
    codesign --verify --strict --verbose=2 "$APP"
    echo "Signed and verified."

    if [ -n "$NOTARY_PROFILE" ]; then
        ZIP="dist/$APP_NAME.zip"
        echo "Packaging for notarization: $ZIP"
        rm -f "$ZIP"
        ditto -c -k --keepParent "$APP" "$ZIP"
        echo "Submitting to Apple notary service (can take a few minutes)…"
        xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
        echo "Stapling the notarization ticket…"
        xcrun stapler staple "$APP"
        xcrun stapler validate "$APP"
        spctl --assess --type execute --verbose=2 "$APP" || true
        rm -f "$ZIP"
        echo "Notarized, stapled, and Gatekeeper-checked."
    else
        echo "NOTARY_PROFILE not set — signed only (not notarized)."
    fi
else
    echo "SIGN_IDENTITY not set — left ad-hoc signed (runs on this machine only,"
    echo "not distributable). See the header of this script to enable signing."
fi

echo
echo "Run it with:  open \"$APP\""
