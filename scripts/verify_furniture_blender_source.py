"""Audit the editable Blender source with Blender's actual geometry API.

Run Blender --background --factory-startup --python-exit-code 1 --python this_file.py.
This is a development check, not an application runtime dependency.
"""
import json
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
PRESETS = {"sofa": (2.2, .9, .85), "bed": (1.8, 2.1, .55), "table": (1.4, .8, .75),
           "chair": (.45, .45, .85), "cabinet": (1.2, .6, 2), "custom": (1, .6, .8),
           "nightstand": (.5, .4, .55), "wardrobe": (1.8, .6, 2.2)}

source = ROOT / "development_assets" / "furniture-presets.blend"
bpy.ops.wm.open_mainfile(filepath=str(source))
bpy.context.view_layer.update()
assert bpy.context.scene.unit_settings.system == "METRIC"
assert bpy.context.scene["license"] == "CC0-1.0"
assert set(bpy.data.collections.keys()) == set(PRESETS)
assert not bpy.data.libraries, "Editable source must not depend on installed asset libraries"
assert not bpy.data.brushes, "Unrelated default brush assets must not be included"
assert all(not image.filepath or image.packed_file for image in bpy.data.images)

manifest = json.loads((ROOT / "static/studio/assets/furniture-manifest.json").read_text(encoding="utf-8"))
report = {"blender": bpy.app.version_string, "source": source.relative_to(ROOT).as_posix(),
          "bytes": source.stat().st_size, "collections": {}, "externalLibraries": len(bpy.data.libraries)}
for kind, expected in PRESETS.items():
    objects = list(bpy.data.collections[kind].objects)
    assert objects and all(obj.type == "MESH" for obj in objects)
    points = [obj.matrix_world @ vertex.co for obj in objects for vertex in obj.data.vertices]
    low = [min(p[i] for p in points) for i in range(3)]
    high = [max(p[i] for p in points) for i in range(3)]
    size = [high[i] - low[i] for i in range(3)]
    assert all(abs(size[i] - expected[i]) < 1e-5 for i in range(3)), (kind, size, expected)
    assert abs(low[2]) < 1e-5, "Every furniture item must rest on the ground plane"
    faces = 0
    for obj in objects:
        assert obj.data.materials and all(material.library is None for material in obj.data.materials)
        normal_matrix = obj.matrix_world.to_3x3().inverted().transposed()
        center = obj.matrix_world @ (sum((v.co for v in obj.data.vertices), Vector()) / len(obj.data.vertices))
        for polygon in obj.data.polygons:
            vertices = [obj.matrix_world @ obj.data.vertices[index].co for index in polygon.vertices]
            normal = (normal_matrix @ polygon.normal).normalized()
            geometric = (vertices[1] - vertices[0]).cross(vertices[2] - vertices[0]).normalized()
            middle = sum(vertices, Vector()) / len(vertices)
            assert normal.dot(geometric) > .99999, "Transformed normals must agree with actual face winding"
            assert normal.dot(middle - center) > 1e-7, "All beveled part normals must point outward"
            faces += 1
    assert faces == manifest["modelStats"][kind]["faces"]
    report["collections"][kind] = {"parts": len(objects), "faces": faces, "sizeMetres": size}

report["parts"] = sum(item["parts"] for item in report["collections"].values())
output = ROOT / "artifacts/furniture/blender-source-validation.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
