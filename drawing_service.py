"""Local drawing upload, real PDF rasterization and closed-region candidates.

PNG/JPEG decoding uses Windows System.Drawing and PDF rendering uses Windows'
native PdfDocument API. Recognition runs on the actual image pixels with NumPy;
its polygons are editable candidates, never a substitute for user confirmation.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import threading
import uuid

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data" / "drawings"
BRIDGE_PATH = BASE_DIR / "drawing_bridge.ps1"
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_IMAGE_PIXELS = 32_000_000
MAX_ANALYSIS_DIMENSION = 1400
_ID = re.compile(r"^[a-f0-9]{32}$")
_ASSET = re.compile(r"^(?:original\.(?:png|jpg|pdf)|preview\.png|page-[1-9][0-9]*\.png)$")
_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()


class DrawingError(ValueError):
    """An invalid upload or an unavailable real rendering operation."""


def _lock(identifier: str):
    if not isinstance(identifier, str) or not _ID.fullmatch(identifier):
        raise DrawingError("图纸编号无效")
    with _locks_guard:
        return _locks.setdefault(identifier, threading.RLock())


def _directory(identifier: str) -> Path:
    if not isinstance(identifier, str) or not _ID.fullmatch(identifier):
        raise DrawingError("图纸编号无效")
    root = Path(DATA_DIR).resolve()
    directory = (root / identifier).resolve()
    if directory.parent != root:
        raise DrawingError("图纸路径无效")
    if not directory.is_dir():
        raise DrawingError("图纸不存在，请重新上传")
    return directory


def _write_json(path: Path, value: dict):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _metadata(identifier: str):
    try:
        return json.loads((_directory(identifier) / "metadata.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DrawingError("图纸记录不完整，请重新上传") from error


def _image_header(content: bytes):
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(content) < 33 or content[12:16] != b"IHDR" or struct.unpack(">I", content[8:12])[0] != 13:
            raise DrawingError("PNG 文件头不完整")
        width, height = struct.unpack(">II", content[16:24])
        kind = "png"
    elif content.startswith(b"\xff\xd8\xff"):
        position = 2
        width = height = None
        while position < len(content):
            if content[position] != 0xFF:
                position += 1
                continue
            while position < len(content) and content[position] == 0xFF:
                position += 1
            if position >= len(content):
                break
            marker = content[position]
            position += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if marker == 0xDA or position + 2 > len(content):
                break
            length = int.from_bytes(content[position:position + 2], "big")
            if length < 2 or position + length > len(content):
                raise DrawingError("JPEG 文件结构不完整")
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                          0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                if length < 8:
                    raise DrawingError("JPEG 尺寸记录无效")
                height = int.from_bytes(content[position + 3:position + 5], "big")
                width = int.from_bytes(content[position + 5:position + 7], "big")
                break
            position += length
        if width is None:
            raise DrawingError("无法读取 JPEG 尺寸")
        kind = "jpg"
    else:
        return None
    if not width or not height or width > 20000 or height > 20000 or width * height > MAX_IMAGE_PIXELS:
        raise DrawingError("图片尺寸过大，最多支持 3200 万像素")
    return kind, width, height


def _bridge(mode: str, source: Path, target: Path, *, page=1, maximum=2400):
    if sys.platform != "win32" or not BRIDGE_PATH.is_file():
        raise DrawingError("当前环境没有可用的图纸解码器；此版本需要 Windows 图像/PDF 组件")
    script = BRIDGE_PATH.read_text(encoding="utf-8")
    # Only trusted application code is submitted to PowerShell. User filenames
    # and paths are separate environment values, never interpolated as code.
    command = "& {\n" + script + "\n} -Mode $env:DRAWING_MODE -InputPath $env:DRAWING_INPUT -OutputPath $env:DRAWING_OUTPUT -Page ([int]$env:DRAWING_PAGE) -MaxDimension ([int]$env:DRAWING_MAXIMUM)"
    encoded = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
    environment = os.environ.copy()
    environment.update({"DRAWING_MODE": mode, "DRAWING_INPUT": str(source.resolve()),
                        "DRAWING_OUTPUT": str(target.resolve()), "DRAWING_PAGE": str(page),
                        "DRAWING_MAXIMUM": str(maximum)})
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
            env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DrawingError("图纸解码超时或 Windows 图纸组件无法启动") from error
    if result.returncode or not target.is_file():
        detail = result.stderr.decode("utf-8", errors="replace")
        if "outside the document" in detail:
            raise DrawingError("PDF 页码超出范围")
        raise DrawingError("图纸无法解码；请确认文件完整，PDF 未加密且页码正确")
    try:
        return json.loads(result.stdout.decode("utf-8-sig").strip().splitlines()[-1])
    except (ValueError, IndexError) as error:
        raise DrawingError("图纸解码器没有返回有效的图片信息") from error


def _url(identifier, filename):
    return f"/api/drawings/{identifier}/assets/{filename}"


def _public(metadata, page):
    active = metadata["rendered"][str(page)]
    return {"id": metadata["id"], "name": metadata["name"], "type": metadata["type"],
            "width": active["width"], "height": active["height"], "dpi": active["dpi"],
            "url": _url(metadata["id"], active["asset"]), "page": page,
            "pages": metadata["pages"], "page_count": metadata["pages"],
            "original_url": _url(metadata["id"], metadata["original"]),
            "renderer": active["renderer"]}


def save_upload(content: bytes, filename: str):
    if not isinstance(content, (bytes, bytearray)) or not content:
        raise DrawingError("请选择 PNG、JPG 或 PDF 图纸")
    if len(content) > MAX_UPLOAD_BYTES:
        raise DrawingError("图纸文件不能超过 64 MB")
    header = _image_header(content)
    if header:
        kind = header[0]
    elif bytes(content[:1024]).lstrip().startswith(b"%PDF-"):
        kind = "pdf"
    else:
        raise DrawingError("只支持真实的 PNG、JPG、PDF 文件")
    identifier = uuid.uuid4().hex
    directory = Path(DATA_DIR).resolve() / identifier
    directory.mkdir(parents=True, exist_ok=False)
    original = "original." + kind
    (directory / original).write_bytes(content)
    name = str(filename or "图纸").replace("\\", "/").split("/")[-1][:200] or "图纸"
    metadata = {"id": identifier, "name": name, "type": kind, "original": original,
                "sha256": hashlib.sha256(content).hexdigest(), "pages": 1, "rendered": {}}
    asset = "page-1.png" if kind == "pdf" else "preview.png"
    target = directory / asset
    temporary = directory / (asset + ".tmp")
    decoded = _bridge("pdf" if kind == "pdf" else "image", directory / original,
                      temporary, page=1, maximum=2400 if kind == "pdf" else 0)
    os.replace(temporary, target)
    metadata["pages"] = int(decoded.get("pages", 1))
    metadata["rendered"]["1"] = {"asset": asset, "width": int(decoded["width"]),
        "height": int(decoded["height"]), "dpi": round(float(decoded.get("dpi", 96)), 3),
        "renderer": decoded.get("renderer", "windows-drawing")}
    _write_json(directory / "metadata.json", metadata)
    return _public(metadata, 1)


def render_pdf_page(identifier: str, page=1):
    try:
        page = int(page)
    except (TypeError, ValueError) as error:
        raise DrawingError("PDF 页码必须是整数") from error
    with _lock(identifier):
        metadata = _metadata(identifier)
        if page < 1 or page > metadata["pages"]:
            raise DrawingError("PDF 页码超出范围")
        if str(page) not in metadata["rendered"]:
            directory = _directory(identifier)
            asset = f"page-{page}.png"
            temporary = directory / (asset + ".tmp")
            decoded = _bridge("pdf", directory / metadata["original"], temporary,
                              page=page, maximum=2400)
            os.replace(temporary, directory / asset)
            metadata["rendered"][str(page)] = {"asset": asset, "width": int(decoded["width"]),
                "height": int(decoded["height"]), "dpi": round(float(decoded["dpi"]), 3),
                "renderer": "windows-pdf"}
            _write_json(directory / "metadata.json", metadata)
        return _public(metadata, page)


def get_asset_path(identifier: str, name: str):
    if not isinstance(name, str) or not _ASSET.fullmatch(name):
        raise DrawingError("图纸文件路径无效")
    directory = _directory(identifier)
    path = (directory / name).resolve()
    if path.parent != directory or not path.is_file():
        raise DrawingError("图纸文件不存在")
    return path


def _closed_mask(mask, radius, np):
    if not radius:
        return mask
    height, width = mask.shape
    padded = np.pad(mask, radius, constant_values=False)
    dilated = np.zeros_like(mask)
    for dy in range(radius * 2 + 1):
        for dx in range(radius * 2 + 1):
            dilated |= padded[dy:dy + height, dx:dx + width]
    padded = np.pad(dilated, radius, constant_values=False)
    closed = np.ones_like(mask)
    for dy in range(radius * 2 + 1):
        for dx in range(radius * 2 + 1):
            closed &= padded[dy:dy + height, dx:dx + width]
    return closed


def _components(white, np):
    height, width = white.shape
    parents, segments = [], []

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    previous = []
    for y in range(height):
        transition = np.flatnonzero(np.diff(np.pad(white[y], 1, constant_values=False).astype(np.int8)))
        current = []
        cursor = 0
        for start, end in zip(transition[::2].tolist(), transition[1::2].tolist()):
            index = len(parents)
            parents.append(index)
            segments.append((y, start, end))
            current.append((start, end, index))
            while cursor < len(previous) and previous[cursor][1] <= start:
                cursor += 1
            check = cursor
            while check < len(previous) and previous[check][0] < end:
                root_a, root_b = find(index), find(previous[check][2])
                if root_a != root_b:
                    parents[root_a] = root_b
                check += 1
        previous = current
    groups = {}
    for index, segment in enumerate(segments):
        groups.setdefault(find(index), []).append(segment)
    result = []
    for runs in groups.values():
        area = sum(end - start for _, start, end in runs)
        touches = any(y in (0, height - 1) or start == 0 or end == width for y, start, end in runs)
        result.append((area, touches, runs))
    return result


def _polygon_area(points):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1])) / 2


def _simplify(points, tolerance=1.5):
    # First remove pixel stair collinearity. A closed RDP pass preserves corners.
    if len(points) <= 4:
        return points
    reduced = [point for index, point in enumerate(points)
               if ((point[0] - points[index - 1][0]) * (points[(index + 1) % len(points)][1] - point[1])
                   != (point[1] - points[index - 1][1]) * (points[(index + 1) % len(points)][0] - point[0]))]
    if len(reduced) <= 4:
        return reduced

    def rdp(line):
        if len(line) <= 2:
            return line
        first, last = line[0], line[-1]
        dx, dy = last[0] - first[0], last[1] - first[1]
        denominator = math.hypot(dx, dy)
        distances = [abs(dy * (p[0] - first[0]) - dx * (p[1] - first[1])) / denominator
                     if denominator else math.dist(first, p) for p in line[1:-1]]
        maximum = max(distances, default=0)
        if maximum <= tolerance:
            return [first, last]
        split = distances.index(maximum) + 1
        return rdp(line[:split + 1])[:-1] + rdp(line[split:])

    split = max(range(1, len(reduced)), key=lambda i: math.dist(reduced[0], reduced[i]))
    return rdp(reduced[:split + 1])[:-1] + rdp(reduced[split:] + [reduced[0]])[:-1]


def _contours(runs, original_lines, np):
    y0, y1 = runs[0][0], runs[-1][0]
    x0 = min(start for _, start, _ in runs)
    x1 = max(end for _, _, end in runs)
    mask = np.zeros((y1 - y0 + 1, x1 - x0), dtype=bool)
    for y, start, end in runs:
        mask[y - y0, start - x0:end - x0] = True
    padded = np.pad(mask, 1, constant_values=False)
    sides = [mask & ~padded[:-2, 1:-1], mask & ~padded[1:-1, 2:],
             mask & ~padded[2:, 1:-1], mask & ~padded[1:-1, :-2]]
    edges = set()
    supported = 0
    for side, bitmap in enumerate(sides):
        yy, xx = np.nonzero(bitmap)
        for y, x in zip(yy.tolist(), xx.tolist()):
            x, y = x + x0, y + y0
            if side == 0:
                start, end, neighbor = (x, y), (x + 1, y), (x, y - 1)
            elif side == 1:
                start, end, neighbor = (x + 1, y), (x + 1, y + 1), (x + 1, y)
            elif side == 2:
                start, end, neighbor = (x + 1, y + 1), (x, y + 1), (x, y + 1)
            else:
                start, end, neighbor = (x, y + 1), (x, y), (x - 1, y)
            edges.add((start, end))
            if 0 <= neighbor[1] < original_lines.shape[0] and 0 <= neighbor[0] < original_lines.shape[1]:
                supported += bool(original_lines[neighbor[1], neighbor[0]])
    perimeter = len(edges)
    outgoing = {}
    for start, end in edges:
        outgoing.setdefault(start, []).append(end)
    loops = []
    directions = {(1, 0): 0, (0, 1): 1, (-1, 0): 2, (0, -1): 3}
    while edges:
        first, next_point = next(iter(edges))
        points = [first]
        current = first
        direction = directions[(next_point[0] - first[0], next_point[1] - first[1])]
        while True:
            edges.remove((current, next_point))
            current = next_point
            if current == first:
                break
            points.append(current)
            options = [end for end in outgoing.get(current, []) if (current, end) in edges]
            if not options:
                points = []
                break
            next_point = min(options, key=lambda end: {1: 0, 0: 1, 3: 2, 2: 3}[
                (directions[(end[0] - current[0], end[1] - current[1])] - direction) % 4])
            direction = directions[(next_point[0] - current[0], next_point[1] - current[1])]
        if len(points) >= 4:
            loops.append(_simplify(points))
    return loops, supported / max(1, perimeter)


def recognize(identifier: str, page=1, *, threshold=210, min_area=None,
              close_radius=1, max_candidates=100):
    try:
        import numpy as np
    except ImportError as error:
        raise DrawingError("封闭区域识别需要 NumPy；当前环境没有安装该组件") from error
    try:
        threshold, close_radius = int(threshold), int(close_radius)
        max_candidates = int(max_candidates)
    except (TypeError, ValueError) as error:
        raise DrawingError("识别参数无效") from error
    if not 10 <= threshold <= 245 or not 0 <= close_radius <= 2 or not 1 <= max_candidates <= 200:
        raise DrawingError("识别参数超出允许范围")
    if min_area is not None:
        try:
            min_area = float(min_area)
        except (TypeError, ValueError) as error:
            raise DrawingError("识别最小区域面积无效") from error
        if not math.isfinite(min_area) or min_area < 16:
            raise DrawingError("识别最小区域面积无效")
    with _lock(identifier):
        active = render_pdf_page(identifier, page)
        directory = _directory(identifier)
        gray_path = directory / f"analysis-page-{active['page']}.gray"
        decoded = _bridge("pixels", get_asset_path(identifier, active["url"].rsplit("/", 1)[-1]),
                          gray_path, maximum=MAX_ANALYSIS_DIMENSION)
        width, height = int(decoded["width"]), int(decoded["height"])
        data = gray_path.read_bytes()
        if len(data) != width * height:
            raise DrawingError("图片像素数据不完整，无法识别")
        gray = np.frombuffer(data, dtype=np.uint8).reshape(height, width)
        lines = gray <= threshold
        closed = _closed_mask(lines, close_radius, np)
        minimum = max(120, width * height * 0.00015) if min_area is None else min_area
        scale_x, scale_y = active["width"] / width, active["height"] / height
        groups = sorted(_components(~closed, np), key=lambda item: item[0], reverse=True)
        candidates = []
        for area, touches, runs in groups:
            if touches or area < minimum or area > width * height * 0.85:
                continue
            loops, support = _contours(runs, lines, np)
            if not loops:
                continue
            outer = max(loops, key=lambda points: abs(_polygon_area(points)))
            holes = [loop for loop in loops if loop is not outer and abs(_polygon_area(loop)) >= 9]
            points = lambda polygon: [{"x": round(x * scale_x, 2), "y": round(y * scale_y, 2)} for x, y in polygon]
            candidates.append({"id": f"candidate-{len(candidates) + 1}", "name": f"区域 {len(candidates) + 1}",
                "points": points(outer), "holes": [points(hole) for hole in holes],
                "area_pixels": round(area * scale_x * scale_y, 2),
                "confidence": round(support * 0.95, 3), "confidence_kind": "boundary_line_support",
                "requires_confirmation": True})
            if len(candidates) >= max_candidates:
                break
        return {"drawing_id": identifier, "page": active["page"], "candidates": candidates,
            "method": "threshold-closed-white-regions", "requires_confirmation": True,
            "width": active["width"], "height": active["height"],
            "analysis_width": width, "analysis_height": height,
            "parameters": {"threshold": threshold, "close_radius": close_radius,
                           "min_area": minimum, "max_candidates": max_candidates},
            "message": "候选来自图纸实际封闭白区；请预览并确认边界后再用于材料计算。"}
