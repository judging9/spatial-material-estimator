"""Capture only this application's windows for visual verification on Windows."""
import ctypes as ct
from ctypes import wintypes as wt
from pathlib import Path
import struct
import sys
import tempfile
import tkinter as tk

DESKTOP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DESKTOP))
from main import AnalysisDialog, DesktopApp, demo_project, prepare_data


def capture(window, path):
    window.update()
    user = ct.windll.user32
    gdi = ct.windll.gdi32
    user.GetParent.argtypes = [wt.HWND]
    user.GetParent.restype = wt.HWND
    hwnd = user.GetParent(window.winfo_id())
    rectangle = wt.RECT()
    user.GetWindowRect(hwnd, ct.byref(rectangle))
    width, height = rectangle.right - rectangle.left, rectangle.bottom - rectangle.top
    user.GetWindowDC.argtypes = [wt.HWND]
    user.GetWindowDC.restype = wt.HDC
    user.ReleaseDC.argtypes = [wt.HWND, wt.HDC]
    gdi.CreateCompatibleDC.argtypes = [wt.HDC]
    gdi.CreateCompatibleDC.restype = wt.HDC
    gdi.CreateCompatibleBitmap.argtypes = [wt.HDC, ct.c_int, ct.c_int]
    gdi.CreateCompatibleBitmap.restype = wt.HBITMAP
    gdi.SelectObject.argtypes = [wt.HDC, wt.HGDIOBJ]
    gdi.SelectObject.restype = wt.HGDIOBJ
    gdi.DeleteObject.argtypes = [wt.HGDIOBJ]
    gdi.DeleteDC.argtypes = [wt.HDC]
    user.PrintWindow.argtypes = [wt.HWND, wt.HDC, wt.UINT]
    source = user.GetWindowDC(hwnd)
    target = gdi.CreateCompatibleDC(source)
    bitmap = gdi.CreateCompatibleBitmap(source, width, height)
    previous = gdi.SelectObject(target, bitmap)
    try:
        if not user.PrintWindow(hwnd, target, 2):
            raise RuntimeError("PrintWindow failed")
        stride = ((width * 3 + 3) // 4) * 4
        size = stride * height
        info = struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, size, 0, 0, 0, 0)
        buffer = ct.create_string_buffer(size)
        header = ct.create_string_buffer(info)
        gdi.GetDIBits.argtypes = [wt.HDC, wt.HBITMAP, wt.UINT, wt.UINT, ct.c_void_p, ct.c_void_p, wt.UINT]
        if not gdi.GetDIBits(target, bitmap, 0, height, buffer, header, 0):
            raise RuntimeError("GetDIBits failed")
        path.write_bytes(struct.pack("<2sIHHI", b"BM", size + 54, 0, 0, 54) + info + buffer.raw)
    finally:
        gdi.SelectObject(target, previous)
        gdi.DeleteObject(bitmap)
        gdi.DeleteDC(target)
        user.ReleaseDC(hwnd, source)


output = DESKTOP / "previews"
output.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory() as temporary:
    data = prepare_data(temporary)
    root = tk.Tk()
    app = DesktopApp(root, data)
    app.load_into_ui(demo_project())
    app.mark_saved()
    try:
        capture(root, output / "quote.bmp")
        app.notebook.select(app.material_page)
        capture(root, output / "materials.bmp")
        dialog = AnalysisDialog(root, app.project["items"][1], app.project["resources"])
        capture(dialog, output / "analysis.bmp")
        dialog.destroy()
        print("Captured quote, materials and analysis previews")
    finally:
        root.destroy()
