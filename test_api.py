# -*- coding: utf-8 -*-
"""端到端接口自测（开发用，可删）。"""
import io
import json
import sys

import requests

B = "http://127.0.0.1:8765"
out = io.StringIO()


def log(*a):
    print(*a, file=out)


def get(p):
    r = requests.get(B + p, timeout=30)
    return r


def post(p, body):
    r = requests.post(B + p, json=body, timeout=60)
    return r


log("== stats", get("/api/stats").json())

# 1. 统计局抓取
r = post("/api/scrape/nbs/preview", {})
d = r.json()
log("== nbs preview", r.status_code, "ok=", d.get("ok"))
if d.get("ok"):
    data = d["data"]
    log("   title:", data["title"][:40], "| period:", data["period"], "| date:", data["price_date"])
    log("   rows:", len(data["rows"]))
    for row in data["rows"][:4]:
        log("   ", row["name"], "|", row["spec"], "|", row["unit"], "|", row["price"], "|", row["change_pct"])
    rows = data["rows"]
    r2 = post("/api/scrape/apply", {"rows": rows})
    log("== nbs apply", r2.json())

# 2. 材料与价格
mats = get("/api/materials?region=全国").json()["data"]
priced = [m for m in mats if m["price"] is not None]
log("== materials", len(mats), "priced:", len(priced))
for m in priced[:5]:
    log("   ", m["name"], m["spec"], m["price"], m["unit"], m["price_date"])

# 3. 报价单
items = []
for m in priced[:3]:
    items.append({
        "material_id": m["id"], "name": m["name"], "spec": m["spec"], "unit": m["unit"],
        "qty": 12.5, "unit_price": m["price"], "loss_rate": 2,
    })
if not items:
    items = [{"name": "测试材料", "spec": "", "unit": "吨", "qty": 10, "unit_price": 100, "loss_rate": 0}]
quote = {
    "title": "测试报价单-城南项目", "client": "某建设集团", "region": "全国",
    "quote_date": "2026-11-07", "labor": 5000, "freight": 1200, "other_fee": 300,
    "tax_rate": 9, "note": "含税含运，有效期7天", "items": items,
}
r = post("/api/quotes", quote)
q = r.json()
log("== quote save", r.status_code, json.dumps(q.get("data", {}).get("total") if q.get("ok") else q, ensure_ascii=False))
if q.get("ok"):
    qd = q["data"]
    log("   id:", qd["id"], "sub:", qd["material_subtotal"], "before:", qd["before_tax"],
        "tax:", qd["tax"], "total:", qd["total"])
    # 导出
    r3 = get("/api/quotes/%d/export.xlsx" % qd["id"])
    log("== export", r3.status_code, len(r3.content), "bytes")
    open("_test_quote.xlsx", "wb").write(r3.content)
    # 读回验证
    from openpyxl import load_workbook
    wb = load_workbook("_test_quote.xlsx")
    ws = wb.active
    log("   xlsx sheets:", wb.sheetnames, "A1:", ws["A1"].value, "max_row:", ws.max_row)

# 4. 模板 + 导入
r4 = get("/api/template.xlsx")
log("== template", r4.status_code, len(r4.content), "bytes")
csv = "材料名称,规格型号,单位,地区,价格,价格日期,供应商,来源,分类\n" \
      "中砂,机制砂 2.3-3.0,立方米,广州市,138,2026-10-31,某砂场,广州造价信息2026年10月,砂石\n" \
      "碎石,16-31.5mm,立方米,广州市,126,2026-10-31,某石场,广州造价信息2026年10月,砂石\n"
r5 = requests.post(B + "/api/import/preview?name=test.csv", data=csv.encode("utf-8"),
                   headers={"Content-Type": "application/octet-stream"}, timeout=30)
log("== import preview", r5.status_code, r5.json().get("ok"), len(r5.json().get("data", {}).get("rows", [])))
if r5.json().get("ok"):
    rows = r5.json()["data"]["rows"]
    log("   ", rows)
    r6 = post("/api/import/apply", {"rows": rows})
    log("== import apply", r6.json())

# 5. 地区价回退
mats2 = get("/api/materials?region=广州市").json()["data"]
for m in mats2:
    if m["name"] in ("中砂", "碎石", "螺纹钢"):
        log("== region price", m["name"], m["price"], m["price_region"], m["price_date"])

# 6. 通用抓取预览（用统计局页面测试表格解析）
r7 = post("/api/scrape/preview", {"url": "https://www.stats.gov.cn/sj/zxfb/202611/t20261103_1965738.html"})
d7 = r7.json()
log("== generic preview", r7.status_code, "tables:", len(d7.get("data", {}).get("tables", [])))
if d7.get("ok") and d7["data"]["tables"]:
    t = d7["data"]["tables"][0]
    log("   table0 rows/cols:", t["rows"], t["cols"], t["sample"][0][:5])

# 7. 保存抓取源
r8 = post("/api/sources", {"name": "统计局测试", "kind": "nbs", "url": "https://www.stats.gov.cn/sj/zxfb/", "mapping": {}, "region": "全国"})
log("== source save", r8.json().get("ok"), r8.json().get("data", {}).get("id"))
r9 = post("/api/sources/%d/run" % r8.json()["data"]["id"], {})
log("== source run", r9.json())

# 8. 最近价格
r10 = get("/api/prices/recent")
log("== recent", len(r10.json()["data"]))

open("test_out.txt", "w", encoding="utf-8").write(out.getvalue())
print("done")
