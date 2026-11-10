# -*- coding: utf-8 -*-
"""中文材料报价桌面版。基于 GEstimator 2.7 的工程清单和单价分析模型。

Copyright (C) 2014 Manu Varkey (GEstimator original calculation model).
This adaptation is distributed under GPL-3.0-or-later; see LICENSE and NOTICE.md.
"""
from __future__ import annotations

import argparse
import copy
from contextlib import closing
import ctypes
import datetime as dt
import json
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import tkinter as tk
from tkinter import font as tkfont
from tkinter import filedialog, messagebox, ttk

APP_DIR = Path(__file__).resolve().parent
HOME_DIR = Path(os.environ.get("MATERIAL_QUOTE_HOME", APP_DIR)).resolve()
if str(APP_DIR.parent) not in sys.path:
    sys.path.insert(0, str(APP_DIR.parent))

import store
from estimate_core import (calculate_analysis, calculate_project, currency, decimal_value,
                           load_eproj, load_project, measurement_quantity,
                           new_project, resource_price, save_project)
from materials_panel import MaterialsPanel, material_picker
from exporting import export_project_xlsx

VERSION = "1.0.0"
BG = "#f3f5f9"
INK = "#182b44"
BLUE = "#245bd6"


def number(value, places=2):
    return f"{decimal_value(value):,.{places}f}"


def checked(value, label, allow_negative=False):
    result = decimal_value(value, label)
    if not allow_negative and result < 0:
        raise ValueError(f"{label}不能小于零")
    return str(result)


def prepare_data(home=HOME_DIR):
    """材料库首次从只读快照复制，之后桌面版使用自己的数据库。"""
    data = Path(home) / "data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "projects").mkdir(exist_ok=True)
    destination = data / "materials.db"
    if not destination.exists():
        seed = APP_DIR / "seed.db"
        original = APP_DIR.parent / "data" / "app.db"
        source = seed if seed.exists() else original
        if source.exists():
            with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as src:
                with closing(sqlite3.connect(destination)) as dst:
                    src.backup(dst)
    store.DATA_DIR = str(data)
    store.DB_PATH = str(destination)
    store.init_db()
    return data


def setup_style(root):
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
        tkfont.nametofont(name, root=root).configure(family="Microsoft YaHei UI", size=10)
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure("TFrame", background=BG)
    style.configure("TLabel", background=BG, foreground=INK)
    style.configure("Title.TLabel", font=("Microsoft YaHei UI", 22, "bold"))
    style.configure("Hint.TLabel", foreground="#66768d", font=("Microsoft YaHei UI", 9))
    style.configure("Total.TLabel", foreground=BLUE, font=("Microsoft YaHei UI", 22, "bold"))
    style.configure("TButton", padding=(12, 7))
    style.configure("Primary.TButton", background=BLUE, foreground="white")
    style.map("Primary.TButton", background=[("active", "#1748af")])
    style.configure("Treeview", rowheight=32, font=("Microsoft YaHei UI", 10), background="white", fieldbackground="white")
    style.configure("Treeview.Heading", font=("Microsoft YaHei UI", 10, "bold"), padding=(6, 8), background="#e8edf5")
    style.map("Treeview", background=[("selected", "#dbe7ff")], foreground=[("selected", INK)])
    style.configure("TNotebook", background=BG, borderwidth=0)
    style.configure("TNotebook.Tab", padding=(20, 10))
    root.configure(background=BG)


def table(parent, columns, widths=None):
    frame = ttk.Frame(parent)
    frame.pack(fill="both", expand=True)
    tree = ttk.Treeview(frame, columns=[c[0] for c in columns], show="headings", selectmode="extended", height=8)
    for key, label in columns:
        tree.heading(key, text=label)
        tree.column(key, width=(widths or {}).get(key, 110), minwidth=65, anchor="w")
    vertical = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
    horizontal = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
    tree.grid(row=0, column=0, sticky="nsew")
    vertical.grid(row=0, column=1, sticky="ns")
    horizontal.grid(row=1, column=0, sticky="ew")
    frame.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    return tree


class FieldsDialog(tk.Toplevel):
    def __init__(self, parent, title, fields, values=None, validate=None):
        super().__init__(parent)
        self.title(title)
        self.transient(parent)
        self.resizable(False, False)
        self.result = None
        self.validator = validate
        self.variables = {}
        body = ttk.Frame(self, padding=20)
        body.pack(fill="both", expand=True)
        for row, (key, label, default) in enumerate(fields):
            ttk.Label(body, text=label).grid(row=row, column=0, sticky="w", padx=(0, 18), pady=6)
            var = tk.StringVar(value=str((values or {}).get(key, default)))
            self.variables[key] = var
            entry = ttk.Entry(body, textvariable=var, width=40)
            entry.grid(row=row, column=1, sticky="ew", pady=6)
            if row == 0:
                self.first_entry = entry
        buttons = ttk.Frame(body)
        buttons.grid(row=len(fields), column=0, columnspan=2, sticky="e", pady=(15, 0))
        ttk.Button(buttons, text="取消", command=self.destroy).pack(side="left", padx=6)
        ttk.Button(buttons, text="确定", style="Primary.TButton", command=self.accept).pack(side="left")
        self.bind("<Escape>", lambda _event: self.destroy())
        self.bind("<Return>", lambda _event: self.accept())
        self.grab_set()
        self.first_entry.focus_set()

    def accept(self):
        values = {key: var.get().strip() for key, var in self.variables.items()}
        try:
            if self.validator:
                self.validator(values)
        except (ValueError, ArithmeticError) as error:
            messagebox.showerror("请检查输入", str(error), parent=self)
            return
        self.result = values
        self.destroy()


def ask_fields(parent, title, fields, values=None, validate=None):
    previous = parent.grab_current()
    try:
        dialog = FieldsDialog(parent, title, fields, values, validate)
        parent.wait_window(dialog)
        return dialog.result
    finally:
        if previous is not None and previous.winfo_exists():
            previous.grab_set()


def validate_resource(values):
    if not values["description"] or not values["code"]:
        raise ValueError("资源编号和名称不能为空")
    for key, label in (("rate", "单价"), ("vat", "资源税率"), ("discount", "折扣率")):
        values[key] = checked(values[key], label, allow_negative=key == "vat")
    if decimal_value(values["vat"]) < -100:
        raise ValueError("资源税率调整不能低于 -100%")
    if decimal_value(values["discount"]) > 100:
        raise ValueError("折扣率应在 0 到 100 之间")


