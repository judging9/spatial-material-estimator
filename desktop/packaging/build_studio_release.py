"""Build the Windows x64 distribution of the current spatial estimating studio.

Uses only locally installed dependencies. Does not read or package user data.
The older Tk desktop distribution is deliberately outside this build.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import zipfile


PACKAGING = Path(__file__).resolve().parent
WORKSPACE = PACKAGING.parent.parent
RELEASE_ROOT = WORKSPACE / "release"
PRODUCT = "空间材料估算"
VERSION = "1.3.0"
RELEASE_NAME = f"{PRODUCT}-{VERSION}-Windows-x64"
STAGE = RELEASE_ROOT / RELEASE_NAME / PRODUCT
DEPENDENCIES = (
    "requests", "openpyxl", "numpy", "urllib3", "certifi",
    "charset-normalizer", "idna", "et-xmlfile",
)
APPLICATION_MODULES = (
    "app.py", "store.py", "scrape.py", "excelio.py", "autoupdate.py",
    "drawing_service.py", "drawing_bridge.ps1",
)
PROGRAM_DIRECTORIES = {"app", "runtime", "licenses"}
PUBLIC_DOCUMENTS = {
    f"{PRODUCT}.exe", "使用说明.md", "使用说明.html", "版本说明.md",
    "THIRD_PARTY_NOTICES.md", "BUILD-MANIFEST.json",
}


def check_stage() -> None:
    # All generated and overwritten files stay inside one explicit release tree.
    if not STAGE.resolve().is_relative_to(RELEASE_ROOT.resolve()):
        raise RuntimeError("Release path is outside the workspace release directory")
    STAGE.mkdir(parents=True, exist_ok=True)


def copy_file(source: Path, target: Path) -> None:
    if not source.is_file():
        raise RuntimeError(f"Required release component missing: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_tree(source: Path, target: Path, ignored=()) -> None:
    if not source.is_dir():
        raise RuntimeError(f"Required runtime directory missing: {source}")
    shutil.copytree(
        source, target, dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", *ignored),
    )


def copy_distribution(name: str, target: Path) -> dict:
    distribution = importlib.metadata.distribution(name)
    base = Path(distribution.locate_file(""))
    if not distribution.files:
        raise RuntimeError(f"Installed dependency has no file manifest: {name}")
    count = 0
    for entry in distribution.files:
        relative = Path(str(entry))
        if ".." in relative.parts or "__pycache__" in relative.parts or "tests" in relative.parts:
            continue
        source = base / relative
        if source.is_file() and source.suffix != ".pyc":
            # The wheel manifest includes sibling numpy.libs and dist-info/licenses.
            copy_file(source, target / relative)
            count += 1
    return {"name": name, "version": distribution.version, "files": count}


def make_runtime() -> list[dict]:
    if sys.platform != "win32" or sys.version_info[:2] != (3, 11) or struct.calcsize("P") != 8:
        raise RuntimeError("Build requires local Windows x64 Python 3.11")
    prefix = Path(sys.base_prefix)
    runtime = STAGE / "runtime"
    for name in (
        "python.exe", "pythonw.exe", "python3.dll", "python311.dll",
        "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt",
    ):
        copy_file(prefix / name, runtime / name)
    copy_tree(prefix / "DLLs", runtime / "DLLs", (
        "_test*", "*_test*", "*.cat", "*.ico", "_tkinter.pyd", "tcl*.dll", "tk*.dll",
    ))
    copy_tree(prefix / "Lib", runtime / "Lib", (
        "site-packages", "test", "tests", "idlelib", "ensurepip", "turtledemo", "tkinter",
    ))
    packages = runtime / "Lib" / "site-packages"
    manifest = [copy_distribution(name, packages) for name in DEPENDENCIES]
    # Isolate from the recipient's Python registry, environment and user packages.
    (runtime / "python311._pth").write_text(
        "Lib\nDLLs\nLib/site-packages\n../app\nimport site\n", encoding="utf-8",
    )
    copy_file(prefix / "LICENSE.txt", STAGE / "licenses" / "PYTHON-LICENSE.txt")
    return manifest


def make_application() -> None:
    application = STAGE / "app"
    for name in APPLICATION_MODULES:
        copy_file(WORKSPACE / name, application / name)
    copy_file(WORKSPACE / "desktop" / "studio_launcher.py", application / "studio_launcher.py")
    # Remove the superseded generated host from this exact staging location.
    old_host = application / "python_host.ps1"
    if old_host.is_file():
        if not old_host.resolve().is_relative_to(STAGE.resolve()):
            raise RuntimeError("Obsolete host resolves outside the release directory")
        old_host.unlink()
    copy_tree(WORKSPACE / "static", application / "static", ("*.ts", "*.map"))
    copy_file(WORKSPACE / "THIRD_PARTY_NOTICES.md", STAGE / "THIRD_PARTY_NOTICES.md")
    for source_name, public_name in (
        ("client-user-guide.md", "使用说明.md"),
        ("client-user-guide.html", "使用说明.html"),
        ("client-release-notes.md", "版本说明.md"),
    ):
        source = WORKSPACE / "docs" / source_name
        if source.is_file():
            copy_file(source, STAGE / public_name)
    if not any((STAGE / name).is_file() for name in ("使用说明.md", "使用说明.html")):
        raise RuntimeError("The client user guide must exist before release")


def make_icon() -> Path:
    """A simple architectural plan mark rendered directly into a 32-bit ICO."""
    icon = PACKAGING / "studio-release.ico"
    size = 64
    bitmap = bytearray()
    ink = (78, 111, 94, 255)  # BGRA, muted teal.
    paper = (249, 250, 247, 255)
    for y in reversed(range(size)):
        for x in range(size):
            inside = 12 <= x <= 51 and 12 <= y <= 51
            line = inside and (
                x <= 15 or x >= 48 or y <= 15 or y >= 48
                or 30 <= x <= 33
                or (x >= 32 and 29 <= y <= 32)
            )
            bitmap.extend(ink if line else paper)
    mask = bytes(size * ((size + 31) // 32) * 4)
    dib = struct.pack("<IIIHHIIIIII", 40, size, size * 2, 1, 32, 0, len(bitmap), 0, 0, 0, 0)
    data = dib + bitmap + mask
    header = struct.pack("<HHH", 0, 1, 1)
    directory = struct.pack("<BBBBHHII", size, size, 0, 0, 1, 32, len(data), 22)
    icon.write_bytes(header + directory + data)
    return icon


def make_launcher() -> None:
    gcc, windres = shutil.which("gcc"), shutil.which("windres")
    if not gcc or not windres:
        raise RuntimeError("Local GCC and windres are required for the Windows entry point")
    launcher = PACKAGING / "studio_launcher.c"
    if not launcher.is_file():
        raise RuntimeError("studio_launcher.c has not been generated yet")
    icon = make_icon()
    resource = PACKAGING / "studio-release.rc"
    numeric_version = VERSION.replace(".", ",") + ",0"
    resource.write_text(
        '#pragma code_page(65001)\n#include <windows.h>\n'
        f'1 ICON "{icon.name}"\n'
        f'1 VERSIONINFO\nFILEVERSION {numeric_version}\nPRODUCTVERSION {numeric_version}\n'
        'FILEFLAGSMASK 0x3fL\nFILEFLAGS 0\nFILEOS VOS_NT_WINDOWS32\n'
        'FILETYPE VFT_APP\nFILESUBTYPE 0\nBEGIN\n'
        ' BLOCK "StringFileInfo"\n BEGIN\n  BLOCK "080404b0"\n  BEGIN\n'
        f'   VALUE "FileDescription", "{PRODUCT}\\0"\n'
        f'   VALUE "ProductName", "{PRODUCT}\\0"\n'
        f'   VALUE "FileVersion", "{VERSION}\\0"\n'
        f'   VALUE "ProductVersion", "{VERSION}\\0"\n'
        f'   VALUE "InternalName", "PlanMatter\\0"\n'
        f'   VALUE "OriginalFilename", "{PRODUCT}.exe\\0"\n'
        '  END\n END\n BLOCK "VarFileInfo"\n BEGIN\n'
        '  VALUE "Translation", 0x804, 1200\n END\nEND\n', encoding="utf-8",
    )
    obj = RELEASE_ROOT / RELEASE_NAME / "studio-release-resource.o"
    subprocess.run([windres, "--codepage=65001", str(resource), "-o", str(obj)],
                   cwd=PACKAGING, check=True)
    subprocess.run([
        gcc, "-municode", "-mwindows", "-O2", "-static-libgcc",
        str(launcher), str(obj), "-o", str(STAGE / f"{PRODUCT}.exe"),
    ], cwd=PACKAGING, check=True)


def package_files() -> list[Path]:
    files = []
    for path in STAGE.rglob("*"):
        if not path.is_file():
            continue
        if not path.resolve().is_relative_to(STAGE.resolve()):
            raise RuntimeError("Package file resolves outside the release directory")
        relative = path.relative_to(STAGE)
        if "__pycache__" in relative.parts or path.suffix == ".pyc":
            continue
        if relative.parts[0] == "runtime" and "tests" in relative.parts:
            continue
        if relative.parts[0] not in PROGRAM_DIRECTORIES and relative.as_posix() not in PUBLIC_DOCUMENTS:
            continue
        if relative.parts[0] == "app" and any(part in {"data", "logs", "profile", "browser-profile"} for part in relative.parts):
            raise RuntimeError(f"Mutable client data must not enter the release: {relative}")
        if path.suffix.lower() in {".db", ".sqlite", ".sqlite3", ".eproj"}:
            raise RuntimeError(f"Database must not enter the release: {relative}")
        files.append(path)
    return sorted(files)


def write_manifest(packages: list[dict] | None = None) -> dict:
    manifest_path = STAGE / "BUILD-MANIFEST.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    entries = []
    for path in package_files():
        if path.name == manifest_path.name:
            continue
        entries.append({"path": path.relative_to(STAGE).as_posix(), "bytes": path.stat().st_size,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    manifest = {
        "product": PRODUCT, "version": VERSION, "platform": "Windows x64",
        "python": sys.version.split()[0], "dependencies": packages or previous.get("dependencies", []),
        "data_included": False, "files": entries,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def make_archive() -> Path:
    for required in (
        f"{PRODUCT}.exe", "runtime/python.exe", "runtime/pythonw.exe",
        "app/studio_launcher.py", "app/static/studio/app.js",
        "app/static/studio/lib/wall-solid.js", "app/static/studio/opening-editor.js",
        "app/static/studio/cost-workbench.js", "app/static/studio/structure-module.js",
        "app/static/studio/finish-module.js", "app/static/studio/municipal-module.js",
        "app/static/studio/lib/cost.js", "app/static/studio/lib/cost-export.js",
        "app/static/studio/lib/structure.js", "app/static/studio/lib/finish.js",
        "app/static/studio/lib/municipal.js",
        "app/static/studio/lib/levels.js", "app/static/studio/lib/scene-furniture.js",
        "app/static/studio/lib/scene-services.js", "app/static/studio/lib/municipal-scene.js",
        "app/static/studio/lib/terrain.js", "app/static/studio/lib/terrain-scene.js",
        "app/static/studio/lib/road-profile.js", "app/static/studio/lib/road-tunnel.js",
        "app/static/studio/lib/tunnel-scene.js", "app/static/studio/lib/scene-visibility.js",
        "app/static/studio/site-placement.js", "app/static/studio/terrain-visibility.css",
        "app/static/studio/viewer3d.js",
    ):
        if not (STAGE / required).is_file():
            raise RuntimeError(f"Release component missing: {required}")
    if not any((STAGE / name).is_file() for name in ("使用说明.md", "使用说明.html")):
        raise RuntimeError("The release is missing the client user guide")
    manifest = write_manifest()
    archive = RELEASE_ROOT / f"{RELEASE_NAME}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for path in package_files():
            output.write(path, PRODUCT + "/" + path.relative_to(STAGE).as_posix())
    with zipfile.ZipFile(archive) as output:
        if output.testzip() is not None:
            raise RuntimeError("Archive CRC validation failed")
        names = set(output.namelist())
        for item in manifest["files"]:
            name = PRODUCT + "/" + item["path"]
            if name not in names or hashlib.sha256(output.read(name)).hexdigest() != item["sha256"]:
                raise RuntimeError(f"Archive manifest validation failed: {item['path']}")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (RELEASE_ROOT / f"{RELEASE_NAME}.sha256.txt").write_text(
        f"{checksum}  {archive.name}\n", encoding="utf-8",
    )
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                      "files": len(names), "sha256": checksum}, ensure_ascii=True))
    return archive


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--runtime-only", action="store_true", help="Stage only the self-contained runtime")
    actions.add_argument("--stage-only", action="store_true", help="Build all program files without creating ZIP")
    actions.add_argument("--archive", action="store_true", help="Create ZIP from previously staged files")
    parser.add_argument("--refresh-app", action="store_true", help="Refresh program and documents without recopying runtime")
    args = parser.parse_args()
    check_stage()
    if args.archive:
        make_archive()
        return 0
    packages = None if args.refresh_app else make_runtime()
    if not args.runtime_only:
        make_application()
        make_launcher()
    write_manifest(packages)
    print("Staged:", STAGE)
    if not args.stage_only and not args.runtime_only:
        make_archive()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
