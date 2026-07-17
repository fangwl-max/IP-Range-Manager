"""经典公网 IPv4 新购（AddPublicIp，对应首云控制台新购 IPv4 数量）。"""
from __future__ import annotations

import ipaddress
import json
import math
import queue
import threading
import time
from typing import Any, Callable, Dict, Iterator, List, Optional, Set, Tuple, Union

import requests

from ip_announce_system import CapitalOnlineClient, is_success_response, load_config, parse_cidr
from rule_builder import normalize_cidr_input
from stream_keepalive import KEEPALIVE_LINE, iter_queue_with_keepalive

ProgressFn = Optional[Callable[[Dict[str, Any]], None]]

STANDARD_PURCHASE_NUMBERS = [4, 8, 16, 32, 64, 128]
DUAL_SLASH25_NUMBER = 128
DUAL_SLASH25_COUNT = 2


def _emit(fn: ProgressFn, event: Dict[str, Any]) -> None:
    if fn:
        fn(event)


def _phase(
    fn: ProgressFn,
    *,
    cidr: str,
    phase: str,
    status: str,
    message: str,
    completed: bool = False,
    step: int = 0,
    total: int = 0,
) -> None:
    ev: Dict[str, Any] = {
        "type": "phase",
        "cidr": cidr,
        "phase": phase,
        "status": status,
        "message": message,
        "completed": completed,
    }
    if step:
        ev["step"] = step
    if total:
        ev["total_steps"] = total
    _emit(fn, ev)


def slash25_halves_for_cidr(cidr: str) -> Tuple[str, str]:
    """/24 拆成 .0/25 与 .128/25 两段（展示与确认用）。"""
    net = ipaddress.ip_network(cidr, strict=False)
    if net.version != 4 or net.prefixlen != 24:
        raise ValueError("仅 /24 BYOIP 网段支持一次新购双 /25")
    subs = list(net.subnets(new_prefix=25))
    if len(subs) != 2:
        raise ValueError("无法拆分 /25 子网")
    return str(subs[0]), str(subs[1])


def count_slash25_in_segments(segments: List[str]) -> int:
    count = 0
    for seg in segments:
        try:
            if ipaddress.ip_network(seg, strict=False).prefixlen == 25:
                count += 1
        except ValueError:
            continue
    return count


def count_dual_slash25_slots(segments: List[str]) -> int:
    """已购 /25 段数；兼容掩码非 /25 但块大小为 128 的经典公网段。"""
    slash25 = count_slash25_in_segments(segments)
    if slash25 >= 2:
        return 2
    blocks_128 = 0
    for seg in segments:
        try:
            net = ipaddress.ip_network(seg, strict=False)
        except ValueError:
            continue
        if net.version == 4 and net.num_addresses == 128:
            blocks_128 += 1
    return min(2, max(slash25, blocks_128))


def mask_for_ip_number(number: int) -> str:
    if number <= 0 or (number & (number - 1)) != 0:
        return ""
    return f"/{32 - int(math.log2(number))}"


