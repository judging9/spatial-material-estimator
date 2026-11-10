# -*- coding: utf-8 -*-
"""材料报价系统 - 本地服务端（标准库 http.server + SQLite）。

启动：  python app.py          默认 http://127.0.0.1:8765
       python app.py --port 9000 --no-browser
"""
import argparse
import json
import mimetypes
import os
import re
import socket
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import store
import scrape
import excelio
import autoupdate
import drawing_service

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

ROUTES = []


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn

    return deco


class ApiError(Exception):
    pass


def body_length(handler):
    raw = (handler.headers.get("Content-Length") or "0").strip()
    if handler.headers.get("Transfer-Encoding") or not re.fullmatch(r"[0-9]+", raw):
        handler.close_connection = True
        raise ApiError("请求体长度无效，请发送带 Content-Length 的完整文件")
    if len(handler.headers.get_all("Content-Length", [])) > 1:
        handler.close_connection = True
        raise ApiError("请求体长度重复")
    digits = raw.lstrip("0") or "0"
    maximum = str(drawing_service.MAX_UPLOAD_BYTES)
    if len(digits) > len(maximum) or (len(digits) == len(maximum) and digits > maximum):
        handler.close_connection = True
        raise ApiError("请求体不能超过 64 MB")
    length = int(digits)
    return length


def read_json(handler):
    length = body_length(handler)
    if not length:
        return {}
    raw = handler.rfile.read(length)
    handler.consumed += len(raw)
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        raise ApiError("请求体不是合法 JSON")


def read_raw(handler):
    length = body_length(handler)
    content = handler.rfile.read(length) if length else b""
    handler.consumed += len(content)
    return content


# ---------------------------------------------------------------- 图纸工作台

def drawing_call(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except (drawing_service.DrawingError, TypeError, ValueError) as error:
        raise ApiError(str(error)) from error


def drawing_payload(handler):
    payload = read_json(handler)
    if not isinstance(payload, dict):
        raise ApiError("图纸请求必须是 JSON 对象")
    return payload


def drawing_page(payload):
    page = payload.get("page", 1)
    if isinstance(page, bool) or not re.fullmatch(r"[1-9][0-9]*", str(page)):
        raise ApiError("PDF 页码必须是大于零的整数")
    return int(page)


@route("POST", r"/api/drawings")
def api_drawing_upload(handler, match):
    query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
    name = (query.get("name") or ["图纸"])[0]
    return drawing_call(drawing_service.save_upload, read_raw(handler), name)


@route("POST", r"/api/drawings/([a-f0-9]{32})/page")
def api_drawing_page(handler, match):
    payload = drawing_payload(handler)
    return drawing_call(drawing_service.render_pdf_page, match.group(1), drawing_page(payload))


@route("POST", r"/api/drawings/([a-f0-9]{32})/recognize")
def api_drawing_recognize(handler, match):
    payload = drawing_payload(handler)
    options = {key: payload[key] for key in ("threshold", "min_area", "close_radius", "max_candidates") if key in payload}
    return drawing_call(drawing_service.recognize, match.group(1), drawing_page(payload), **options)


@route("GET", r"/api/drawings/([a-f0-9]{32})/assets/([^/]+)")
def api_drawing_asset(handler, match):
    path = drawing_call(drawing_service.get_asset_path, match.group(1), match.group(2))
    content_type = {".png": "image/png", ".jpg": "image/jpeg", ".pdf": "application/pdf"}[path.suffix.lower()]
    handler._send(200, path.read_bytes(), content_type, {"X-Content-Type-Options": "nosniff"})
    return None


# ---------------------------------------------------------------- 基础

@route("GET", r"/api/stats")
def api_stats(h, m):
    return store.stats()


@route("GET", r"/api/materials")
def api_materials(h, m):
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(h.path).query)
    q = (qs.get("q") or [""])[0]
    region = (qs.get("region") or ["全国"])[0]
    return store.current_prices(region, q)


@route("POST", r"/api/materials")
def api_material_save(h, m):
    return store.save_material(read_json(h))


@route("DELETE", r"/api/materials/(\d+)")
def api_material_delete(h, m):
    store.delete_material(int(m.group(1)))
    return {"deleted": True}


@route("GET", r"/api/materials/(\d+)/prices")
def api_material_prices(h, m):
    return store.price_history(int(m.group(1)))


@route("POST", r"/api/prices")
def api_price_add(h, m):
    d = read_json(h)
    mid = int(d["material_id"])
    store.upsert_price(
        mid,
        d.get("region") or "全国",
        float(d["price"]),
        d.get("price_date") or store.today_str(),
        d.get("source") or "手工录入",
        d.get("supplier") or "",
        d.get("note") or "",
    )
    return {"saved": True}


