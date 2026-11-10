"""Build an offline Windows x64 distribution from the installed Python runtime.

No downloads or system-wide changes are performed. The complete dist directory
includes a bundled interpreter and a system-Python compatibility fallback. Rebuilding
overwrites shipped program files but preserves dist/data and dist/logs.

SPDX-License-Identifier: GPL-3.0-or-later
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys

PACKAGING = Path(__file__).resolve().parent
DESKTOP = PACKAGING.parent
WORKSPACE = DESKTOP.parent
DEFAULT_OUTPUT = DESKTOP / "dist"
DEPENDENCIES = (
    "requests", "openpyxl", "urllib3", "certifi", "charset-normalizer",
    "idna", "et-xmlfile",
)
ROOT_MODULES = ("store.py", "scrape.py", "excelio.py", "autoupdate.py")


def copy_tree(source: Path, destination: Path, ignored=()) -> None:
    shutil.copytree(source, destination, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", *ignored))


def copy_distribution(name: str, destination: Path) -> dict:
    distribution = importlib.metadata.distribution(name)
    source_root = Path(distribution.locate_file(""))
    files = distribution.files
    if not files:
        raise RuntimeError(f"Package has no installed file manifest: {name}")
    count = 0
    for package_file in files:
        relative = Path(str(package_file))
        if ".." in relative.parts or "__pycache__" in relative.parts:
            continue
        source = source_root / relative
        if source.is_file() and source.suffix != ".pyc":
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            count += 1
    return {"name": name, "version": distribution.version, "files": count}


def make_runtime(output: Path) -> list[dict]:
    prefix = Path(sys.base_prefix)
    runtime = output / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    for filename in (
        "python.exe", "pythonw.exe", "python3.dll", "python311.dll",
        "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt",
    ):
        source = prefix / filename
        if not source.is_file():
            raise RuntimeError(f"Required runtime component missing: {source}")
        shutil.copy2(source, runtime / filename)
    copy_tree(prefix / "DLLs", runtime / "DLLs", ("_test*", "*_test*", "*.cat"))
    copy_tree(prefix / "Lib", runtime / "Lib",
              ("site-packages", "test", "tests", "idlelib", "ensurepip", "turtledemo"))
    copy_tree(prefix / "tcl", runtime / "tcl", ("*.lib", "nmake"))
    packages = runtime / "Lib" / "site-packages"
    packages.mkdir(parents=True, exist_ok=True)
    manifest = [copy_distribution(name, packages) for name in DEPENDENCIES]
    # _pth disables registry/env path discovery and isolates this distribution.
    (runtime / "python311._pth").write_text(
        "Lib\nDLLs\nLib/site-packages\n../app\nimport site\n", encoding="utf-8")
    (output / "PYTHON-LICENSE.txt").write_bytes((prefix / "LICENSE.txt").read_bytes())
    return manifest


def make_application(output: Path) -> None:
    application = output / "app"
    application.mkdir(parents=True, exist_ok=True)
    for source in DESKTOP.glob("*.py"):
        if not source.name.startswith("test_"):
            shutil.copy2(source, application / source.name)
    for filename in ROOT_MODULES:
        source = WORKSPACE / filename
        if source.is_file():
            shutil.copy2(source, application / filename)
    seed = DESKTOP / "seed.db"
    if seed.is_file():
        shutil.copy2(seed, application / "seed.db")
    sample = DESKTOP / "sample.estimate.json"
    if sample.is_file():
        shutil.copy2(sample, output / sample.name)
    # Ship the exact launcher source, build script and workflow tests as well.
    source_root = output / "source" / "project"
    source_desktop = source_root / "desktop"
    source_packaging = source_desktop / "packaging"
    source_packaging.mkdir(parents=True, exist_ok=True)
    for filename in ("launcher.c", "build_portable.py", "start_desktop.bat"):
        shutil.copy2(PACKAGING / filename, source_packaging / filename)
    for source in DESKTOP.glob("*.py"):
        shutil.copy2(source, source_desktop / source.name)
    for filename in ROOT_MODULES:
        shutil.copy2(WORKSPACE / filename, source_root / filename)
    for filename in ("LICENSE", "NOTICE.md", "README.md", "使用说明.md", "seed.db", "sample.estimate.json"):
        source = DESKTOP / filename
        if source.is_file():
            shutil.copy2(source, source_desktop / filename)
    for directory in ("assets",):
        source = DESKTOP / directory
        if source.is_dir():
            copy_tree(source, application / directory)
    docs = DESKTOP / "docs"
    if docs.is_dir():
        copy_tree(docs, output / "docs")
    for source in DESKTOP.iterdir():
        if source.is_file() and (source.suffix.lower() in (".md", ".txt")
                                 or source.name.upper() in ("COPYING", "LICENSE")):
            shutil.copy2(source, output / source.name)
    instructions = output / "启动应用.bat"
    instructions.write_text(
        '@echo off\nsetlocal\ncd /d "%~dp0"\nset "MATERIAL_QUOTE_HOME=%~dp0"\n'
        'where pythonw.exe >nul 2>nul\nif errorlevel 1 goto packaged\n'
        'start "" pythonw.exe "%~dp0app\\main.py" %*\nexit /b 0\n'
        ':packaged\n"%~dp0' + '材料报价.exe' + '" %*\n',
        encoding="gbk", newline="\r\n")
    source_license = WORKSPACE / "GEstimator-2.7" / "GEstimator-2.7" / "LICENSE"
    if source_license.is_file():
        shutil.copy2(source_license, output / "GEstimator-LICENSE.txt")
    # Python Tkinter iconbitmap can use this existing upstream application icon.
    icon = WORKSPACE / "GEstimator-2.7" / "GEstimator-2.7" / "GEstimator.ico"
    if icon.is_file():
        shutil.copy2(icon, application / "GEstimator.ico")


def make_launcher(output: Path) -> None:
    gcc = shutil.which("gcc")
    if not gcc:
        raise RuntimeError("gcc is required to compile the Windows launcher")
    subprocess.run([
        gcc, "-municode", "-mwindows", "-O2", "-static-libgcc",
        str(PACKAGING / "launcher.c"), "-o", str(output / "材料报价.exe"),
    ], check=True)


def verify_runtime(output: Path) -> None:
    code = (
        "import sys, tkinter, sqlite3, decimal, ssl, requests, openpyxl; "
        "from pathlib import Path; "
        "assert Path(sys.prefix).resolve() == Path(sys.executable).resolve().parent; "
        "r=tkinter.Tk(); r.withdraw(); r.update(); r.destroy(); "
        "print('Portable runtime OK:', sys.version.split()[0]); "
        "print('Executable:', sys.executable); print('Paths:', sys.path)"
    )
    subprocess.run([str(output / "runtime" / "python.exe"), "-c", code], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--refresh-app", action="store_true",
                        help="Refresh application files only after UI changes")
    parser.add_argument("--self-test", action="store_true",
                        help="Also execute the application's --self-test")
    parser.add_argument("--allow-system-fallback", action="store_true",
                        help="Keep the bundle if managed Windows blocks DLL startup; verify launcher fallback")
    args = parser.parse_args()
    output = args.output.resolve()
    # Writes are restricted to the one known distributable tree.
    if output != DEFAULT_OUTPUT.resolve():
        raise SystemExit("Output must be desktop/dist within this workspace")
    output.mkdir(parents=True, exist_ok=True)
    packages = None
    if not args.refresh_app:
        if sys.version_info[:2] != (3, 11) or sys.platform != "win32":
            raise SystemExit("Build requires the installed Windows Python 3.11 runtime")
        packages = make_runtime(output)
        make_launcher(output)
    make_application(output)
    if packages is not None:
        manifest = {"python": sys.version, "architecture": "Windows x64",
                    "packages": packages, "source": "local installed runtime"}
        (output / "BUILD-MANIFEST.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    validation = {"bundled_runtime": False, "launcher_self_test": None}
    try:
        verify_runtime(output)
        validation["bundled_runtime"] = True
    except subprocess.CalledProcessError:
        if not args.allow_system_fallback:
            raise
        validation["limitation"] = "DLL initialization fails for newly launched executables in the managed build environment; target Windows startup remains unverified."
        print("Bundled process DLL startup blocked in this environment; target startup remains unverified.")
    (output / "VALIDATION.json").write_text(
        json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.self_test:
        result = subprocess.run([str(output / "材料报价.exe"), "--self-test"])
        validation["launcher_self_test"] = result.returncode == 0
        validation["launcher_exit_code"] = result.returncode
        (output / "VALIDATION.json").write_text(
            json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
        result.check_returncode()
    print(f"Built: {output / '材料报价.exe'}")
    print("Copy the complete dist directory, including its bundled Python runtime.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
