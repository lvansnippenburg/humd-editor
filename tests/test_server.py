#!/usr/bin/env python3
"""Unit tests for the pure helpers in server/server.py.

Run with:  python3 -m unittest discover -s tests
"""

import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import server  # noqa: E402

_settings_dir = None


def setUpModule():
    # SETTINGS_PATH is set on import, so patching Path.home is too late: point
    # it at a temporary file, so no test can touch the real settings.
    global _settings_dir
    _settings_dir = tempfile.TemporaryDirectory()
    server.SETTINGS_PATH = Path(_settings_dir.name) / "settings.json"


def tearDownModule():
    _settings_dir.cleanup()


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
        self.assertEqual(
            server.extract_inline_tags("see https://x.com/p#frag and #real"), ["real"]
        )

    def test_ignores_midword_hash(self):
        self.assertEqual(server.extract_inline_tags("a#b not a tag"), [])


class YamlTagTests(unittest.TestCase):
    def test_inline_flow(self):
        self.assertEqual(
            server.extract_yaml_tags("---\ntags: [a, b]\n---\nx"), ["a", "b"]
        )

    def test_scalar_comma_list(self):
        self.assertEqual(
            server.extract_yaml_tags("---\ntags: hist, modern\n---"), ["hist", "modern"]
        )

    def test_block_sequence(self):
        md = "---\ntitle: t\ntags:\n  - one\n  - two\n---\nbody"
        self.assertEqual(server.extract_yaml_tags(md), ["one", "two"])

    def test_strips_hash_and_quotes(self):
        self.assertEqual(
            server.extract_yaml_tags('---\ntags: ["#foo", bar]\n---'), ["foo", "bar"]
        )

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


class InlineWikilinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, rel, text):
        (Path(self.vault) / rel).write_text(text, encoding="utf-8")

    def test_basic_and_alias(self):
        self._write("b.md", "body of b")
        out = server.inline_wikilinks("See [[b]] and [[b|alias]].", self.vault)
        self.assertEqual(out, "See body of b and body of b.")

    def test_case_insensitive_resolution(self):
        self._write("Note Name.md", "content")
        out = server.inline_wikilinks("[[note name]]", self.vault)
        self.assertEqual(out, "content")

    def test_frontmatter_stripped(self):
        self._write("b.md", "---\ntags:\n  - x\n---\nplain body")
        out = server.inline_wikilinks("[[b]]", self.vault)
        self.assertEqual(out, "plain body")

    def test_recursive_import(self):
        self._write("a.md", "a says [[b]]")
        self._write("b.md", "b body")
        out = server.inline_wikilinks("start [[a]] end", self.vault)
        self.assertEqual(out, "start a says b body end")

    def test_cycle_left_as_link(self):
        self._write("a.md", "a links [[b]]")
        self._write("b.md", "b links [[a]]")
        out = server.inline_wikilinks("[[a]]", self.vault)
        self.assertEqual(out, "a links b links [[a]]")

    def test_self_link_via_source_path(self):
        self._write("a.md", "whole of a")
        out = server.inline_wikilinks(
            "see [[a]]", self.vault, str(Path(self.vault) / "a.md")
        )
        self.assertEqual(out, "see [[a]]")

    def test_unresolved_left_untouched(self):
        out = server.inline_wikilinks("see [[missing]]", self.vault)
        self.assertEqual(out, "see [[missing]]")

    def test_code_not_expanded(self):
        self._write("b.md", "body")
        src = "```\n[[b]]\n```\nand `[[b]]` but [[b]]"
        out = server.inline_wikilinks(src, self.vault)
        self.assertEqual(out, "```\n[[b]]\n```\nand `[[b]]` but body")

    def test_heading_anchor_imports_note(self):
        self._write("b.md", "body")
        self.assertEqual(server.inline_wikilinks("[[b#intro]]", self.vault), "body")
        # A pure self-anchor has no note to import.
        self.assertEqual(
            server.inline_wikilinks("[[#intro]]", self.vault), "[[#intro]]"
        )


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


