#!/usr/bin/env python3
"""Unit tests for the pure helpers in server/server.py.

Run with:  python3 -m unittest discover -s tests
"""

import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import server  # noqa: E402


class InlineTagTests(unittest.TestCase):
    def test_basic_and_nested(self):
        tags = server.extract_inline_tags("About #history and #area/research here.")
        self.assertEqual(tags, ["history", "area/research"])

    def test_repeats_counted(self):
        self.assertEqual(server.extract_inline_tags("#a then #a"), ["a", "a"])

    def test_ignores_headings(self):
        self.assertEqual(server.extract_inline_tags("# Heading\n## Sub"), [])

    def test_ignores_code(self):
        md = "text\n```\n#define X\n```\ninline `#nope` and #yes"
        self.assertEqual(server.extract_inline_tags(md), ["yes"])

    def test_ignores_url_fragments(self):
        self.assertEqual(server.extract_inline_tags("see https://x.com/p#frag and #real"), ["real"])

    def test_ignores_midword_hash(self):
        self.assertEqual(server.extract_inline_tags("a#b not a tag"), [])


class YamlTagTests(unittest.TestCase):
    def test_inline_flow(self):
        self.assertEqual(server.extract_yaml_tags("---\ntags: [a, b]\n---\nx"), ["a", "b"])

    def test_scalar_comma_list(self):
        self.assertEqual(server.extract_yaml_tags("---\ntags: hist, modern\n---"), ["hist", "modern"])

    def test_block_sequence(self):
        md = "---\ntitle: t\ntags:\n  - one\n  - two\n---\nbody"
        self.assertEqual(server.extract_yaml_tags(md), ["one", "two"])

    def test_strips_hash_and_quotes(self):
        self.assertEqual(server.extract_yaml_tags('---\ntags: ["#foo", bar]\n---'), ["foo", "bar"])

    def test_no_frontmatter(self):
        self.assertEqual(server.extract_yaml_tags("no front matter #x"), [])


class VaultTests(unittest.TestCase):
    def setUp(self):
        server._file_cache.clear()
        server._last_index_json.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = self.tmp.name
        (Path(self.vault) / "sub").mkdir()
        self._write("a.md", "About #history. See [[b]] and [[b|alias]].")
        self._write("b.md", "---\ntags:\n  - project\n---\nplain body")
        self._write("sub/c.md", "no tags here")

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, rel, text):
        (Path(self.vault) / rel).write_text(text, encoding="utf-8")

    def test_build_index(self):
        idx = server.build_link_index(self.vault)
        self.assertEqual(sorted(idx["notes"].keys()), ["a", "b", "c"])
        self.assertIn("history", idx["tag_index"])
        self.assertIn("project", idx["tag_index"])
        # b is linked to from a → backlink under "b"
        self.assertEqual(idx["backlinks"].get("b"), ["a"])
        # c.md has no tags → untagged
        self.assertTrue(any(p.endswith("c.md") for p in idx["untagged"]))

    def test_incremental_update_and_prune(self):
        server.build_link_index(self.vault)
        # add a tag, rebuild → picked up
        self._write("sub/c.md", "now with #fresh")
        idx = server.build_link_index(self.vault)
        self.assertIn("fresh", idx["tag_index"])
        # delete a file, rebuild → pruned from cache
        (Path(self.vault) / "sub" / "c.md").unlink()
        server.build_link_index(self.vault)
        self.assertFalse(any(k.endswith("c.md") for k in server._file_cache))

    def test_search(self):
        hits = server.search_vault(self.vault, "history")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["name"], "a")
        self.assertEqual(hits[0]["matches"][0]["line"], 1)

    def test_search_empty_query(self):
        self.assertEqual(server.search_vault(self.vault, "   "), [])

    def test_rename_rewrites_wikilinks(self):
        n = server.rename_wikilink_targets(self.vault, "b", "beta")
        self.assertEqual(n, 1)
        self.assertEqual(
            (Path(self.vault) / "a.md").read_text(encoding="utf-8"),
            "About #history. See [[beta]] and [[beta|alias]].",
        )

    def test_rename_noop_same_name(self):
        self.assertEqual(server.rename_wikilink_targets(self.vault, "b", "b"), 0)

    def test_index_write_skipped_when_unchanged(self):
        server.build_link_index(self.vault)
        index_file = Path(self.vault) / ".link-index.json"
        mtime1 = index_file.stat().st_mtime_ns
        time.sleep(0.01)
        server.build_link_index(self.vault)  # nothing changed
        self.assertEqual(index_file.stat().st_mtime_ns, mtime1)
        # A real change does rewrite the file.
        self._write("a.md", "About #history and #newtag.")
        server.build_link_index(self.vault)
        self.assertNotEqual(index_file.stat().st_mtime_ns, mtime1)

    def test_vault_hash_is_digest_and_changes(self):
        h1 = server.get_vault_hash(self.vault)
        self.assertRegex(h1, r"^[0-9a-f]{40}$")  # compact sha1 hex, not a path list
        time.sleep(0.01)
        self._write("a.md", "changed content")
        self.assertNotEqual(server.get_vault_hash(self.vault), h1)

    def test_search_reuses_cache_content(self):
        # After a search populates the cache, the entry carries the file text.
        server.search_vault(self.vault, "history")
        entry = next(v for k, v in server._file_cache.items() if k.endswith("a.md"))
        self.assertIn("content", entry)
        self.assertIn("history", entry["content"])


class PathConfinementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = str(Path(self.tmp.name).resolve())
        self._orig = server.load_settings
        server.load_settings = lambda: {"vaultPath": self.vault}

    def tearDown(self):
        server.load_settings = self._orig
        self.tmp.cleanup()

    def test_inside_vault_ok(self):
        p = server.safe_path(str(Path(self.vault) / "note.md"))
        self.assertTrue(str(p).startswith(self.vault))

    def test_vault_root_ok(self):
        self.assertEqual(server.safe_path(self.vault), Path(self.vault))

    def test_traversal_rejected(self):
        with self.assertRaises(PermissionError):
            server.safe_path(str(Path(self.vault) / ".." / "escape.md"))

    def test_absolute_outside_rejected(self):
        with self.assertRaises(PermissionError):
            server.safe_path("/etc/passwd")

    def test_no_vault_rejected(self):
        server.load_settings = lambda: {}
        with self.assertRaises(PermissionError):
            server.safe_path("/anything")


if __name__ == "__main__":
    unittest.main()
