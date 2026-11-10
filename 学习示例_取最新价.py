# -*- coding: utf-8 -*-
"""演示：价格如何更新、报价如何取到“最新价”。跑在数据库副本上，不动正式数据。"""
import os
import shutil

import store

SRC = store.DB_PATH
DEMO = os.path.join(store.DATA_DIR, "_demo.db")
shutil.copyfile(SRC, DEMO)
store.DB_PATH = DEMO

out = []


def log(*a):
    out.append(" ".join(str(x) for x in a))


c = store.connect()
mid = c.execute("SELECT id FROM materials WHERE name='螺纹钢'").fetchone()["id"]
c.close()

log("【1】现在的数据：")
p = store.latest_price(store.connect(), mid, "全国")
log("   螺纹钢 全国价 =", p["price"], "日期", p["price_date"], "来源", p["source"])

log("\n【2】抓一期新数据（2026-11-05，3400 元/吨）写进去：")
store.upsert_price(mid, "全国", 3400, "2026-11-05", "国家统计局", note="11月上旬")
p = store.latest_price(store.connect(), mid, "全国")
log("   现在取到 =", p["price"], "日期", p["price_date"])
log("   → 取价规则：WHERE material_id=? ORDER BY price_date DESC LIMIT 1")

log("\n【3】再抓一次同一天同来源（数据被修正成 3410）：")
c = store.connect()
before = c.execute("SELECT COUNT(*) n FROM prices WHERE material_id=?", (mid,)).fetchone()["n"]
c.close()
store.upsert_price(mid, "全国", 3410, "2026-11-05", "国家统计局", note="11月上旬")
c = store.connect()
after = c.execute("SELECT COUNT(*) n FROM prices WHERE material_id=?", (mid,)).fetchone()["n"]
c.close()
p = store.latest_price(store.connect(), mid, "全国")
log("   价格条数：%d → %d（没有变多），值变成 %s" % (before, after, p["price"]))
log("   → 唯一索引 UNIQUE(material_id, region, price_date, source) + ON CONFLICT DO UPDATE")

log("\n【4】给广州市录一条更早的地区价（3550，2026-11-01），按广州市取价：")
store.upsert_price(mid, "广州市", 3550, "2026-11-01", "广州造价信息")
p_gz = store.latest_price(store.connect(), mid, "广州市")
p_cn = store.latest_price(store.connect(), mid, "全国")
log("   广州市取到 =", p_gz["price"], p_gz["price_date"], p_gz["region"],
    "| 全国取到 =", p_cn["price"], p_cn["price_date"], p_cn["region"])
log("   → 先按地区精确匹配，地区没有再退“全国”；注意：地区价即使更旧也优先，")
log("     因为对报价来说“本地价”比“全国最新”更贴近实际。")

log("\n【5】没有该地区价时怎么退：用“深圳市”取价：")
p_sz = store.latest_price(store.connect(), mid, "深圳市")
log("   深圳市 →", p_sz["price"], p_sz["region"], p_sz["price_date"], "（退到了全国）")

log("\n【6】报价单里点选材料时发生了什么：")
m = [x for x in store.current_prices("广州市") if x["id"] == mid][0]
log("   选“螺纹钢”带出的单价 =", m["price"], "（来自", m["price_region"], m["price_date"], "）")
log("   → 前端 addMaterialItem() 直接把 m.price 写进这一行的 unit_price")

log("\n【7】保存报价单 = 存快照：")
q = store.save_quote({
    "title": "演示单", "client": "甲", "region": "广州市", "quote_date": "2026-11-07",
    "labor": 0, "freight": 0, "other_fee": 0, "tax_rate": 9,
    "items": [{"material_id": mid, "name": "螺纹钢", "spec": "", "unit": "吨",
               "qty": 10, "unit_price": m["price"], "loss_rate": 0}],
})
log("   保存后合计 =", q["total"], "（单价 %s × 10 吨 × 1.09）" % m["price"])

store.upsert_price(mid, "广州市", 4200, "2026-11-07", "供应商询价")
q2 = store.get_quote(q["id"])
log("   涨价后再读这张已保存的报价单：单价 =", q2["items"][0]["unit_price"], "合计 =", q2["total"],
    "（没变）")
m2 = [x for x in store.current_prices("广州市") if x["id"] == mid][0]
log("   但材料库里已经是最新价 =", m2["price"], "；新建一张单会带出 4200")
log("   → 已出的报价单不会自己变价（否则发出去的报价会变），要更新就重新选材料或手改单价")

open("demo_out.txt", "w", encoding="utf-8").write("\n".join(out))
print("ok")