class VersionTests(unittest.TestCase):
    def test_version_is_stable_hex(self):
        v = server._compute_version()
        self.assertRegex(v, r"^[0-9a-f]{12}$")
        self.assertEqual(v, server._compute_version())  # deterministic

    def test_ensure_starts_when_nothing_running(self):
        # Port 0 → OS-assigned ephemeral, so nothing is "already running".
        srv, _ = server.ensure_our_server(0)
        self.assertIsNotNone(srv)
        srv.server_close()

    def test_reuse_when_same_version(self):
        srv, port = server._make_server(8137)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            time.sleep(0.2)
            # Same process → same SERVER_VERSION → ensure should say 'reuse'.
            again, p = server.ensure_our_server(port)
            self.assertIsNone(again)
            self.assertEqual(p, port)
        finally:
            srv.shutdown()
            srv.server_close()


class SettingsTestCase(unittest.TestCase):
    """Gives each test an empty settings file of its own (setUpModule already
    keeps every test away from the real ~/.humd-editor/settings.json)."""

    def setUp(self):
        server.SETTINGS_PATH.unlink(missing_ok=True)

    def set_settings(self, **settings):
        server.save_settings(settings)


class OpenSettingsFileTests(SettingsTestCase):
    def test_opens_the_settings_file(self):
        with mock.patch.object(server.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=0, stderr="")
            server.open_settings_file()
        self.assertEqual(run.call_args.args[0], ["open", str(server.SETTINGS_PATH)])

    def test_reports_failure(self):
        with mock.patch.object(server.subprocess, "run") as run:
            run.return_value = mock.Mock(returncode=1, stderr="no such file")
            with self.assertRaisesRegex(RuntimeError, "no such file"):
                server.open_settings_file()


class AiModelTests(SettingsTestCase):
    def test_empty(self):
        self.assertEqual(server.load_ai_models(), [])
        with self.assertRaisesRegex(RuntimeError, "No AI model is set up"):
            server.selected_ai_model()

    def test_add_replace_and_remove(self):
        server.add_ai_model("https://api.mistral.ai/v1/", "mistral-small-latest", "key-1")
        server.add_ai_model("http://127.0.0.1:8000/v1", "qwen", small=True)
        server.add_ai_model("https://api.mistral.ai/v1", "mistral-small-latest", "key-2")  # replaces key-1
        models = server.load_ai_models()
        self.assertEqual(
            models,
            [
                {"url": "https://api.mistral.ai/v1", "model": "mistral-small-latest", "apiKey": "key-2", "small": False},
                {"url": "http://127.0.0.1:8000/v1", "model": "qwen", "apiKey": "", "small": True},
            ],
        )
        self.assertEqual([server.ai_model_name(m) for m in models], ["Mistral", "oMLX"])
        self.assertEqual(server.ai_model_name({"url": "http://host:1234/v1"}), "host:1234")
        # Without a selection the first one is used.
        self.assertEqual(server.selected_ai_model()["model"], "mistral-small-latest")
        key = server.ai_model_key(models[1])
        server.save_settings({**server.load_settings(), "aiModel": key})
        self.assertEqual(server.selected_ai_model()["model"], "qwen")
        server.remove_ai_model(key)
        self.assertEqual(len(server.load_ai_models()), 1)
        self.assertNotIn("aiModel", server.load_settings())

    def test_selection_gone(self):
        server.add_ai_model("http://localhost:11434/v1", "qwen3:4b")
        server.save_settings({**server.load_settings(), "aiModel": "gone @ http://x/v1"})
        with self.assertRaisesRegex(RuntimeError, "not set up any more"):
            server.selected_ai_model()

    def test_validation(self):
        with self.assertRaisesRegex(ValueError, "URL"):
            server.add_ai_model("localhost:8000", "m")
        with self.assertRaisesRegex(ValueError, "model name"):
            server.add_ai_model("http://localhost:8000/v1", " ")


