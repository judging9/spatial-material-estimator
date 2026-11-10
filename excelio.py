# -*- coding: utf-8 -*-
"""Excel / CSV 导入导出。"""
import io
import csv
import re
import datetime
import math

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter

FIELD_ALIASES = {
    "name": ["名称", "材料名称", "产品名称", "品名", "材料", "规格名称"],
    "spec": ["规格", "规格型号", "型号", "规格/型号"],
    "unit": ["单位", "计价单位"],
    "region": ["地区", "区域", "城市", "省市"],
    "price": ["价格", "单价", "市场价", "含税价", "信息价", "除税价", "市场信息价"],
    "price_date": ["日期", "价格日期", "时间", "发布期", "年月"],
    "supplier": ["供应商", "厂家", "品牌", "生产厂家"],
    "source": ["来源", "数据来源"],
    "category": ["分类", "类别", "材料类别"],
}

THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD_FILL = PatternFill("solid", fgColor="F2F2F2")


def _norm(v):
    if v is None:
        return ""
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, datetime.date):
        return v.strftime("%Y-%m-%d")
    return str(v).strip()


def _norm_date(v):
    """把 2026/10/31、2026年10月31日、2026-10 等统一成 2026-10-31 形式。"""
    s = _norm(v)
    if not s:
        return ""
    m = re.match(r"^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})", s)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return datetime.date(y, mo, d).isoformat()
        except ValueError:
            return s
    m = re.match(r"^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$", s)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        if 1 <= mo <= 12:
            nxt = datetime.date(y + (mo == 12), (mo % 12) + 1, 1)
            return (nxt - datetime.timedelta(days=1)).isoformat()
    return s


def _field_candidates(header):
    """按匹配强度给表头排序可用字段：完全相等 > 前缀/后缀 > 包含，且长词优先。

    这样「价格日期」不会被当成「价格」，「规格型号」也不会被当成「名称」。
    """
    h = _norm(header).replace(" ", "")
    scored = []
    for key, names in FIELD_ALIASES.items():
        best = 0.0
        for n in names:
            if h == n:
                best = max(best, 3.0 + len(n) / 100.0)
            elif h.startswith(n) or h.endswith(n):
                best = max(best, 2.0 + len(n) / 100.0)
            elif n in h:
                best = max(best, 1.0 + len(n) / 100.0)
        if best:
            scored.append((best, key))
    scored.sort(reverse=True)
    return [k for _, k in scored]


def _read_rows(content, filename):
    low = (filename or "").lower()
    if low.endswith(".csv") or low.endswith(".txt"):
        for enc in ("utf-8-sig", "gbk", "utf-8"):
            try:
                text = content.decode(enc)
                break
            except UnicodeDecodeError:
                text = None
        if text is None:
            raise ValueError("无法识别文件编码，请另存为 UTF-8 或 xlsx")
        return [r for r in csv.reader(io.StringIO(text))]
    wb = load_workbook(io.BytesIO(content), data_only=True)
    ws = wb[wb.sheetnames[0]]
    return [[c for c in row] for row in ws.iter_rows(values_only=True)]


def parse_price_file(content, filename):
    """解析导入文件，返回 {headers, mapping, rows, errors}。"""
    raw = _read_rows(content, filename)
    if not raw:
        raise ValueError("文件是空的")
    header = raw[0]
    mapping = {}
    for i, h in enumerate(header):
        for k in _field_candidates(h):
            if k not in mapping:
                mapping[k] = i
                break
    if "name" not in mapping or "price" not in mapping:
        raise ValueError("表头里找不到“名称”或“价格”列，请检查第一行表头")
    rows, errors = [], []
    for n, r in enumerate(raw[1:], start=2):
        def get(k):
            i = mapping.get(k)
            return _norm(r[i]) if i is not None and i < len(r) else ""

        name = get("name")
        if not name:
            continue
        price_txt = get("price").replace(",", "").replace("元", "")
        try:
            price = float(price_txt)
        except ValueError:
            errors.append("第%d行价格不是数字：%s" % (n, price_txt))
            continue
        if not math.isfinite(price) or price < 0:
            errors.append("第%d行价格必须是非负的有限数字：%s" % (n, price_txt))
            continue
        rows.append({
            "name": name,
            "spec": get("spec"),
            "unit": get("unit"),
            "region": get("region") or "全国",
            "price": price,
            "price_date": _norm_date(get("price_date")) or datetime.date.today().isoformat(),
            "source": get("source") or "Excel导入",
            "supplier": get("supplier"),
            "category": get("category"),
            "note": "",
            "region_provided": bool(get("region")),
            "source_provided": bool(get("source")),
            "date_provided": bool(get("price_date")),
        })
    return {
        "headers": [_norm(h) for h in header],
        "mapping": mapping,
        "rows": rows,
        "errors": errors[:20],
    }


