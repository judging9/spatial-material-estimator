# -*- coding: utf-8 -*-
"""自动更新：定时检查国家统计局是否发布了新一期旬价，有新数据就抓下来入库。

设计要点：
- 只做"检查+增量入库"，不会覆盖已有历史；重复抓同一期是幂等的（靠唯一索引）。
- 抓取失败不抛出到界面，只记录状态，下次再试，避免开机就弹错误。
- 每 6 小时查一次即可：统计局每旬（10 天）才发一期。
"""
import datetime
import threading
import time
import traceback

import scrape
import store

CHECK_INTERVAL = 6 * 3600  # 秒
FIRST_DELAY = 8            # 启动后先等 8 秒，别和开页面抢带宽

_lock = threading.Lock()
_state = {"running": False, "last_result": "", "last_error": "", "last_check": ""}


def _now():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def status():
    return {
        "enabled": store.get_setting("auto_update", "1") == "1",
        "running": _state["running"],
        "last_check": _state["last_check"] or store.get_setting("auto_last_check", ""),
        "last_update": store.get_setting("auto_last_update", ""),
        "last_period": store.get_setting("auto_last_period", ""),
        "last_result": _state["last_result"],
        "last_error": _state["last_error"],
        "interval_hours": CHECK_INTERVAL // 3600,
    }


def check_once(force=False):
    """检查一次。force=True 时忽略开关和"已是最新"判断，强制重新抓取核对。"""
    if not force and store.get_setting("auto_update", "1") != "1":
        return {"status": "disabled", "message": "自动更新已关闭"}
    if not _lock.acquire(blocking=False):
        return {"status": "busy", "message": "上一次检查还没结束"}
    try:
        _state["running"] = True
        _state["last_check"] = _now()
        store.set_setting("auto_last_check", _state["last_check"])

        url, title = scrape.nbs_find_latest()
        period = scrape.period_of(title)
        last = store.get_setting("auto_last_period", "")

        if period == last and not force:
            msg = "已是最新（%s），无需更新" % period
            _state["last_result"] = msg
            _state["last_error"] = ""
            return {"status": "up-to-date", "period": period, "message": msg}

        res = scrape.nbs_fetch(url)
        out = store.add_price_batch(res["rows"], allow_new=True)
        store.set_setting("auto_last_period", period)
        store.set_setting("auto_last_update", _now())
        if period == last:
            msg = "已是最新（%s），重新核对了 %d 条价格" % (period, out["prices"])
            status = "up-to-date"
        else:
            msg = "已更新到 %s：%d 条价格%s" % (
                period,
                out["prices"],
                "，新增 %d 种材料" % out["created_materials"] if out["created_materials"] else "",
            )
            status = "updated"
        _state["last_result"] = msg
        _state["last_error"] = ""
        return {"status": status, "period": period, "message": msg, **out}
    except Exception as e:  # noqa: BLE001
        _state["last_error"] = "%s: %s" % (type(e).__name__, e)
        _state["last_result"] = "检查失败，稍后自动重试"
        traceback.print_exc()
        return {"status": "error", "message": _state["last_error"]}
    finally:
        _state["running"] = False
        _lock.release()


def _loop():
    time.sleep(FIRST_DELAY)
    while True:
        try:
            check_once()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
        time.sleep(CHECK_INTERVAL)


def start_background():
    threading.Thread(target=_loop, name="auto-update", daemon=True).start()