RESOURCE_FIELDS = [("code", "资源编号", ""), ("description", "材料 / 人工 / 机具名称", ""),
                   ("unit", "单位", ""), ("rate", "基础单价（元）", "0"),
                   ("vat", "资源税率 / 调整（%）", "0"), ("discount", "折扣率（%）", "0"),
                   ("category", "分类", "材料")]


class AnalysisDialog(tk.Toplevel):
    def __init__(self, parent, item, resources):
        super().__init__(parent)
        self.title("单价分析 · " + item["description"])
        self.geometry("1010x650")
        self.minsize(800, 500)
        self.transient(parent)
        self.result = None
        self.analysis = copy.deepcopy(item.get("analysis") or [])
        self.resources = copy.deepcopy(resources)
        if not self.analysis:
            self.analysis = [{"itemtype": 0, "description": "材料、人工及机具", "code": "", "resource_list": []},
                             {"itemtype": 1, "description": "合计"},
                             {"itemtype": 4, "description": "单价保留两位小数", "value": 2}]
        body = ttk.Frame(self, padding=18)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="用量是每 1 单位清单所需的资源消耗量；附加比例按上一计算小计计取。", style="Hint.TLabel").pack(anchor="w", pady=(0, 10))
        bar = ttk.Frame(body)
        bar.pack(fill="x", pady=(0, 10))
        for title, command in (("添加资源", self.add_resource), ("新建资源", self.new_resource),
                               ("添加分组", self.add_group), ("附加费 / 系数", self.add_operation),
                               ("编辑", self.edit), ("上移", lambda: self.move(-1)),
                               ("下移", lambda: self.move(1)), ("删除", self.delete)):
            ttk.Button(bar, text=title, command=command).pack(side="left", padx=(0, 5))
        self.tree = table(body, [("type", "类型 / 编号"), ("description", "名称"),
                                 ("unit", "单位"), ("qty", "消耗量 / 比例"),
                                 ("rate", "资源单价（元）"), ("amount", "计算金额（元）")], {"description": 270})
        self.tree.bind("<Double-1>", lambda _event: self.edit())
        bottom = ttk.Frame(body)
        bottom.pack(fill="x", pady=(14, 0))
        self.total = tk.StringVar()
        ttk.Label(bottom, textvariable=self.total, style="Total.TLabel").pack(side="left")
        ttk.Button(bottom, text="取消", command=self.destroy).pack(side="right", padx=6)
        ttk.Button(bottom, text="应用分析", style="Primary.TButton", command=self.apply).pack(side="right")
        self.grab_set()
        self.refresh()

    def refresh(self):
        self.tree.delete(*self.tree.get_children())
        resources = {r["code"]: r for r in self.resources}
        try:
            computed = calculate_analysis(self.analysis, self.resources)
            self.total.set("分析单价  ¥ " + number(computed["rate"]))
            results = computed.get("results", [])
        except (ValueError, ArithmeticError) as error:
            self.total.set("分析尚未完成：" + str(error))
            results = []
        labels = {0: "资源分组", 1: "小计", 2: "附加比例", 3: "乘数系数", 4: "舍入"}
        for index, row in enumerate(self.analysis):
            kind = row["itemtype"]
            value = row.get("value", "")
            if kind == 2:
                value = str(decimal_value(value) * 100) + "%"
            amount = ""
            if index < len(results):
                result = results[index]
                if not isinstance(result, (list, tuple, dict)):
                    amount = number(result)
                elif kind == 0 and isinstance(result, (list, tuple)) and result:
                    try:
                        amount = number(result[-1])
                    except (ValueError, TypeError):
                        pass
            self.tree.insert("", "end", iid=f"row:{index}", values=(labels.get(kind, kind), row.get("description", ""), "", value, "", amount))
            if kind == 0:
                for subindex, resource_line in enumerate(row.get("resource_list", [])):
                    code, qty = resource_line[:2]
                    resource = resources.get(code)
                    rate = resource_price(resource) if resource else 0
                    self.tree.insert("", "end", iid=f"res:{index}:{subindex}", values=(code, "    " + (resource or {}).get("description", "资源缺失"), (resource or {}).get("unit", ""), qty, number(rate), number(currency(decimal_value(qty) * rate))))

    def selection(self):
        values = self.tree.selection()
        return values[0].split(":") if values else None

    def selected_group(self):
        selected = self.selection()
        if selected and self.analysis[int(selected[1])]["itemtype"] == 0:
            return int(selected[1])
        for index, row in enumerate(self.analysis):
            if row["itemtype"] == 0:
                return index
        self.analysis.insert(0, {"itemtype": 0, "description": "资源", "resource_list": [], "code": ""})
        return 0

    def add_resource(self):
        if not self.resources:
            self.new_resource()
            return
        chooser = tk.Toplevel(self)
        chooser.title("选择工程资源")
        chooser.geometry("740x430")
        chooser.transient(self)
        body = ttk.Frame(chooser, padding=15)
        body.pack(fill="both", expand=True)
        query = tk.StringVar()
        ttk.Entry(body, textvariable=query).pack(fill="x", pady=(0, 10))
        tree = table(body, [("code", "编号"), ("description", "名称"), ("unit", "单位"), ("rate", "单价")], {"description": 300})

        def refresh(*_args):
            tree.delete(*tree.get_children())
            for index, resource in enumerate(self.resources):
                if query.get().lower() in (resource["code"] + resource["description"]).lower():
                    tree.insert("", "end", iid=str(index), values=(resource["code"], resource["description"], resource.get("unit", ""), number(resource_price(resource))))

        def choose():
            selected = tree.selection()
            if not selected:
                return
            resource = self.resources[int(selected[0])]
            self.analysis[self.selected_group()]["resource_list"].append([resource["code"], "1", ""])
            chooser.destroy()
            self.grab_set()
            self.refresh()

        query.trace_add("write", refresh)
        tree.bind("<Double-1>", lambda _event: choose())
        ttk.Button(body, text="加入分析", style="Primary.TButton", command=choose).pack(anchor="e", pady=(10, 0))
        refresh()
        chooser.grab_set()
        self.wait_window(chooser)
        if self.winfo_exists():
            self.grab_set()

    def new_resource(self):
        code = "R" + str(len(self.resources) + 1)
        while any(r["code"] == code for r in self.resources):
            code += "A"
        values = ask_fields(self, "新建工程资源", RESOURCE_FIELDS, {"code": code}, validate_resource)
        if values:
            if any(r["code"] == values["code"] for r in self.resources):
                messagebox.showerror("编号重复", "请使用不同的资源编号", parent=self)
                return
            self.resources.append(values)
            self.analysis[self.selected_group()]["resource_list"].append([values["code"], "1", ""])
            self.refresh()

    def add_group(self):
        values = ask_fields(self, "添加分组", [("description", "分组名称", "人工")])
        if values:
            position = next((i for i, r in enumerate(self.analysis) if r["itemtype"] != 0), len(self.analysis))
            self.analysis.insert(position, {"itemtype": 0, "description": values["description"], "resource_list": [], "code": ""})
            self.refresh()

    def add_operation(self):
        values = ask_fields(self, "添加计算步骤", [("kind", "类型：比例 / 小计 / 系数 / 舍入", "比例"),
                                                   ("description", "说明", "管理费"), ("value", "比例填百分数，系数填倍数", "0")])
        if not values:
            return
        mapping = {"比例": 2, "小计": 1, "系数": 3, "舍入": 4}
        try:
            kind = mapping.get(values["kind"])
            if kind is None:
                raise ValueError("类型请填写：比例、小计、系数或舍入")
            value = decimal_value(checked(values["value"], "计算值", allow_negative=kind in (2, 3)))
            if kind == 4:
                currency(0, value)
            row = {"itemtype": kind, "description": values["description"]}
            if kind != 1:
                row["value"] = str(value / 100 if kind == 2 else value)
            selected = self.selection()
            position = int(selected[1]) + 1 if selected else len(self.analysis)
            # Keep a terminal sum/round after fees: GEstimator's final row is
            # the quoted rate, so ending on a percentage quotes only the fee.
            if self.analysis and self.analysis[-1]["itemtype"] in (1, 4):
                position = min(position, len(self.analysis) - 1)
            self.analysis.insert(position, row)
            if self.analysis[-1]["itemtype"] == 2:
                self.analysis.append({"itemtype": 1, "description": "合计"})
            self.refresh()
        except (ValueError, ArithmeticError) as error:
            messagebox.showerror("请检查输入", str(error), parent=self)

    def edit(self):
        selected = self.selection()
        if not selected:
            return
        index = int(selected[1])
        row = self.analysis[index]
        if selected[0] == "res":
            subindex = int(selected[2])
            line = row["resource_list"][subindex]
            values = ask_fields(self, "编辑资源消耗量", [("qty", "每单位工程消耗量", line[1]), ("remarks", "备注", line[2] if len(line) > 2 else "")], validate=lambda v: checked(v["qty"], "消耗量", allow_negative=True))
            if values:
                row["resource_list"][subindex] = [line[0], checked(values["qty"], "消耗量", allow_negative=True), values["remarks"]]
        else:
            fields = [("description", "说明", row.get("description", ""))]
            if row["itemtype"] in (2, 3, 4):
                value = decimal_value(row.get("value", 0))
                fields.append(("value", "百分数" if row["itemtype"] == 2 else "计算值", str(value * 100 if row["itemtype"] == 2 else value)))

            def validate(values):
                if "value" in values:
                    value = decimal_value(checked(values["value"], "计算值", allow_negative=row["itemtype"] in (2, 3)))
                    if row["itemtype"] == 4:
                        currency(0, value)

            values = ask_fields(self, "编辑计算步骤", fields, validate=validate)
            if values:
                row["description"] = values["description"]
                if "value" in values:
                    value = decimal_value(values["value"])
                    row["value"] = str(value / 100 if row["itemtype"] == 2 else value)
        self.refresh()

    def delete(self):
        selected = self.selection()
        if not selected:
            return
        if selected[0] == "res":
            del self.analysis[int(selected[1])]["resource_list"][int(selected[2])]
        else:
            del self.analysis[int(selected[1])]
        self.refresh()

    def move(self, offset):
        selected = self.selection()
        if not selected:
            return
        index = int(selected[1])
        if selected[0] == "res":
            rows = self.analysis[index]["resource_list"]
            old = int(selected[2])
            target = old + offset
            key = lambda i: f"res:{index}:{i}"
        else:
            rows = self.analysis
            old = index
            target = index + offset
            key = lambda i: f"row:{i}"
        if 0 <= target < len(rows):
            rows[old], rows[target] = rows[target], rows[old]
            self.refresh()
            self.tree.selection_set(key(target))

    def apply(self):
        try:
            if self.analysis and self.analysis[-1]["itemtype"] == 2:
                raise ValueError("分析最后一行是附加费，请在末尾添加“小计”或“舍入”，再应用完整单价。")
            computed = calculate_analysis(self.analysis, self.resources)
            self.result = {"analysis": self.analysis, "resources": self.resources, "rate": str(computed["rate"])}
            self.destroy()
        except (ValueError, ArithmeticError) as error:
            messagebox.showerror("无法应用分析", str(error), parent=self)


