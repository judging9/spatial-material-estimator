"""Regression tests for financial rounding, saved snapshots and .eproj import."""
import ast
import copy
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

import estimate_core as core


WORKSPACE = Path(__file__).resolve().parents[1]
GESTIMATOR = WORKSPACE / "GEstimator-2.7" / "GEstimator-2.7"


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.resources = [
            {"code": "M", "description": "材料", "unit": "t", "rate": "100", "vat": "0", "discount": "0"},
            {"code": "L", "description": "人工", "unit": "h", "rate": "20", "vat": "0", "discount": "0"},
        ]

    def test_resource_tax_discount_and_half_up_rounding(self):
        resource = {"rate": "3800", "vat": "9", "discount": "10"}
        self.assertEqual(core.resource_price(resource), Decimal("3727.80"))
        self.assertEqual(core.resource_price({"rate": "118", "vat": "-15.25"}), Decimal("100.01"))
        self.assertEqual(core.currency("1.005"), Decimal("1.01"))
        self.assertEqual(core.currency("-1.005"), Decimal("-1.01"))
        self.assertEqual(core.currency("10.025", "2.5"), Decimal("10.05"))
        self.assertEqual(core.currency("149", "-2"), Decimal("100"))

    def test_percentages_use_last_group_or_explicit_sum_base(self):
        analysis = [
            {"itemtype": 0, "description": "材料", "resource_list": [["M", "1", ""]]},
            {"itemtype": 2, "description": "材料运费", "value": "0.1"},
            {"itemtype": 0, "description": "人工", "resource_list": [["L", "1", ""]]},
            {"itemtype": 2, "description": "人工附加", "value": "0.5"},
            {"itemtype": 1, "description": "合计"},
            {"itemtype": 2, "description": "管理费", "value": "0.1"},
            {"itemtype": 3, "description": "单位换算", "value": "0.5"},
            {"itemtype": 4, "description": "取整", "value": "2"},
        ]
        result = core.calculate_analysis(analysis, self.resources)
        self.assertEqual(result["results"][4], Decimal("140.00"))
        self.assertEqual(result["results"][5], Decimal("14.00"))
        # A multiplier refers to the last established base, matching GEstimator.
        self.assertEqual(result["rate"], Decimal("70.00"))

    def test_final_group_uses_original_get_ana_rate_behavior(self):
        result = core.calculate_analysis([
            {"itemtype": 0, "resource_list": [["M", "1"]]},
            {"itemtype": 0, "resource_list": [["L", "1"]]},
        ], self.resources)
        self.assertEqual(result["rate"], Decimal("20.00"))
        self.assertEqual(result["cumulative_total"], Decimal("120.00"))

    def test_invalid_resources_and_nonfinite_values_raise_friendly_errors(self):
        for value in ("NaN", "Infinity", "1e100", "__import__('os')", True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                core.decimal_value(value)
        with self.assertRaisesRegex(ValueError, "不存在"):
            core.calculate_analysis([{"itemtype": 0, "resource_list": [["missing", 1]]}], self.resources)
        with self.assertRaisesRegex(ValueError, "折扣"):
            core.resource_price({"rate": 10, "discount": 101})


class ProjectTests(unittest.TestCase):
    def project(self):
        project = core.new_project("测试工程")
        project.update(labor="100", freight="50", other_fee="25", tax_rate="9")
        project["resources"] = [{"code": "M", "description": "钢筋", "unit": "t", "rate": "3800"}]
        project["items"] = [{"code": "1", "description": "钢筋采购", "unit": "t", "qty": "2",
                             "rate": "3727.80", "loss_rate": "5", "analysis": [],
                             "measurements": [{"count": "2", "length": "1", "note": "按采购量"}]}]
        return project

    def test_quote_amounts_use_price_snapshot_and_support_deductions(self):
        project = self.project()
        totals = core.calculate_project(project)
        self.assertEqual(totals["subtotal"], Decimal("7828.38"))
        self.assertEqual(totals["net"], Decimal("8003.38"))
        self.assertEqual(totals["tax"], Decimal("720.30"))
        self.assertEqual(totals["total"], Decimal("8723.68"))
        project["resources"][0]["rate"] = "9000"
        self.assertEqual(core.calculate_project(project)["total"], totals["total"])
        project["items"].append({"code": "2", "qty": "1", "rate": "-100", "loss_rate": "0"})
        self.assertEqual(core.calculate_project(project)["subtotal"], Decimal("7728.38"))

    def test_measurements_are_explicit_and_support_deductions(self):
        self.assertEqual(core.measurement_quantity("2", "3.5", "0.4", "1.2", "-1"), Decimal("-3.36000"))
        self.assertEqual(core.calculate_project(self.project())["items"][0]["qty"], Decimal("2"))

    def test_atomic_save_and_round_trip_preserve_measurements_and_decimals(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "中文工程.estimate.json"
            project = self.project()
            project["items"][0]["rate"] = Decimal("3727.80")
            core.save_project(project, destination)
            original = destination.read_bytes()
            project["name"] = "修订稿"
            with mock.patch.object(core.os, "replace", side_effect=OSError("simulated disk error")):
                with self.assertRaises(OSError):
                    core.save_project(project, destination)
            self.assertEqual(destination.read_bytes(), original)
            self.assertEqual(list(Path(temporary).glob("*.tmp")), [])
            core.save_project(project, destination)
            loaded = core.load_project(destination)
            self.assertEqual(loaded["name"], "修订稿")
            self.assertEqual(loaded["items"][0]["measurements"], project["items"][0]["measurements"])
            self.assertEqual(core.calculate_project(loaded)["total"], Decimal("8723.68"))
            with self.assertRaisesRegex(ValueError, "只读"):
                core.save_project(project, Path(temporary) / "original.eproj")

    def test_unknown_project_format_and_invalid_sqlite_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "unknown.json"
            source.write_text('{"format":"something-else"}', encoding="utf-8")
            with self.assertRaises(ValueError):
                core.load_project(source)
            database = Path(temporary) / "unknown.eproj"
            connection = sqlite3.connect(database)
            try:
                connection.execute("CREATE TABLE unrelated (id INTEGER)")
                connection.commit()
            finally:
                connection.close()
            with self.assertRaisesRegex(ValueError, "数据表"):
                core.load_eproj(database)


@unittest.skipUnless(GESTIMATOR.exists(), "Downloaded GEstimator sources are not available")
class GEstimatorCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Load only the three pure algorithm definitions from the reference
        # source; its GTK/Peewee imports and application initialization are omitted.
        tree = ast.parse((GESTIMATOR / "estimator" / "data" / "schedule.py").read_text(encoding="utf-8"))
        names = {"Currency", "ScheduleItemModel", "ResourceItemModel"}
        module = ast.Module(body=[node for node in tree.body
                                  if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names],
                            type_ignores=[])
        cls.reference = {"Decimal": Decimal, "ROUND_HALF_UP": ROUND_HALF_UP, "copy": copy}
        exec(compile(module, "gestimator_pure_reference", "exec"), cls.reference)

    def test_real_bundled_databases_remain_unchanged_and_match_reference_analysis(self):
        for name in ("DSR2021.eproj", "DSREM2022.eproj"):
            with self.subTest(database=name):
                source = GESTIMATOR / "estimator" / "database" / name
                before = hashlib.sha256(source.read_bytes()).digest()
                project = core.load_eproj(source)
                self.assertGreater(len(project["resources"]), 1000)
                self.assertGreater(len(project["items"]), 1000)
                self.assertEqual(project["tax_rate"], "0")
                self.assertTrue(project["import_warnings"])
                resources = {
                    resource["code"]: self.reference["ResourceItemModel"](
                        code=resource["code"], description=resource["description"], unit=resource["unit"],
                        rate=Decimal(resource["rate"]), vat=Decimal(resource["vat"]),
                        discount=Decimal(resource["discount"]))
                    for resource in project["resources"]
                }
                checked = 0
                for item in project["items"]:
                    if not item["analysis"]:
                        continue
                    reference = self.reference["ScheduleItemModel"](item["code"], item["description"])
                    reference.resources = resources
                    reference.ana_items = copy.deepcopy(item["analysis"])
                    # The original ORM returns Decimal fields.
                    for row in reference.ana_items:
                        if "value" in row:
                            row["value"] = Decimal(row["value"])
                        for usage in row.get("resource_list", []):
                            usage[1] = Decimal(usage[1])
                    reference.evaluate_results()
                    result = core.calculate_analysis(item["analysis"], project["resources"])
                    self.assertEqual(result["results"], reference.results, item["code"])
                    self.assertEqual(result["rate"], reference.get_ana_rate(), item["code"])
                    checked += 1
                    if checked >= 100:
                        break
                self.assertEqual(checked, 100)
                self.assertEqual(hashlib.sha256(source.read_bytes()).digest(), before)
                self.assertFalse(Path(str(source) + "-journal").exists())


if __name__ == "__main__":
    unittest.main()
