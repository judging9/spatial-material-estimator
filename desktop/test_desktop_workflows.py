"""真实 Tk 工程工作流回归检查，数据库与输出均使用临时目录。"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import sys
import tempfile
import tkinter as tk
import unittest
from unittest.mock import patch

from openpyxl import load_workbook

DESKTOP_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(DESKTOP_DIR))
sys.path.insert(0, str(DESKTOP_DIR.parent))

import main as gui
import store
from estimate_core import calculate_analysis, calculate_project, load_project, new_project
from exporting import export_project_xlsx


def item(code="Q1", **overrides):
    result = {"code": code, "description": "Test item", "unit": "t", "qty": "1",
              "rate": "100", "loss_rate": "0", "analysis": [], "measurements": []}
    result.update(overrides)
    return result


class DesktopWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="desktop-workflow-")
        self.data = Path(self.temporary.name)
        (self.data / "projects").mkdir()
        self.original_store = store.DATA_DIR, store.DB_PATH
        store.DATA_DIR, store.DB_PATH = str(self.data), str(self.data / "test.db")
        store.init_db()
        self.root = tk.Tk()
        self.root.withdraw()
        self.messages = []
        self.patches = [
            patch.object(gui.messagebox, "showerror", side_effect=lambda title, text, **kw: self.messages.append((title, text))),
            patch.object(gui.messagebox, "showinfo", return_value=None),
            patch.object(gui.messagebox, "askyesno", return_value=True),
            patch("autoupdate.check_once", side_effect=AssertionError("Workflow tests must not access network")),
        ]
        for patched in self.patches:
            patched.start()
        self.app = gui.DesktopApp(self.root, self.data)
        self.project = new_project("Workflow test")
        self.project["items"] = [item()]
        self.app.load_into_ui(self.project)
        self.app.mark_saved()

    def tearDown(self):
        self.app.materials.destroy()
        for identifier in self.root.tk.call("after", "info"):
            self.root.after_cancel(identifier)
        self.root.destroy()
        for patched in reversed(self.patches):
            patched.stop()
        store.DATA_DIR, store.DB_PATH = self.original_store
        self.temporary.cleanup()

    def test_cancel_new_keeps_unsaved_project(self):
        self.app.vars["client"].set("Unsaved client")
        before = self.app.signature()
        with patch.object(gui.messagebox, "askyesnocancel", return_value=None):
            self.app.new()
        self.assertEqual(self.app.signature(), before)

    def test_cancel_save_prevents_open_and_keeps_unsaved_project(self):
        self.app.vars["client"].set("Unsaved client")
        before = self.app.signature()
        with patch.object(gui.messagebox, "askyesnocancel", return_value=True), \
                patch.object(gui.filedialog, "asksaveasfilename", return_value=""), \
                patch.object(gui.filedialog, "askopenfilename") as choose_open:
            self.app.open()
        choose_open.assert_not_called()
        self.assertEqual(self.app.signature(), before)

    def test_save_then_cancel_open_preserves_saved_current_project(self):
        self.app.vars["client"].set("Saved client")
        target = self.data / "projects" / "saved.estimate.json"
        with patch.object(gui.messagebox, "askyesnocancel", return_value=True), \
                patch.object(gui.filedialog, "asksaveasfilename", return_value=str(target)), \
                patch.object(gui.filedialog, "askopenfilename", return_value=""):
            self.app.open()
        self.assertEqual(load_project(target)["client"], "Saved client")
        self.assertEqual(self.app.path, target)
        self.assertEqual(self.app.signature(), self.app.saved_signature)

    def test_malformed_project_does_not_replace_current_state(self):
        malformed = new_project("Malformed incoming project")
        malformed["resources"] = [{"code": "R1", "rate": "20", "unit": "t"}]
        target = self.data / "malformed.estimate.json"
        target.write_text(json.dumps(malformed), encoding="utf-8")
        self.app.path = self.data / "existing.estimate.json"
        original_path, before = self.app.path, self.app.signature()
        with patch.object(gui.filedialog, "askopenfilename", return_value=str(target)):
            self.app.open()
        self.assertTrue(self.messages, "Malformed project should report an error")
        self.assertEqual(self.app.signature(), before)
        self.assertEqual(self.app.path, original_path)

    def test_material_code_collision_keeps_original_resource(self):
        unrelated = {"code": "M1", "description": "Existing unrelated labour", "unit": "day",
                     "rate": "200", "vat": "0", "discount": "0"}
        self.app.project["resources"] = [unrelated]
        material = {"id": 1, "name": "Picked steel", "spec": "20mm", "unit": "t", "price": 3500}
        created = self.app.material_resource(material)
        self.assertEqual(unrelated["description"], "Existing unrelated labour")
        self.assertNotEqual(created["code"], "M1")
        self.assertEqual(created["material_id"], 1)
        self.assertEqual(created["description"], "Picked steel 20mm")
        self.assertEqual(len(self.app.project["resources"]), 2)

    def test_explicit_update_changes_material_snapshot_and_marks_dirty(self):
        material = store.save_material({"name": "Workflow steel", "spec": "20mm", "unit": "t"})
        store.upsert_price(material["id"], "全国", 3500, "2026-11-01", "Test price")
        self.project["items"] = [item(rate="3000", material_id=material["id"])]
        self.app.load_into_ui(self.project)
        self.app.mark_saved()
        self.app.materials.refresh()
        self.assertEqual(self.app.project["items"][0]["rate"], "3000")
        self.app.items_tree.selection_set("0")
        self.app.update_rates()
        self.assertEqual(self.app.project["items"][0]["rate"], "3500.0")
        self.assertEqual(self.app.project["items"][0]["price_date"], "2026-11-01")
        self.assertNotEqual(self.app.signature(), self.app.saved_signature)

    def test_batch_update_failure_does_not_partially_change_rates(self):
        material = store.save_material({"name": "Workflow batch steel", "spec": "", "unit": "t"})
        store.upsert_price(material["id"], "全国", 3500, "2026-11-01", "Test price")
        missing_analysis = [{"itemtype": 0, "description": "Missing", "resource_list": [["missing", "1", ""]]}]
        self.project["items"] = [item(material_id=material["id"]), item("Q2", analysis=missing_analysis)]
        self.app.load_into_ui(self.project)
        self.app.items_tree.selection_set("0", "1")
        before = copy.deepcopy(self.app.project["items"])
        self.app.update_rates()
        self.assertEqual(self.app.project["items"], before)
        self.assertTrue(self.messages)

    def test_original_negative_tax_adjustment_can_be_edited(self):
        values = {"code": "R1", "description": "Imported tax removal", "unit": "t",
                  "rate": "100", "vat": "-15.25", "discount": "0", "category": "Imported"}
        gui.validate_resource(values)
        self.assertEqual(values["vat"], "-15.25")

    def test_closing_nested_fields_restores_analysis_modal_grab(self):
        analysis = gui.AnalysisDialog(self.root, item(), [])
        analysis.withdraw()
        try:
            self.assertIs(self.root.grab_current(), analysis)

            def cancel_nested():
                dialog = next(widget for widget in analysis.winfo_children()
                              if isinstance(widget, gui.FieldsDialog))
                dialog.destroy()

            self.root.after(0, cancel_nested)
            self.assertIsNone(gui.ask_fields(analysis, "Nested fields", [("description", "Name", "")]))
            self.assertIs(self.root.grab_current(), analysis)
        finally:
            analysis.destroy()

    def test_new_fee_keeps_terminal_total_in_analysis(self):
        resources = [{"code": "R1", "description": "Resource", "unit": "t",
                      "rate": "100", "vat": "0", "discount": "0"}]
        for select_final_rounding in (False, True):
            with self.subTest(select_final_rounding=select_final_rounding):
                analysis = gui.AnalysisDialog(self.root, item(), resources)
                analysis.withdraw()
                try:
                    analysis.analysis[0]["resource_list"] = [["R1", "1", ""]]
                    analysis.refresh()
                    if select_final_rounding:
                        analysis.tree.selection_set("row:2")
                    with patch.object(gui, "ask_fields", return_value={"kind": "比例", "description": "Management fee", "value": "10"}):
                        analysis.add_operation()
                    self.assertEqual(calculate_analysis(analysis.analysis, resources)["rate"], 110)
                finally:
                    analysis.destroy()

    def test_export_uses_same_rounded_lines_as_quote_total(self):
        project = new_project("Rounding regression")
        project["tax_rate"] = "0"
        project["items"] = [item(qty="0.005", rate="1"), item("Q2", qty="0.005", rate="1")]
        target = self.data / "rounded.xlsx"
        export_project_xlsx(project, target)
        book = load_workbook(target, data_only=True)
        try:
            sheet = book["报价单"]
            self.assertEqual(sheet["H6"].value, 0.01)
            self.assertEqual(sheet["H7"].value, 0.01)
            self.assertEqual(sheet["H8"].value, 0.02)
            self.assertEqual(float(calculate_project(project)["subtotal"]), sheet["H8"].value)
        finally:
            book.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
