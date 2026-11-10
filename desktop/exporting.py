# -*- coding: utf-8 -*-
"""中文工程报价与 GEstimator 单价分析导出，GPL-3.0-or-later。"""
from __future__ import annotations

import io
import os
from pathlib import Path
import tempfile

from openpyxl import load_workbook
from openpyxl.styles import Alignment, Font, PatternFill

import excelio
from estimate_core import (calculate_analysis, calculate_project, decimal_value,
                           measurement_quantity, resource_price)


def write_rows(sheet, headers, rows, widths=None):
    sheet.append(headers)
    sheet.freeze_panes = "A2"
    sheet.sheet_view.showGridLines = False
    for cell in sheet[1]:
        cell.font = Font(name="Microsoft YaHei", bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="245BD6")
        cell.alignment = Alignment(vertical="center")
    sheet.row_dimensions[1].height = 27
    for row in rows:
        sheet.append(row)
    for column, width in enumerate(widths or [18] * len(headers), 1):
        sheet.column_dimensions[excelio.get_column_letter(column)].width = width
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.font = Font(name="Microsoft YaHei", size=10)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            if isinstance(cell.value, (int, float)):
                cell.number_format = "#,##0.00####"
    sheet.auto_filter.ref = sheet.dimensions


def export_project_xlsx(project, path):
    totals = calculate_project(project)
    quote = {"title": project["name"], "client": project.get("client", ""),
             "region": project.get("region", "全国"), "quote_date": project.get("date", ""),
             "note": project.get("note", ""), "material_subtotal": float(totals["subtotal"]),
             "labor": float(totals["labor"]), "freight": float(totals["freight"]),
             "other_fee": float(totals["other_fee"]), "before_tax": float(totals["net"]),
             "tax_rate": float(decimal_value(project.get("tax_rate", 0))),
             "tax": float(totals["tax"]), "total": float(totals["total"])}
    items = []
    for item in totals["items"]:
        amount = item["amount"]
        items.append({"name": item["description"], "spec": item.get("remarks", ""),
                      "unit": item.get("unit", ""), "qty": item["qty"], "unit_price": item["rate"],
                      "loss_rate": item.get("loss_rate", 0), "line_total": amount})
    workbook = load_workbook(io.BytesIO(excelio.export_quote_xlsx(quote, items)))
    quote_sheet = workbook["报价单"]
    quote_sheet["B5"] = "项目 / 材料名称"
    quote_sheet["C5"] = "备注"
    quote_sheet["A" + str(6 + len(items))] = "清单小计"
    quote_sheet.print_options.horizontalCentered = True
    quote_sheet.sheet_properties.pageSetUpPr.fitToPage = True
    quote_sheet.page_setup.orientation = "landscape"
    quote_sheet.page_setup.paperSize = quote_sheet.PAPERSIZE_A4
    quote_sheet.page_setup.fitToWidth = 1
    quote_sheet.page_setup.fitToHeight = 0
    resources = {resource["code"]: resource for resource in project.get("resources", [])}
    write_rows(workbook.create_sheet("工程资源"),
               ["编号", "资源名称", "分类", "单位", "基础单价（元）", "资源税率（%）", "折扣率（%）", "分析用单价（元）"],
               [(r["code"], r["description"], r.get("category", ""), r.get("unit", ""),
                 float(decimal_value(r["rate"])), float(decimal_value(r.get("vat", 0))),
                 float(decimal_value(r.get("discount", 0))), float(resource_price(r)))
                for r in resources.values()], [14, 38, 16, 10, 18, 18, 16, 20])
    analysis_rows = []
    kinds = {0: "资源分组", 1: "小计", 2: "附加比例", 3: "乘数系数", 4: "舍入"}
    for item in project.get("items", []):
        analysis = item.get("analysis", [])
        if not analysis:
            continue
        computed = calculate_analysis(analysis, project["resources"])
        analysis_rows.append((item["code"], item["description"], "清单单价快照", "", "", "", float(decimal_value(item["rate"]))))
        for index, row in enumerate(analysis):
            kind = row["itemtype"]
            result = computed["results"][index]
            amount = result[-1] if kind == 0 else result
            value = row.get("value", "")
            if kind == 2:
                value = str(decimal_value(value) * 100) + "%"
            analysis_rows.append((item["code"], row.get("description", ""), kinds[kind], "", str(value), "", float(amount)))
            if kind == 0:
                for subindex, line in enumerate(row.get("resource_list", [])):
                    resource = resources[line[0]]
                    rate, line_amount = result[subindex]
                    analysis_rows.append((line[0], resource["description"], "资源", resource.get("unit", ""), float(decimal_value(line[1])), float(rate), float(line_amount)))
        analysis_rows.append((item["code"], "当前资源价格计算的单价", "分析结果", "", "", "", float(computed["rate"])))
        analysis_rows.append(("", "", "", "", "", "", ""))
    write_rows(workbook.create_sheet("单价分析"),
               ["编号", "说明", "类型", "单位", "用量 / 比例", "资源单价（元）", "金额（元）"],
               analysis_rows, [14, 44, 20, 10, 20, 20, 20])
    measurement_rows = []
    for item in project.get("items", []):
        for row in item.get("measurements", []):
            dimensions = {key: row.get(key, 1) for key in ("count", "length", "width", "height", "coefficient")}
            qty = measurement_quantity(**dimensions)
            measurement_rows.append((item["code"], item["description"], row.get("description", ""),
                                     *(float(decimal_value(dimensions[key])) for key in dimensions), float(qty)))
    write_rows(workbook.create_sheet("工程量明细"),
               ["清单编号", "清单名称", "部位 / 说明", "件数", "长度", "宽度", "高度", "系数", "工程量"],
               measurement_rows, [14, 32, 32, 12, 12, 12, 12, 12, 18])
    write_rows(workbook.create_sheet("价格来源"),
               ["清单编号", "清单名称", "报价单价快照（元）", "价格地区", "价格日期", "来源", "计价方式"],
               [(item["code"], item["description"], float(decimal_value(item["rate"])),
                 item.get("price_region", ""), item.get("price_date", ""), item.get("price_source", ""),
                 "单价分析快照" if item.get("analysis") else "手工 / 材料库")
                for item in project.get("items", [])], [14, 38, 24, 18, 18, 40, 24])
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".xlsx", delete=False) as stream:
            temporary = Path(stream.name)
        workbook.save(temporary)
        os.replace(temporary, target)
    finally:
        workbook.close()
        if temporary and temporary.exists():
            temporary.unlink()
