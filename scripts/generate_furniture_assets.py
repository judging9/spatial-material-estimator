"""Generate the project's original, lightweight furniture meshes offline.

Run with local Python, or Blender --background --python this_file.py.
No downloaded models, textures or external dependencies are used. Blender
creates and applies its own bevel modifier when bpy is available; otherwise
the same original designs use deterministic analytic bevel geometry.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "static" / "studio" / "assets"
PALETTE = {"wood": "#b8a084", "woodLight": "#cdbca4", "cloth": "#cbcdbf", "cushion": "#dedfd2", "linen": "#e9e6dc", "metal": "#848f83", "cabinet": "#d2d0c4"}
PRESETS = {"sofa": (2.2, .9, .85), "bed": (1.8, 2.1, .55), "table": (1.4, .8, .75), "chair": (.45, .45, .85), "cabinet": (1.2, .6, 2), "custom": (1, .6, .8), "nightstand": (.5, .4, .55), "wardrobe": (1.8, .6, 2.2)}


def designs():
    result = {}
    for kind in ("sofa", "bed", "table", "chair", "cabinet", "custom", "nightstand", "wardrobe"):
        parts = []
        def add(x, z, bottom, top, width, depth, material, radius=.025):
            parts.append({"center": [x, (bottom + top) / 2, z], "size": [width, top - bottom, depth], "color": PALETTE[material], "bevel": radius})
        def legs(top):
            for x, z in itertools.product((-1, 1), repeat=2): add(x * .41, z * .41, 0, top, .055, .055, "wood", .012)
        if kind == "sofa":
            legs(.12); add(0, 0, .10, .48, .96, .93, "cloth")
            for x in (-.245, .245):
                add(x, .085, .48, .67, .47, .69, "cushion", .045)
                add(x, -.405, .47, 1, .47, .19, "cloth", .055)
            for x in (-.45, .45): add(x, 0, .38, .85, .10, 1, "cloth", .035)
        elif kind == "bed":
            legs(.14); add(0, 0, .10, .42, 1, 1, "wood")
            add(0, .025, .42, .81, .96, .93, "linen", .04)
            add(0, -.475, .16, 1, 1, .05, "woodLight", .014)
            for x in (-.23, .23): add(x, -.29, .81, .94, .41, .22, "cushion", .045)
        elif kind == "table":
            legs(.91); add(0, 0, .91, 1, 1, 1, "woodLight", .025)
        elif kind == "chair":
            legs(.48); add(0, .02, .48, .59, 1, .96, "cushion", .04)
            add(0, -.45, .54, 1, 1, .10, "woodLight", .025)
        elif kind == "nightstand":
            legs(.12); add(0, -.025, .10, .97, .96, .90, "woodLight", .018)
            add(0, 0, .94, 1, 1, 1, "woodLight", .018)
            for bottom, top in ((.22, .55), (.58, .91)):
                add(0, .46, bottom, top, .91, .045, "cabinet", .012)
                add(0, .495, (bottom + top) / 2 - .018, (bottom + top) / 2 + .018, .26, .03, "metal", .008)
        elif kind in ("wardrobe", "cabinet"):
            add(0, 0, 0, 1, 1, .94, "woodLight", .012)
            for x in (-.245, .245):
                add(x, .475, .045, .96, .47, .05, "cabinet", .015)
            for x in (-.04, .04): add(x, .515, .40, .61, .014, .03, "metal", .005)
            add(0, .49, .012, .04, .95, .02, "wood", .004)
        else:
            add(0, 0, 0, 1, 1, 1, "cabinet", .035)
        result[kind] = parts
    return result


def face_normal(points):
    a, b, c = points[:3]
    u = [b[i] - a[i] for i in range(3)]; v = [c[i] - a[i] for i in range(3)]
    n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    length = math.sqrt(sum(x * x for x in n))
    return [x / length for x in n]


def analytic_part(part):
    center, size = part["center"], part["size"]
    radius = min(part["bevel"], min(size) * .23)
    bounds = [[center[i] - size[i] / 2, center[i] + size[i] / 2] for i in range(3)]
    faces = []
    def add(points):
        # Winding is corrected against the part centre, so normals remain
        # outward and lighting agrees with Blender output.
        n = face_normal(points)
        middle = [sum(p[i] for p in points) / len(points) for i in range(3)]
        if sum(n[i] * (middle[i] - center[i]) for i in range(3)) < 0: points.reverse(); n = [-x for x in n]
        faces.append({"points": points, "normal": n, "color": part["color"]})
    for axis in range(3):
        u, v = [i for i in range(3) if i != axis]
        for sign in (0, 1):
            points = []
            for su, sv in ((0, 0), (1, 0), (1, 1), (0, 1)):
                p = list(center); p[axis] = bounds[axis][sign]
                p[u] = bounds[u][su] + radius * (1 if su == 0 else -1)
                p[v] = bounds[v][sv] + radius * (1 if sv == 0 else -1); points.append(p)
            add(points)
    for axis in range(3):
        u, v = [i for i in range(3) if i != axis]
        for su, sv in itertools.product((0, 1), repeat=2):
            points = []
            for along, bevel_u in ((0, True), (1, True), (1, False), (0, False)):
                p = list(center); p[axis] = bounds[axis][along] + radius * (1 if along == 0 else -1)
                p[u] = bounds[u][su] + (0 if bevel_u else radius * (1 if su == 0 else -1))
                p[v] = bounds[v][sv] + (radius * (1 if sv == 0 else -1) if bevel_u else 0); points.append(p)
            add(points)
    for signs in itertools.product((0, 1), repeat=3):
        points = []
        for untrimmed in range(3):
            points.append([bounds[i][signs[i]] + (0 if i == untrimmed else radius * (1 if signs[i] == 0 else -1)) for i in range(3)])
        add(points)
    return faces


def blender_part(part, bpy, retained=None):
    # Blender Z is height; the app's Y is height. Keep conversion explicit.
    x, y, z = part["center"]; w, h, d = part["size"]
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, z, y))
    obj = bpy.context.object; obj.scale = (w, d, h)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = obj.modifiers.new("Original furniture edge bevel", "BEVEL")
    bevel.width = min(part["bevel"], min(part["size"]) * .23); bevel.segments = 1
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    faces = []
    for polygon in obj.data.polygons:
        points = []
        for index in polygon.vertices:
            p = obj.matrix_world @ obj.data.vertices[index].co
            points.append([p.x, p.z, p.y])
        normal = face_normal(points)
        # Swapping Blender Y/Z reflects winding. Restore outward normals.
        middle = [sum(p[i] for p in points) / len(points) for i in range(3)]
        if sum(normal[i] * (middle[i] - part["center"][i]) for i in range(3)) < 0:
            points.reverse(); normal = [-n for n in normal]
        faces.append({"points": points, "normal": normal, "color": part["color"]})
    if retained is None:
        bpy.data.objects.remove(obj, do_unlink=True)
    else:
        retained.append(obj)
    return faces


def source_collection(kind, parts, objects, low, dimensions, index, bpy, materials):
    """Keep editable original parts in metres, separate from runtime output."""
    width, depth, height = PRESETS[kind]
    collection = bpy.data.collections.new(kind)
    bpy.context.scene.collection.children.link(collection)
    offset_x, offset_y = index % 4 * 3.2, index // 4 * 3.6
    for part_index, (obj, part) in enumerate(zip(objects, parts)):
        obj.name = f"{kind}-part-{part_index + 1:02d}"
        for previous in list(obj.users_collection): previous.objects.unlink(obj)
        collection.objects.link(obj)
        x, z, y = obj.location
        obj.location = (((x - low[0]) / dimensions[0] - .5) * width + offset_x,
                        ((z - low[2]) / dimensions[2] - .5) * depth + offset_y,
                        (y - low[1]) / dimensions[1] * height)
        obj.scale = (width / dimensions[0], depth / dimensions[2], height / dimensions[1])
        color = part["color"]
        if color not in materials:
            material = bpy.data.materials.new("Original " + color)
            material.diffuse_color = tuple(int(color[i:i+2], 16) / 255 for i in (1, 3, 5)) + (1,)
            materials[color] = material
        obj.data.materials.append(materials[color])
        obj["preset"] = kind; obj["original_design"] = True
    return collection


def save_blender_source(bpy):
    source = ROOT / "development_assets" / "furniture-presets.blend"
    if not source.resolve().is_relative_to(ROOT.resolve()): raise RuntimeError("Blender source outside workspace")
    source.parent.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"; scene.unit_settings.scale_length = 1
    scene["license"] = "CC0-1.0"
    scene["source"] = "Original procedural furniture designs"
    scene["runtime_asset"] = "static/studio/assets/furniture-original.json"
    # Factory startup includes unused brush assets with installation paths.
    # The editable source should contain only our local meshes and materials.
    for brush in list(bpy.data.brushes): bpy.data.brushes.remove(brush)
    used = {material for obj in bpy.data.objects if obj.type == "MESH" for material in obj.data.materials}
    for material in list(bpy.data.materials):
        if material not in used: bpy.data.materials.remove(material, do_unlink=True)
    bpy.data.orphans_purge(do_recursive=True)
    for collection in list(bpy.data.collections):
        if not collection.objects and not collection.children: bpy.data.collections.remove(collection)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.context.preferences.filepaths.file_preview_type = "NONE"
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "VIEW_3D": area.spaces.active.shading.color_type = "MATERIAL"
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    return source.relative_to(ROOT).as_posix()


def make_preview(kind, model):
    width, depth, height = PRESETS[kind]
    def project(p):
        x, y, z = p[0] * width, p[1] * height, p[2] * depth
        return ((x - z) * .707107, (x + z) * .38 - y)
    points = [project(p) for face in model["faces"] for p in face["points"]]
    low = [min(p[i] for p in points) for i in range(2)]; high = [max(p[i] for p in points) for i in range(2)]
    scale = min(160 / (high[0] - low[0]), 122 / (high[1] - low[1]))
    polygons = []
    ordered = sorted(model["faces"], key=lambda face: sum(p[0] * width + p[2] * depth + p[1] * height * .6 for p in face["points"]) / len(face["points"]))
    for face in ordered:
        nx, ny, nz = face["normal"]
        if nx * .7 + ny * .6 + nz * .7 < .01: continue
        color = face["color"]; light = min(1.06, max(.73, .82 + .18 * ny + .08 * nx))
        shaded = "#" + "".join(f"{min(255, round(int(color[i:i+2], 16) * light)):02x}" for i in (1, 3, 5))
        ring = []
        for point in face["points"]:
            x, y = project(point)
            ring.append(f"{100+(x-(low[0]+high[0])/2)*scale:.2f},{80+(y-(low[1]+high[1])/2)*scale:.2f}")
        polygons.append(f'<polygon points="{" ".join(ring)}" fill="{shaded}"/>')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160"><title>Original '+kind+' preview</title>'+''.join(polygons)+'</svg>'


def main():
    try:
        import bpy
    except ImportError:
        bpy = None
    if bpy:
        # --factory-startup isolates this working scene from user preferences.
        for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
    if not OUTPUT.resolve().is_relative_to(ROOT.resolve()): raise RuntimeError("Asset output outside workspace")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    models = {}; materials = {}
    for index, (kind, parts) in enumerate(designs().items()):
        retained = [] if bpy else None
        faces = [face for part in parts for face in (blender_part(part, bpy, retained) if bpy else analytic_part(part))]
        points = [p for face in faces for p in face["points"]]
        low = [min(p[i] for p in points) for i in range(3)]; high = [max(p[i] for p in points) for i in range(3)]
        dimensions = [high[i] - low[i] for i in range(3)]
        for face in faces:
            face["points"] = [[round((p[i] - low[i]) / dimensions[i] - (0 if i == 1 else .5), 7) for i in range(3)] for p in face["points"]]
            # Normal inverse-transpose for the normalisation transform.
            n = [face["normal"][i] * dimensions[i] for i in range(3)]; length = math.sqrt(sum(v * v for v in n))
            face["normal"] = [round(v / length, 7) for v in n]
        models[kind] = {"faces": faces, "triangles": sum(len(f["points"]) - 2 for f in faces)}
        if bpy: source_collection(kind, parts, retained, low, dimensions, index, bpy, materials)
    payload = {"schema": 1, "units": "normalized-metres", "license": "CC0-1.0", "creator": "Space Material Estimator project", "models": models}
    asset = OUTPUT / "furniture-original.json"
    asset.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    previews = OUTPUT / "furniture"; previews.mkdir(exist_ok=True)
    for kind, model in models.items(): (previews / (kind + ".svg")).write_text(make_preview(kind, model), encoding="utf-8")
    manifest = {"schema": 1, "asset": asset.name, "sha256": hashlib.sha256(asset.read_bytes()).hexdigest(), "bytes": asset.stat().st_size,
                "generator": "Blender " + bpy.app.version_string if bpy else "Local Python analytic bevel generator", "generatorScript": "scripts/generate_furniture_assets.py",
                "source": "Original procedural furniture designs; no third-party model files", "license": "CC0-1.0",
                "modelStats": {kind: {"faces": len(model["faces"]), "triangles": model["triangles"], "preview": "furniture/" + kind + ".svg"} for kind, model in models.items()}}
    if bpy: manifest["sourceBlend"] = save_blender_source(bpy)
    (OUTPUT / "furniture-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=True))


if __name__ == "__main__": main()
