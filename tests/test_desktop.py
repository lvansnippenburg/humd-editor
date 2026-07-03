#!/usr/bin/env python3
"""Unit tests for the window geometry loading and saving helpers in server/desktop.py.

Run with:  python3 -m unittest discover -s tests
"""

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

# Add server directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import desktop

import server


class DesktopGeometryTests(unittest.TestCase):
    def setUp(self):
        # Keep track of original SETTINGS_PATH to restore it in tearDown
        self.original_settings_path = server.SETTINGS_PATH
        self.tmp_dir = tempfile.TemporaryDirectory()
        server.SETTINGS_PATH = Path(self.tmp_dir.name) / "settings.json"

    def tearDown(self):
        # Restore SETTINGS_PATH and cleanup
        server.SETTINGS_PATH = self.original_settings_path
        self.tmp_dir.cleanup()

    def test_load_geometry_no_settings(self):
        # If settings.json does not exist or has no 'window' field, it should return None
        res = desktop._load_window_geometry("1920x1080")
        self.assertIsNone(res)

    def test_load_geometry_layout_mismatch_falls_back_to_centering(self):
        # If screens don't match or is empty, it should return (None, None, width, height)
        server.save_settings(
            {
                "window": {
                    "x": 100,
                    "y": 200,
                    "width": 800,
                    "height": 600,
                    "screens": "1920x1080",
                }
            }
        )
        # Screen layout mismatch
        res = desktop._load_window_geometry("2560x1440")
        self.assertEqual(res, (None, None, 800, 600))

        # No signature provided
        res = desktop._load_window_geometry("")
        self.assertEqual(res, (None, None, 800, 600))

    def test_load_geometry_layout_matches(self):
        # If screens match, it should return (x, y, width, height)
        server.save_settings(
            {
                "window": {
                    "x": 100,
                    "y": 200,
                    "width": 800,
                    "height": 600,
                    "screens": "1920x1080",
                }
            }
        )
        res = desktop._load_window_geometry("1920x1080")
        self.assertEqual(res, (100, 200, 800, 600))

    def test_save_geometry_basic(self):
        state = {"x": 150, "y": 250, "width": 900, "height": 700}
        desktop._save_window_geometry(state, "1920x1080")

        saved = server.load_settings().get("window")
        self.assertIsNotNone(saved)
        self.assertEqual(saved["x"], 150)
        self.assertEqual(saved["y"], 250)
        self.assertEqual(saved["width"], 900)
        self.assertEqual(saved["height"], 700)
        self.assertEqual(saved["screens"], "1920x1080")

    def test_save_geometry_invalid_state(self):
        # If state doesn't have width or x, it shouldn't save
        state = {"x": None, "y": None, "width": None, "height": None}
        desktop._save_window_geometry(state, "1920x1080")
        self.assertIsNone(server.load_settings().get("window"))

    def test_debounced_save_geometry(self):
        state = {"x": 300, "y": 400, "width": 1000, "height": 800}

        # Trigger debounced save
        desktop._debounced_save_geometry(state, "1920x1080")

        # Verify it hasn't written immediately (it has 1 second debounce)
        self.assertIsNone(server.load_settings().get("window"))

        # Wait more than 1 second (e.g. 1.2s)
        time.sleep(1.2)

        # Verify it has now written
        saved = server.load_settings().get("window")
        self.assertIsNotNone(saved)
        self.assertEqual(saved["x"], 300)
        self.assertEqual(saved["y"], 400)
        self.assertEqual(saved["width"], 1000)
        self.assertEqual(saved["height"], 800)


if __name__ == "__main__":
    unittest.main()
