"""Real raster/PDF roundtrips and drawing-region extraction on known fixtures."""
from __future__ import annotations

import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import drawing_service as service


def png(width=240, height=180, rectangles=(), holes=(), gap=False):
    pixels = bytearray([255] * width * height * 3)

    def black(x, y):
        at = (y * width + x) * 3
        pixels[at:at + 3] = b"\x00\x00\x00"

    for x0, y0, x1, y1 in rectangles:
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if x < x0 + 3 or x > x1 - 3 or y < y0 + 3 or y > y1 - 3:
                    if not (gap and y < y0 + 3 and 80 <= x <= 120):
                        black(x, y)
    for x0, y0, x1, y1 in holes:
        for y in range(y0, y1):
            for x in range(x0, x1):
                black(x, y)
    scanlines = b"".join(b"\0" + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


def pdf(pages=((200, 200), (300, 150))):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(len(pages)))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    for index, (width, height) in enumerate(pages):
        objects.append((f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
                        f"/Resources << >> /Contents {4 + index * 2} 0 R >>").encode())
        stream = f"0 0 0 RG 2 w 20 20 {width - 40} {height - 40} re S".encode()
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{index} 0 obj\n".encode() + value + b"\nendobj\n"
    xref = len(data)
    data += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets[1:]:
        data += f"{offset:010d} 00000 n \n".encode()
    data += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode()
    return bytes(data)


class UploadValidationTests(unittest.TestCase):
    def test_magic_validation_rejects_executable_and_disguised_markup(self):
        for content in (b"MZ\x00\x00", b"<svg><script>alert(1)</script></svg>", b"", b"not a PNG"):
            with self.subTest(content=content), self.assertRaises(service.DrawingError):
                service.save_upload(content, "drawing.png")

    def test_dimension_bomb_is_rejected_before_decode(self):
        content = bytearray(png(4, 4))
        content[16:24] = struct.pack(">II", 10000, 10000)
        with self.assertRaisesRegex(service.DrawingError, "尺寸过大"):
            service.save_upload(bytes(content), "large.png")

    def test_paths_and_recognition_parameters_are_rejected(self):
        for identifier in ("../../data", "not-an-id", "a" * 31):
            with self.assertRaises(service.DrawingError):
                service.get_asset_path(identifier, "preview.png")
        with self.assertRaises(service.DrawingError):
            service.recognize("a" * 32, threshold=1000)
        with self.assertRaises(service.DrawingError):
            service.recognize("a" * 32, min_area="nan")


@unittest.skipUnless(sys.platform == "win32", "Real Windows image/PDF components are required")
class WindowsDrawingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="drawing-service-test-")
        self.root = Path(self.temporary.name)
        self.patch = mock.patch.object(service, "DATA_DIR", self.root / "uploads")
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temporary.cleanup()

    def test_png_upload_is_decoded_and_names_cannot_overwrite_existing_files(self):
        content = png(rectangles=((20, 20, 220, 160),))
        first = service.save_upload(content, "../../app.py")
        second = service.save_upload(content, "../../app.py")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["name"], "app.py")
        self.assertEqual((first["width"], first["height"]), (240, 180))
        asset = service.get_asset_path(first["id"], "preview.png")
        self.assertEqual(service._image_header(asset.read_bytes()), ("png", 240, 180))
        self.assertEqual(service.get_asset_path(first["id"], "original.png").read_bytes(), content)
        for name in ("../app.py", "metadata.json", "analysis-page-1.gray"):
            with self.assertRaises(service.DrawingError):
                service.get_asset_path(first["id"], name)

    def test_real_jpeg_normalizes_to_png(self):
        source = self.root / "fixture.png"
        output = self.root / "fixture.jpg"
        source.write_bytes(png(rectangles=((20, 20, 220, 160),)))
        environment = os.environ.copy()
        environment.update({"TEST_IMAGE_SOURCE": str(source), "TEST_IMAGE_TARGET": str(output)})
        command = ("Add-Type -AssemblyName System.Drawing; "
                   "$image=[System.Drawing.Image]::FromFile($env:TEST_IMAGE_SOURCE); "
                   "try {$image.Save($env:TEST_IMAGE_TARGET,[System.Drawing.Imaging.ImageFormat]::Jpeg)} finally {$image.Dispose()}")
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                       env=environment, check=True, timeout=20, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        metadata = service.save_upload(output.read_bytes(), "fixture.jpg")
        self.assertEqual(metadata["type"], "jpg")
        self.assertEqual((metadata["width"], metadata["height"]), (240, 180))
        self.assertEqual(service._image_header(service.get_asset_path(metadata["id"], "preview.png").read_bytes())[0], "png")

    def test_two_page_pdf_selection_uses_real_raster_dimensions(self):
        first = service.save_upload(pdf(), "two-pages.pdf")
        self.assertEqual(first["pages"], 2)
        self.assertEqual(first["page"], 1)
        second = service.render_pdf_page(first["id"], 2)
        self.assertEqual(second["page"], 2)
        self.assertAlmostEqual(second["width"] / second["height"], 2, places=2)
        asset = service.get_asset_path(first["id"], "page-2.png")
        _, width, height = service._image_header(asset.read_bytes())
        self.assertEqual((width, height), (second["width"], second["height"]))
        self.assertNotEqual(first["url"], second["url"])
        with mock.patch.object(service, "_bridge", side_effect=AssertionError("A cached PDF page should not rerender")):
            self.assertEqual(service.render_pdf_page(first["id"], 2), second)
        with self.assertRaises(service.DrawingError):
            service.render_pdf_page(first["id"], 3)

    def test_real_pdf_geometry_is_recognized(self):
        metadata = service.save_upload(pdf(((200, 200),)), "rectangle.pdf")
        result = service.recognize(metadata["id"])
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(len(candidate["points"]), 4)
        self.assertTrue(candidate["requires_confirmation"])
        self.assertGreater(candidate["area_pixels"], metadata["width"] * metadata["height"] * 0.5)
        self.assertTrue(all(0 < p["x"] < metadata["width"] and 0 < p["y"] < metadata["height"] for p in candidate["points"]))

    def test_raster_closed_region_and_column_hole_are_preserved(self):
        metadata = service.save_upload(png(rectangles=((20, 20, 220, 160),), holes=((100, 70, 120, 90),)), "column.png")
        result = service.recognize(metadata["id"], close_radius=0)
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(len(candidate["points"]), 4)
        self.assertEqual(len(candidate["holes"]), 1)
        self.assertEqual(len(candidate["holes"][0]), 4)
        self.assertGreater(candidate["area_pixels"], 10000)

    def test_blank_and_open_diagrams_have_no_fabricated_candidates(self):
        for content in (png(), png(rectangles=((20, 20, 220, 160),), gap=True)):
            metadata = service.save_upload(content, "open.png")
            result = service.recognize(metadata["id"])
            self.assertEqual(result["candidates"], [])

    def test_corrupt_image_and_pdf_are_rejected_by_real_decoders(self):
        content = png(rectangles=((20, 20, 220, 160),))
        for broken in (content[:33], b"%PDF-1.4\nThis is not a real document"):
            with self.assertRaises(service.DrawingError):
                service.save_upload(broken, "invalid.png")


if __name__ == "__main__":
    unittest.main()