def _sheet_head(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


def export_quote_xlsx(quote, items):
    wb = Workbook()
    ws = wb.active
    ws.title = "报价单"
    ws.sheet_view.showGridLines = False
    _sheet_head(ws, [6, 26, 22, 9, 10, 12, 8, 14])

    ws.merge_cells("A1:H1")
    ws["A1"] = quote.get("title") or "材料报价单"
    ws["A1"].font = Font(size=16, bold=True)
    ws["A1"].alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[1].height = 34

    meta = [
        ("客户：", quote.get("client") or "—", "报价日期：", quote.get("quote_date") or ""),
        ("价格地区：", quote.get("region") or "全国", "说明：", quote.get("note") or ""),
    ]
    r = 2
    for a, b, c, d in meta:
        ws.cell(r, 1, a).font = Font(bold=True)
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=3)
        ws.cell(r, 2, b)
        ws.cell(r, 4, c).font = Font(bold=True)
        ws.merge_cells(start_row=r, start_column=5, end_row=r, end_column=8)
        ws.cell(r, 5, d)
        r += 1

    head_row = 5
    headers = ["序号", "材料名称", "规格型号", "单位", "数量", "单价(元)", "损耗率", "小计(元)"]
    for i, h in enumerate(headers, start=1):
        c = ws.cell(head_row, i, h)
        c.font = Font(bold=True)
        c.fill = HEAD_FILL
        c.border = BORDER
        c.alignment = Alignment(horizontal="center", vertical="center")

    row = head_row + 1
    for i, it in enumerate(items, start=1):
        vals = [
            i, it["name"], it["spec"], it["unit"],
            float(it["qty"]), float(it["unit_price"]),
            float(it["loss_rate"]) / 100.0, float(it["line_total"]),
        ]
        for col, v in enumerate(vals, start=1):
            c = ws.cell(row, col, v)
            c.border = BORDER
            c.alignment = Alignment(
                horizontal="left" if col in (2, 3) else "center", vertical="center")
        ws.cell(row, 6).number_format = "#,##0.00"
        ws.cell(row, 7).number_format = "0%"
        ws.cell(row, 8).number_format = "#,##0.00"
        row += 1

    total_row = row
    rows_tail = [
        ("材料小计", quote["material_subtotal"]),
        ("人工费", quote["labor"]),
        ("运费", quote["freight"]),
        ("其他费用", quote["other_fee"]),
        ("不含税合计", quote["before_tax"]),
        ("税金（%s%%）" % (("%g" % quote["tax_rate"])), quote["tax"]),
        ("合计（含税）", quote["total"]),
    ]
    for label, value in rows_tail:
        ws.merge_cells(start_row=total_row, start_column=1, end_row=total_row, end_column=7)
        c = ws.cell(total_row, 1, label)
        c.alignment = Alignment(horizontal="right", vertical="center")
        c.font = Font(bold=(label.startswith("合计") or label.startswith("不含税")))
        c.border = BORDER
        v = ws.cell(total_row, 8, value)
        v.number_format = "#,##0.00"
        v.border = BORDER
        v.font = Font(bold=(label.startswith("合计")))
        total_row += 1

    ws.cell(total_row + 1, 1, "价格来源见材料库价格记录；本表由材料报价系统生成。").font = Font(size=9, color="808080")

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def export_template():
    wb = Workbook()
    ws = wb.active
    ws.title = "价格导入模板"
    headers = ["材料名称", "规格型号", "单位", "地区", "价格", "价格日期", "供应商", "来源", "分类"]
    for i, h in enumerate(headers, start=1):
        c = ws.cell(1, i, h)
        c.font = Font(bold=True)
        c.fill = HEAD_FILL
        c.border = BORDER
    sample = [
        ["普通硅酸盐水泥", "P.O 42.5 散装", "吨", "广州市", 415, "2026-10-31", "海螺水泥", "广州造价信息2026年10月", "水泥"],
        ["螺纹钢", "HRB400E Φ20", "吨", "广州市", 3520, "2026-10-31", "韶钢", "广州造价信息2026年10月", "钢材"],
    ]
    for r, row in enumerate(sample, start=2):
        for c, v in enumerate(row, start=1):
            ws.cell(r, c, v).border = BORDER
    _sheet_head(ws, [22, 22, 8, 10, 10, 14, 16, 30, 10])
    ws2 = wb.create_sheet("填写说明")
    notes = [
        "1. 第一行表头不要改：材料名称、规格型号、单位、地区、价格、价格日期、供应商、来源、分类。",
        "2. 每行一条价格；同一材料+地区+日期+来源重复导入会自动覆盖为最新值。",
        "3. 地区和来源用来区分“广州信息价”“全国市场价”，报价时按地区取最新价。",
        "4. 材料名称+规格+单位相同的行会合并到同一材料；不存在的材料会自动新建。",
        "5. 支持 .xlsx / .csv（UTF-8 或 GBK）。",
    ]
    for i, n in enumerate(notes, start=1):
        ws2.cell(i, 1, n)
    ws2.column_dimensions["A"].width = 100
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
