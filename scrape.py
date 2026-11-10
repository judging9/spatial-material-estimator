# -*- coding: utf-8 -*-
"""价格抓取：通用 HTML 表格解析 + 国家统计局每旬价格源。"""
import re
import datetime
import math
import urllib.parse
from html.parser import HTMLParser

try:
    import requests
except ImportError:  # 退化为标准库
    requests = None
    import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

NBS_LIST = "https://www.stats.gov.cn/sj/zxfb/"


def fetch(url, timeout=15):
    headers = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    if requests:
        r = requests.get(url, headers=headers, timeout=timeout)
        r.raise_for_status()
        if not r.encoding or r.encoding.lower() == "iso-8859-1":
            r.encoding = r.apparent_encoding or "utf-8"
        return r.text
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        ctype = resp.headers.get("Content-Type", "")
    m = re.search(r"charset=([\w-]+)", ctype)
    enc = m.group(1) if m else "utf-8"
    try:
        return raw.decode(enc)
    except Exception:
        return raw.decode("gbk", "ignore")


class TableParser(HTMLParser):
    """把页面里所有 <table> 抽成 [[cell,...],...]，处理简单的 rowspan/colspan。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self._stack = []
        self._row = None
        self._cell = None
        self._buf = []
        self._colspan = 1
        self._rowspan = 1

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "table":
            self._stack.append([])
        elif tag == "tr" and self._stack:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []
            self._buf = []
            try:
                self._colspan = max(1, int(attrs.get("colspan", 1)))
            except Exception:
                self._colspan = 1
            try:
                self._rowspan = max(1, int(attrs.get("rowspan", 1)))
            except Exception:
                self._rowspan = 1
        elif tag in ("br", "p") and self._cell is not None:
            self._buf.append(" ")

    def handle_endtag(self, tag):
        if tag == "table" and self._stack:
            t = self._stack.pop()
            if t:
                self.tables.append(t)
        elif tag == "tr" and self._row is not None and self._stack:
            if self._row:
                self._stack[-1].append(self._row)
            self._row = None
        elif tag in ("td", "th") and self._cell is not None:
            text = re.sub(r"\s+", " ", "".join(self._cell)).strip()
            for _ in range(self._colspan):
                self._row.append(text)
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def parse_tables(html):
    p = TableParser()
    try:
        p.feed(html)
    except Exception:
        pass
    out = []
    for t in p.tables:
        rows = [r for r in t if any(c.strip() for c in r)]
        if len(rows) >= 1:
            width = max(len(r) for r in rows)
            rows = [r + [""] * (width - len(r)) for r in rows]
            out.append(rows)
    return out


# ---------------------------------------------------------------- 国家统计局

CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

# 建材相关板块（其余板块如化工、农产、煤炭不进建材库）
WANT_SECTIONS = {"一、黑色金属", "二、有色金属", "六、非金属矿物制品"}


def _split_name(text):
    """“螺纹钢（Φ20mm，HRB400E）” -> ("螺纹钢", "Φ20mm，HRB400E")"""
    m = re.match(r"^(.*?)[（(](.+)[）)]\s*$", text)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return text.strip(), ""


def _period_date(title):
    """从“2026年10月下旬”推出该旬的截止日期。"""
    m = re.search(r"(\d{4})年(\d{1,2})月(上|中|下)旬", title)
    if not m:
        return "", title
    year, month, part = int(m.group(1)), int(m.group(2)), m.group(3)
    if part == "上":
        day = 10
    elif part == "中":
        day = 20
    else:
        nxt = datetime.date(year + (month == 12), (month % 12) + 1, 1)
        day = (nxt - datetime.timedelta(days=1)).day
    return datetime.date(year, month, day).isoformat(), "%d年%d月%s旬" % (year, month, part)


def period_of(title):
    """从“2026年10月下旬流通领域重要生产资料市场价格变动情况”里取出“2026年10月下旬”。"""
    return _period_date(title)[1]


def nbs_find_latest():
    html = fetch(NBS_LIST)
    links = re.findall(r'href="([^"]+)"[^>]*>([^<]*流通领域重要生产资料市场价格变动情况[^<]*)<', html)
    if not links:
        links = re.findall(r'href="([^"]+t\d+\.html)"[^>]*>([^<]{5,60})<', html)
        links = [x for x in links if "生产资料" in x[1]]
    if not links:
        raise RuntimeError("没有在统计局网站上找到“流通领域重要生产资料价格”页面")
    href, title = links[0]
    return urllib.parse.urljoin(NBS_LIST, href), title.strip()


def nbs_fetch(url=None, only_sections=True):
    """返回 {title, period, price_date, rows:[...]}，rows 已按板块过滤。"""
    # 传列表页地址或留空时，自动找到最新一期文章
    if not url or re.search(r"/sj/zxfb/?(\?.*)?$", url):
        url, _ = nbs_find_latest()
    html = fetch(url)
    title = ""
    m = re.search(r"<title>(.*?)</title>", html, re.S)
    if m:
        title = re.sub(r"\s+", " ", m.group(1)).strip()
    tables = parse_tables(html)
    table = None
    for t in tables:
        head = " ".join(t[0])
        if "产品名称" in head and "本期价格" in head:
            table = t
            break
    if table is None:
        raise RuntimeError("页面里没有找到价格表（可能是页面结构变了）")

    price_date, period = _period_date(title)
    rows = []
    section = ""
    for r in table[1:]:
        cells = [c.strip() for c in r if c.strip()]
        if not cells:
            continue
        if len(cells) == 1:
            section = cells[0]
            continue
        if only_sections and section not in WANT_SECTIONS:
            continue
        if len(cells) < 3:
            continue
        full_name = cells[0]
        unit = cells[1]
        try:
            price = float(re.sub(r"[^\d.\-]", "", cells[2]))
        except ValueError:
            continue
        change = ""
        if len(cells) >= 5:
            change = cells[4]
        name, spec = _split_name(full_name)
        rows.append({
            "name": name,
            "spec": spec,
            "unit": unit,
            "price": price,
            "change_pct": change,
            "region": "全国",
            "price_date": price_date,
            "source": "国家统计局·流通领域重要生产资料",
            "supplier": "",
            "note": "全国均价/%s" % period,
            "category": {"一、黑色金属": "钢材", "二、有色金属": "金属", "六、非金属矿物制品": "水泥/玻璃"}.get(section, ""),
        })
    return {"url": url, "title": title, "period": period, "price_date": price_date, "rows": rows}


# ---------------------------------------------------------------- 通用表格

def generic_preview(url, max_rows=30):
    html = fetch(url)
    tables = parse_tables(html)
    out = []
    for i, t in enumerate(tables[:12]):
        sample = t[: min(len(t), 12)]
        out.append({
            "index": i,
            "rows": len(t),
            "cols": len(t[0]) if t else 0,
            "sample": sample[:12],
        })
    return {"url": url, "tables": out}


def generic_rows(url, table_index, mapping, region="全国", source="", has_header=True):
    """按列映射抓取：mapping = {name, spec, unit, price, date, supplier} 值为列号(字符串)。"""
    html = fetch(url)
    tables = parse_tables(html)
    if table_index < 0 or table_index >= len(tables):
        raise RuntimeError("表格序号超出范围")
    t = tables[table_index]
    if has_header:
        t = t[1:]

    def col(key):
        v = mapping.get(key)
        if v in (None, "", "-1", -1):
            return None
        try:
            index = int(v)
            if index < 0 or index > 1000:
                raise RuntimeError("报价列序号无效")
            return index
        except (TypeError, ValueError):
            return None

    idx = {k: col(k) for k in ("name", "spec", "unit", "price", "date", "supplier", "region", "source")}
    if idx["name"] is None or idx["price"] is None:
        raise RuntimeError("至少要映射“名称”和“价格”两列")
    rows = []
    for r in t:
        def get(k):
            i = idx[k]
            return r[i].strip() if i is not None and i < len(r) else ""

        price_txt = get("price").replace(",", "").replace("，", "").replace("¥", "").replace("￥", "").replace("元", "").strip()
        try:
            price = float(price_txt)
        except ValueError:
            continue
        if not math.isfinite(price) or price < 0:
            continue
        name = get("name")
        if not name:
            continue
        rows.append({
            "name": name,
            "spec": get("spec"),
            "unit": get("unit"),
            "price": price,
            "price_date": get("date") or datetime.date.today().isoformat(),
            "region": get("region") or region or "全国",
            "source": get("source") or source or ("网页抓取 " + urllib.parse.urlparse(url).netloc),
            "supplier": get("supplier"),
            "category": "",
            "note": "",
            "date_provided": bool(get("date")),
            "region_provided": bool(get("region") or region),
            "source_provided": bool(get("source") or source),
        })
    return {"url": url, "rows": rows}
