"""中文桌面工程报价的数据与计价核心。

The analysis item types, sequence semantics and currency rounding are adapted
from GEstimator 2.7, estimator/data/schedule.py, by Manu Varkey (copyright 2014).
This derivative module is licensed under GNU GPL version 3 or, at your option,
any later version. See the accompanying LICENSE and NOTICE.md.

No GTK or Peewee dependency is required. Original .eproj files are opened in
SQLite read-only mode; measurement plug-ins and expressions are never executed.
All quoted rates are snapshots: updating a resource does not change an item rate
until the user explicitly applies its analysis result.
"""
from __future__ import annotations

import copy
import datetime as _datetime
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from typing import Any


PROJECT_FORMAT = "cn-estimate"
PROJECT_VERSION = 1
ANA_GROUP, ANA_SUM, ANA_WEIGHT, ANA_TIMES, ANA_ROUND = range(5)
ZERO = Decimal("0")
HUNDRED = Decimal("100")


def decimal_value(value: Any, label: str = "数值") -> Decimal:
    """Parse a finite decimal without binary float artefacts or executable text."""
    if value is None or value == "":
        value = "0"
    if isinstance(value, bool):
        raise ValueError(f"{label}必须是有效数字")
    try:
        result = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{label}必须是有效数字") from None
    if not result.is_finite():
        raise ValueError(f"{label}必须是有限数字")
    # Decimal arithmetic needs a bounded, practical magnitude. This also gives
    # the GUI a useful error instead of raising decimal.InvalidOperation.
    if result and (result.adjusted() > 24 or result.adjusted() < -24):
        raise ValueError(f"{label}超出可用范围")
    return result


def currency(value: Any, places: Any = 2) -> Decimal:
    """GEstimator ROUND_HALF_UP, including 2.5 = round to multiples of 0.05."""
    number = decimal_value(value)
    places_number = decimal_value(places, "小数位")
    precision = int(places_number)
    if not -6 <= precision <= 12:
        raise ValueError("小数位必须在 -6 到 12 之间")
    with localcontext() as context:
        context.prec = 64
        exponent = Decimal(1).scaleb(-precision)
        if places_number == precision:
            return number.quantize(exponent, rounding=ROUND_HALF_UP)
        base_number = (places_number - precision) * 10
        if base_number != base_number.to_integral_value() or not 1 <= base_number <= 9:
            raise ValueError("取整规则须为整数小数位或 2.5 等形式")
        increment = base_number * exponent
        rounded = (number / increment).quantize(Decimal(1), rounding=ROUND_HALF_UP) * increment
        return rounded.quantize(exponent, rounding=ROUND_HALF_UP)


# Preserve the familiar original function name for code or data adaptations.
Currency = currency


def resource_price(resource: dict[str, Any]) -> Decimal:
    """Tax-inclusive, discounted resource price, rounded as in GEstimator."""
    rate = decimal_value(resource.get("rate", 0), "资源单价")
    vat = decimal_value(resource.get("vat", 0), "资源税率")
    discount = decimal_value(resource.get("discount", 0), "折扣率")
    if rate < 0:
        raise ValueError("资源单价不能为负数")
    # Some bundled market-rate libraries use a negative VAT adjustment to
    # remove tax already included in their source price (for example -15.25%).
    if vat < -HUNDRED:
        raise ValueError("资源税率调整不能低于 -100%")
    if not ZERO <= discount <= HUNDRED:
        raise ValueError("折扣率必须在 0 到 100 之间")
    with localcontext() as context:
        context.prec = 64
        return currency(rate * (HUNDRED + vat) * (HUNDRED - discount) / Decimal("10000"))


