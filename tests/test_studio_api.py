"""HTTP integration tests using isolated material and drawing storage."""
from __future__ import annotations

import contextlib
import http.client
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import drawing_service
import store
from test_drawing_service import png, pdf


class QuietHandler(app.Handler):
    def log_message(self, *args):
        pass


class StudioApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="studio-api-test-")
        cls.root = Path(cls.temporary.name)
        cls.patches = [
            mock.patch.object(store, "DATA_DIR", str(cls.root / "materials")),
            mock.patch.object(store, "DB_PATH", str(cls.root / "materials" / "test.db")),
            mock.patch.object(drawing_service, "DATA_DIR", cls.root / "drawings"),
        ]
        for patch in cls.patches:
            patch.start()
        store.init_db()
        cls.server = app.Server(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        for patch in reversed(cls.patches):
            patch.stop()
        cls.temporary.cleanup()

    def request(self, method, path, content=None, headers=None, timeout=20):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            connection.request(method, path, body=content, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def json_request(self, method, path, payload=None):
        raw = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        status, headers, body = self.request(method, path, raw, {"Content-Type": "application/json"})
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        return status, json.loads(body)

    def upload(self, content, name="中文平面图.png"):
        status, _, body = self.request("POST", "/api/drawings?name=" + urllib.parse.quote(name), content,
                                       {"Content-Type": "application/octet-stream"})
        payload = json.loads(body)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"])
        return payload["data"]

    def test_home_studio_and_legacy_routes_preserve_both_interfaces(self):
        home = self.request("GET", "/")
        self.assertEqual(home[0], 200)
        self.assertIn(b"/studio/app.js", home[2])
        self.assertEqual(self.request("GET", "/studio")[2], home[2])
        self.assertEqual(self.request("GET", "/studio/")[2], home[2])
        legacy = self.request("GET", "/legacy")
        self.assertEqual(legacy[0], 200)
        self.assertIn(b'data-view="quotes"', legacy[2])
        self.assertIn(b'href="/studio"', legacy[2])
        self.assertEqual(self.request("GET", "/index.html")[2], legacy[2])
        self.assertEqual(self.request("GET", "/studio/studio.css")[0], 200)

    def test_existing_material_stats_and_quote_apis_still_work(self):
        status, result = self.json_request("GET", "/api/stats")
        self.assertEqual(status, 200)
        self.assertTrue(result["ok"])
        self.assertIn("materials", result["data"])
        status, result = self.json_request("GET", "/api/materials")
        self.assertEqual(status, 200)
        self.assertTrue(result["data"])
        status, result = self.json_request("POST", "/api/quotes", {
            "title": "HTTP兼容测试", "items": [{"name": "材料", "unit": "m²", "qty": 2,
                                                   "unit_price": 100, "loss_rate": 0}],
            "tax_rate": 0, "labor": 0, "freight": 0, "other_fee": 0})
        self.assertEqual(status, 200, result)
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["total"], 200)

    @unittest.skipUnless(sys.platform == "win32", "Real Windows image decoding is required")
    def test_real_png_upload_asset_and_recognition_roundtrip(self):
        metadata = self.upload(png(rectangles=((20, 20, 220, 160),)))
        self.assertEqual(metadata["name"], "中文平面图.png")
        status, headers, body = self.request("GET", metadata["url"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(drawing_service._image_header(body)[1:], (metadata["width"], metadata["height"]))
        status, result = self.json_request("POST", f"/api/drawings/{metadata['id']}/recognize", {"page": 1})
        self.assertEqual(status, 200, result)
        self.assertEqual(len(result["data"]["candidates"]), 1)
        self.assertTrue(result["data"]["requires_confirmation"])

    @unittest.skipUnless(sys.platform == "win32", "Real Windows PDF rendering is required")
    def test_real_pdf_upload_and_second_page_render(self):
        metadata = self.upload(pdf(), "两页图纸.pdf")
        self.assertEqual(metadata["pages"], 2)
        status, result = self.json_request("POST", f"/api/drawings/{metadata['id']}/page", {"page": 2})
        self.assertEqual(status, 200, result)
        page = result["data"]
        self.assertEqual(page["page"], 2)
        self.assertAlmostEqual(page["width"] / page["height"], 2, places=2)
        status, headers, body = self.request("GET", page["url"])
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(drawing_service._image_header(body)[1:], (page["width"], page["height"]))
        status, result = self.json_request("POST", f"/api/drawings/{metadata['id']}/page", {"page": 3})
        self.assertEqual(status, 400)
        self.assertFalse(result["ok"])

    def test_upload_and_drawing_input_errors_return_400(self):
        status, _, body = self.request("POST", "/api/drawings?name=fake.png", b"<svg>not png</svg>")
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(body)["ok"])
        for payload in ([], {"page": 0}, {"page": 1.5}, {"threshold": 1000}):
            status, result = self.json_request("POST", "/api/drawings/" + "a" * 32 + "/recognize", payload)
            self.assertEqual(status, 400, result)
            self.assertFalse(result["ok"])
        status, _, body = self.request("POST", "/api/drawings/" + "a" * 32 + "/page", b"{")
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(body)["ok"])
        status, _, body = self.request("GET", "/api/drawings/" + "a" * 32 + "/assets/metadata.json")
        self.assertEqual(status, 400)
        self.assertFalse(json.loads(body)["ok"])

    def test_declared_oversized_or_invalid_body_is_rejected_without_reading_it(self):
        for length in (str(drawing_service.MAX_UPLOAD_BYTES + 1), "-1", "not-a-number", "9" * 5000):
            status, _, body = self.request("POST", "/api/drawings?name=large.png", b"x",
                                           {"Content-Length": length}, timeout=2)
            self.assertEqual(status, 400)
            self.assertFalse(json.loads(body)["ok"])

    def test_decoded_static_paths_cannot_escape_to_a_sibling_with_matching_prefix(self):
        root = self.root / "static"
        sibling = self.root / "static_extra"
        root.mkdir(exist_ok=True)
        sibling.mkdir(exist_ok=True)
        (sibling / "secret.txt").write_text("must not be served", encoding="utf-8")
        with mock.patch.object(app, "STATIC_DIR", str(root)):
            for path in ("/%2e%2e/static_extra/secret.txt", "/..%5Cstatic_extra%5Csecret.txt", "/C:%5CWindows%5Cwin.ini"):
                self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("GET", "/%00")[0], 400)
        self.assertEqual(self.request("GET", "/%FF")[0], 400)

    def test_startup_flag_disables_background_updates_and_default_still_enables_them(self):
        class DummyServer:
            def __init__(self, *args):
                pass

            def serve_forever(self):
                raise KeyboardInterrupt

            def server_close(self):
                pass

        for disabled in (True, False):
            arguments = ["app.py", "--no-browser"] + (["--no-auto-update"] if disabled else [])
            with mock.patch.object(sys, "argv", arguments), mock.patch.object(app, "Server", DummyServer), \
                    mock.patch.object(app, "port_in_use", return_value=False), mock.patch.object(store, "init_db"), \
                    mock.patch.object(app.autoupdate, "start_background") as background, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(app.main(), 0)
                self.assertEqual(background.call_count, 0 if disabled else 1)


if __name__ == "__main__":
    unittest.main()
