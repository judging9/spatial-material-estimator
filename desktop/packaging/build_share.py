"""Create a Windows test-sharing archive with a fresh public template database.

The personal distribution and all user data are read only. GPL-3.0-or-later.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import zipfile

PACKAGING = Path(__file__).resolve().parent
DESKTOP = PACKAGING.parent
WORKSPACE = DESKTOP.parent
sys.path.insert(0, str(WORKSPACE))
import store

ARCHIVE_NAME = "material-quote-share-windows-test.zip"
SEED_LOCATIONS = {"app/seed.db", "source/project/desktop/seed.db"}

INSTRUCTIONS = """# 材料报价桌面版 · Windows 测试分享版

## 对方怎么启动

1. 将整个压缩包解压到可写的文件夹，例如桌面。不要直接在压缩包里运行。
2. 双击“启动分享版.bat”，它会检查并选择可用运行环境。
3. 软件会在解压目录的 data 中创建自己的材料库和工程文件。

包内提供 Python/Tk 和 Excel、网络依赖。独立运行时与 exe 在当前受限构建环境中未通过启动验证，因此暂不承诺对方无需安装 Python。

稳妥的测试方式是让对方使用 64 位 Windows 10/11，并安装含 Tcl/Tk 的 64 位 Python 3.11 或 3.12。可以从 https://www.python.org/downloads/windows/ 下载，安装时启用 Python Launcher 或 Add Python to PATH。启动器会使用包内依赖，不需要另行 pip 安装 requests/openpyxl。

如果打不开，请查看 logs/startup.log；启动器会显示运行环境错误提示。

## 包里有什么

中文材料库、价格历史、单价分析、工程量计算、工程保存、Excel 导出和 GEstimator .eproj 只读导入。sample.estimate.json 是示例工程，价格仅作演示。

本分享包使用新建的通用材料模板库，不包含分享者的实际报价、客户、供应商、价格记录、个人材料备注、抓取设置和运行日志。app/seed.db 与源码中的 seed.db 都已替换。

## 分享与修改

本软件依 GEstimator 源码适配，使用 GPL-3.0-or-later 许可。转发完整压缩包时保留 LICENSE、NOTICE.md 和 source/project 对应源码；修改后再分发时，也需要按 GPL 提供修改版的对应源码及许可证。

不应只发送单独的 exe，它需要同目录的程序和运行时文件。第一次请先让一位接收者在其电脑上试运行，确认启动、保存和 Excel 导出。

详细操作见“使用说明.md”。软件打开后的价格更新需要联网，本地材料维护与报价可离线使用。
"""


def public_seed(directory):
    previous = store.DATA_DIR, store.DB_PATH
    target = Path(directory) / "public-seed.db"
    try:
        store.DATA_DIR, store.DB_PATH = str(directory), str(target)
        store.init_db()
        with closing(sqlite3.connect(target)) as database:
            database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            database.execute("PRAGMA journal_mode=DELETE")
            counts = {table: database.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                      for table in ("materials", "prices", "quotes", "quote_items", "sources", "settings")}
            assert counts["materials"] == 16
            assert all(counts[table] == 0 for table in counts if table != "materials")
            assert database.execute("SELECT COUNT(*) FROM materials WHERE note != ''").fetchone()[0] == 0
            assert database.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return target.read_bytes(), counts
    finally:
        store.DATA_DIR, store.DB_PATH = previous


def build_share():
    distribution = DESKTOP / "dist"
    bootstrap = PACKAGING / "bootstrap.py"
    launcher = PACKAGING / "start_share.bat"
    for required in (distribution / "app" / "main.py", bootstrap, launcher):
        if not required.is_file():
            raise RuntimeError(f"Sharing component missing: {required.name}")
    # -I -S ensures success does not depend on the developer's site-packages.
    subprocess.run([sys.executable, "-I", "-S", "-X", "utf8", str(bootstrap),
                    "--root", str(distribution), "--probe"], check=True)
    subprocess.run([sys.executable, "-I", "-S", "-X", "utf8", str(bootstrap),
                    "--root", str(distribution), "--self-test"], check=True)
    # Known workspace temporary directory; no user folder is deleted or moved.
    with tempfile.TemporaryDirectory(prefix="share-build-", dir=PACKAGING) as temporary:
        seed, counts = public_seed(temporary)
    archive = DESKTOP / ARCHIVE_NAME
    copied_seeds = set()
    prefix = "material-quote-share"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for path in sorted(distribution.rglob("*")):
            if not path.is_file():
                continue
            if not path.resolve().is_relative_to(distribution.resolve()):
                raise RuntimeError("Distribution contains a file outside its directory")
            relative = path.relative_to(distribution)
            name = relative.as_posix()
            if relative.parts[0] in ("data", "logs") or "__pycache__" in relative.parts or path.suffix == ".pyc":
                continue
            if relative.parts[0] == "source" and (len(relative.parts) < 2 or relative.parts[1] != "project"):
                continue
            if name in ("启动应用.bat", "使用说明.md", "README.md",
                        "source/project/desktop/使用说明.md", "source/project/desktop/README.md"):
                continue
            if name in SEED_LOCATIONS:
                package.writestr(prefix + "/" + name, seed)
                copied_seeds.add(name)
            elif path.suffix in (".db", ".sqlite", ".sqlite3", ".eproj") or path.name.endswith(("-wal", "-shm")):
                continue
            elif path.name.endswith(".estimate.json") and path.name != "sample.estimate.json":
                continue
            else:
                package.write(path, prefix + "/" + name)
        assert copied_seeds == SEED_LOCATIONS
        package.write(bootstrap, prefix + "/bootstrap.py")
        package.write(launcher, prefix + "/启动分享版.bat")
        package.write(bootstrap, prefix + "/source/project/desktop/packaging/bootstrap.py")
        package.write(launcher, prefix + "/source/project/desktop/packaging/start_share.bat")
        package.write(Path(__file__), prefix + "/source/project/desktop/packaging/build_share.py")
        package.write(DESKTOP / "README.md", prefix + "/source/project/desktop/README.md")
        manual = (DESKTOP / "使用说明.md").read_text(encoding="utf-8")
        start = manual.index("## 启动")
        end = manual.index("## 做第一份报价")
        manual = manual[:start] + "## 启动\n\n请先阅读“先读我.md”，然后双击“启动分享版.bat”。首次运行创建的是通用材料模板库；各接收者的材料和工程数据保存在自己的 data 目录。\n\n" + manual[end:]
        for name in ("使用说明.md", "source/project/desktop/使用说明.md"):
            package.writestr(prefix + "/" + name, manual)
        package.writestr(prefix + "/先读我.md", INSTRUCTIONS)
        package.writestr(prefix + "/README.md", INSTRUCTIONS)
        audit = {"variant": "Windows test-sharing", "seed_counts": counts,
                 "user_data_included": False, "private_seed_replaced_in_app_and_source": True,
                 "bundled_executable_verified": False,
                 "installed_python_fallback_with_bundled_dependencies_verified": True,
                 "license": "GPL-3.0-or-later"}
        package.writestr(prefix + "/SHARE-VALIDATION.json", json.dumps(audit, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None
        for location in SEED_LOCATIONS:
            assert package.read(prefix + "/" + location) == seed
        assert not any("/data/" in name or "/logs/" in name for name in package.namelist())
    print("Share archive:", archive)
    print("Size MB:", round(archive.stat().st_size / 1024 / 1024, 2))
    print("Public seed counts:", counts)
    print("SHA256:", hashlib.sha256(archive.read_bytes()).hexdigest())
    return archive


if __name__ == "__main__":
    build_share()
