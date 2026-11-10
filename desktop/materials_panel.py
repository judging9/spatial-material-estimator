# -*- coding: utf-8 -*-
"""中文材料库、价格维护以及报价单的模态材料选择器。"""
from __future__ import annotations

import datetime
import math
from pathlib import Path
import queue
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import autoupdate
import excelio
import store


PRICE_COLUMNS = (
    ("name", "材料名称", 180),
    ("spec", "规格型号", 190),
    ("unit", "单位", 65),
    ("category", "分类", 90),
    ("price", "最新单价（元）", 120),
    ("price_region", "价格地区", 100),
    ("price_date", "价格日期", 110),
    ("price_source", "来源", 225),
)


def _money(value):
    return "未录入" if value is None else f"{float(value):,.2f}"


def _valid_price(value):
    try:
        amount = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        raise ValueError("价格请填写数字，例如 3520.50。") from None
    if not math.isfinite(amount) or amount < 0:
        raise ValueError("价格必须是大于或等于 0 的有效数字。")
    return amount


def _valid_date(value):
    try:
        text = str(value).strip()
        normalized = datetime.date.fromisoformat(text).isoformat()
        if normalized != text:
            raise ValueError
        return normalized
    except (TypeError, ValueError):
        raise ValueError("日期请按 年-月-日 填写，例如 2026-11-07。") from None


def _table(master, columns, selectmode="browse", checks=False):
    frame = ttk.Frame(master)
    frame.rowconfigure(0, weight=1)
    frame.columnconfigure(0, weight=1)
    tree = ttk.Treeview(
        frame, columns=[key for key, _, _ in columns],
        show="tree headings" if checks else "headings", selectmode=selectmode,
    )
    if checks:
        tree.heading("#0", text="导入")
        tree.column("#0", width=60, minwidth=60, stretch=False, anchor="center")
    for key, title, width in columns:
        tree.heading(key, text=title)
        tree.column(key, width=width, minwidth=55,
                    stretch=key in ("name", "spec", "price_source", "source", "note"),
                    anchor="e" if key == "price" else "w")
    tree.grid(row=0, column=0, sticky="nsew")
    vertical = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
    vertical.grid(row=0, column=1, sticky="ns")
    horizontal = ttk.Scrollbar(frame, orient="horizontal", command=tree.xview)
    horizontal.grid(row=1, column=0, sticky="ew")
    tree.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
    tree.tag_configure("alternate", background="#f3f6fa")
    return frame, tree