def build_vdc_public_index(vdc_resp: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    """vdc_id -> {public_id, public_name}（取该 VDC 下首个经典公网）。"""
    index: Dict[str, Dict[str, str]] = {}
    if not is_success_response(vdc_resp):
        return index
    for vdc in vdc_resp.get("Data") or []:
        vdc_id = str(vdc.get("VdcId", ""))
        if not vdc_id:
            continue
        for public_net in vdc.get("PublicNetwork") or []:
            public_id = str(public_net.get("PublicId", "")).strip()
            if public_id:
                index[vdc_id] = {
                    "public_id": public_id,
                    "public_name": str(public_net.get("Name", "")),
                }
                break
    return index


def purchase_number_options(item: Dict[str, Any]) -> List[int]:
    raw = item.get("ip_number_options") or []
    opts = sorted({int(x) for x in raw if str(x).isdigit() and int(x) > 0})
    return opts if opts else list(STANDARD_PURCHASE_NUMBERS)


def normalize_purchase_number(
    number: Any,
    *,
    options: Optional[List[int]] = None,
    default: int = 128,
) -> int:
    try:
        value = int(number)
    except (TypeError, ValueError) as exc:
        raise ValueError("新购 IPv4 数量无效") from exc

    allowed: Set[int] = set(options or STANDARD_PURCHASE_NUMBERS)
    allowed &= set(STANDARD_PURCHASE_NUMBERS)
    if not allowed:
        allowed = set(STANDARD_PURCHASE_NUMBERS)

    if value not in allowed:
        opts_text = "、".join(str(x) for x in sorted(allowed))
        raise ValueError(f"数量须为平台支持档位之一：{opts_text}")
    return value


def enrich_items_purchase_meta(
    items: List[Dict[str, Any]],
    vdc_resp: Dict[str, Any],
    *,
    default_number: int = 128,
) -> None:
    pub_index = build_vdc_public_index(vdc_resp)
    safe_default = default_number if default_number in STANDARD_PURCHASE_NUMBERS else 128

    for item in items:
        vdc_id = str(item.get("vdc_id", ""))
        pub = pub_index.get(vdc_id, {})
        item["public_id"] = pub.get("public_id", "")
        item["public_name"] = pub.get("public_name", "")
        opts = purchase_number_options(item)
        item["purchase_number_options"] = opts
        item["purchase_default_number"] = safe_default if safe_default in opts else (
            128 if 128 in opts else opts[-1]
        )
        item["can_purchase_ipv4"] = bool(
            item.get("id")
            and pub.get("public_id")
            and str(item.get("status", "")).lower() in {"broadcasted", "broadcasting"}
        )
        segs = item.get("ipv4_segments") or []
        item["existing_slash25_count"] = count_dual_slash25_slots(segs)
        mask = str(item.get("mask", ""))
        if mask == "24" and item.get("cidr"):
            try:
                lower, upper = slash25_halves_for_cidr(str(item["cidr"]))
                item["purchase_mode"] = "dual_slash25"
                item["purchase_slash25_halves"] = [lower, upper]
                item["purchase_default_number"] = DUAL_SLASH25_NUMBER
            except ValueError:
                item["purchase_mode"] = "single"
        else:
            item["purchase_mode"] = "single"


def _resolve_byoip_context(
    client: CapitalOnlineClient,
    normalized: str,
    address: str,
    mask: str,
    public_id: str,
) -> Tuple[Dict[str, Any], str, str, List[int]]:
    resp = client.describe_byoip_list(keyword=address, show_all=True)
    if not is_success_response(resp):
        raise RuntimeError(f"DescribeBYOIPList 失败: {resp.get('Message', resp)}")

    byoip: Optional[Dict[str, Any]] = None
    for item in ((resp.get("Data") or {}).get("ByoipList")) or []:
        if str(item.get("Address", "")) == address and str(item.get("Mask", "")) == str(mask):
            byoip = item
            break
    if not byoip:
        raise ValueError(f"未找到 BYOIP 记录: {normalized}")

    status = str(byoip.get("Status", "")).lower()
    if status not in {"broadcasted", "broadcasting"}:
        raise ValueError("须先完成 BYOIP 广播（状态为已广播）后才能新购经典公网 IPv4")

    byoip_id = str(byoip.get("Id", ""))
    if not byoip_id:
        raise ValueError("BYOIP Id 为空")

    opts = purchase_number_options({"ip_number_options": byoip.get("IpNumList")})
    resolved_public_id = str(public_id or "").strip()
    if not resolved_public_id:
        vdc_id = str(byoip.get("VdcId", ""))
        vdc_resp = client.describe_vdc()
        if not is_success_response(vdc_resp):
            raise RuntimeError(f"DescribeVdc 失败: {vdc_resp.get('Message', vdc_resp)}")
        resolved_public_id = (build_vdc_public_index(vdc_resp).get(vdc_id) or {}).get("public_id", "")
    if not resolved_public_id:
        raise ValueError("无法解析该 VDC 下的公网 PublicId，请先在首云控制台确认经典公网资源")

    return byoip, byoip_id, resolved_public_id, opts


def purchase_dual_slash25_classic_ipv4(
    config_path: str,
    *,
    cidr: str,
    public_id: str = "",
    existing_slash25: int = 0,
    dry_run: Optional[bool] = None,
    on_progress: ProgressFn = None,
) -> Dict[str, Any]:
    """一次新购两个 /25：各调用 AddPublicIp(Number=128)，对应 .0/25 与 .128/25。"""
    cfg = load_config(config_path)
    if dry_run is None:
        dry_run = bool((cfg.get("automation") or {}).get("dry_run", True))

    normalized = normalize_cidr_input(cidr)
    address, mask = parse_cidr(normalized)
    if str(mask) != "24":
        raise ValueError("双 /25 新购仅支持 /24 BYOIP 网段")

    lower, upper = slash25_halves_for_cidr(normalized)
    qty = DUAL_SLASH25_NUMBER
    need = DUAL_SLASH25_COUNT - int(existing_slash25 or 0)
    if need <= 0:
        raise ValueError(f"两个 /25 均已购买：{lower}、{upper}")

    _phase(
        on_progress,
        cidr=normalized,
        phase="prepare",
        status="running",
        message="校验 BYOIP 广播状态与公网 PublicId…",
    )

    client = CapitalOnlineClient(cfg)
    byoip, byoip_id, resolved_public_id, opts = _resolve_byoip_context(
        client, normalized, address, mask, public_id
    )
    vdc_id = str(byoip.get("VdcId", ""))
    if vdc_id:
        vdc_resp = client.describe_vdc()
        if is_success_response(vdc_resp):
            from byoip_service import build_vdc_ipv4_index, resolve_classic_ipv4_info

            vdc_index = build_vdc_ipv4_index(vdc_resp)
            _, _, _, live_segments = resolve_classic_ipv4_info(
                vdc_id=vdc_id,
                byoip_cidr=normalized,
                vdc_index=vdc_index,
            )
            live_slash25 = count_dual_slash25_slots(live_segments)
            existing_slash25 = max(int(existing_slash25 or 0), live_slash25)
            need = DUAL_SLASH25_COUNT - existing_slash25
            if need <= 0:
                raise ValueError(f"两个 /25 均已购买：{lower}、{upper}")

    normalize_purchase_number(qty, options=opts, default=qty)

    wait_opts = (cfg.get("web") or {})
    task_wait = int(wait_opts.get("purchase_task_wait_seconds", 300))
    task_poll = int(wait_opts.get("purchase_task_poll_seconds", 5))
    vdc_wait = int(wait_opts.get("purchase_vdc_wait_seconds", 120))

    def _live_slash25_count() -> int:
        if dry_run or not vdc_id:
            return int(existing_slash25 or 0)
        vdc_resp = client.describe_vdc()
        if not is_success_response(vdc_resp):
            return int(existing_slash25 or 0)
        from byoip_service import build_vdc_ipv4_index, resolve_classic_ipv4_info

        vdc_index = build_vdc_ipv4_index(vdc_resp)
        _, _, _, live_segments = resolve_classic_ipv4_info(
            vdc_id=vdc_id,
            byoip_cidr=normalized,
            vdc_index=vdc_index,
        )
        return count_dual_slash25_slots(live_segments)

    _phase(
        on_progress,
        cidr=normalized,
        phase="prepare",
        status="done",
        message=f"可新购 {need} 个 /25 · PublicId {resolved_public_id[:8]}…",
        completed=True,
    )

    halves = [lower, upper]
    task_ids: List[str] = []
    purchased = 0
    while purchased < need:
        if not dry_run and _live_slash25_count() >= DUAL_SLASH25_COUNT:
            break
        step = purchased + 1
        half_hint = halves[step - 1] if step - 1 < len(halves) else f"/25 #{step}"
        baseline = _live_slash25_count()
        _phase(
            on_progress,
            cidr=normalized,
            phase="submit",
            status="running",
            message=f"提交 AddPublicIp Number={qty}（{half_hint}）…",
            step=step,
            total=need,
        )
        if dry_run:
            api_resp = {"Code": "OK", "Success": True, "TaskId": "dry-run"}
        else:
            api_resp = client.add_public_ip(resolved_public_id, byoip_id, qty)
            code = str(api_resp.get("Code", "")).upper()
            success = api_resp.get("Success")
            if code not in {"SUCCESS", "OK"} or (success is not None and not success):
                _phase(
                    on_progress,
                    cidr=normalized,
                    phase="submit",
                    status="failed",
                    message=str(api_resp.get("Message", api_resp)),
                    step=step,
                    total=need,
                    completed=True,
                )
                raise RuntimeError(f"AddPublicIp 失败: {api_resp.get('Message', api_resp)}")
        tid = str(api_resp.get("TaskId", ""))
        if tid:
            task_ids.append(tid)
        _phase(
            on_progress,
            cidr=normalized,
            phase="submit",
            status="done",
            message=f"已提交 · TaskId {tid or '-'}",
            step=step,
            total=need,
            completed=True,
        )
        if not dry_run and tid:
            from public_ipv4_release import wait_for_async_task

            def _task_progress(ev: Dict[str, Any], *, st: int = step) -> None:
                _phase(
                    on_progress,
                    cidr=normalized,
                    phase="wait_task",
                    status="running",
                    message=ev.get("message") or f"等待第 {st} 个 /25 任务…",
                    step=st,
                    total=need,
                )

            _phase(
                on_progress,
                cidr=normalized,
                phase="wait_task",
                status="running",
                message=f"等待首云开通任务（{half_hint}）…",
                step=step,
                total=need,
            )
            wait_for_async_task(
                client,
                tid,
                timeout_seconds=task_wait,
                poll_interval=task_poll,
                on_progress=lambda ev: _task_progress(ev, st=step),
                progress_message=f"等待第 {step} 个 /25 新购任务",
                fail_prefix="新购公网 IP 任务失败",
                timeout_prefix="等待新购公网 IP 任务超时",
            )
            _phase(
                on_progress,
                cidr=normalized,
                phase="wait_task",
                status="done",
                message="首云任务已完成",
                step=step,
                total=need,
                completed=True,
            )
            _phase(
                on_progress,
                cidr=normalized,
                phase="wait_vdc",
                status="running",
                message="等待 VDC 出现新 /25…",
                step=step,
                total=need,
            )
            deadline = time.time() + max(10, vdc_wait)
            vdc_ok = False
            poll_n = 0
            while time.time() < deadline:
                if _live_slash25_count() > baseline:
                    vdc_ok = True
                    break
                poll_n += 1
                _phase(
                    on_progress,
                    cidr=normalized,
                    phase="wait_vdc",
                    status="running",
                    message=f"轮询 VDC 新 /25（第 {poll_n} 次）…",
                    step=step,
                    total=need,
                )
                time.sleep(max(1, task_poll))
            _phase(
                on_progress,
                cidr=normalized,
                phase="wait_vdc",
                status="done",
                message="VDC 已出现新 /25" if vdc_ok else "任务已完成（VDC 同步中，请稍后刷新列表）",
                step=step,
                total=need,
                completed=True,
            )
        purchased += 1

    if dry_run:
        message = f"[演练] 将新购 {need}×{qty}（/25），对应 {lower} 与 {upper}"
    elif purchased <= 0:
        message = f"两个 /25 均已存在，无需新购：{lower}、{upper}"
    else:
        message = f"已提交 {purchased} 次新购（每次 {qty} 个 IPv4=/25），对应 {lower}、{upper}"
        if purchased < need:
            message += f"；另有 {need - purchased} 个未提交（可能首云仍在处理上一任务，请刷新后点「补购 1 个 /25」）"
        if len(task_ids) == 2:
            message += f"；任务 ID: {task_ids[0]} / {task_ids[1]}"
        elif task_ids:
            message += f"；任务 ID: {task_ids[0]}"

    return {
        "ok": True,
        "mode": "dual_slash25",
        "cidr": normalized,
        "number": qty,
        "purchase_count": purchased,
        "mask_hint": "/25",
        "slash25_halves": [lower, upper],
        "public_id": resolved_public_id,
        "byoip_id": byoip_id,
        "task_ids": task_ids,
        "dry_run": dry_run,
        "message": message,
    }


def purchase_classic_ipv4(
    config_path: str,
    *,
    cidr: str,
    number: int,
    public_id: str = "",
    dry_run: Optional[bool] = None,
    on_progress: ProgressFn = None,
) -> Dict[str, Any]:
    cfg = load_config(config_path)
    if dry_run is None:
        dry_run = bool((cfg.get("automation") or {}).get("dry_run", True))

    normalized = normalize_cidr_input(cidr)
    address, mask = parse_cidr(normalized)

    _phase(
        on_progress,
        cidr=normalized,
        phase="prepare",
        status="running",
        message="校验 BYOIP 广播状态与公网 PublicId…",
    )

    client = CapitalOnlineClient(cfg)
    _, byoip_id, resolved_public_id, opts = _resolve_byoip_context(
        client, normalized, address, mask, public_id
    )
    web_default = int((cfg.get("web") or {}).get("default_purchase_ip_number", 128))
    qty = normalize_purchase_number(number, options=opts, default=web_default)
    mask_hint = mask_for_ip_number(qty)

    _phase(
        on_progress,
        cidr=normalized,
        phase="prepare",
        status="done",
        message=f"将新购 {qty} 个 IPv4（约 {mask_hint or '-'}）",
        completed=True,
    )

    _phase(
        on_progress,
        cidr=normalized,
        phase="submit",
        status="running",
        message=f"提交 AddPublicIp Number={qty}…",
        step=1,
        total=1,
    )

    if dry_run:
        api_resp = {"Code": "OK", "Success": True, "Message": f"dry-run: AddPublicIp number={qty}"}
    else:
        api_resp = client.add_public_ip(resolved_public_id, byoip_id, qty)
        code = str(api_resp.get("Code", "")).upper()
        success = api_resp.get("Success")
        if code not in {"SUCCESS", "OK"} or (success is not None and not success):
            _phase(
                on_progress,
                cidr=normalized,
                phase="submit",
                status="failed",
                message=str(api_resp.get("Message", api_resp)),
                step=1,
                total=1,
                completed=True,
            )
            raise RuntimeError(f"AddPublicIp 失败: {api_resp.get('Message', api_resp)}")

    tid = str(api_resp.get("TaskId", ""))
    _phase(
        on_progress,
        cidr=normalized,
        phase="submit",
        status="done",
        message=f"已提交 · TaskId {tid or '-'}",
        step=1,
        total=1,
        completed=True,
    )

    if not dry_run and tid:
        wait_opts = (cfg.get("web") or {})
        task_wait = int(wait_opts.get("purchase_task_wait_seconds", 300))
        task_poll = int(wait_opts.get("purchase_task_poll_seconds", 5))
        from public_ipv4_release import wait_for_async_task

        _phase(
            on_progress,
            cidr=normalized,
            phase="wait_task",
            status="running",
            message="等待首云开通任务…",
            step=1,
            total=1,
        )

        def _task_progress(ev: Dict[str, Any]) -> None:
            _phase(
                on_progress,
                cidr=normalized,
                phase="wait_task",
                status="running",
                message=ev.get("message") or "等待首云任务…",
                step=1,
                total=1,
            )

        wait_for_async_task(
            client,
            tid,
            timeout_seconds=task_wait,
            poll_interval=task_poll,
            on_progress=_task_progress,
            progress_message="等待新购公网 IP 任务",
            fail_prefix="新购公网 IP 任务失败",
            timeout_prefix="等待新购公网 IP 任务超时",
        )
        _phase(
            on_progress,
            cidr=normalized,
            phase="wait_task",
            status="done",
            message="首云任务已完成",
            step=1,
            total=1,
            completed=True,
        )

    return {
        "ok": True,
        "cidr": normalized,
        "number": qty,
        "mask_hint": mask_hint,
        "public_id": resolved_public_id,
        "byoip_id": byoip_id,
        "task_id": tid,
        "dry_run": dry_run,
        "message": (
            f"[演练] 将新购 {qty} 个 IPv4（约 {mask_hint}）到经典公网"
            if dry_run
            else f"已提交新购 {qty} 个 IPv4（约 {mask_hint}），任务 ID: {api_resp.get('TaskId', '-')}"
        ),
    }


def purchase_ipv4_batch(
    config_path: str,
    items: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """批量新购经典公网 IPv4，按条顺序提交并汇总结果。"""
    if not items:
        raise ValueError("请至少选择一个网段")

    results: List[Dict[str, Any]] = []
    success_count = 0

    for raw in items:
        cidr = str(raw.get("cidr", "")).strip()
        if not cidr:
            results.append({"cidr": "", "ok": False, "error": "CIDR 为空"})
            continue
        try:
            one = purchase_one_from_row(config_path, raw)
            results.append({"cidr": one.get("cidr", cidr), "ok": True, **one})
            success_count += 1
        except (ValueError, RuntimeError, requests.RequestException) as exc:
            results.append({"cidr": cidr, "ok": False, "error": str(exc)})

    failed = len(results) - success_count
    return {
        "ok": success_count > 0,
        "total": len(results),
        "success": success_count,
        "failed": failed,
        "results": results,
        "message": f"批量新购完成：成功 {success_count} 条，失败 {failed} 条",
    }


def purchase_one_from_row(
    config_path: str,
    raw: Dict[str, Any],
    *,
    on_progress: ProgressFn = None,
) -> Dict[str, Any]:
    cidr = str(raw.get("cidr", "")).strip()
    if not cidr:
        raise ValueError("CIDR 为空")
    normalized = normalize_cidr_input(cidr)
    public_id = str(raw.get("public_id", "")).strip()
    mode = str(raw.get("mode", "")).strip().lower()
    existing_slash25 = int(raw.get("existing_slash25", 0) or 0)
    _, mask = parse_cidr(normalized)

    if mode == "dual_slash25" or str(mask) == "24":
        return purchase_dual_slash25_classic_ipv4(
            config_path,
            cidr=normalized,
            public_id=public_id,
            existing_slash25=existing_slash25,
            on_progress=on_progress,
        )

    number = raw.get("number")
    if number is None:
        cfg = load_config(config_path)
        number = int((cfg.get("web") or {}).get("default_purchase_ip_number", 128))
    return purchase_classic_ipv4(
        config_path,
        cidr=normalized,
        number=int(number),
        public_id=public_id,
        on_progress=on_progress,
    )


def _purchase_need_count(raw: Dict[str, Any]) -> int:
    mode = str(raw.get("mode", "")).strip().lower()
    existing = int(raw.get("existing_slash25", 0) or 0)
    cidr = str(raw.get("cidr", "")).strip()
    if not cidr:
        return 1
    try:
        normalized = normalize_cidr_input(cidr)
        _, mask = parse_cidr(normalized)
    except ValueError:
        return 1
    if mode == "dual_slash25" or str(mask) == "24":
        return max(1, DUAL_SLASH25_COUNT - existing)
    return 1


def _purchase_row_stream(
    config_path: str,
    raw: Dict[str, Any],
) -> Iterator[Union[str, Dict[str, Any]]]:
    """逐条产出 phase 的 NDJSON 行，最后产出结果 dict（供组装 cidr_result）。"""
    event_q: queue.Queue = queue.Queue()
    holder: Dict[str, Any] = {}

    def worker() -> None:
        try:
            holder["detail"] = purchase_one_from_row(
                config_path,
                raw,
                on_progress=lambda ev: event_q.put(("phase", ev)),
            )
            event_q.put(("done", None))
        except BaseException as exc:  # noqa: BLE001
            holder["error"] = exc
            event_q.put(("error", None))

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    for kind, payload in iter_queue_with_keepalive(event_q):
        if kind == "keepalive":
            yield KEEPALIVE_LINE
        elif kind == "phase":
            yield json.dumps(payload, ensure_ascii=False) + "\n"
        elif kind == "error":
            raise holder.get("error") or RuntimeError("新购失败")
        elif kind == "done":
            break

    yield holder["detail"]


def iter_purchase_events(
    config_path: str,
    items: List[Dict[str, Any]],
    *,
    operator: str = "",
) -> Iterator[str]:
    """新购进度事件流（NDJSON）。

    将任务入队 PurchaseTaskManager，等待轮到自己执行后输出流式事件。
    支持多任务排队、取消和超时自动解锁。
    """
    from purchase_task_store import get_purchase_task_manager, PurchaseTask
    from stream_keepalive import KEEPALIVE_LINE

    manager = get_purchase_task_manager()
    task = PurchaseTask(items=items, config_path=config_path, operator=operator)
    info = manager.enqueue(task)

    # 立刻告知前端任务已入队
    yield json.dumps({
        "type": "task_queued",
        "task_id": task.task_id,
        "position": info["position"],
        "queue_length": info["position"],
    }, ensure_ascii=False) + "\n"

    # 等待 worker 启动（start 信号），期间持续发心跳防止连接超时
    while True:
        try:
            kind, _ = task.event_q.get(timeout=15)
            if kind == "start":
                break
            if kind == "done":
                # 任务在排队时就被取消或出错
                yield json.dumps({"type": "task_cancelled"}, ensure_ascii=False) + "\n"
                return
        except queue.Empty:
            yield KEEPALIVE_LINE

    yield json.dumps({"type": "task_started", "task_id": task.task_id}, ensure_ascii=False) + "\n"

    # 流式读取 worker 产生的事件
    while True:
        try:
            kind, payload = task.event_q.get(timeout=15)
        except queue.Empty:
            yield KEEPALIVE_LINE
            continue

        if kind == "event":
            yield payload
        elif kind == "done":
            break

    # 任务结束后刷新 byoip 缓存（调用方也会 invalidate，双保险）


def iter_purchase_events_internal(
    config_path: str,
    items: List[Dict[str, Any]],
    *,
    operator: str = "",
    cancel_event: Optional[Any] = None,
    on_event: Optional[Any] = None,
) -> Iterator[str]:
    """实际执行购买逻辑的内部生成器，由 worker 线程调用。

    cancel_event: threading.Event，置位后在下一个检查点终止
    on_event: 每条事件产出时的额外回调（用于更新 PurchaseTask 状态）
    """
    cfg = load_config(config_path)
    dry_run = bool((cfg.get("automation") or {}).get("dry_run", True))
    total = len(items)

    def _check_cancel() -> None:
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("任务已被取消")

    def _emit(ev: Dict[str, Any]) -> str:
        if on_event:
            try:
                on_event(ev)
            except Exception:  # noqa: BLE001
                pass
        return json.dumps(ev, ensure_ascii=False) + "\n"

    batch_ev = {"type": "batch_start", "total": total, "dry_run": dry_run}
    yield _emit(batch_ev)

    success_count = 0
    results: List[Dict[str, Any]] = []

    for idx, raw in enumerate(items):
        _check_cancel()

        cidr_hint = str(raw.get("cidr", "")).strip() or f"行{idx + 1}"
        try:
            cidr_hint = normalize_cidr_input(cidr_hint)
        except ValueError:
            pass

        mode = str(raw.get("mode", "")).strip().lower()
        if not mode and cidr_hint:
            try:
                _, mask = parse_cidr(cidr_hint)
                if str(mask) == "24":
                    mode = "dual_slash25"
            except ValueError:
                pass

        cidr_start_ev = {
            "type": "cidr_start",
            "index": idx,
            "total": total,
            "cidr": cidr_hint,
            "mode": mode or "single",
            "need_count": _purchase_need_count(raw),
        }
        yield _emit(cidr_start_ev)
        _check_cancel()

        try:
            detail = None
            for chunk in _purchase_row_stream(config_path, raw):
                _check_cancel()
                if isinstance(chunk, str):
                    # 同步 phase 事件到 on_event 回调
                    if on_event:
                        try:
                            on_event(json.loads(chunk))
                        except Exception:  # noqa: BLE001
                            pass
                    yield chunk
                else:
                    detail = chunk
            if detail is None:
                raise RuntimeError("新购未返回结果")
            success_count += 1
            result = {"type": "cidr_result", "index": idx, **detail}
            results.append(result)
            yield _emit(result)
        except Exception as exc:  # noqa: BLE001
            err_text = str(exc)
            lower_err = err_text.lower()
            # 取消信号直接向上冒泡，不包装为错误结果
            if "任务已被取消" in err_text:
                raise
            if any(k in lower_err for k in ("task", "正在执行", "并发", "conflict", "in progress", "running")):
                err_text = f"首云有任务正在执行，请等待上一个购买任务完成后再试（原因：{err_text}）"
            result = {
                "type": "cidr_result",
                "index": idx,
                "cidr": cidr_hint,
                "ok": False,
                "error": err_text,
            }
            results.append(result)
            yield _emit(result)

    batch_done_ev = {
        "type": "batch_done",
        "total": total,
        "success_count": success_count,
        "results": results,
    }
    yield _emit(batch_done_ev)

