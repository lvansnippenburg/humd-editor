#!/usr/bin/env python3
"""Unit tests for server/mdsearch.py, the retrieval worker: keyword search
and passages (semantic search needs fastembed, which the tests don't load).

Run with:  python3 -m unittest discover -s tests
"""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import mdsearch  # noqa: E402


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "murano.md").write_text(
            "# Murano\n\nIn 1291 the glassmakers moved their furnaces to Murano.\n", encoding="utf-8"
        )
        (self.root / "pisa.md").write_text("# Pisa\n\nThe archive of Pisa was moved in 1890.\n", encoding="utf-8")
        (self.root / ".trash").mkdir()
        (self.root / ".trash" / "old.md").write_text("Glassmakers, glassmakers.\n", encoding="utf-8")

    def test_keyword_search(self):
        index = mdsearch.Index(self.root)
        self.assertEqual([f for f, _, _ in index.docs], ["murano.md", "pisa.md"])  # not .trash
        hits = index.search("Why did the glassmakers move?")
        self.assertEqual(hits[0][:2], ("murano.md", 1))
        self.assertIn("furnaces", hits[0][2])
        self.assertEqual(index.search("nothing matches this"), [])

    def test_no_similar_notes_without_embeddings(self):
        index = mdsearch.Index(self.root)
        self.assertEqual(mdsearch.similar_notes(index, "Glass furnaces", None, {"pisa.md"}), [])

    def test_passages(self):
        lines = ["word " * 60, "", "second " * 40, "end"]
        self.assertEqual([n for n, _ in mdsearch.passages(lines)], [1, 3])

    def test_signature_changes(self):
        before = mdsearch.vault_signature(self.root)
        (self.root / "new.md").write_text("New.", encoding="utf-8")
        self.assertNotEqual(mdsearch.vault_signature(self.root), before)


if __name__ == "__main__":
    unittest.main()
