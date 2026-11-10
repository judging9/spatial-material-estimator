# -*- coding: utf-8 -*-
"""数据层：SQLite 存储、材料/价格/报价单的增删改查与计算。"""
import os
import re
import sqlite3
import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "app.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_material ON materials(name, spec, unit);

CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
    region TEXT NOT NULL DEFAULT '全国',
    price REAL NOT NULL,
    price_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    supplier TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_price ON prices(material_id, region, price_date, source);
CREATE INDEX IF NOT EXISTS ix_price_mat ON prices(material_id, price_date DESC);

CREATE TABLE IF NOT EXISTS quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT '未命名报价',
    client TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '全国',
    quote_date TEXT NOT NULL,
    labor REAL NOT NULL DEFAULT 0,
    freight REAL NOT NULL DEFAULT 0,
    other_fee REAL NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 9,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quote_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    material_id INTEGER,
    name TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    qty REAL NOT NULL DEFAULT 0,
    unit_price REAL NOT NULL DEFAULT 0,
    loss_rate REAL NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_item_quote ON quote_items(quote_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'table',
    url TEXT NOT NULL,
    mapping TEXT NOT NULL DEFAULT '{}',
    region TEXT NOT NULL DEFAULT '全国',
    last_run TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
"""


def now_str():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str():
    return datetime.date.today().strftime("%Y-%m-%d")


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    c = connect()
    c.executescript(SCHEMA)
    c.commit()
    if not c.execute("SELECT COUNT(*) FROM materials").fetchone()[0]:
        seed(c)
    c.close()
    dedupe_materials()


# ------------------------------------------------------- 名称归一（防重复）
# 抓来的规格写法五花八门：Φ20mm，HRB400E / Φ20mm HRB400E / φ20mm,HRB400E
# 直接按字符串比较会重复建材料，所以先归一化再比。
NAME_ALIASES = {
    "热轧板卷": "热轧普通板卷",
    "热轧卷板": "热轧普通板卷",
    "高线": "线材",
    "普通硅酸盐水泥(散装)": "普通硅酸盐水泥",
}

_PUNCT_MAP = {
    "，": ",", "、": ",", "；": ",", ";": ",",
    "—": "-", "–": "-", "－": "-", "~": "-", "～": "-",
    "×": "x", "＊": "*", "（": "(", "）": ")", "．": ".",
}


def norm_name(name):
    n = (name or "").strip()
    return NAME_ALIASES.get(n, n)


def norm_key(s):
    """把名称/规格/单位归一成用于比较的键：去空白、统一标点、忽略大小写。"""
    s = (s or "").strip().lower()
    for a, b in _PUNCT_MAP.items():
        s = s.replace(a, b)
    s = re.sub(r"[\s,]+", "", s)
    return s


def _material_key(name, spec, unit):
    return (norm_key(norm_name(name)), norm_key(spec), norm_key(unit))


def material_index(c):
    """{归一化键: 材料id}，用于导入时判断是不是同一种材料。"""
    return {
        _material_key(r["name"], r["spec"], r["unit"]): r["id"]
        for r in c.execute("SELECT id,name,spec,unit FROM materials")
    }


def dedupe_materials():
    """合并历史上因规格写法不同而重复建的材料，返回合并条数。"""
    c = connect()
    groups = {}
    for r in c.execute("SELECT id,name,spec,unit FROM materials ORDER BY id"):
        groups.setdefault(_material_key(r["name"], r["spec"], r["unit"]), []).append(r["id"])
    merged = 0
    for ids in groups.values():
        if len(ids) < 2:
            continue
        counts = {i: c.execute("SELECT COUNT(*) FROM prices WHERE material_id=?", (i,)).fetchone()[0] for i in ids}
        keep = max(ids, key=lambda i: (counts[i], -i))
        for other in ids:
            if other == keep:
                continue
            for p in c.execute("SELECT * FROM prices WHERE material_id=?", (other,)).fetchall():
                c.execute(
                    """INSERT INTO prices(material_id,region,price,price_date,source,supplier,note,created_at)
                       VALUES(?,?,?,?,?,?,?,?)
                       ON CONFLICT(material_id,region,price_date,source) DO UPDATE SET
                         price=excluded.price, supplier=excluded.supplier, note=excluded.note""",
                    (keep, p["region"], p["price"], p["price_date"], p["source"],
                     p["supplier"], p["note"], p["created_at"]),
                )
            c.execute("DELETE FROM materials WHERE id=?", (other,))
            merged += 1
    c.commit()
    c.close()
    return merged


def seed(c):
    """首次启动时放一批常用建材（不带价格），价格由抓取/导入填充。

    名称与规格尽量贴近国家统计局的写法，这样第一次抓取就能直接对上、不会重复建材料。
    """
    rows = [
        ("螺纹钢", "Φ20mm HRB400E", "吨", "钢材"),
        ("线材", "Φ8-10mm HPB300", "吨", "钢材"),
        ("普通中板", "20mm Q235", "吨", "钢材"),
        ("热轧普通板卷", "4.75-11.5mm Q235", "吨", "钢材"),
        ("无缝钢管", "219*6 20#", "吨", "钢材"),
        ("角钢", "5#", "吨", "钢材"),
        ("铝锭", "A00", "吨", "金属"),
        ("电解铜", "1#", "吨", "金属"),
        ("普通硅酸盐水泥", "P.O 42.5 散装", "吨", "水泥"),
        ("普通硅酸盐水泥", "P.O 42.5 袋装", "吨", "水泥"),
        ("浮法平板玻璃", "5/6mm", "吨", "玻璃"),
        ("中砂", "机制砂 2.3-3.0", "立方米", "砂石"),
        ("碎石", "16-31.5mm", "立方米", "砂石"),
        ("加气混凝土砌块", "600×200×100", "立方米", "砌体"),
        ("石膏板", "1200×2400×9.5", "张", "板材"),
        ("木工板", "1220×2440×15", "张", "板材"),
    ]
    t = now_str()
    for name, spec, unit, cat in rows:
        c.execute(
            "INSERT OR IGNORE INTO materials(name,spec,unit,category,note,created_at) VALUES(?,?,?,?,'',?)",
            (name, spec, unit, cat, t),
        )
    c.commit()


# ---------------------------------------------------------------- 材料

def list_materials(q=""):
    c = connect()
    sql = "SELECT * FROM materials"
    args = []
    if q:
        sql += " WHERE name LIKE ? OR spec LIKE ? OR category LIKE ?"
        args = ["%%%s%%" % q, "%%%s%%" % q, "%%%s%%" % q]
    sql += " ORDER BY category, name, spec"
    rows = [dict(r) for r in c.execute(sql, args)]
    c.close()
    return rows


def save_material(data):
    c = connect()
    mid = data.get("id")
    vals = (
        (data.get("name") or "").strip(),
        (data.get("spec") or "").strip(),
        (data.get("unit") or "").strip(),
        (data.get("category") or "").strip(),
        (data.get("note") or "").strip(),
    )
    if not vals[0]:
        raise ValueError("材料名称不能为空")
    if mid:
        c.execute(
            "UPDATE materials SET name=?,spec=?,unit=?,category=?,note=? WHERE id=?",
            vals + (mid,),
        )
    else:
        dup = material_index(c).get(_material_key(vals[0], vals[1], vals[2]))
        if dup:
            c.close()
            raise ValueError("材料库里已经有同名同规格同单位的材料（编号 %d），直接改它的价格就行" % dup)
        cur = c.execute(
            "INSERT INTO materials(name,spec,unit,category,note,created_at) VALUES(?,?,?,?,?,?)",
            vals + (now_str(),),
        )
        mid = cur.lastrowid
    c.commit()
    row = dict(c.execute("SELECT * FROM materials WHERE id=?", (mid,)).fetchone())
    c.close()
    return row


def delete_material(mid):
    c = connect()
    c.execute("DELETE FROM materials WHERE id=?", (mid,))
    c.commit()
    c.close()


# ---------------------------------------------------------------- 价格

def upsert_price(mid, region, price, price_date, source="", supplier="", note=""):
    """同一材料+地区+日期+来源只保留一条，重复抓取时更新数值。"""
    c = connect()
    c.execute(
        """INSERT INTO prices(material_id,region,price,price_date,source,supplier,note,created_at)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(material_id,region,price_date,source) DO UPDATE SET
             price=excluded.price, supplier=excluded.supplier, note=excluded.note""",
        (mid, region or "全国", float(price), price_date or today_str(), source or "手工录入", supplier or "", note or "", now_str()),
    )
    c.commit()
    c.close()


def price_history(mid, limit=50):
    c = connect()
    rows = [
        dict(r)
        for r in c.execute(
            "SELECT * FROM prices WHERE material_id=? ORDER BY price_date DESC, id DESC LIMIT ?",
            (mid, limit),
        )
    ]
    c.close()
    return rows


def latest_price(c, mid, region):
    """取该地区最新价；没有该地区则退回全国，再退回任意地区。"""
    row = c.execute(
        """SELECT * FROM prices WHERE material_id=? AND region IN (?, '全国')
           ORDER BY CASE WHEN region=? THEN 0 ELSE 1 END, price_date DESC, id DESC LIMIT 1""",
        (mid, region or "全国", region or "全国"),
    ).fetchone()
    if row is None:
        row = c.execute(
            "SELECT * FROM prices WHERE material_id=? ORDER BY price_date DESC, id DESC LIMIT 1",
            (mid,),
        ).fetchone()
    return dict(row) if row else None


def current_prices(region="全国", q=""):
    """材料列表 + 当前价，用于材料库和报价单选料。"""
    c = connect()
    mats = [dict(r) for r in c.execute("SELECT * FROM materials ORDER BY category,name,spec")]
    out = []
    for m in mats:
        if q and q not in (m["name"] + m["spec"] + m["category"]):
            continue
        p = latest_price(c, m["id"], region)
        m["price"] = p["price"] if p else None
        m["price_date"] = p["price_date"] if p else ""
        m["price_region"] = p["region"] if p else ""
        m["price_source"] = p["source"] if p else ""
        out.append(m)
    c.close()
    return out


def recent_prices(limit=200):
    c = connect()
    rows = [
        dict(r)
        for r in c.execute(
            """SELECT p.*, m.name, m.spec, m.unit FROM prices p
               JOIN materials m ON m.id=p.material_id
               ORDER BY p.created_at DESC, p.id DESC LIMIT ?""",
            (limit,),
        )
    ]
    c.close()
    return rows


def add_price_batch(rows, allow_new=True):
    """rows: [{name,spec,unit,region,price,price_date,source,supplier,category,note}]"""
    c = connect()
    created, updated = 0, 0
    index = material_index(c)
    for r in rows:
        name = (r.get("name") or "").strip()
        if not name:
            continue
        spec = (r.get("spec") or "").strip()
        unit = (r.get("unit") or "").strip()
        key = _material_key(name, spec, unit)
        mid = index.get(key)
        if mid:
            pass
        elif allow_new:
            mid = c.execute(
                "INSERT INTO materials(name,spec,unit,category,note,created_at) VALUES(?,?,?,?,'',?)",
                (name, spec, unit, (r.get("category") or "").strip(), now_str()),
            ).lastrowid
            index[key] = mid
            created += 1
        else:
            continue
        try:
            price = float(str(r.get("price")).replace(",", "").replace("元", "").strip())
        except (TypeError, ValueError):
            continue
        c.execute(
            """INSERT INTO prices(material_id,region,price,price_date,source,supplier,note,created_at)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(material_id,region,price_date,source) DO UPDATE SET
                 price=excluded.price, supplier=excluded.supplier, note=excluded.note""",
            (
                mid,
                (r.get("region") or "全国").strip() or "全国",
                price,
                (r.get("price_date") or today_str()).strip(),
                (r.get("source") or "批量导入").strip(),
                (r.get("supplier") or "").strip(),
                (r.get("note") or "").strip(),
                now_str(),
            ),
        )
        updated += 1
    c.commit()
    c.close()
    return {"created_materials": created, "prices": updated}


# ---------------------------------------------------------------- 报价单

def calc_totals(quote, items):
    subtotal = 0.0
    for it in items:
        line = float(it.get("qty") or 0) * float(it.get("unit_price") or 0)
        line *= 1 + float(it.get("loss_rate") or 0) / 100.0
        it["line_total"] = round(line, 2)
        subtotal += line
    labor = float(quote.get("labor") or 0)
    freight = float(quote.get("freight") or 0)
    other = float(quote.get("other_fee") or 0)
    tax_rate = float(quote.get("tax_rate") or 0)
    before_tax = subtotal + labor + freight + other
    tax = before_tax * tax_rate / 100.0
    return {
        "material_subtotal": round(subtotal, 2),
        "labor": round(labor, 2),
        "freight": round(freight, 2),
        "other_fee": round(other, 2),
        "before_tax": round(before_tax, 2),
        "tax_rate": tax_rate,
        "tax": round(tax, 2),
        "total": round(before_tax + tax, 2),
    }


def save_quote(data):
    c = connect()
    t = now_str()
    qid = data.get("id")
    head = (
        (data.get("title") or "未命名报价").strip(),
        (data.get("client") or "").strip(),
        (data.get("region") or "全国").strip(),
        (data.get("quote_date") or today_str()).strip(),
        float(data.get("labor") or 0),
        float(data.get("freight") or 0),
        float(data.get("other_fee") or 0),
        float(data.get("tax_rate") or 0),
        (data.get("note") or "").strip(),
    )
    if qid:
        c.execute(
            """UPDATE quotes SET title=?,client=?,region=?,quote_date=?,labor=?,freight=?,
               other_fee=?,tax_rate=?,note=?,updated_at=? WHERE id=?""",
            head + (t, qid),
        )
    else:
        cur = c.execute(
            """INSERT INTO quotes(title,client,region,quote_date,labor,freight,other_fee,tax_rate,note,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            head + (t, t),
        )
        qid = cur.lastrowid
    c.execute("DELETE FROM quote_items WHERE quote_id=?", (qid,))
    for i, it in enumerate(data.get("items") or []):
        c.execute(
            """INSERT INTO quote_items(quote_id,material_id,name,spec,unit,qty,unit_price,loss_rate,sort)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                qid,
                it.get("material_id"),
                (it.get("name") or "").strip(),
                (it.get("spec") or "").strip(),
                (it.get("unit") or "").strip(),
                float(it.get("qty") or 0),
                float(it.get("unit_price") or 0),
                float(it.get("loss_rate") or 0),
                i,
            ),
        )
    c.commit()
    c.close()
    return get_quote(qid)


def get_quote(qid):
    c = connect()
    q = c.execute("SELECT * FROM quotes WHERE id=?", (qid,)).fetchone()
    if not q:
        c.close()
        return None
    q = dict(q)
    items = [
        dict(r)
        for r in c.execute(
            "SELECT * FROM quote_items WHERE quote_id=? ORDER BY sort,id", (qid,)
        )
    ]
    q["items"] = items
    q.update(calc_totals(q, items))
    c.close()
    return q


def list_quotes():
    c = connect()
    rows = []
    for q in c.execute("SELECT * FROM quotes ORDER BY updated_at DESC, id DESC"):
        q = dict(q)
        items = [dict(r) for r in c.execute("SELECT * FROM quote_items WHERE quote_id=?", (q["id"],))]
        q.update(calc_totals(q, items))
        rows.append(q)
    c.close()
    return rows


def delete_quote(qid):
    c = connect()
    c.execute("DELETE FROM quotes WHERE id=?", (qid,))
    c.commit()
    c.close()


# ---------------------------------------------------------------- 抓取源

def list_sources():
    c = connect()
    rows = [dict(r) for r in c.execute("SELECT * FROM sources ORDER BY id")]
    c.close()
    return rows


def save_source(data):
    import json

    c = connect()
    sid = data.get("id")
    vals = (
        (data.get("name") or "").strip() or "未命名源",
        (data.get("kind") or "table").strip(),
        (data.get("url") or "").strip(),
        json.dumps(data.get("mapping") or {}, ensure_ascii=False),
        (data.get("region") or "全国").strip(),
    )
    if sid:
        c.execute("UPDATE sources SET name=?,kind=?,url=?,mapping=?,region=? WHERE id=?", vals + (sid,))
    else:
        sid = c.execute(
            "INSERT INTO sources(name,kind,url,mapping,region,last_run,created_at) VALUES(?,?,?,?,?,'',?)",
            vals + (now_str(),),
        ).lastrowid
    c.commit()
    row = dict(c.execute("SELECT * FROM sources WHERE id=?", (sid,)).fetchone())
    c.close()
    return row


def touch_source(sid):
    c = connect()
    c.execute("UPDATE sources SET last_run=? WHERE id=?", (now_str(), sid))
    c.commit()
    c.close()


def delete_source(sid):
    c = connect()
    c.execute("DELETE FROM sources WHERE id=?", (sid,))
    c.commit()
    c.close()


def stats():
    c = connect()
    data = {
        "materials": c.execute("SELECT COUNT(*) FROM materials").fetchone()[0],
        "prices": c.execute("SELECT COUNT(*) FROM prices").fetchone()[0],
        "quotes": c.execute("SELECT COUNT(*) FROM quotes").fetchone()[0],
        "last_price": (c.execute("SELECT MAX(created_at) FROM prices").fetchone()[0] or ""),
        "db_path": DB_PATH,
    }
    c.close()
    return data


# ---------------------------------------------------------------- 设置

def get_setting(key, default=""):
    c = connect()
    row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    c.close()
    return row["value"] if row else default


def set_setting(key, value):
    c = connect()
    c.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )
    c.commit()
    c.close()