@route("GET", r"/api/prices/recent")
def api_prices_recent(h, m):
    return store.recent_prices(200)


# ---------------------------------------------------------------- 导入

@route("POST", r"/api/import/preview")
def api_import_preview(h, m):
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(h.path).query)
    fname = (qs.get("name") or ["upload.xlsx"])[0]
    content = read_raw(h)
    if not content:
        raise ApiError("没有收到文件内容")
    return excelio.parse_price_file(content, fname)


@route("POST", r"/api/import/apply")
def api_import_apply(h, m):
    d = read_json(h)
    rows = d.get("rows") or []
    if not rows:
        raise ApiError("没有要导入的数据")
    return store.add_price_batch(rows, allow_new=bool(d.get("allow_new", True)))


@route("GET", r"/api/template.xlsx")
def api_template(h, m):
    data = excelio.export_template()
    h.send_bytes(
        data,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "价格导入模板.xlsx",
    )
    return None


# ---------------------------------------------------------------- 抓取

@route("POST", r"/api/scrape/nbs/preview")
def api_nbs_preview(h, m):
    d = read_json(h)
    return scrape.nbs_fetch(d.get("url") or None)


@route("POST", r"/api/scrape/preview")
def api_scrape_preview(h, m):
    d = read_json(h)
    url = (d.get("url") or "").strip()
    if not url.startswith("http"):
        raise ApiError("请填写以 http(s):// 开头的网址")
    return scrape.generic_preview(url)


@route("POST", r"/api/scrape/apply")
def api_scrape_apply(h, m):
    d = read_json(h)
    rows = d.get("rows")
    if rows is None:
        rows = scrape.generic_rows(
            d["url"],
            int(d.get("table_index") or 0),
            d.get("mapping") or {},
            d.get("region") or "全国",
            d.get("source") or "",
            bool(d.get("has_header", True)),
        )["rows"]
    if not rows:
        raise ApiError("没有解析到数据行")
    return store.add_price_batch(rows, allow_new=bool(d.get("allow_new", True)))


@route("GET", r"/api/sources")
def api_sources(h, m):
    return store.list_sources()