class MeasurementDialog(tk.Toplevel):
    FIELDS = [("description", "部位 / 说明", ""), ("count", "数量 / 件数", "1"),
              ("length", "长度", "1"), ("width", "宽度", "1"),
              ("height", "高度 / 厚度", "1"), ("coefficient", "系数", "1")]

    def __init__(self, parent, item):
        super().__init__(parent)
        self.title("工程量明细 · " + item["description"])
        self.geometry("900x540")
        self.transient(parent)
        self.rows = copy.deepcopy(item.get("measurements", []))
        self.result = None
        body = ttk.Frame(self, padding=18)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text="工程量 = 件数 × 长 × 宽 × 高 × 系数；不需要的维度填 1。", style="Hint.TLabel").pack(anchor="w", pady=(0, 12))
        bar = ttk.Frame(body)
        bar.pack(fill="x", pady=(0, 10))
        for title, command in (("新增明细", lambda: self.edit(True)), ("编辑明细", self.edit), ("删除", self.delete)):
            ttk.Button(bar, text=title, command=command).pack(side="left", padx=(0, 8))
        self.tree = table(body, [("description", "部位"), ("count", "件数"), ("length", "长"), ("width", "宽"), ("height", "高"), ("coefficient", "系数"), ("quantity", "工程量")], {"description": 190})
        self.tree.bind("<Double-1>", lambda _event: self.edit())
        bottom = ttk.Frame(body)
        bottom.pack(fill="x", pady=(12, 0))
        self.total = tk.StringVar()
        ttk.Label(bottom, textvariable=self.total, style="Total.TLabel").pack(side="left")
        ttk.Button(bottom, text="取消", command=self.destroy).pack(side="right", padx=6)
        ttk.Button(bottom, text="应用并更新工程量", style="Primary.TButton", command=self.apply).pack(side="right")
        self.grab_set()
        self.refresh()

    @staticmethod
    def quantity(row):
        return measurement_quantity(**{key: row.get(key, 1) for key in ("count", "length", "width", "height", "coefficient")})

    def refresh(self):
        self.tree.delete(*self.tree.get_children())
        total = decimal_value(0)
        for index, row in enumerate(self.rows):
            qty = self.quantity(row)
            total += qty
            self.tree.insert("", "end", iid=str(index), values=(*(row.get(key, "") for key, _, _ in self.FIELDS), number(qty, 4)))
        self.total.set("工程量合计  " + number(total, 4))

    def edit(self, new=False):
        selected = self.tree.selection()
        if not new and not selected:
            return
        index = int(selected[0]) if selected and not new else None

        def validate(values):
            for key, label, _ in self.FIELDS[1:]:
                values[key] = checked(values[key], label, allow_negative=key == "coefficient")

        values = ask_fields(self, "工程量明细", self.FIELDS, self.rows[index] if index is not None else None, validate)
        if values:
            if index is None:
                self.rows.append(values)
            else:
                self.rows[index] = values
            self.refresh()

    def delete(self):
        selected = self.tree.selection()
        for index in sorted((int(s) for s in selected), reverse=True):
            del self.rows[index]
        self.refresh()

    def apply(self):
        self.result = {"measurements": self.rows, "qty": str(sum((self.quantity(row) for row in self.rows), decimal_value(0)))}
        self.destroy()


