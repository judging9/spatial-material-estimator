"""Windows desktop host for the measured 2D/3D material estimator.

The packaged application uses its own browser profile and a fixed loopback
origin. Program updates therefore do not move or erase local projects.
"""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

PRODUCT_NAME = "空间材料估算"
PRODUCT_ID = "planmatter-desktop"
VERSION = "1.3.0"
DEFAULT_PORT = 18770


def application_directory(root: Path | None = None) -> tuple[Path, Path]:
    """Locate only the application shipped beside this launcher."""
    if root is not None:
        root = root.resolve()
        application = root / "app" if (root / "app" / "app.py").is_file() else root
    else:
        script = Path(__file__).resolve()
        application = script.parent if (script.parent / "app.py").is_file() else script.parent.parent
        root = script.parent.parent if application == script.parent else application
    if not (application / "app.py").is_file():
        raise RuntimeError("程序文件不完整，请重新解压完整软件目录。")
    return root, application


def default_data_directory() -> Path:
    configured = os.environ.get("PLANMATTER_DATA_DIR")
    if configured:
        return Path(configured).resolve()
    local = os.environ.get("LOCALAPPDATA")
    return (Path(local) / "PlanMatter" if local else Path.home() / ".planmatter").resolve()


def configure_output(directory: Path) -> None:
    logs = directory / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None:
        sys.stdout = open(logs / "desktop.log", "a", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = sys.stdout


def configured_port(directory: Path, requested: int | None) -> int:
    config_file = directory / "desktop-config.json"
    config = {}
    if config_file.is_file():
        try:
            config = json.loads(config_file.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            raise RuntimeError("本地启动配置无法读取，请检查 desktop-config.json 或联系技术支持。")
    port = requested if requested is not None else config.get("port", DEFAULT_PORT)
    if isinstance(port, bool) or not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("本地服务端口必须为 1024–65535。")
    # Persist deliberate port changes; never silently choose a random origin.
    if config.get("port") != port:
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / "desktop-config.tmp"
        temporary.write_text(json.dumps({"port": port}, indent=2), encoding="utf-8")
        temporary.replace(config_file)
    return port


class InstanceLock:
    def __init__(self, directory: Path):
        self.path = directory / "desktop.lock"
        self.file = None

    def acquire(self) -> bool:
        self.file = open(self.path, "a+b")
        if os.fstat(self.file.fileno()).st_size == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            self.file.close()
            self.file = None
            return False

    def close(self) -> None:
        if self.file is not None:
            self.file.close()
            self.file = None


def storage_identity(directory: Path) -> str:
    return hashlib.sha256(os.path.normcase(str(directory.resolve())).encode("utf-8")).hexdigest()[:24]


def local_request(url: str, token: str | None = None) -> dict:
    request = urllib.request.Request(url, data=b"{}" if token else None,
                                     headers={"X-PlanMatter-Token": token} if token else {})
    # Local readiness must not be redirected through a corporate HTTP proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=.6) as response:
        return json.loads(response.read().decode("utf-8"))


def activate_existing(directory: Path, port: int) -> bool:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        try:
            state = json.loads((directory / "desktop-state.json").read_text(encoding="utf-8"))
            url = f"http://127.0.0.1:{port}"
            health = local_request(url + "/__desktop/health")
            if health.get("product") != PRODUCT_ID or health.get("storage") != storage_identity(directory):
                return False
            return bool(local_request(url + "/__desktop/activate", state["token"]).get("ok"))
        except (OSError, ValueError, KeyError, urllib.error.URLError):
            time.sleep(.2)
    return False


def find_browser(explicit: Path | None = None) -> Path:
    if explicit:
        if explicit.is_file():
            return explicit.resolve()
        raise RuntimeError("指定的浏览器程序不存在。")
    candidates = []
    for variable in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if base:
            candidates.extend((Path(base) / "Microsoft/Edge/Application/msedge.exe",
                               Path(base) / "Google/Chrome/Application/chrome.exe"))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError("未找到 Microsoft Edge 或 Google Chrome。请安装其中一个浏览器后启动软件。")


def focus_browser(process_id: int) -> bool:
    if os.name != "nt":
        return False
    from ctypes import wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    found = []
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]

    @callback_type
    def visit(window, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        if pid.value == process_id and user32.IsWindowVisible(window):
            found.append(window)
        return True

    user32.EnumWindows(visit, 0)
    if found:
        user32.ShowWindow(found[0], 9)  # SW_RESTORE
        user32.SetForegroundWindow(found[0])
    return bool(found)


class DesktopHost:
    def __init__(self, application: Path, directory: Path, port: int):
        sys.path.insert(0, str(application))
        import app
        self.app = app
        self.directory = directory
        self.url = f"http://127.0.0.1:{port}"
        self.identity = storage_identity(directory)
        self.token = secrets.token_urlsafe(32)
        self.stop = threading.Event()
        self.activation = threading.Event()
        self.browser = None
        self.browser_path = None
        self.server = None
        self.server_thread = None
        app.store.DATA_DIR = str(directory / "data")
        app.store.DB_PATH = str(directory / "data" / "app.db")
        app.drawing_service.DATA_DIR = directory / "data" / "drawings"
        app.store.init_db()
        host = self

        class DesktopHandler(app.Handler):
            server_version = "PlanMatter/" + VERSION

            def _dispatch(self, method, path):
                if path == "/__desktop/health" and method == "GET":
                    self.send_json({"ok": True, "product": PRODUCT_ID, "name": PRODUCT_NAME,
                                    "version": VERSION, "storage": host.identity, "url": host.url})
                    return
                if path in ("/__desktop/activate", "/__desktop/shutdown") and method == "POST":
                    if not secrets.compare_digest(self.headers.get("X-PlanMatter-Token", ""), host.token):
                        self.send_json({"ok": False, "error": "启动会话无效。"}, 403)
                        return
                    (host.activation if path.endswith("activate") else host.stop).set()
                    self.send_json({"ok": True})
                    return
                super()._dispatch(method, path)

        try:
            self.server = app.Server(("127.0.0.1", port), DesktopHandler)
        except OSError as error:
            raise RuntimeError(f"本地端口 {port} 已被其他程序占用。请关闭占用程序后重试；软件不会自动更换地址，以免影响已保存项目。") from error

    def start(self) -> None:
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.write_state()
        print(json.dumps({"ready": True, "name": PRODUCT_NAME, "version": VERSION,
                          "url": self.url, "data_dir": str(self.directory)}, ensure_ascii=False), flush=True)

    def write_state(self) -> None:
        state = {"product": PRODUCT_ID, "version": VERSION, "pid": os.getpid(),
                 "url": self.url, "token": self.token, "storage": self.identity}
        if self.browser:
            state["browser_pid"] = self.browser.pid
        temporary = self.directory / "desktop-state.tmp"
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.directory / "desktop-state.json")

    def open_browser(self, browser: Path, *, headless: bool = False) -> None:
        self.browser_path = browser
        profile = self.directory / "browser-profile"
        profile.mkdir(parents=True, exist_ok=True)
        command = [
            str(browser), self.url if headless else "--app=" + self.url, "--user-data-dir=" + str(profile),
            "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
            "--disable-features=msStartupBoost,msEdgeBackgroundMode", "--window-size=1440,960",
        ]
        if headless:
            # Headless Chromium needs a regular page target; --app creates a
            # native window and may exit immediately without a visible desktop.
            # This opt-in verification mode matches the existing browser tests.
            command.extend(("--headless=new", "--remote-debugging-port=0", "--no-sandbox"))
        self.browser = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.write_state()

    def run(self) -> None:
        while not self.stop.wait(.25):
            if self.activation.is_set():
                self.activation.clear()
                if self.browser and self.browser.poll() is None:
                    focus_browser(self.browser.pid)
            if self.browser:
                exit_code = self.browser.poll()
                if exit_code is not None:
                    if exit_code != 0:
                        raise RuntimeError(f"软件窗口意外退出（代码 {exit_code}）。请查看运行日志，或关闭残留的 Edge/Chrome 软件窗口后重试。")
                    break

    def close(self) -> None:
        if self.browser and self.browser.poll() is None:
            # Administrative shutdown is restricted to this launch session.
            # Release its dedicated profile as well as the loopback server.
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                self.browser.terminate()
                self.browser.wait(timeout=5)
        if self.server:
            if self.server_thread:
                self.server.shutdown()
                self.server_thread.join(timeout=3)
            self.server.server_close()
        state = self.directory / "desktop-state.json"
        with contextlib.suppress(OSError, ValueError):
            if json.loads(state.read_text(encoding="utf-8")).get("token") == self.token:
                state.unlink()


def self_test(application: Path, directory: Path) -> int:
    import ssl
    import sqlite3
    import requests
    import openpyxl
    import numpy
    host = DesktopHost(application, directory, 0)
    # The self-test is isolated and may use an OS-selected port; user launches
    # always use their persistent configured port.
    host.url = f"http://127.0.0.1:{host.server.server_address[1]}"
    try:
        host.start()
        health = local_request(host.url + "/__desktop/health")
        assert health["storage"] == storage_identity(directory)
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(host.url + "/", timeout=3) as response:
            assert response.status == 200 and b"drawing-canvas" in response.read()
        with contextlib.closing(sqlite3.connect(host.app.store.DB_PATH)) as connection:
            assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        runtime = application.parent / "runtime"
        isolated = None
        if runtime.is_dir():
            allowed = (runtime.resolve(), application.resolve())
            isolated = all(any(Path(entry).resolve().is_relative_to(root) for root in allowed)
                           for entry in sys.path)
            assert isolated, "The packaged interpreter loaded a path outside the application."
        print(json.dumps({"self_test": "passed", "product": PRODUCT_ID, "version": VERSION,
                          "python": sys.version.split()[0], "executable": sys.executable,
                          "prefix": sys.prefix, "base_prefix": sys.base_prefix,
                          "sys_path": sys.path, "path_isolation_verified": isolated,
                          "dependencies": {"requests": requests.__version__, "openpyxl": openpyxl.__version__,
                                           "numpy": numpy.__version__}}, ensure_ascii=False), flush=True)
        return 0
    finally:
        host.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=PRODUCT_NAME)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--port", type=int)
    parser.add_argument("--browser-path", type=Path)
    parser.add_argument("--headless-browser", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--serve-only", "--no-browser", action="store_true", dest="serve_only")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    _, application = application_directory(args.root)
    if args.self_test:
        if args.data_dir:
            directory = args.data_dir.resolve()
            directory.mkdir(parents=True, exist_ok=True)
            configure_output(directory)
            return self_test(application, directory)
        with tempfile.TemporaryDirectory(prefix="planmatter-check-") as temporary:
            directory = Path(temporary)
            configure_output(directory)
            return self_test(application, directory)
    directory = args.data_dir.resolve() if args.data_dir else default_data_directory()
    directory.mkdir(parents=True, exist_ok=True)
    configure_output(directory)
    lock = InstanceLock(directory)
    acquired = lock.acquire()
    if not acquired:
        # Read the established config only; a second invocation must not change
        # the running instance's origin or overwrite its ready state.
        config = json.loads((directory / "desktop-config.json").read_text(encoding="utf-8"))
        if args.port is not None and args.port != config["port"]:
            raise RuntimeError("软件已运行。请先关闭软件再更改本地端口。")
        if activate_existing(directory, config["port"]):
            print("软件已运行，已恢复原窗口。", flush=True)
            return 0
        raise RuntimeError("软件正在启动或已有实例未能响应。请稍后重试，或查看运行日志。")
    host = None
    try:
        port = configured_port(directory, args.port)
        browser = None if args.serve_only else find_browser(args.browser_path)
        host = DesktopHost(application, directory, port)
        host.start()
        if browser:
            host.open_browser(browser, headless=args.headless_browser)
        host.run()
        return 0
    except KeyboardInterrupt:
        return 0
    finally:
        if host:
            host.close()
        lock.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        if sys.stderr is not None:
            print(f"{PRODUCT_NAME}：{error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
