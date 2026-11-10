"""Desktop lifecycle regression checks; no user directories are touched."""
import contextlib
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "desktop" / "studio_launcher.py"
spec = importlib.util.spec_from_file_location("studio_launcher", SCRIPT)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class DesktopLauncherTests(unittest.TestCase):
    def test_deliberate_origin_survives_restart_and_invalid_config_does_not_change_it(self):
        with tempfile.TemporaryDirectory(prefix="desktop-port-") as temporary:
            directory = Path(temporary)
            self.assertEqual(launcher.configured_port(directory, None), 18770)
            self.assertEqual(launcher.configured_port(directory, 19555), 19555)
            self.assertEqual(launcher.configured_port(directory, None), 19555)
            for bad in (0, 65536, True, "18770"):
                with self.assertRaises(ValueError):
                    launcher.configured_port(directory, bad)
                self.assertEqual(launcher.configured_port(directory, None), 19555)

    def test_instance_lock_cannot_be_owned_by_two_hosts_and_releases_on_close(self):
        with tempfile.TemporaryDirectory(prefix="desktop-lock-") as temporary:
            directory = Path(temporary)
            first, second = launcher.InstanceLock(directory), launcher.InstanceLock(directory)
            try:
                self.assertTrue(first.acquire())
                self.assertFalse(second.acquire())
                first.close()
                self.assertTrue(second.acquire())
            finally:
                first.close()
                second.close()

    def test_distribution_application_is_resolved_without_developer_paths(self):
        with tempfile.TemporaryDirectory(prefix="desktop-program-") as temporary:
            root = Path(temporary)
            (root / "app").mkdir()
            (root / "app" / "app.py").write_text("", encoding="utf-8")
            package_root, application = launcher.application_directory(root)
            self.assertEqual(package_root, root.resolve())
            self.assertEqual(application, root.resolve() / "app")
            with self.assertRaises(RuntimeError):
                launcher.application_directory(root / "missing")

    def test_http_host_single_instance_authorization_shutdown_and_persistent_database(self):
        with tempfile.TemporaryDirectory(prefix="desktop-host-") as temporary:
            directory = Path(temporary)
            log = open(directory / "process.log", "wb")
            with contextlib.closing(socket.socket()) as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            url = f"http://127.0.0.1:{port}"
            arguments = [sys.executable, "-I", "-X", "utf8", str(SCRIPT),
                         "--data-dir", str(directory), "--port", str(port), "--serve-only"]
            process = None

            def start(args):
                child = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=log,
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        self.fail((directory / "process.log").read_text(encoding="utf-8"))
                    try:
                        health = launcher.local_request(url + "/__desktop/health")
                        self.assertEqual(health["product"], "planmatter-desktop")
                        self.assertEqual(health["storage"], launcher.storage_identity(directory))
                        return child
                    except (OSError, urllib.error.URLError):
                        time.sleep(.1)
                child.terminate()
                child.wait(timeout=5)
                self.fail("Desktop host did not become ready")

            def stop(child):
                state = json.loads((directory / "desktop-state.json").read_text(encoding="utf-8"))
                self.assertTrue(launcher.local_request(url + "/__desktop/shutdown", state["token"])["ok"])
                self.assertEqual(child.wait(timeout=5), 0)
                self.assertFalse((directory / "desktop-state.json").exists())

            try:
                process = start(arguments)
                state = json.loads((directory / "desktop-state.json").read_text(encoding="utf-8"))
                database = directory / "data" / "app.db"
                self.assertTrue(database.is_file())
                self.assertEqual(state["url"], url)
                with self.assertRaises(urllib.error.HTTPError) as unauthorized:
                    launcher.local_request(url + "/__desktop/shutdown", "invalid-session")
                self.assertEqual(unauthorized.exception.code, 403)
                self.assertIsNone(process.poll())
                duplicate = subprocess.run(arguments, cwd=ROOT, stdout=log, stderr=log, timeout=15,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self.assertEqual(duplicate.returncode, 0)
                self.assertIsNone(process.poll())
                self.assertEqual(json.loads((directory / "desktop-state.json").read_text(encoding="utf-8"))["pid"], process.pid)
                stop(process)
                process = None
                # Record a real SQLite value between launches. The application
                # must reopen the same user directory rather than a seed copy.
                import sqlite3
                with contextlib.closing(sqlite3.connect(database)) as connection:
                    connection.execute("INSERT INTO settings(key,value) VALUES('desktop-regression','kept')")
                    connection.commit()
                process = start(arguments[:-3] + ["--serve-only"])
                self.assertEqual(json.loads((directory / "desktop-config.json").read_text(encoding="utf-8"))["port"], port)
                with contextlib.closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(connection.execute("SELECT value FROM settings WHERE key='desktop-regression'").fetchone()[0], "kept")
                stop(process)
                process = None
            finally:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                log.close()


if __name__ == "__main__":
    unittest.main()