def _show_modal(window, parent):
    previous_grab = window.grab_current()
    window.transient(parent.winfo_toplevel())
    window.update_idletasks()
    width, height = window.winfo_width(), window.winfo_height()
    owner = parent.winfo_toplevel()
    x = max(0, owner.winfo_rootx() + (owner.winfo_width() - width) // 2)
    y = max(0, owner.winfo_rooty() + (owner.winfo_height() - height) // 2)
    window.geometry(f"+{x}+{y}")
    window.grab_set()
    try:
        window.wait_window()
    finally:
        if previous_grab is not None:
            try:
                if previous_grab.winfo_exists():
                    previous_grab.grab_set()
            except tk.TclError:
                pass


class MaterialsPanel(ttk.Frame):
    """on_change() 在材料或价格变更后调用；notify(message) 显示状态文字。"""

    def __init__(self, master, on_change, notify=None):
        super().__init__(master, padding=18)
        self.on_change = on_change
        self.notify = notify
        self.region = tk.StringVar(self, value="全国")
        self.query = tk.StringVar(self)
        self.summary = tk.StringVar(self)
        self.update_status = tk.StringVar(self)
        self.auto_enabled = tk.BooleanVar(self)
        self._rows = {}
        self._tasks = queue.Queue()
        self._busy = False
        self._alive = True
        self._search_after = None
        self._poll_after = None
        self._buttons = []
        self._build()
        self.bind("<Destroy>", self._on_destroy, add="+")
        self.refresh()
        self._poll_after = self.after(100, self._poll)

    def _button(self, master, text, command):
        button = ttk.Button(master, text=text, command=command)
        button.pack(side="left", padx=(0, 8))
        self._buttons.append(button)
        return button

    def _build(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)
        ttk.Label(self, text="材料库与价格", font=("Microsoft YaHei UI", 18, "bold")).grid(
            row=0, column=0, sticky="w", pady=(0, 14))

        filters = ttk.Frame(self)
        filters.grid(row=1, column=0, sticky="ew", pady=(0, 12))
        ttk.Label(filters, text="搜索").pack(side="left", padx=(0, 6))
        search = ttk.Entry(filters, textvariable=self.query, width=32)
        search.pack(side="left", padx=(0, 16))
        search.bind("<Return>", lambda _event: self.refresh())
        self.query.trace_add("write", self._schedule_search)
        ttk.Label(filters, text="取价地区").pack(side="left", padx=(0, 6))
        region = ttk.Entry(filters, textvariable=self.region, width=15)
        region.pack(side="left", padx=(0, 8))
        region.bind("<Return>", lambda _event: self.refresh())
        self._button(filters, "查询", self.refresh)
        ttk.Label(filters, textvariable=self.summary).pack(side="right")

        actions = ttk.Frame(self)
        actions.grid(row=2, column=0, sticky="ew", pady=(0, 12))
        for text, command in (
            ("新增材料", self._new_material), ("编辑材料", self._edit_material),
            ("录入价格", self._new_price), ("价格历史", self._history),
            ("删除材料", self._delete_material),
        ):
            self._button(actions, text, command)

        table_frame, self.tree = _table(self, PRICE_COLUMNS)
        table_frame.grid(row=3, column=0, sticky="nsew")
        self.tree.bind("<Double-1>", lambda _event: self._history())
        self.tree.bind("<Delete>", lambda _event: self._delete_material())

        ttk.Label(self, text="优先使用所选地区价格，缺少时取全国或其他地区价格；表内标明实际来源。").grid(
            row=4, column=0, sticky="w", pady=(8, 12))
        footer = ttk.Frame(self)
        footer.grid(row=5, column=0, sticky="ew")
        self._button(footer, "导入 Excel / CSV", self._import_file)
        self._button(footer, "下载导入模板", self._export_template)
        self._button(footer, "更新统计局价格", self._update_nbs)
        self.progress = ttk.Progressbar(footer, mode="indeterminate", length=105)
        self.progress.pack(side="right", padx=(12, 0))
        options = ttk.Frame(self)
        options.grid(row=6, column=0, sticky="ew", pady=(12, 0))
        self.auto_check = ttk.Checkbutton(
            options, text="软件运行时自动检查价格（每 6 小时）",
            variable=self.auto_enabled, command=self._set_auto,
        )
        self.auto_check.pack(side="left")
        ttk.Label(options, textvariable=self.update_status, wraplength=600).pack(
            side="left", padx=(18, 0))

    def refresh(self):
        if not self._alive:
            return
        previous = self.tree.selection()
        selected = previous[0] if previous else None
        try:
            rows = store.current_prices(self.region.get().strip() or "全国", self.query.get().strip())
            status = autoupdate.status()
        except Exception as exc:
            self._error("读取材料失败", exc)
            return
        self._rows = {str(row["id"]): row for row in rows}
        self.tree.delete(*self.tree.get_children())
        for number, row in enumerate(rows):
            values = [_money(row.get(key)) if key == "price" else row.get(key, "")
                      for key, _, _ in PRICE_COLUMNS]
            self.tree.insert("", "end", iid=str(row["id"]), values=values,
                             tags=("alternate",) if number % 2 else ())
        if selected in self._rows:
            self.tree.selection_set(selected)
            self.tree.see(selected)
        self.summary.set(f"共 {len(rows)} 种材料")
        self.auto_enabled.set(status["enabled"])
        period = status.get("last_period") or "尚未获取统计局价格"
        updated = status.get("last_update") or ""
        self.update_status.set(period + (f"  ·  更新于 {updated}" if updated else ""))

    def selected_material(self):
        selection = self.tree.selection()
        row = self._rows.get(selection[0]) if selection else None
        return dict(row) if row is not None else None

    def _selected(self):
        row = self.selected_material()
        if row is None:
            messagebox.showinfo("选择材料", "请先在表格中选择一种材料。", parent=self)
        return row

    def _schedule_search(self, *_args):
        if self._search_after is not None:
            self.after_cancel(self._search_after)
        self._search_after = self.after(250, self._search)

    def _search(self):
        self._search_after = None
        self.refresh()

    def _changed(self, message, mid=None):
        self.refresh()
        if mid is not None and str(mid) in self._rows:
            self.tree.selection_set(str(mid))
            self.tree.see(str(mid))
        if self.notify:
            self.notify(message)
        if self.on_change:
            self.on_change()

    def _error(self, title, error):
        messagebox.showerror(title, str(error), parent=self)

    def _new_material(self):
        if not self._busy:
            self._material_dialog()

    def _edit_material(self):
        if not self._busy:
            row = self._selected()
            if row is not None:
                self._material_dialog(row)

    def _material_dialog(self, row=None):
        row = row or {}
        window = tk.Toplevel(self)
        window.title("编辑材料" if row else "新增材料")
        window.resizable(False, False)
        body = ttk.Frame(window, padding=20)
        body.pack(fill="both", expand=True)
        fields = (("name", "材料名称 *"), ("spec", "规格型号"),
                  ("unit", "计价单位"), ("category", "材料分类"), ("note", "备注"))
        variables = {}
        first = None
        for number, (key, caption) in enumerate(fields):
            ttk.Label(body, text=caption).grid(row=number, column=0, sticky="w", padx=(0, 14), pady=6)
            variables[key] = tk.StringVar(window, value=row.get(key, ""))
            entry = ttk.Entry(body, textvariable=variables[key], width=42)
            entry.grid(row=number, column=1, sticky="ew", pady=6)
            first = first or entry
        ttk.Label(body, text="同名、同规格、同单位只建立一次；价格单独维护。").grid(
            row=5, column=0, columnspan=2, sticky="w", pady=(6, 14))

        def save():
            data = {key: variable.get().strip() for key, variable in variables.items()}
            if row:
                data["id"] = row["id"]
            try:
                result = store.save_material(data)
            except Exception as exc:
                messagebox.showerror("材料未保存", str(exc), parent=window)
                return
            window.destroy()
            self._changed("材料已保存", result["id"])

        buttons = ttk.Frame(body)
        buttons.grid(row=6, column=0, columnspan=2, sticky="e")
        ttk.Button(buttons, text="取消", command=window.destroy).pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="保存材料", command=save).pack(side="left")
        window.bind("<Escape>", lambda _event: window.destroy())
        first.focus_set()
        _show_modal(window, self)

    def _delete_material(self):
        if self._busy:
            return
        row = self._selected()
        if row is None:
            return
        if not messagebox.askyesno(
            "删除材料", f"确定删除「{row['name']} {row['spec']}」吗？\n\n"
            "该材料的历史价格也会删除。已保存报价单中的名称和单价仍会保留。",
            parent=self, default="no",
        ):
            return
        try:
            store.delete_material(row["id"])
        except Exception as exc:
            self._error("删除失败", exc)
            return
        self._changed("材料及其价格记录已删除")

    def _new_price(self):
        if self._busy:
            return
        row = self._selected()
        if row is None:
            return
        window = tk.Toplevel(self)
        window.title("录入材料价格")
        window.resizable(False, False)
        body = ttk.Frame(window, padding=20)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text=f"{row['name']}  {row['spec']}  / {row['unit']}",
                  font=("Microsoft YaHei UI", 11, "bold")).grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 12))
        values = {
            "price": "" if row.get("price") is None else str(row["price"]),
            "region": self.region.get().strip() or "全国", "price_date": store.today_str(),
            "source": "手工录入", "supplier": "", "note": "",
        }
        variables = {}
        first = None
        for number, (key, caption) in enumerate((
            ("price", "单价（元） *"), ("region", "价格地区"), ("price_date", "价格日期 *"),
            ("source", "价格来源"), ("supplier", "供应商"), ("note", "备注"),
        ), start=1):
            ttk.Label(body, text=caption).grid(row=number, column=0, sticky="w", padx=(0, 14), pady=6)
            variables[key] = tk.StringVar(window, value=values[key])
            entry = ttk.Entry(body, textvariable=variables[key], width=42)
            entry.grid(row=number, column=1, sticky="ew", pady=6)
            first = first or entry
        ttk.Label(body, text="同一材料、地区、日期和来源的记录会更新为本次价格。").grid(
            row=7, column=0, columnspan=2, sticky="w", pady=(8, 14))

        def save():
            data = {key: variable.get().strip() for key, variable in variables.items()}
            try:
                price = _valid_price(data["price"])
                date = _valid_date(data["price_date"])
                store.upsert_price(row["id"], data["region"], price, date,
                                   data["source"], data["supplier"], data["note"])
            except Exception as exc:
                messagebox.showerror("价格未保存", str(exc), parent=window)
                return
            window.destroy()
            self._changed("价格已保存，报价单可选用最新价格", row["id"])

        buttons = ttk.Frame(body)
        buttons.grid(row=8, column=0, columnspan=2, sticky="e")
        ttk.Button(buttons, text="取消", command=window.destroy).pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="保存价格", command=save).pack(side="left")
        window.bind("<Escape>", lambda _event: window.destroy())
        first.focus_set()
        _show_modal(window, self)

    def _history(self):
        row = self._selected()
        if row is None:
            return
        try:
            records = store.price_history(row["id"], limit=1000)
        except Exception as exc:
            self._error("价格历史读取失败", exc)
            return
        window = tk.Toplevel(self)
        window.title(f"价格历史 · {row['name']}")
        window.geometry("950x460")
        body = ttk.Frame(window, padding=18)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text=f"{row['name']}  {row['spec']}  / {row['unit']}",
                  font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w", pady=(0, 12))
        columns = (("price_date", "价格日期", 110), ("region", "地区", 100),
                   ("price", "单价（元）", 110), ("source", "来源", 230),
                   ("supplier", "供应商", 130), ("note", "备注", 200))
        frame, tree = _table(body, columns)
        frame.pack(fill="both", expand=True)
        for number, record in enumerate(records):
            values = [_money(record[key]) if key == "price" else record.get(key, "")
                      for key, _, _ in columns]
            tree.insert("", "end", values=values, tags=("alternate",) if number % 2 else ())
        footer = ttk.Frame(body)
        footer.pack(fill="x", pady=(12, 0))
        ttk.Label(footer, text=f"最近 {len(records)} 条价格记录" if records else "还没有价格记录，可从「录入价格」添加。").pack(side="left")
        ttk.Button(footer, text="关闭", command=window.destroy).pack(side="right")
        window.bind("<Escape>", lambda _event: window.destroy())
        _show_modal(window, self)

    def _export_template(self):
        filename = filedialog.asksaveasfilename(
            parent=self, title="保存价格导入模板", initialfile="材料价格导入模板.xlsx",
            defaultextension=".xlsx", filetypes=[("Excel 工作簿", "*.xlsx")],
        )
        if not filename:
            return
        try:
            Path(filename).write_bytes(excelio.export_template())
        except Exception as exc:
            self._error("模板保存失败", exc)
            return
        if self.notify:
            self.notify(f"导入模板已保存到 {filename}")

    def _import_file(self):
        if self._busy:
            return
        filename = filedialog.askopenfilename(
            parent=self, title="选择材料价格文件",
            filetypes=[("Excel / CSV", "*.xlsx *.csv"), ("Excel 工作簿", "*.xlsx"),
                       ("CSV 表格", "*.csv")],
        )
        if not filename:
            return

        def parse():
            return excelio.parse_price_file(Path(filename).read_bytes(), Path(filename).name)

        self._start_task(parse, lambda result: self._preview_import(filename, result), "正在解析价格文件…")

    def _preview_import(self, filename, result):
        rows, errors = [], list(result.get("errors", []))
        for row in result.get("rows", []):
            try:
                data = dict(row)
                data["price"] = _valid_price(data["price"])
                data["price_date"] = _valid_date(data["price_date"])
                rows.append(data)
            except ValueError as exc:
                errors.append(f"{row.get('name', '材料')}：{exc}")
        if not rows:
            messagebox.showerror("没有可导入的价格", "\n".join(errors[:8]) or "文件中没有有效材料价格。", parent=self)
            return
        window = tk.Toplevel(self)
        window.title("价格导入预览")
        window.geometry("1040x560")
        body = ttk.Frame(window, padding=18)
        body.pack(fill="both", expand=True)
        ttk.Label(body, text=Path(filename).name, font=("Microsoft YaHei UI", 12, "bold")).pack(
            anchor="w", pady=(0, 8))
        selected = set(range(len(rows)))
        summary = tk.StringVar(window)
        ttk.Label(body, textvariable=summary).pack(anchor="w", pady=(0, 10))
        columns = (("name", "材料名称", 170), ("spec", "规格型号", 160),
                   ("unit", "单位", 60), ("region", "地区", 90),
                   ("price", "单价（元）", 110), ("price_date", "价格日期", 110),
                   ("source", "来源", 185), ("supplier", "供应商", 120))
        frame, tree = _table(body, columns, checks=True)
        frame.pack(fill="both", expand=True)
        for number, row in enumerate(rows):
            values = [_money(row[key]) if key == "price" else row.get(key, "") for key, _, _ in columns]
            tree.insert("", "end", iid=str(number), text="☑", values=values,
                        tags=("alternate",) if number % 2 else ())

        def update_summary():
            summary.set(f"识别到 {len(rows)} 条有效价格，已勾选 {len(selected)} 条。点击左侧勾选框可调整。")

        def toggle(event):
            if tree.identify_column(event.x) != "#0":
                return
            iid = tree.identify_row(event.y)
            if iid:
                index = int(iid)
                if index in selected:
                    selected.remove(index)
                else:
                    selected.add(index)
                tree.item(iid, text="☑" if index in selected else "☐")
                update_summary()

        def choose_all(checked):
            selected.clear()
            if checked:
                selected.update(range(len(rows)))
            for iid in tree.get_children():
                tree.item(iid, text="☑" if checked else "☐")
            update_summary()

        tree.bind("<Button-1>", toggle, add="+")
        update_summary()
        if errors:
            ttk.Label(body, text="已跳过无效行：" + "；".join(errors[:4]), wraplength=960).pack(
                anchor="w", pady=(10, 0))
        ttk.Label(body, text="已有材料自动匹配；相同材料、地区、日期和来源的记录会覆盖。新材料可在下方选择是否创建。",
                  wraplength=960).pack(anchor="w", pady=(10, 8))
        allow_new = tk.BooleanVar(window, value=True)
        ttk.Checkbutton(body, text="自动创建库中不存在的材料", variable=allow_new).pack(anchor="w")
        buttons = ttk.Frame(body)
        buttons.pack(fill="x", pady=(12, 0))
        ttk.Button(buttons, text="全选", command=lambda: choose_all(True)).pack(side="left", padx=(0, 8))
        ttk.Button(buttons, text="全不选", command=lambda: choose_all(False)).pack(side="left")

        def import_rows():
            if not selected:
                messagebox.showinfo("选择价格", "请至少勾选一条价格。", parent=window)
                return
            chosen = [rows[index] for index in sorted(selected)]
            create = allow_new.get()
            window.destroy()

            def complete(out):
                text = f"导入完成：写入 {out['prices']} 条价格，新增 {out['created_materials']} 种材料。"
                self._changed(text)
                messagebox.showinfo("价格导入完成", text, parent=self)

            self._start_task(lambda: store.add_price_batch(chosen, allow_new=create), complete, "正在导入价格…")

        ttk.Button(buttons, text="确认导入", command=import_rows).pack(side="right", padx=(8, 0))
        ttk.Button(buttons, text="取消", command=window.destroy).pack(side="right")
        window.bind("<Escape>", lambda _event: window.destroy())
        _show_modal(window, self)

    def _set_auto(self):
        try:
            store.set_setting("auto_update", "1" if self.auto_enabled.get() else "0")
        except Exception as exc:
            self._error("设置未保存", exc)
            self.refresh()
            return
        if self.notify:
            self.notify("已开启自动检查价格" if self.auto_enabled.get() else "已关闭自动检查价格")

    def _update_nbs(self):
        def complete(result):
            if result.get("status") == "error":
                self.update_status.set("更新失败，可稍后重试或导入价格文件。")
                self._error("统计局价格更新失败", result.get("message", "请检查网络后重试。"))
                return
            self._changed(result.get("message", "价格检查完成"))

        self._start_task(lambda: autoupdate.check_once(force=True), complete, "正在检查统计局最新价格…")

    def _start_task(self, task, completed, status):
        if self._busy or not self._alive:
            return
        self._busy = True
        for button in self._buttons:
            button.state(["disabled"])
        self.progress.start(12)
        self.update_status.set(status)
        if self.notify:
            self.notify(status)

        def worker():
            try:
                result = task()
                self._tasks.put((completed, result, None))
            except Exception as exc:
                self._tasks.put((completed, None, exc))

        threading.Thread(target=worker, name="desktop-price-task", daemon=True).start()

    def _poll(self):
        self._poll_after = None
        if not self._alive:
            return
        try:
            completed, result, error = self._tasks.get_nowait()
        except queue.Empty:
            pass
        else:
            self._busy = False
            self.progress.stop()
            for button in self._buttons:
                button.state(["!disabled"])
            if error is not None:
                self.update_status.set("操作失败，可稍后重试。")
                self._error("价格操作失败", error)
            else:
                self.refresh()
                try:
                    completed(result)
                except Exception as exc:
                    self._error("价格操作未完成", exc)
        if self._alive:
            self._poll_after = self.after(100, self._poll)

    def _on_destroy(self, event):
        if event.widget is not self:
            return
        self._alive = False
        for handle in (self._poll_after, self._search_after):
            if handle is not None:
                try:
                    self.after_cancel(handle)
                except tk.TclError:
                    pass