@route("POST", r"/api/scrape/rows/preview")
def api_scrape_rows_preview(h, m):
    """Read a complete mapped website table without mutating either library."""
    d = read_json(h)
    if not isinstance(d, dict):
        raise ApiError("报价请求必须是 JSON 对象")
    url = str(d.get("url") or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        raise ApiError("请填写完整的 http(s) 来源网址")
    table_index = d.get("table_index", 0)
    if isinstance(table_index, bool) or not isinstance(table_index, int) or not 0 <= table_index <= 100:
        raise ApiError("表格序号无效")
    mapping = d.get("mapping")
    if not isinstance(mapping, dict):
        raise ApiError("请选择报价表格的名称、单位和单价列")
    return scrape.generic_rows(url, table_index, mapping,
                               str(d.get("region") or ""), str(d.get("source") or ""),
                               bool(d.get("has_header", True)))


@route("POST", r"/api/sources")
def api_source_save(h, m):
    return store.save_source(read_json(h))


@route("DELETE", r"/api/sources/(\d+)")
def api_source_delete(h, m):
    store.delete_source(int(m.group(1)))
    return {"deleted": True}


@route("POST", r"/api/sources/(\d+)/run")
def api_source_run(h, m):
    sid = int(m.group(1))
    src = [s for s in store.list_sources() if s["id"] == sid]
    if not src:
        raise ApiError("抓取源不存在")
    src = src[0]
    if src["kind"] == "nbs":
        res = scrape.nbs_fetch(src["url"] or None)
    else:
        mapping = json.loads(src["mapping"] or "{}")
        res = scrape.generic_rows(src["url"], int(mapping.get("table_index", 0)),
                                  mapping, src["region"], src["name"])
    out = store.add_price_batch(res["rows"], allow_new=True)
    store.touch_source(sid)
    return {"rows": len(res["rows"]), **out}


# ---------------------------------------------------------------- 自动更新

@route("GET", r"/api/auto")
def api_auto_status(h, m):
    return autoupdate.status()


@route("POST", r"/api/auto")
def api_auto_toggle(h, m):
    d = read_json(h)
    if "enabled" in d:
        store.set_setting("auto_update", "1" if d["enabled"] else "0")
    return autoupdate.status()


@route("POST", r"/api/auto/check")
def api_auto_check(h, m):
    return autoupdate.check_once(force=True)


# ---------------------------------------------------------------- 报价单

@route("GET", r"/api/quotes")
def api_quotes(h, m):
    return store.list_quotes()


@route("GET", r"/api/quotes/(\d+)")
def api_quote_get(h, m):
    q = store.get_quote(int(m.group(1)))
    if not q:
        raise ApiError("报价单不存在")
    return q


@route("POST", r"/api/quotes")
def api_quote_save(h, m):
    return store.save_quote(read_json(h))


@route("DELETE", r"/api/quotes/(\d+)")
def api_quote_delete(h, m):
    store.delete_quote(int(m.group(1)))
    return {"deleted": True}


@route("GET", r"/api/quotes/(\d+)/export.xlsx")
def api_quote_export(h, m):
    q = store.get_quote(int(m.group(1)))
    if not q:
        raise ApiError("报价单不存在")
    data = excelio.export_quote_xlsx(q, q["items"])
    name = re.sub(r'[\\/:*?"<>|]', "_", q.get("title") or "报价单")
    h.send_bytes(
        data,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "%s.xlsx" % name,
    )
    return None


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "MaterialQuote/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def send_json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def send_bytes(self, data, ctype, filename):
        quoted = urllib.parse.quote(filename)
        self._send(200, data, ctype, {
            "Content-Disposition": "attachment; filename*=UTF-8''%s" % quoted
        })

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_DELETE(self):
        self.handle_any("DELETE")

    def handle_any(self, method):
        self.consumed = 0
        length = 0
        try:
            length = body_length(self)
            try:
                path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path, errors="strict")
            except UnicodeDecodeError as error:
                raise ApiError("网址编码无效") from error
            if "\x00" in path:
                raise ApiError("网址路径无效")
            self._dispatch(method, path)
        except ApiError as error:
            self.close_connection = True
            self.send_json({"ok": False, "error": str(error)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            # 有些接口不读请求体（例如"立即检查"），残留字节会被当成下一个请求，必须读干净
            left = 0 if self.close_connection else length - self.consumed
            if left > 0:
                try:
                    self.rfile.read(left)
                except Exception:  # noqa: BLE001
                    pass

    def _dispatch(self, method, path):
        try:
            if path.startswith("/api/"):
                for mth, rx, fn in ROUTES:
                    if mth != method:
                        continue
                    mm = rx.match(path)
                    if mm:
                        try:
                            result = fn(self, mm)
                        except ApiError as e:
                            self.send_json({"ok": False, "error": str(e)}, 400)
                            return
                        except Exception as e:  # noqa: BLE001
                            self.log_message("ERROR %s: %s", path, e)
                            self.send_json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 500)
                            return
                        if result is not None:
                            self.send_json({"ok": True, "data": result})
                        return
                self.send_json({"ok": False, "error": "接口不存在: " + path}, 404)
                return
            self.serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            raise

    def serve_static(self, path):
        if path in ("/", "", "/studio", "/studio/"):
            path = "/studio/index.html"
        elif path in ("/legacy", "/legacy/"):
            path = "/index.html"
        root = os.path.realpath(STATIC_DIR)
        full = os.path.realpath(os.path.join(root, os.path.normpath(path.lstrip("/\\"))))
        try:
            within_root = os.path.normcase(os.path.commonpath((root, full))) == os.path.normcase(root)
        except ValueError:
            within_root = False
        if not within_root or not os.path.isfile(full):
            self._send(404, b"Not Found", "text/plain; charset=utf-8")
            return
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, (ctype or "application/octet-stream") + "; charset=utf-8")


class Server(ThreadingHTTPServer):
    # Windows 上 allow_reuse_address=True 会让第二个进程"成功"绑定同一端口，
    # 表面上没报错、实际请求被两个进程抢，很难排查，所以显式关掉。
    allow_reuse_address = False
    daemon_threads = True


def port_in_use(host, port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.4)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--no-auto-update", action="store_true", help="启动时不运行后台价格抓取")
    args = ap.parse_args()

    url = "http://%s:%d" % (args.host, args.port)

    if port_in_use(args.host, args.port):
        print("=" * 60)
        print("  [提示] 端口 %d 已经有程序在监听，多半是软件已经开着了。" % args.port)
        print("         直接用浏览器打开： %s" % url)
        print("         要重开请先关掉之前的那个黑窗口；")
        print("         或者换个端口： python app.py --port 8766")
        print("=" * 60)
        if not args.no_browser:
            webbrowser.open(url)
        return 2

    store.init_db()
    if not args.no_auto_update:
        autoupdate.start_background()

    try:
        httpd = Server((args.host, args.port), Handler)
    except OSError as e:
        print("=" * 60)
        print("  [错误] 启动失败：%s" % e)
        print("  如果提示地址已被占用，说明程序已经开着了，直接打开 %s" % url)
        print("  换端口试试： python app.py --port 8766")
        print("=" * 60)
        return 1

    print("=" * 56)
    print("  材料报价系统已启动： %s" % url)
    print("  数据文件： %s" % store.DB_PATH)
    print("  关闭窗口或按 Ctrl+C 退出")
    print("=" * 56)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