class DesktopApp:
    def __init__(self, root, data_dir):
        self.root = root
        self.data_dir = Path(data_dir)
        self.project = new_project("新建工程报价")
        self.path = None
        self.loading = False
        self.saved_signature = ""
        self.pending_calc = None
        self.auto_poll = None
        self.last_auto_state = None
        self.status = tk.StringVar(value="就绪 · 数据保存在本机")
        self.vars = {}
        setup_style(root)
        root.title("材料报价桌面版")
        root.geometry("1280x850")
        root.minsize(1060, 730)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.report_callback_exception = self.callback_error
        self.build_menu()
        body = ttk.Frame(root, padding=22)
        body.pack(fill="both", expand=True)
        hero = ttk.Frame(body)
        hero.pack(fill="x", pady=(0, 16))
        ttk.Label(hero, text="材料报价", style="Title.TLabel").pack(side="left")
        ttk.Label(hero, text="  桌面版  /  工程清单 · 单价分析 · 本地材料库", style="Hint.TLabel").pack(side="left", pady=(8, 0))
        actions = ttk.Frame(hero)
        actions.pack(side="right")
        for title, command, primary in (("新建", self.new, False), ("打开", self.open, False), ("保存工程", self.save, False), ("导出 Excel", self.export, True)):
            ttk.Button(actions, text=title, command=command, style="Primary.TButton" if primary else "TButton").pack(side="left", padx=(6, 0))
        self.notebook = ttk.Notebook(body)
        self.notebook.pack(fill="both", expand=True)
        self.quote_page = ttk.Frame(self.notebook, padding=16)
        self.resource_page = ttk.Frame(self.notebook, padding=16)
        self.material_page = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(self.quote_page, text="工程报价")
        self.notebook.add(self.resource_page, text="工程资源")
        self.notebook.add(self.material_page, text="材料库与价格")
        self.build_quote()
        self.build_resources()
        self.materials = MaterialsPanel(self.material_page, on_change=self.material_change, notify=self.notify)
        self.materials.pack(fill="both", expand=True)
        footer = ttk.Frame(body)
        footer.pack(side="bottom", fill="x", pady=(12, 0), before=self.notebook)
        ttk.Label(footer, textvariable=self.status, style="Hint.TLabel").pack(side="left")
        ttk.Button(footer, text="使用说明", command=self.help).pack(side="right")
        root.bind("<Control-s>", lambda _event: self.save())
        root.bind("<Control-o>", lambda _event: self.open())
        root.bind("<Control-n>", lambda _event: self.new())
        self.load_into_ui(self.project)
        self.mark_saved()

    def build_menu(self):
        menu = tk.Menu(self.root)
        files = tk.Menu(menu, tearoff=False)
        for title, command in (("新建工程  Ctrl+N", self.new), ("打开工程  Ctrl+O", self.open), ("保存工程  Ctrl+S", self.save), ("另存为", lambda: self.save(True)), ("导出 Excel", self.export)):
            files.add_command(label=title, command=command)
        files.add_separator()
        files.add_command(label="导入 GEstimator .eproj", command=self.import_eproj)
        files.add_command(label="打开数据目录", command=lambda: os.startfile(self.data_dir))
        files.add_separator()
        files.add_command(label="退出", command=self.close)
        menu.add_cascade(label="文件", menu=files)
        help_menu = tk.Menu(menu, tearoff=False)
        help_menu.add_command(label="使用说明", command=self.help)
        help_menu.add_command(label="关于与开源许可", command=self.about)
        menu.add_cascade(label="帮助", menu=help_menu)
        self.root.config(menu=menu)

    def build_quote(self):
        meta = ttk.Frame(self.quote_page)
        meta.pack(fill="x", pady=(0, 14))
        fields = [("name", "工程名称", "新建工程报价"), ("client", "客户", ""), ("region", "价格地区", "全国"), ("date", "报价日期", dt.date.today().isoformat())]
        for col, (key, label, default) in enumerate(fields):
            ttk.Label(meta, text=label).grid(row=0, column=col, sticky="w", pady=(0, 5))
            var = tk.StringVar(value=default)
            self.vars[key] = var
            ttk.Entry(meta, textvariable=var, width=28 if col < 2 else 16).grid(row=1, column=col, sticky="ew", padx=(0, 12 if col < 3 else 0))
            var.trace_add("write", self.changed)
            meta.columnconfigure(col, weight=2 if col < 2 else 1)
        actions = ttk.Frame(self.quote_page)
        actions.pack(fill="x", pady=(0, 12))
        for title, command in (("＋ 从材料库添加", self.add_material), ("＋ 自定义清单", self.add_item), ("编辑清单", self.edit_item), ("单价分析", self.analyze), ("工程量明细", self.measure), ("更新单价", self.update_rates), ("删除", self.delete_items)):
            ttk.Button(actions, text=title, command=command).pack(side="left", padx=(0, 6))
        self.items_tree = table(self.quote_page, [("code", "编号"), ("description", "项目 / 材料名称"), ("unit", "单位"), ("qty", "工程量"), ("rate", "单价（元）"), ("loss", "损耗率"), ("amount", "金额（元）"), ("source", "价格来源 / 分析")], {"code": 80, "description": 240, "unit": 70, "source": 180})
        self.items_tree.bind("<Double-1>", lambda _event: self.edit_item())
        ttk.Label(self.quote_page, text="选中清单后可分析单价或计算工程量；更新材料库不会改变已保存的报价。", style="Hint.TLabel").pack(anchor="w", pady=(8, 12))
        totals = ttk.Frame(self.quote_page)
        totals.pack(fill="x")
        fees = ttk.Frame(totals)
        fees.pack(side="left", fill="x", expand=True)
        for col, (key, label, default) in enumerate((("labor", "另计人工费（元）", "0"), ("freight", "运费（元）", "0"), ("other_fee", "其他费用（元）", "0"), ("tax_rate", "报价税率（%）", "9"))):
            ttk.Label(fees, text=label).grid(row=0, column=col, sticky="w", padx=(0, 12), pady=(0, 5))
            var = tk.StringVar(value=default)
            self.vars[key] = var
            ttk.Entry(fees, textvariable=var, width=17).grid(row=1, column=col, sticky="ew", padx=(0, 12))
            var.trace_add("write", self.changed)
        summary = ttk.Frame(totals)
        summary.pack(side="right", padx=(20, 0))
        self.total_var = tk.StringVar()
        self.breakdown_var = tk.StringVar()
        ttk.Label(summary, text="含税总报价", style="Hint.TLabel").pack(anchor="e")
        ttk.Label(summary, textvariable=self.total_var, style="Total.TLabel").pack(anchor="e")
        ttk.Label(summary, textvariable=self.breakdown_var, style="Hint.TLabel").pack(anchor="e")
        ttk.Label(self.quote_page, text="报价说明（如有效期、付款方式、包含范围）", style="Hint.TLabel").pack(anchor="w", pady=(12, 5))
        self.note = tk.Text(self.quote_page, height=2, wrap="word", relief="solid", borderwidth=1)
        self.note.pack(fill="x")
        self.note.bind("<KeyRelease>", self.changed)

    def build_resources(self):
        ttk.Label(self.resource_page, text="本工程使用的资源价格用于单价分析。修改后，在工程报价中选中项目并点击“更新单价”。", style="Hint.TLabel").pack(anchor="w", pady=(0, 12))
        actions = ttk.Frame(self.resource_page)
        actions.pack(fill="x", pady=(0, 12))
        for title, command in (("新建资源", self.add_resource), ("从材料库添加", self.add_project_material), ("编辑资源", self.edit_resource), ("删除资源", self.delete_resource), ("导入 GEstimator 工程", self.import_eproj)):
            ttk.Button(actions, text=title, command=command).pack(side="left", padx=(0, 8))
        self.resources_tree = table(self.resource_page, [("code", "编号"), ("description", "资源名称"), ("category", "分类"), ("unit", "单位"), ("rate", "基础单价（元）"), ("vat", "资源税率"), ("discount", "折扣率"), ("net", "分析用单价（元）")], {"description": 300, "code": 100})
        self.resources_tree.bind("<Double-1>", lambda _event: self.edit_resource())
        ttk.Label(self.resource_page, text="材料单价已含税时，资源税率填 0；人工已计入单价分析时，避免再填入另计人工费。", style="Hint.TLabel").pack(anchor="w", pady=(12, 0))

    def collect(self):
        for key, var in self.vars.items():
            value = var.get().strip()
            if key in ("labor", "freight", "other_fee", "tax_rate"):
                value = checked(value, {"labor": "人工费", "freight": "运费", "other_fee": "其他费用", "tax_rate": "税率"}[key])
            self.project[key] = value
        if not self.project["name"]:
            raise ValueError("工程名称不能为空")
        try:
            dt.date.fromisoformat(self.project["date"])
        except ValueError:
            raise ValueError("报价日期请填写 YYYY-MM-DD，例如 2026-11-07") from None
        self.project["note"] = self.note.get("1.0", "end-1c").strip()
        calculate_project(self.project)
        return self.project

    def signature(self):
        project = copy.deepcopy(self.project)
        for key, var in self.vars.items():
            project[key] = var.get().strip()
        project["note"] = self.note.get("1.0", "end-1c").strip()
        return json.dumps(project, sort_keys=True, ensure_ascii=False, default=str)

    def mark_saved(self):
        self.saved_signature = self.signature()
        self.update_title()

    def update_title(self):
        dirty = self.signature() != self.saved_signature
        self.root.title(("* " if dirty else "") + self.vars["name"].get() + " · 材料报价桌面版")

    def changed(self, *_args):
        if self.loading:
            return
        self.update_title()
        if self.pending_calc:
            self.root.after_cancel(self.pending_calc)
        self.pending_calc = self.root.after(150, self.recalculate)

    def recalculate(self):
        self.pending_calc = None
        selected = self.items_tree.selection()
        try:
            project = self.collect()
            totals = calculate_project(project)
            self.items_tree.delete(*self.items_tree.get_children())
            for index, item in enumerate(project["items"]):
                amount = totals["items"][index]["amount"]
                source = "单价分析" if item.get("analysis") else item.get("price_source", "手工录入")
                self.items_tree.insert("", "end", iid=str(index), values=(item["code"], item["description"], item.get("unit", ""), number(item["qty"], 4), number(item["rate"]), str(item.get("loss_rate", 0)) + "%", number(amount), source))
            for iid in selected:
                if self.items_tree.exists(iid):
                    self.items_tree.selection_add(iid)
            self.total_var.set("¥ " + number(totals["total"]))
            self.breakdown_var.set("清单 " + number(totals["subtotal"]) + "    税金 " + number(totals["tax"]))
            self.status.set(f"{len(project['items'])} 条清单 · {len(project['resources'])} 项工程资源 · 金额单位：人民币元")
        except (ValueError, ArithmeticError, KeyError) as error:
            self.total_var.set("请检查输入")
            self.breakdown_var.set(str(error))
        self.update_title()

    def refresh_resources(self):
        self.resources_tree.delete(*self.resources_tree.get_children())
        for index, resource in enumerate(self.project["resources"]):
            self.resources_tree.insert("", "end", iid=str(index), values=(resource["code"], resource["description"], resource.get("category", ""), resource.get("unit", ""), number(resource["rate"]), str(resource.get("vat", 0)) + "%", str(resource.get("discount", 0)) + "%", number(resource_price(resource))))

    def load_into_ui(self, project):
        # Validate everything needed to render before replacing the current model.
        calculate_project(project)
        for resource in project["resources"]:
            str(resource["code"])
            str(resource["description"])
            number(resource["rate"])
            resource_price(resource)
        for item in project["items"]:
            str(item["code"])
            str(item["description"])
            number(item["qty"])
            number(item["rate"])
        self.loading = True
        self.project = copy.deepcopy(project)
        for key, var in self.vars.items():
            var.set(str(self.project.get(key, "0" if key in ("labor", "freight", "other_fee", "tax_rate") else "")))
        self.note.delete("1.0", "end")
        self.note.insert("1.0", self.project.get("note", ""))
        self.loading = False
        self.refresh_resources()
        self.recalculate()

    def selected_item(self):
        selected = self.items_tree.selection()
        if not selected:
            self.notify("请先选中一条工程清单")
            return None
        return self.project["items"][int(selected[0])]

    def next_code(self, prefix, rows):
        index = len(rows) + 1
        while any(row["code"] == prefix + str(index) for row in rows):
            index += 1
        return prefix + str(index)

    def material_resource(self, material):
        code = "M" + str(material["id"])
        resource = next((r for r in self.project["resources"] if r.get("material_id") == material["id"]), None)
        if resource is None:
            while any(r["code"] == code for r in self.project["resources"]):
                code += "A"
            resource = {"code": code, "description": material["name"] + (" " + material["spec"] if material.get("spec") else ""), "unit": material.get("unit", ""), "rate": str(material.get("price") or 0), "vat": "0", "discount": "0", "category": material.get("category", "材料"), "material_id": material["id"], "reference": material.get("price_source", "")}
            self.project["resources"].append(resource)
            self.refresh_resources()
        return resource

    def add_material(self):
        material = material_picker(self.root, self.vars["region"].get() or "全国")
        if material:
            resource = self.material_resource(material)
            item = {"code": self.next_code("Q", self.project["items"]), "description": resource["description"], "unit": resource["unit"], "qty": "1", "rate": str(material.get("price") or 0), "loss_rate": "0", "category": resource.get("category", ""), "analysis": [], "measurements": [], "material_id": material["id"], "price_date": material.get("price_date", ""), "price_region": material.get("price_region", ""), "price_source": material.get("price_source", ""), "remarks": ""}
            self.project["items"].append(item)
            self.recalculate()
            self.items_tree.selection_set(str(len(self.project["items"]) - 1))

    def item_dialog(self, item):
        fields = [("code", "清单编号", item.get("code", "")), ("description", "项目 / 材料名称", ""), ("unit", "单位", ""), ("qty", "工程量", "1"), ("rate", "单价（元）", "0"), ("loss_rate", "损耗率（%）", "0"), ("remarks", "备注", "")]

        def validate(values):
            if not values["description"] or not values["code"]:
                raise ValueError("清单编号和名称不能为空")
            for key, label in (("qty", "工程量"), ("rate", "单价"), ("loss_rate", "损耗率")):
                values[key] = checked(values[key], label, allow_negative=key in ("qty", "rate"))
            if any(other is not item and other["code"] == values["code"] for other in self.project["items"]):
                raise ValueError("清单编号已存在")

        return ask_fields(self.root, "编辑工程清单", fields, item, validate)

    def add_item(self):
        item = {"code": self.next_code("Q", self.project["items"]), "analysis": [], "measurements": [], "qty": "1", "rate": "0", "loss_rate": "0"}
        values = self.item_dialog(item)
        if values:
            item.update(values)
            self.project["items"].append(item)
            self.recalculate()

    def edit_item(self):
        item = self.selected_item()
        if item is not None:
            values = self.item_dialog(item)
            if values:
                item.update(values)
                self.recalculate()

    def delete_items(self):
        selected = self.items_tree.selection()
        if selected and messagebox.askyesno("删除清单", f"删除选中的 {len(selected)} 条清单？", parent=self.root):
            for index in sorted((int(i) for i in selected), reverse=True):
                del self.project["items"][index]
            self.recalculate()

    def analyze(self):
        item = self.selected_item()
        if item is None:
            return
        dialog = AnalysisDialog(self.root, item, self.project["resources"])
        self.root.wait_window(dialog)
        if dialog.result:
            item["analysis"] = dialog.result["analysis"]
            item["rate"] = dialog.result["rate"]
            self.project["resources"] = dialog.result["resources"]
            self.refresh_resources()
            self.recalculate()
            self.notify("已应用单价分析，并更新该清单单价")

    def measure(self):
        item = self.selected_item()
        if item is None:
            return
        if item.get("source_measurements") and not item.get("measurements"):
            messagebox.showinfo("原工程测量记录", "原 GEstimator 的自定义测量模板已随工程保留。本版使用件数、长、宽、高和系数重新录入；原数量在应用新明细前保留。", parent=self.root)
        dialog = MeasurementDialog(self.root, item)
        self.root.wait_window(dialog)
        if dialog.result:
            item.update(dialog.result)
            self.recalculate()

    def update_rates(self):
        selected = self.items_tree.selection()
        if not selected:
            self.notify("请先选择需要更新单价的清单")
            return
        if not messagebox.askyesno("更新选中清单的单价", "将按当前工程资源或材料库的最新价格更新选中清单。是否继续？", parent=self.root):
            return
        project = copy.deepcopy(self.project)
        materials = {m["id"]: m for m in store.current_prices(self.vars["region"].get() or "全国")}
        count = 0
        try:
            for iid in selected:
                item = project["items"][int(iid)]
                if item.get("analysis"):
                    item["rate"] = str(calculate_analysis(item["analysis"], project["resources"])["rate"])
                elif item.get("material_id") in materials and materials[item["material_id"]]["price"] is not None:
                    material = materials[item["material_id"]]
                    item.update(rate=str(material["price"]), price_date=material["price_date"], price_region=material["price_region"], price_source=material["price_source"])
                else:
                    continue
                count += 1
            self.project = project
            self.recalculate()
            self.notify(f"已更新 {count} 条清单单价；未找到价格的项目保持原价")
        except (ValueError, ArithmeticError) as error:
            messagebox.showerror("更新失败", str(error), parent=self.root)

    def add_resource(self):
        values = ask_fields(self.root, "新建工程资源", RESOURCE_FIELDS, {"code": self.next_code("R", self.project["resources"])}, validate_resource)
        if values:
            if any(r["code"] == values["code"] for r in self.project["resources"]):
                messagebox.showerror("编号重复", "工程资源编号已存在", parent=self.root)
                return
            self.project["resources"].append(values)
            self.refresh_resources()
            self.changed()

    def add_project_material(self):
        material = material_picker(self.root, self.vars["region"].get() or "全国")
        if material:
            self.material_resource(material)
            self.changed()

    def edit_resource(self):
        selected = self.resources_tree.selection()
        if not selected:
            return
        resource = self.project["resources"][int(selected[0])]
        values = ask_fields(self.root, "编辑工程资源", RESOURCE_FIELDS, resource, validate_resource)
        if values:
            if any(r is not resource and r["code"] == values["code"] for r in self.project["resources"]):
                messagebox.showerror("编号重复", "资源编号已存在", parent=self.root)
                return
            old_code = resource["code"]
            resource.update(values)
            for item in self.project["items"]:
                for row in item.get("analysis", []):
                    for line in row.get("resource_list", []):
                        if line[0] == old_code:
                            line[0] = resource["code"]
            self.refresh_resources()
            self.changed()

    def delete_resource(self):
        selected = self.resources_tree.selection()
        if not selected:
            return
        index = int(selected[0])
        resource = self.project["resources"][index]
        if any(line[0] == resource["code"] for item in self.project["items"] for row in item.get("analysis", []) for line in row.get("resource_list", [])):
            messagebox.showinfo("资源正在使用", "该资源已用于清单的单价分析，请先在分析中删除对应资源行。", parent=self.root)
            return
        if messagebox.askyesno("删除工程资源", "删除“" + resource["description"] + "”？", parent=self.root):
            del self.project["resources"][index]
            self.refresh_resources()
            self.changed()

    def confirm_unsaved(self):
        if self.signature() == self.saved_signature:
            return True
        choice = messagebox.askyesnocancel("工程尚未保存", "是否保存当前工程的修改？", parent=self.root)
        if choice is None:
            return False
        return self.save() if choice else True

    def new(self):
        if self.confirm_unsaved():
            self.path = None
            self.load_into_ui(new_project("新建工程报价"))
            self.mark_saved()
            self.notebook.select(self.quote_page)

    def open(self):
        if not self.confirm_unsaved():
            return
        path = filedialog.askopenfilename(parent=self.root, initialdir=self.data_dir / "projects", title="打开工程", filetypes=[("工程文件", "*.estimate.json *.json *.eproj"), ("全部文件", "*.*")])
        if not path:
            return
        try:
            imported = path.lower().endswith(".eproj")
            project = load_eproj(path) if imported else load_project(path)
            self.load_into_ui(project)
            self.path = None if imported else Path(path)
            self.mark_saved()
            self.notebook.select(self.quote_page)
            self.notify("已导入 GEstimator 工程，请另存为桌面版工程" if imported else "已打开工程：" + Path(path).name)
            if imported:
                self.import_notice()
        except Exception as error:
            messagebox.showerror("无法打开工程", str(error), parent=self.root)

    def import_eproj(self):
        if not self.confirm_unsaved():
            return
        path = filedialog.askopenfilename(parent=self.root, title="导入 GEstimator 工程或定额库", filetypes=[("GEstimator 工程", "*.eproj")])
        if path:
            try:
                project = load_eproj(path)
                self.load_into_ui(project)
                self.path = None
                self.mark_saved()
                self.import_notice()
                self.notify(f"已只读导入 {len(project['items'])} 条清单和 {len(project['resources'])} 项资源，请另存工程")
            except Exception as error:
                messagebox.showerror("导入失败", str(error), parent=self.root)

    def import_notice(self):
        messagebox.showinfo("GEstimator 工程已导入", "原文件保持不变，清单和资源价格按原工程导入。\n\n自带 DSR 是印度定额，分析可能包含 GST 等当地费用；用于国内项目前，请修改材料价格、附加费和报价税率。\n\n自定义测量模板的原始数据会保留，当前版提供件数 × 长 × 宽 × 高的工程量明细。", parent=self.root)

    def save(self, save_as=False):
        try:
            project = self.collect()
            path = self.path
            if save_as or path is None:
                name = "".join(c for c in project["name"] if c not in '\\/:*?"<>|').strip() or "工程报价"
                selected = filedialog.asksaveasfilename(parent=self.root, initialdir=self.data_dir / "projects", initialfile=name + ".estimate.json", defaultextension=".estimate.json", filetypes=[("桌面版工程", "*.estimate.json")], title="保存工程")
                if not selected:
                    return False
                path = Path(selected)
            save_project(project, path)
            self.path = Path(path)
            self.mark_saved()
            self.notify("已保存：" + self.path.name)
            return True
        except Exception as error:
            messagebox.showerror("保存失败", str(error), parent=self.root)
            return False

    def export(self):
        try:
            project = self.collect()
            name = "".join(c for c in project["name"] if c not in '\\/:*?"<>|') or "工程报价"
            path = filedialog.asksaveasfilename(parent=self.root, initialfile=name + ".xlsx", defaultextension=".xlsx", filetypes=[("Excel 工作簿", "*.xlsx")], title="导出工程报价")
            if path:
                export_project_xlsx(project, path)
                self.notify("Excel 已导出：" + str(path))
                messagebox.showinfo("导出完成", "已导出报价单、工程资源、单价分析、工程量明细和价格来源。", parent=self.root)
        except Exception as error:
            messagebox.showerror("导出失败", str(error), parent=self.root)

    def material_change(self):
        self.notify("材料库已更新；已保存的工程报价保留原单价")

    def poll_auto_updates(self):
        import autoupdate
        state = autoupdate.status()
        signature = (state["running"], state["last_update"], state["last_check"], state["last_error"])
        if signature != self.last_auto_state:
            self.last_auto_state = signature
            if not self.materials._busy:
                self.materials.refresh()
                if state["running"]:
                    self.materials.update_status.set("正在后台检查统计局最新价格…")
                elif state["last_error"]:
                    self.materials.update_status.set("价格检查失败，可手动重试；本地报价功能可正常使用。")
                elif state["last_result"]:
                    self.materials.update_status.set(state["last_result"])
        self.auto_poll = self.root.after(2000, self.poll_auto_updates)

    def notify(self, text):
        self.status.set(text)

    def help(self):
        manual = APP_DIR / "使用说明.md"
        if not manual.exists():
            manual = HOME_DIR / "使用说明.md"
        content = manual.read_text(encoding="utf-8") if manual.exists() else "1. 在材料库维护价格。\n2. 在工程报价添加材料或自定义清单。\n3. 为清单设置单价分析和工程量明细。\n4. 保存工程并导出 Excel。\n\n材料价格更新后，选中清单并点击更新单价才会修改报价。"
        window = tk.Toplevel(self.root)
        window.title("材料报价 · 使用说明")
        window.geometry("900x680")
        body = ttk.Frame(window, padding=20)
        body.pack(fill="both", expand=True)
        text = tk.Text(body, wrap="word", padx=15, pady=12, relief="flat", font=("Microsoft YaHei UI", 11))
        scrollbar = ttk.Scrollbar(body, command=text.yview)
        text.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        text.pack(fill="both", expand=True)
        text.insert("1.0", content.replace("**", "").replace("`", ""))
        text.configure(state="disabled")

    def about(self):
        messagebox.showinfo("关于材料报价桌面版", f"材料报价桌面版 {VERSION}\n\n基于 GEstimator 2.7 的工程清单及单价分析模型\n原作者：Manu Varkey\n中文界面使用 Python / Tkinter，数据保存在本机\n\n开源许可：GPL-3.0-or-later\n详见发行目录 LICENSE 与 NOTICE.md", parent=self.root)

    def callback_error(self, exc, value, traceback):
        logging.error("界面操作异常", exc_info=(exc, value, traceback))
        messagebox.showerror("操作失败", str(value), parent=self.root)

    def close(self):
        if self.confirm_unsaved():
            self.root.destroy()