def material_picker(parent, region="全国"):
    """模态选料，返回含最新价格的 store.current_prices 字典，取消返回 None。"""
    window = tk.Toplevel(parent)
    window.title("选择报价材料")
    window.geometry("1030x540")
    body = ttk.Frame(window, padding=18)
    body.pack(fill="both", expand=True)
    ttk.Label(body, text="从材料库添加到报价单", font=("Microsoft YaHei UI", 13, "bold")).pack(
        anchor="w", pady=(0, 14))
    filters = ttk.Frame(body)
    filters.pack(fill="x", pady=(0, 12))
    query = tk.StringVar(window)
    region_value = tk.StringVar(window, value=region or "全国")
    ttk.Label(filters, text="材料搜索").pack(side="left", padx=(0, 6))
    search = ttk.Entry(filters, textvariable=query, width=30)
    search.pack(side="left", padx=(0, 16))
    ttk.Label(filters, text="取价地区").pack(side="left", padx=(0, 6))
    region_entry = ttk.Entry(filters, textvariable=region_value, width=15)
    region_entry.pack(side="left", padx=(0, 8))
    frame, tree = _table(body, PRICE_COLUMNS)
    frame.pack(fill="both", expand=True)
    rows_by_id = {}
    result = None
    pending = None

    def refresh():
        nonlocal pending
        if pending is not None:
            window.after_cancel(pending)
            pending = None
        try:
            rows = store.current_prices(region_value.get().strip() or "全国", query.get().strip())
        except Exception as exc:
            messagebox.showerror("材料读取失败", str(exc), parent=window)
            return
        rows_by_id.clear()
        tree.delete(*tree.get_children())
        for number, row in enumerate(rows):
            iid = str(row["id"])
            rows_by_id[iid] = row
            values = [_money(row.get(key)) if key == "price" else row.get(key, "") for key, _, _ in PRICE_COLUMNS]
            tree.insert("", "end", iid=iid, values=values, tags=("alternate",) if number % 2 else ())
        if rows:
            tree.selection_set(str(rows[0]["id"]))

    def schedule(*_args):
        nonlocal pending
        if pending is not None:
            window.after_cancel(pending)
        pending = window.after(250, refresh)

    def close():
        nonlocal pending
        if pending is not None:
            window.after_cancel(pending)
            pending = None
        window.destroy()

    def choose(_event=None):
        nonlocal result
        selection = tree.selection()
        if not selection:
            messagebox.showinfo("选择材料", "请在表格中选择一种材料。", parent=window)
            return
        # 选中时再次查询，取用户当前填写地区对应的最新价格。
        try:
            fresh = store.current_prices(region_value.get().strip() or "全国")
            result = next((dict(row) for row in fresh if str(row["id"]) == selection[0]), None)
        except Exception as exc:
            messagebox.showerror("材料读取失败", str(exc), parent=window)
            return
        if result is None:
            messagebox.showinfo("材料已变更", "该材料已被删除，请选择其他材料。", parent=window)
            refresh()
            return
        close()

    ttk.Button(filters, text="查询", command=refresh).pack(side="left")
    search.bind("<Return>", lambda _event: refresh())
    region_entry.bind("<Return>", lambda _event: refresh())
    query.trace_add("write", schedule)
    tree.bind("<Double-1>", choose)
    tree.bind("<Return>", choose)
    footer = ttk.Frame(body)
    footer.pack(fill="x", pady=(12, 0))
    ttk.Label(footer, text="暂无价格的材料可添加后手工填写单价。实际取价地区、日期和来源见表格。").pack(side="left")
    ttk.Button(footer, text="添加到报价", command=choose).pack(side="right", padx=(8, 0))
    ttk.Button(footer, text="取消", command=close).pack(side="right")
    window.protocol("WM_DELETE_WINDOW", close)
    window.bind("<Escape>", lambda _event: close())
    refresh()
    search.focus_set()
    _show_modal(window, parent)
    return result