def _resource_map(resources: Any) -> dict[str, dict[str, Any]]:
    if isinstance(resources, dict):
        return {str(key): value for key, value in resources.items()}
    mapping: dict[str, dict[str, Any]] = {}
    for resource in resources:
        if not isinstance(resource, dict):
            raise ValueError("资源记录格式不正确")
        code = str(resource.get("code", ""))
        if not code:
            raise ValueError("资源编码不能为空")
        if code in mapping:
            raise ValueError(f"资源编码重复：{code}")
        mapping[code] = resource
    return mapping


def calculate_analysis(analysis: list[dict[str, Any]], resources: Any) -> dict[str, Any]:
    """Evaluate all five GEstimator analysis row types in their original order.

    results matches ScheduleItemModel.results. rows is a flat list for exports.
    rate matches get_ana_rate(), including its final-group subtotal semantics.
    """
    resource_lookup = _resource_map(resources)
    sum_total = ZERO
    sum_item = ZERO
    results: list[Any] = []
    rows: list[dict[str, Any]] = []
    with localcontext() as context:
        context.prec = 64
        for index, item in enumerate(analysis):
            if not isinstance(item, dict):
                raise ValueError(f"第 {index + 1} 行单价分析格式不正确")
            try:
                item_type = int(item["itemtype"])
            except (KeyError, ValueError, TypeError):
                raise ValueError(f"第 {index + 1} 行缺少有效分析类型") from None
            description = str(item.get("description") or "")
            if item_type == ANA_GROUP:
                sum_item = ZERO
                group_result: list[Any] = []
                rows.append({"itemtype": ANA_GROUP, "index": index, "description": description,
                             "code": str(item.get("code") or ""), "is_heading": True})
                for entry in item.get("resource_list", []):
                    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
                        raise ValueError(f"第 {index + 1} 行资源用量格式不正确")
                    code = str(entry[0])
                    if code not in resource_lookup:
                        raise ValueError(f"单价分析引用了不存在的资源：{code}")
                    resource = resource_lookup[code]
                    rate = resource_price(resource)
                    qty = decimal_value(entry[1], f"资源 {code} 用量")
                    total = currency(qty * rate)
                    sum_item += total
                    group_result.append([rate, total])
                    rows.append({"itemtype": ANA_GROUP, "index": index, "is_resource": True,
                                 "code": code, "description": str(resource.get("description", "")),
                                 "unit": str(resource.get("unit", "")), "qty": qty,
                                 "rate": rate, "amount": total,
                                 "remarks": str(entry[2] or "") if len(entry) > 2 else ""})
                sum_total = currency(sum_total + sum_item)
                group_result.append(sum_item)
                results.append(group_result)
                rows.append({"itemtype": ANA_GROUP, "index": index, "description": f"{description}合计",
                             "amount": sum_item, "is_group_total": True})
            elif item_type == ANA_SUM:
                sum_item = currency(sum_total)
                results.append(sum_total)
                rows.append({"itemtype": item_type, "index": index,
                             "description": description, "amount": sum_total})
            elif item_type == ANA_WEIGHT:
                factor = decimal_value(item.get("value", 0), "附加费用比例")
                result = currency(sum_item * factor)
                sum_total += result
                results.append(result)
                rows.append({"itemtype": item_type, "index": index,
                             "description": description, "value": factor, "amount": result})
            elif item_type == ANA_TIMES:
                factor = decimal_value(item.get("value", 0), "乘数")
                result = currency(sum_item * factor)
                sum_total = result
                sum_item = result
                results.append(result)
                rows.append({"itemtype": item_type, "index": index,
                             "description": description, "value": factor, "amount": result})
            elif item_type == ANA_ROUND:
                rounding = decimal_value(item.get("value", 2), "取整规则")
                sum_total = currency(sum_total, rounding)
                results.append(sum_total)
                rows.append({"itemtype": item_type, "index": index,
                             "description": description, "value": rounding, "amount": sum_total})
            else:
                raise ValueError(f"不支持的单价分析类型：{item_type}")
    rate = results[-1][-1] if results and isinstance(results[-1], list) else (results[-1] if results else ZERO)
    return {"rate": rate, "results": results, "rows": rows, "cumulative_total": sum_total}