def demo_project():
    project = new_project("城南办公楼 · 材料报价示例")
    project.update(client="示例客户", region="广州市", date=dt.date.today().isoformat(), labor="0", freight="800", other_fee="200", tax_rate="9", note="示例价格仅用于演示，请根据项目实际信息价调整。报价有效期 7 天。")
    project["resources"] = [{"code": "R1", "description": "螺纹钢 HRB400E Φ20", "unit": "吨", "rate": "3520", "vat": "0", "discount": "0", "category": "钢材"}, {"code": "R2", "description": "普通硅酸盐水泥 P.O 42.5", "unit": "吨", "rate": "415", "vat": "0", "discount": "0", "category": "水泥"}, {"code": "R3", "description": "搬运人工", "unit": "工日", "rate": "280", "vat": "0", "discount": "0", "category": "人工"}]
    analysis = [{"itemtype": 0, "description": "材料与人工", "resource_list": [["R2", "1", ""], ["R3", "0.1", ""]], "code": ""}, {"itemtype": 1, "description": "合计"}, {"itemtype": 4, "description": "单价", "value": 2}]
    project["items"] = [{"code": "Q1", "description": "螺纹钢 HRB400E Φ20", "unit": "吨", "qty": "12.5", "rate": "3520", "loss_rate": "2", "analysis": [], "measurements": [], "price_source": "示例信息价", "remarks": ""}, {"code": "Q2", "description": "水泥采购及搬运", "unit": "吨", "qty": "20", "rate": "443", "loss_rate": "0", "analysis": analysis, "measurements": [], "remarks": "材料和搬运人工已组价"}]
    return project


