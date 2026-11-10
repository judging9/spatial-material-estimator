"""Offline entry point for the Windows test-sharing distribution.

Copy this file and start_share.bat into the distribution root alongside app/
and runtime/. Call with Python -I -S -X utf8. A system interpreter contributes
its own standard library, DLLs and Tk; application dependencies are loaded as
pure Python from the shipped site-packages tree. Nothing is installed.

SPDX-License-Identifier: GPL-3.0-or-later
"""
from __future__ import annotations

import argparse
import importlib
import importlib.abc
import importlib.util
import os
from pathlib import Path
import runpy
import struct
import sys
import traceback

PACKAGE_NAMES = frozenset({
    "requests", "openpyxl", "urllib3", "certifi", "charset_normalizer",
    "idna", "et_xmlfile",
})


class PurePythonPackages(importlib.abc.MetaPathFinder):
    """Prefer the included .py files over optional CPython-version-specific pyds."""

    def __init__(self, directory: Path):
        self.directory = directory

    def find_spec(self, fullname, path=None, target=None):
        parts = fullname.split(".")
        if parts[0] not in PACKAGE_NAMES:
            return None
        base = self.directory.joinpath(*parts)
        initializer = base / "__init__.py"
        if initializer.is_file():
            return importlib.util.spec_from_file_location(
                fullname, initializer, submodule_search_locations=[str(base)])
        module = base.with_suffix(".py")
        if module.is_file():
            return importlib.util.spec_from_file_location(fullname, module)
        return None


def configure(root: Path):
    if sys.platform != "win32":
        raise RuntimeError("This sharing distribution requires Windows.")
    if sys.version_info.major != 3 or sys.version_info.minor < 11:
        raise RuntimeError("Python 3.11 or newer is required.")
    if struct.calcsize("P") != 8:
        raise RuntimeError("A 64-bit Python installation is required.")
    application = root / "app"
    packages = root / "runtime" / "Lib" / "site-packages"
    if not (application / "main.py").is_file():
        raise RuntimeError(f"Application files are missing: {application}")
    if not packages.is_dir():
        raise RuntimeError(f"Included dependencies are missing: {packages}")
    # Never add the bundled stdlib or DLLs to a different Python interpreter.
    # -I -S also avoids importing arbitrary host sitecustomize/user packages.
    host_paths = [
        item for item in sys.path
        if "site-packages" not in Path(item).parts
        and "dist-packages" not in Path(item).parts
        and item not in (str(application), str(packages))
    ]
    sys.path[:] = [str(application), str(packages), *host_paths]
    sys.meta_path.insert(0, PurePythonPackages(packages))
    sys.dont_write_bytecode = True
    os.environ.setdefault("MATERIAL_QUOTE_HOME", str(root))
    return application, packages


def probe(packages: Path):
    import sqlite3
    import decimal
    import ctypes
    import ssl
    import tkinter
    # Ensure every dependency really comes from this distribution. Merely
    # succeeding on the developer's machine would hide missing library files.
    modules = [importlib.import_module(name) for name in sorted(PACKAGE_NAMES)]
    for module in modules:
        path = Path(module.__file__).resolve()
        if not path.is_relative_to(packages.resolve()):
            raise RuntimeError(f"Unexpected external dependency: {module.__name__}: {path}")
    for name in ("charset_normalizer.md", "charset_normalizer.cd"):
        module = importlib.import_module(name)
        if Path(module.__file__).suffix != ".py":
            raise RuntimeError(f"An optional compiled extension was loaded: {name}")
    window = tkinter.Tk()
    try:
        window.withdraw()
        window.update_idletasks()
    finally:
        window.destroy()
    return {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "packages": str(packages),
        "isolated": bool(sys.flags.isolated),
        "no_site": bool(sys.flags.no_site),
        "standard_library": str(Path(tkinter.__file__).parent.parent),
        "pure_python_dependencies": True,
    }


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--print-executable", action="store_true")
    args, application_args = parser.parse_known_args()
    application, packages = configure(args.root.resolve())
    if args.probe:
        result = probe(packages)
        if args.print_executable:
            print(sys.executable)
        else:
            for key, value in result.items():
                print(f"{key}: {value}")
        return 0
    if args.print_executable:
        raise RuntimeError("--print-executable requires --probe")
    sys.argv = [str(application / "main.py"), *application_args]
    runpy.run_path(str(application / "main.py"), run_name="__main__")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise SystemExit(1)