def measurement_quantity(count: Any = 1, length: Any = 1, width: Any = 1,
                         height: Any = 1, coefficient: Any = 1) -> Decimal:
    """Common dimension-based quantity. Negative coefficients permit deductions."""
    values = ((count, "数量"), (length, "长度"), (width, "宽度"),
              (height, "高度"), (coefficient, "系数"))
    with localcontext() as context:
        context.prec = 64
        result = Decimal(1)
        for value, label in values:
            result *= decimal_value(value, label)
        return result.quantize(Decimal("0.00001"), rounding=ROUND_HALF_UP)


def new_project(name: str = "新建工程") -> dict[str, Any]:
    return {"format": PROJECT_FORMAT, "version": PROJECT_VERSION,
            "name": name, "client": "", "region": "全国",
            "date": _datetime.date.today().isoformat(), "labor": "0",
            "freight": "0", "other_fee": "0", "tax_rate": "9",
            "note": "", "resources": [], "items": []}


def calculate_project(project: dict[str, Any]) -> dict[str, Any]:
    """Calculate quote snapshots; analysis and measurements do not alter rates/qty."""
    items: list[dict[str, Any]] = []
    subtotal = ZERO
    with localcontext() as context:
        context.prec = 64
        for item in project.get("items", []):
            qty = decimal_value(item.get("qty", 0), "工程量")
            rate = decimal_value(item.get("rate", 0), "清单单价")
            loss_rate = decimal_value(item.get("loss_rate", 0), "损耗率")
            if loss_rate < 0:
                raise ValueError("损耗率不能为负数")
            amount = currency(qty * rate * (Decimal(1) + loss_rate / HUNDRED))
            subtotal += amount
            entry = dict(item)
            entry.update({"qty": qty, "rate": rate, "loss_rate": loss_rate, "amount": amount})
            items.append(entry)
        labor = currency(decimal_value(project.get("labor", 0), "人工费"))
        freight = currency(decimal_value(project.get("freight", 0), "运费"))
        other_fee = currency(decimal_value(project.get("other_fee", 0), "其他费用"))
        tax_rate = decimal_value(project.get("tax_rate", 0), "税率")
        if min(labor, freight, other_fee, tax_rate) < 0:
            raise ValueError("人工费、运费、其他费用和税率不能为负数")
        net = currency(subtotal + labor + freight + other_fee)
        tax = currency(net * tax_rate / HUNDRED)
        total = currency(net + tax)
    return {"subtotal": currency(subtotal), "labor": labor, "freight": freight,
            "other_fee": other_fee, "net": net, "tax_rate": tax_rate,
            "tax": tax, "total": total, "items": items}


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"不能保存的数据类型：{type(value).__name__}")


def _validate_project(project: Any) -> dict[str, Any]:
    if not isinstance(project, dict) or project.get("format") != PROJECT_FORMAT:
        raise ValueError("不是本桌面版的工程文件；GEstimator 工程请使用导入功能")
    if project.get("version") != PROJECT_VERSION:
        raise ValueError("不支持的工程文件版本")
    if not isinstance(project.get("resources"), list) or not isinstance(project.get("items"), list):
        raise ValueError("工程中的资源或清单格式不正确")
    if not isinstance(project.get("name"), str) or not project["name"].strip():
        raise ValueError("工程名称不能为空")
    for resource in project["resources"]:
        if not isinstance(resource, dict) or not all(key in resource for key in ("code", "description", "rate")):
            raise ValueError("资源记录缺少编号、名称或单价")
        if not isinstance(resource["code"], str) or not isinstance(resource["description"], str):
            raise ValueError("资源编号和名称必须是文字")
    resource_lookup = _resource_map(project["resources"])
    for resource in resource_lookup.values():
        resource_price(resource)
    codes: set[str] = set()
    for item in project["items"]:
        if not isinstance(item, dict):
            raise ValueError("清单记录格式不正确")
        if not all(key in item for key in ("code", "description", "qty", "rate")):
            raise ValueError("清单记录缺少编号、名称、工程量或单价")
        if not isinstance(item["code"], str) or not isinstance(item["description"], str):
            raise ValueError("清单编号和名称必须是文字")
        code = str(item.get("code", ""))
        if not code or code in codes:
            raise ValueError("清单编码不能为空且不能重复")
        codes.add(code)
        analysis = item.get("analysis", [])
        if not isinstance(analysis, list):
            raise ValueError("单价分析格式不正确")
        calculate_analysis(analysis, resource_lookup)
        measurements = item.get("measurements", [])
        if not isinstance(measurements, list):
            raise ValueError("测量明细格式不正确")
        for measure in measurements:
            if not isinstance(measure, dict):
                raise ValueError("测量明细记录格式不正确")
            measurement_quantity(*(measure.get(key, 1) for key in ("count", "length", "width", "height", "coefficient")))
    calculate_project(project)
    return project