def self_test():
    """不联网、不操作正式数据；检查 GUI / 金额 / 工程保存 / Excel 导出。"""
    from openpyxl import load_workbook
    with tempfile.TemporaryDirectory(prefix="material-quote-test-") as temporary:
        data = prepare_data(temporary)
        root = tk.Tk()
        root.withdraw()
        try:
            app = DesktopApp(root, data)
            app.load_into_ui(demo_project())
            root.update_idletasks()
            totals = calculate_project(app.collect())
            assert totals["total"] == decimal_value("59666.60"), totals
            assert calculate_analysis(app.project["items"][1]["analysis"], app.project["resources"])["rate"] == decimal_value("443")
            path = Path(temporary) / "中文工程.estimate.json"
            save_project(app.collect(), path)
            reopened = load_project(path)
            assert reopened["items"][1]["analysis"]
            assert calculate_project(reopened)["total"] == totals["total"]
            output = Path(temporary) / "中文报价.xlsx"
            export_project_xlsx(reopened, output)
            book = load_workbook(output, data_only=True)
            assert {"报价单", "工程资源", "单价分析", "工程量明细", "价格来源"} <= set(book.sheetnames)
            assert len(app.items_tree.get_children()) == 2
            assert len(app.resources_tree.get_children()) == 3
            book.close()
            print("SELF-TEST OK: native GUI, decimal totals, project roundtrip, Excel export")
        finally:
            root.destroy()


def main():
    parser = argparse.ArgumentParser(description="中文材料报价桌面版")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--demo", action="store_true", help="打开价格演示工程")
    parser.add_argument("--smoke-exit", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("project", nargs="?")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    logs = HOME_DIR / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=logs / "desktop.log", level=logging.INFO, encoding="utf-8", format="%(asctime)s %(levelname)s %(message)s")
    if sys.platform == "win32":
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    data = prepare_data()
    root = tk.Tk()
    app = DesktopApp(root, data)
    logging.info("Desktop GUI ready: version=%s data=%s", VERSION, data)
    if not args.smoke_exit:
        import autoupdate
        autoupdate.start_background()
        app.poll_auto_updates()
    if args.demo:
        app.load_into_ui(demo_project())
        app.mark_saved()
    elif args.project:
        path = Path(args.project)
        project = load_eproj(path) if path.suffix.lower() == ".eproj" else load_project(path)
        app.load_into_ui(project)
        app.path = None if path.suffix.lower() == ".eproj" else path
        app.mark_saved()
    if args.smoke_exit:
        root.after(args.smoke_exit * 1000, root.destroy)
    root.mainloop()
    logging.info("Desktop GUI closed normally")


if __name__ == "__main__":
    main()