class FakeChatService(BaseHTTPRequestHandler):
    """An OpenAI-compatible /v1/chat/completions. It streams `pieces`, then
    `finish_reason`; it rejects a request with an option named in `reject`
    (400, as a strict service would), and answers model "missing" with 404."""

    pieces = ["<think>hmm</think>", "Hello", " world"]
    finish_reason = "stop"
    reject = ()
    requests = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeChatService.requests.append((self.path, dict(self.headers), body))
        rejected = next((o for o in self.reject if o in body or body.get("response_format", {}).get("type") == o), None)
        if body["model"] == "missing" or rejected:
            code, message = (404, "model 'missing' not found") if not rejected else (400, f"Unsupported: {rejected}")
            data = json.dumps({"error": {"message": message}}).encode()
            self.send_response(code)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [{"choices": [{"delta": {"content": p}, "finish_reason": None}]} for p in self.pieces]
        chunks.append({"choices": [{"delta": {}, "finish_reason": self.finish_reason}]})
        for c in chunks:
            self.wfile.write(f"data: {json.dumps(c)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *args):
        pass


class AiChatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeChatService)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.cfg = {"url": f"http://127.0.0.1:{cls.srv.server_address[1]}/v1", "model": "qwen", "apiKey": "secret"}

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        FakeChatService.requests.clear()
        FakeChatService.finish_reason = "stop"
        FakeChatService.reject = ()

    def test_streams_the_answer(self):
        pieces = []
        answer = server.ai_chat("sys", "Hi", self.cfg, max_tokens=40, temperature=0.2, on_text=pieces.append)
        self.assertEqual(answer, "Hello world")  # without the thoughts
        self.assertEqual(pieces, ["<think>hmm</think>", "Hello", " world"])
        path, headers, body = FakeChatService.requests[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(headers["Authorization"], "Bearer secret")
        self.assertEqual(
            body,
            {
                "model": "qwen",
                "messages": [{"role": "system", "content": "sys"}, {"role": "user", "content": "Hi"}],
                "stream": True,
                "max_tokens": 40,
                "temperature": 0.2,
            },
        )

    def test_json_schema(self):
        server.ai_chat("sys", "Hi", self.cfg, json_schema=server.TRANSLATE_JSON_SCHEMA)
        fmt = FakeChatService.requests[0][2]["response_format"]
        self.assertEqual(fmt["type"], "json_schema")
        self.assertEqual(fmt["json_schema"]["schema"]["properties"]["items"], server.TRANSLATE_JSON_SCHEMA)

    def test_rejected_options_are_dropped(self):
        FakeChatService.reject = ("temperature", "max_tokens", "json_schema")
        server.ai_chat("sys", "Hi", self.cfg, json_schema={}, max_tokens=40, temperature=0.2)
        body = FakeChatService.requests[-1][2]
        self.assertNotIn("temperature", body)
        self.assertEqual(body["max_completion_tokens"], 40)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(len(FakeChatService.requests), 4)

    def test_cut_off(self):
        FakeChatService.finish_reason = "length"
        with self.assertRaisesRegex(RuntimeError, "cut off"):
            server.ai_chat("sys", "Hi", self.cfg)

    def test_missing_model(self):
        with self.assertRaisesRegex(RuntimeError, r"error 404: model 'missing' not found.*Check the URL"):
            server.ai_chat("sys", "Hi", {**self.cfg, "model": "missing"})

    def test_unreachable(self):
        with self.assertRaisesRegex(RuntimeError, r"Could not reach 127.0.0.1:9 at http://127.0.0.1:9/v1 — is it running"):
            server.ai_chat("sys", "Hi", {"url": "http://127.0.0.1:9/v1", "model": "m"})


class AiJobsTests(unittest.TestCase):
    def test_one_job_at_a_time(self):
        jobs = server.AiJobs()
        release = threading.Event()
        jobs.start("search", lambda job: release.wait(5), answer="")
        with self.assertRaisesRegex(RuntimeError, "still answering a question"):
            jobs.run("proofread", lambda job: None)
        release.set()
        for _ in range(50):
            if jobs.status()["state"] != "running":
                break
            time.sleep(0.05)
        self.assertEqual(jobs.status()["state"], "done")
        with self.assertRaisesRegex(ValueError, "boom"):
            jobs.run("translate", lambda job: (_ for _ in ()).throw(ValueError("boom")))
        self.assertEqual((jobs.status()["kind"], jobs.status()["state"], jobs.status()["error"]), ("translate", "error", "boom"))


def wait_for_job(job_id):
    for _ in range(100):
        job = server.ai_jobs.status()
        if job["id"] == job_id and job["state"] != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("the job didn't finish")


class AiActionTests(SettingsTestCase):
    """The AI functions, with the model (ai_chat) and the retrieval worker
    stubbed."""

    TEXT = (
        "---\ntitle: x\n---\n"
        "The archive were closed in 1890 by the city.\n\n"
        "[[Some note]] #tag\n\n"
        "The documents was moved to Pisa afterwards.\n"
    )

    def setUp(self):
        super().setUp()
        server.add_ai_model("http://127.0.0.1:8000/v1", "small-model", small=True)
        server.add_ai_model("https://api.example.com/v1", "large-model", "k")
        patcher = mock.patch.object(server, "ai_chat")
        self.chat = patcher.start()
        self.addCleanup(patcher.stop)
        patcher = mock.patch.object(server.retrieval_worker, "call")
        self.worker = patcher.start()
        self.addCleanup(patcher.stop)

    def use(self, model):
        cfg = next(m for m in server.load_ai_models() if m["model"] == model)
        server.save_settings({**server.load_settings(), "aiModel": server.ai_model_key(cfg)})

    def test_prose_paragraphs(self):
        self.assertEqual(
            server.prose_paragraphs(self.TEXT),
            ["The archive were closed in 1890 by the city.", "The documents was moved to Pisa afterwards."],
        )

    def test_proofread_small_model(self):
        self.use("small-model")
        self.chat.side_effect = [
            '[{"type":"correction","original":"archive were","suggestion":"archive was","comment":"Agreement."},'
            ' {"type":"correction","original":"not in the text","suggestion":"x","comment":""},'
            ' {"type":"correction","original":"in 1890","suggestion":"in 1890","comment":"No error."},'
            ' {"type":"correction","original":"The archive were","suggestion":"The archive was","comment":""}]',
            '```json\n[{"type":"odd","original":"documents was","suggestion":"documents were"}]\n```',
        ]
        self.assertEqual(
            server.proofread_text(self.TEXT),
            [
                {"type": "correction", "original": "archive were", "suggestion": "archive was", "comment": "Agreement."},
                {"type": "correction", "original": "documents was", "suggestion": "documents were", "comment": ""},
            ],
        )
        system, paragraph, cfg = self.chat.call_args_list[0].args
        self.assertIn("copy-editor", system)  # PROOFREAD_SYSTEM_SMALL.md
        self.assertEqual(paragraph, "The archive were closed in 1890 by the city.")
        self.assertEqual(cfg["model"], "small-model")
        job = server.ai_jobs.status()
        self.assertEqual((job["kind"], job["state"], job["step"]), ("proofread", "done", "paragraph 2 of 2"))

    def test_proofread_large_model(self):
        self.use("large-model")
        self.chat.return_value = '{"items": [{"type": "passive", "original": "was moved", "suggestion": "", "comment": "Passive."}]}'
        self.assertEqual(
            server.proofread_text(self.TEXT),
            [{"type": "passive", "original": "was moved", "suggestion": "", "comment": "Passive."}],
        )
        (system, text, cfg), kwargs = self.chat.call_args
        self.assertEqual(text, self.TEXT)  # all at once
        self.assertIs(kwargs["json_schema"], server.PROOFREAD_JSON_SCHEMA)
        self.chat.return_value = "Looks fine to me"
        with self.assertRaisesRegex(RuntimeError, "expected format"):
            server.proofread_text(self.TEXT)

    def test_translate(self):
        self.use("small-model")
        self.chat.side_effect = ["Het archief sloot in 1890.", "The documents was moved to Pisa afterwards."]
        self.assertEqual(
            server.translate_text(self.TEXT, "Dutch"),
            [{"original": "The archive were closed in 1890 by the city.", "suggestion": "Het archief sloot in 1890.", "comment": ""}],
        )
        self.assertIn("Dutch", self.chat.call_args_list[0].args[0])
        self.use("large-model")
        self.chat.side_effect = None
        self.chat.return_value = "[]"
        server.translate_text("texto", "")
        (system, _, _), kwargs = self.chat.call_args
        self.assertIn("English", system)
        self.assertNotIn("{{TARGET_LANGUAGE}}", system)
        item = kwargs["json_schema"]["items"]
        self.assertEqual(sorted(item["properties"]), ["comment", "original", "suggestion"])

    def test_llm_search(self):
        self.worker.return_value = {"passages": [{"file": "a.md", "line": 3, "text": "Because."}]}

        def answer(system, user, cfg, on_text, **kwargs):
            on_text("Because [a.md:3].")
            return "Because [a.md:3]."

        self.chat.side_effect = answer
        job = wait_for_job(server.start_llm_search("/vault", "Why?"))
        self.assertEqual(self.worker.call_args.args[0], {"vault": "/vault", "query": "Why?"})
        self.assertEqual(job["sources"], [{"file": "a.md", "line": 3, "text": "Because.", "path": "/vault/a.md"}])
        self.assertEqual((job["state"], job["answer"]), ("done", "Because [a.md:3]."))
        self.assertIn("Excerpts:\n\n[a.md:3]\nBecause.\n\nQuestion: Why?", self.chat.call_args.args[1])
        self.worker.return_value = {"passages": []}
        job = wait_for_job(server.start_llm_search("/vault", "What?"))
        self.assertEqual(job["answer"], "No matching passages found in your notes.")

    def test_tag_suggestions(self):
        note_tags = {"a.md": ["Merchants", "trade"], "b.md": ["religion"]}
        self.worker.return_value = {"notes": [["a.md", 0.8], ["b.md", 0.3]]}
        self.chat.return_value = "trade, invented, Religion"
        targets = [{"file": "c.md", "text": "Draft about #trade and churches", "existing": ["trade"]}]
        job = wait_for_job(server.start_tag_suggestions("/vault", targets, note_tags))
        self.assertEqual(job["state"], "done")
        self.assertEqual(
            job["results"],
            [{"path": "/vault/c.md", "tags": ["religion"], "evidence": {"religion": ["/vault/b.md"]}}],
        )
        similar = self.worker.call_args.args[0]["similar"]
        self.assertEqual(similar["text"], "Draft about  and churches")  # without its tags
        self.assertIn("- a: Merchants, trade", self.chat.call_args.args[1])

    def test_parse_tags(self):
        allowed = ["Merchants", "religion", "trade"]
        self.assertEqual(
            server.parse_tags("#merchants, Religion, invented, trade", allowed, []),
            ["Merchants", "religion", "trade"],
        )
        self.assertEqual(server.parse_tags("- trade\n- religion", allowed, ["Trade"]), ["religion"])
        self.assertEqual(
            server.parse_tags("trade, religion, merchants, trade", ["a", *allowed], []),
            ["trade", "religion", "Merchants"],
        )


# Stands in for mdsearch.py --serve: a status and the request back as its
# result, or an error for the query "fail"; the query "exit" ends it.
FAKE_WORKER = """
import json, sys
for line in sys.stdin:
    req = json.loads(line)
    say = lambda **ev: print(json.dumps(ev), flush=True)
    say(event="status", message="Reading notes …")
    if req.get("query") == "exit":
        sys.exit(3)
    if req.get("query") == "fail":
        say(event="error", message="It failed.")
    else:
        say(event="result", request=req)
"""


class RetrievalWorkerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        worker = Path(tmp.name) / "worker.py"
        worker.write_text(FAKE_WORKER, encoding="utf-8")
        patcher = mock.patch.object(server, "MDSEARCH_PATH", worker)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.worker = server.RetrievalWorker()
        self.addCleanup(self.stop_worker)

    def stop_worker(self):
        self.worker.idle_timer.cancel()
        self.worker._stop(self.worker.proc)

    def test_requests(self):
        statuses = []
        self.assertEqual(self.worker.call({"query": "a"}, statuses.append), {"request": {"query": "a"}})
        self.assertEqual(statuses, ["Reading notes …"])
        with self.assertRaisesRegex(RuntimeError, "It failed."):
            self.worker.call({"query": "fail"})
        first = self.worker.proc
        self.worker.call({"query": "b"})
        self.assertIs(self.worker.proc, first)  # the same worker throughout
        with self.assertRaisesRegex(RuntimeError, "stopped unexpectedly \\(exit code 3\\)"):
            self.worker.call({"query": "exit"})
        self.assertEqual(self.worker.call({"query": "c"}), {"request": {"query": "c"}})  # a new one


class TagSuggestionTests(SettingsTestCase):
    def setUp(self):
        super().setUp()
        server._file_cache.clear()
        server._last_index_json.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = str(Path(self.tmp.name).resolve())
        self.set_settings(vaultPath=self.vault)
        (Path(self.vault) / "z_notes").mkdir()
        for name, text in [
            ("a.md", "About trade. #Merchants #trade"),
            ("b.md", "---\ntags: [religion]\n---\nChurches."),
            ("z_notes/c.md", "No tags yet."),
        ]:
            (Path(self.vault) / name).write_text(text, encoding="utf-8")

    def test_document_request(self):
        targets, note_tags = server.tag_suggestion_request(
            self.vault, {"path": f"{self.vault}/z_notes/c.md", "text": "Draft #trade\n"}
        )
        self.assertEqual(note_tags, {"a.md": ["Merchants", "trade"], "b.md": ["religion"]})
        self.assertEqual(
            targets, [{"file": "z_notes/c.md", "text": "Draft #trade\n", "existing": ["trade"]}]
        )

    def test_notes_request(self):
        targets, _ = server.tag_suggestion_request(
            self.vault, {"paths": [f"{self.vault}/z_notes/c.md"]}
        )
        self.assertEqual(targets, [{"file": "z_notes/c.md", "text": "No tags yet."}])

    def test_z_output_left_out(self):
        (Path(self.vault) / "z_output").mkdir()
        (Path(self.vault) / "z_output" / "draft.md").write_text("Chapter. #structure", encoding="utf-8")
        (Path(self.vault) / "z_output" / "plain.md").write_text("Untagged chapter.", encoding="utf-8")
        targets, note_tags = server.tag_suggestion_request(
            self.vault,
            {"paths": [f"{self.vault}/z_output/plain.md", f"{self.vault}/z_notes/c.md"]},
        )
        self.assertNotIn("z_output/draft.md", note_tags)
        self.assertEqual([t["file"] for t in targets], ["z_notes/c.md"])

    def test_outside_vault_rejected(self):
        with self.assertRaises(PermissionError):
            server.tag_suggestion_request(self.vault, {"paths": ["/etc/hosts"]})


class ParseJsonListTests(unittest.TestCase):
    def test_shapes(self):
        item = {"original": "a", "suggestion": "b", "comment": ""}
        self.assertEqual(server.parse_json_list('["x"]'), ["x"])
        self.assertEqual(server.parse_json_list('```json\n["x"]\n```'), ["x"])
        self.assertEqual(server.parse_json_list('Here you go: ["x"] done'), ["x"])
        self.assertEqual(server.parse_json_list('{"items": ["x"]}'), ["x"])
        self.assertEqual(server.parse_json_list(json.dumps(item)), [item])

    def test_no_list(self):
        self.assertIsNone(server.parse_json_list("No suggestions."))
        self.assertIsNone(server.parse_json_list('{"a": 1}'))

    def test_parse_suggestions(self):
        self.assertEqual(server._parse_suggestions("[]"), [])
        with self.assertRaisesRegex(RuntimeError, "expected format: Looks fine to me"):
            server._parse_suggestions("Looks fine to me")


if __name__ == "__main__":
    unittest.main()