def save_project(project: dict[str, Any], path: Any) -> None:
    """Validate then atomically replace the destination; never edit .eproj files."""
    destination = Path(path)
    if destination.suffix.lower() == ".eproj":
        raise ValueError("请另存为 .estimate.json；原 GEstimator 工程仅支持只读导入")
    snapshot = copy.deepcopy(project)
    _validate_project(snapshot)
    snapshot["saved_at"] = _datetime.datetime.now().isoformat(timespec="seconds")
    text = json.dumps(snapshot, ensure_ascii=False, indent=2, default=_json_default, allow_nan=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=destination.parent,
                                         prefix=f".{destination.name}.", suffix=".tmp", delete=False) as stream:
            temporary_name = stream.name
            stream.write(text)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def load_project(path: Any) -> dict[str, Any]:
    """Open a desktop JSON project, validating the complete financial model."""
    source = Path(path)
    if source.suffix.lower() == ".eproj":
        return load_eproj(source)
    try:
        with source.open("r", encoding="utf-8-sig") as stream:
            project = json.load(stream, parse_float=Decimal,
                                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"无效数值：{value}")))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise ValueError("工程文件不是有效的 JSON 文件") from error
    return _validate_project(project)


def load_eproj(path: Any) -> dict[str, Any]:
    """Read original GEstimator SQLite resources, schedules and analysis sequences.

    Reads table rows rather than loading GEstimator/Peewee or invoking custom
    measurement templates. Native measurement data is retained as inert text.
    """
    source = Path(path).resolve()
    with source.open("rb") as stream:
        if stream.read(16) != b"SQLite format 3\x00":
            raise ValueError("不是有效的 GEstimator SQLite 工程文件")
    connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"projecttable", "resourcetable", "scheduletable", "sequencetable", "resourceitemtable"}
        if not required.issubset(tables):
            raise ValueError("文件缺少 GEstimator 工程数据表")
        settings = {row["key"]: row["value"] for row in connection.execute("SELECT key,value FROM projecttable")}
        version = settings.get("file_version")
        if version and version != "GESTIMATOR_FILE_REFERENCE_VER_2":
            raise ValueError(f"不支持的 GEstimator 工程版本：{version}")
        resource_categories = ({row["id"]: row["description"] for row in connection.execute("SELECT id,description FROM resourcecategorytable")}
                               if "resourcecategorytable" in tables else {})
        schedule_categories = ({row["id"]: row["description"] for row in connection.execute("SELECT id,description FROM schedulecategorytable")}
                               if "schedulecategorytable" in tables else {})
        project = new_project(settings.get("project_name") or source.stem)
        # Imported DSR templates may already include GST. Adding quote-level tax
        # by default would silently double-count it, so keep an imported project's
        # global tax at zero and explicitly warn the user to review every fee.
        project["tax_rate"] = "0"
        project["source_file"] = str(source)
        project["gestimator_settings"] = settings
        project["import_warnings"] = ["导入保留原工程单价、资源税率及 GST 等分析费用；请按实际项目核对币种、价格和费率。"]
        native_measurement = settings.get("project_measurement")
        if native_measurement:
            project["gestimator_measurement"] = native_measurement
            if native_measurement not in ('["Measurement", ["", []]]', '["Measurement",["",[]]]'):
                project["import_warnings"].append("原 GEstimator 测量插件数据已保留，未执行插件；清单工程量使用原文件已保存的数量。")
        resources_by_id: dict[int, dict[str, Any]] = {}
        for row in connection.execute('SELECT * FROM resourcetable ORDER BY "order", id'):
            resource = {"code": str(row["code"]), "description": row["description"] or "",
                        "unit": row["unit"] or "", "rate": str(row["rate"] or 0),
                        "vat": str(row["vat"] or 0), "discount": str(row["discount"] or 0),
                        "reference": row["reference"] or "",
                        "category": resource_categories.get(row["category_id"], "")}
            project["resources"].append(resource)
            resources_by_id[row["id"]] = resource
        schedules = [dict(row) for row in connection.execute('SELECT * FROM scheduletable ORDER BY "order", COALESCE(suborder,-1), id')]
        item_codes = {row["id"]: str(row["code"]) or f"__heading_{row['id']}" for row in schedules}
        sequences_by_schedule: dict[int, list[dict[str, Any]]] = {}
        for row in connection.execute("SELECT * FROM sequencetable ORDER BY id_sch_id,id_seq,id"):
            sequences_by_schedule.setdefault(row["id_sch_id"], []).append(dict(row))
        resources_by_sequence: dict[int, list[dict[str, Any]]] = {}
        for row in connection.execute("SELECT * FROM resourceitemtable ORDER BY id"):
            resources_by_sequence.setdefault(row["id_seq_id"], []).append(dict(row))
        for original in schedules:
            item = {"code": item_codes[original["id"]], "description": original["description"] or "",
                    "unit": original["unit"] or "", "rate": str(original["rate"] or 0),
                    "qty": str(original["qty"] or 0), "loss_rate": "0",
                    "category": schedule_categories.get(original["category_id"], ""),
                    "parent": item_codes.get(original["parent_id"]),
                    "remarks": original.get("remarks") or "",
                    "ana_remarks": original.get("ana_remarks") or "",
                    "analysis": [], "measurements": []}
            if not original["code"]:
                item["original_code"] = ""
            for sequence in sequences_by_schedule.get(original["id"], []):
                entry: dict[str, Any] = {"itemtype": sequence["itemtype"],
                                         "description": sequence["description"] or ""}
                if sequence["itemtype"] == ANA_GROUP:
                    entry["code"] = sequence["code"] or ""
                    entry["resource_list"] = []
                    for usage in resources_by_sequence.get(sequence["id"], []):
                        if usage["id_sch_id"] != original["id"]:
                            raise ValueError("工程文件的资源用量关联不一致")
                        resource = resources_by_id.get(usage["id_res_id"])
                        if resource is None:
                            raise ValueError("工程文件的单价分析引用了缺失资源")
                        entry["resource_list"].append([resource["code"], str(usage["qty"]), usage["remarks"] or ""])
                elif sequence["itemtype"] in (ANA_WEIGHT, ANA_TIMES, ANA_ROUND):
                    entry["value"] = str(sequence["value"] or 0)
                elif sequence["itemtype"] != ANA_SUM:
                    raise ValueError(f"不支持的 GEstimator 单价分析类型：{sequence['itemtype']}")
                item["analysis"].append(entry)
            project["items"].append(item)
    except sqlite3.DatabaseError as error:
        raise ValueError(f"读取 GEstimator 工程失败：{error}") from error
    finally:
        connection.close()
    return _validate_project(project)
