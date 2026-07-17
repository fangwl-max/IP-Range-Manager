"""经典公网 IPv4 释放（撤播前 DeletePublicIp + 任务/DescribeVdc 轮询）。"""
from __future__ import annotations

import ipaddress
import re
import time
from typing import Any, Callable, Dict, List, Optional, Set

from byoip_service import find_classic_segment_ids_within_byoip
from ip_announce_system import CapitalOnlineClient, is_success_response, load_config

ProgressFn = Optional[Callable[[Dict[str, Any]], None]]


def _task_id_enqueued(task_id: Any) -> bool:
    tid = str(task_id or "").strip()
    return bool(tid) and tid != "0"


def is_autorenew_billing_lock_response(resp: Dict[str, Any]) -> bool:
    """DeletePublicIp 是否仅返回包月订单提示（未下发删除任务）。"""
    if not is_success_response(resp):
        return False
    if _task_id_enqueued(resp.get("TaskId")):
        return False
    msg = str(resp.get("Message", ""))
    if "订单截至" in msg or "变更公网" in msg:
        return True
    return "TaskId" in resp and str(resp.get("TaskId", "")).strip() in {"", "0"}


def delete_public_ip_task_enqueued(resp: Dict[str, Any]) -> bool:
    """DeletePublicIp 是否已下发异步删除任务。"""
    if is_autorenew_billing_lock_response(resp):
        return False
    if not is_success_response(resp):
        return False
    if _task_id_enqueued(resp.get("TaskId")):
        return True
    data = resp.get("Data") or {}
    if isinstance(data, dict) and data.get("order_audit") is not None:
        return True
    msg = str(resp.get("Message", ""))
    return "任务下发" in msg or ("任务" in msg and "成功" in msg)


def format_delete_public_ip_failure(resp: Dict[str, Any], *, segment_cidr: str = "") -> str:
    msg = str(resp.get("Message", "")).strip()
    expiry = ""
    m = re.search(r"(\d{4}-\d{2}-\d{2})", msg)
    if m:
        expiry = f"（订单截至约 {m.group(1)}）"
    seg = f"{segment_cidr}：" if segment_cidr else ""
    return (
        f"{seg}DeletePublicIp 未下发删除任务，公网段仍在 VDC 中。"
        f"{expiry} "
        f"首云返回：{msg or resp}。"
        "当前公网（含 95 峰值/包月订单）在订单有效期内，OpenAPI 通常无法立即释放新购 /25；"
        "请登录控制台「变更公网 IP 与带宽」手动释放对应段，"
        "或待订单到期后再执行撤播。"
    )


def ipv4_count_for_segment_cidr(cidr: str) -> int:
    try:
        return int(ipaddress.ip_network(cidr, strict=False).num_addresses)
    except ValueError:
        return 0


def prepare_public_network_for_release(
    client: CapitalOnlineClient,
    public_id: str,
    *,
    prepared: Set[str],
) -> None:
    """空操作占位，严禁任何情况下操作自动续约。"""
    return


def attempt_delete_public_ip_segment(
    client: CapitalOnlineClient,
    segment_id: str,
    *,
    public_id: str = "",
    byoip_id: str = "",
    number: int = 0,
) -> Dict[str, Any]:
    """
    按多种参数组合尝试 DeletePublicIp（与 AddPublicIp 的 PublicId/ByoipId/Number 对称）。
    返回最后一次 API 响应；若某次已下发删除任务则提前返回该响应。
    """
    strategies: List[Dict[str, Any]] = []
    if public_id and byoip_id and number > 0:
        strategies.append(
            {
                "public_id": public_id,
                "byoip_id": byoip_id,
                "number": number,
            }
        )
    if public_id and byoip_id:
        strategies.append({"public_id": public_id, "byoip_id": byoip_id})
    strategies.append({})

    last: Dict[str, Any] = {}
    for kwargs in strategies:
        last = client.delete_public_ip(
            segment_id,
            public_id=str(kwargs.get("public_id", "")),
            byoip_id=str(kwargs.get("byoip_id", "")),
            number=int(kwargs.get("number", 0) or 0),
        )
        if delete_public_ip_task_enqueued(last):
            return last
    return last


def wait_for_async_task(
    client: CapitalOnlineClient,
    task_id: str,
    *,
    timeout_seconds: int = 300,
    poll_interval: int = 5,
    on_progress: ProgressFn = None,
    progress_message: str = "",
    fail_prefix: str = "异步任务失败",
    timeout_prefix: str = "等待异步任务超时",
) -> Dict[str, Any]:
    """轮询 DescribeTask，直至任务完成或失败。"""
    tid = str(task_id or "").strip()
    if not tid or tid in {"0", "dry-run"}:
        return {}
    deadline = time.time() + max(10, timeout_seconds)
    last: Dict[str, Any] = {}
    while time.time() < deadline:
        last = client.describe_task(tid)
        if not is_success_response(last):
            raise RuntimeError(f"DescribeTask 失败: {last.get('Message', last)}")
        data = last.get("Data") or {}
        status = str(data.get("Status", "")).upper()
        if on_progress and progress_message:
            on_progress(
                {
                    "type": "phase_detail",
                    "status": "running",
                    "message": f"{progress_message}（{status or '进行中'}，TaskId={tid}）",
                }
            )
        if status in {"FINISH", "FINISHED", "SUCCESS", "DONE"}:
            return last
        if status in {"ERROR", "FAILED", "FAIL"}:
            raise RuntimeError(f"{fail_prefix}: {last}")
        time.sleep(max(1, poll_interval))
    raise RuntimeError(f"{timeout_prefix}（TaskId={tid}）")


def wait_for_delete_task(
    client: CapitalOnlineClient,
    task_id: str,
    *,
    timeout_seconds: int = 300,
    poll_interval: int = 5,
    on_progress: ProgressFn = None,
    segment_cidr: str = "",
) -> Dict[str, Any]:
    deadline = time.time() + max(10, timeout_seconds)
    last: Dict[str, Any] = {}
    while time.time() < deadline:
        last = client.describe_task(task_id)
        if not is_success_response(last):
            raise RuntimeError(f"DescribeTask 失败: {last.get('Message', last)}")
        data = last.get("Data") or {}
        status = str(data.get("Status", "")).upper()
        if on_progress:
            on_progress(
                {
                    "type": "segment",
                    "status": "running",
                    "segment_cidr": segment_cidr,
                    "message": f"等待删除任务完成（{status or '进行中'}，TaskId={task_id}）",
                }
            )
        if status in {"FINISH", "FINISHED", "SUCCESS", "DONE"}:
            return last
        if status in {"ERROR", "FAILED", "FAIL"}:
            raise RuntimeError(f"删除公网段任务失败: {last}")
        time.sleep(max(1, poll_interval))
    raise RuntimeError(f"等待删除公网段任务超时（TaskId={task_id}）")


def wait_segments_cleared(
    client: CapitalOnlineClient,
    byoip_cidr: str,
    segment_ids: List[str],
    *,
    vdc_id: str = "",
    timeout_seconds: int = 300,
    poll_interval: int = 5,
    on_progress: ProgressFn = None,
    segment_labels: Optional[Dict[str, str]] = None,
) -> None:
    if not segment_ids:
        return
    want = set(segment_ids)
    labels = segment_labels or {}
    deadline = time.time() + max(10, timeout_seconds)
    remaining = want
    while time.time() < deadline:
        vdc_resp = client.describe_vdc()
        if not is_success_response(vdc_resp):
            raise RuntimeError(f"DescribeVdc 失败: {vdc_resp.get('Message', vdc_resp)}")
        remaining = set(
            find_classic_segment_ids_within_byoip(vdc_resp, byoip_cidr, vdc_id=vdc_id)
        ) & want
        if on_progress:
            left_names = [labels.get(sid, sid[:8] + "…") for sid in sorted(remaining)]
            on_progress(
                {
                    "type": "phase_detail",
                    "status": "running",
                    "message": (
                        f"等待 VDC 段消失（剩余 {len(remaining)} 个）"
                        + (f"：{', '.join(left_names)}" if left_names else "")
                    ),
                }
            )
        if not remaining:
            return
        time.sleep(max(1, poll_interval))
    raise RuntimeError(
        f"等待公网段从 VDC 消失超时，仍存在 SegmentId: {sorted(remaining)}"
    )


def release_classic_segments_for_withdraw(
    client: CapitalOnlineClient,
    *,
    byoip_cidr: str,
    segment_ids: List[str],
    vdc_id: str = "",
    public_id: str = "",
    byoip_id: str = "",
    segment_labels: Optional[Dict[str, str]] = None,
    segment_numbers: Optional[Dict[str, int]] = None,
    dry_run: bool = False,
    wait_timeout_seconds: int = 300,
    poll_interval: int = 5,
    on_progress: ProgressFn = None,
) -> List[str]:
    """
    撤播前释放经典公网段。优先使用 BatchDeletePublicIp（支持包月资源），
    失败时逐条回退到 DeletePublicIp。返回已成功提交删除的 SegmentId 列表。
    """
    if not segment_ids:
        return []

    if dry_run:
        return list(segment_ids)

    labels = segment_labels or {}
    renew_prepared: Set[str] = set()

    if public_id:
        prepare_public_network_for_release(client, public_id, prepared=renew_prepared)

    submitted: List[str] = []

    # 优先使用 BatchDeletePublicIp（一次提交所有段，支持包月资源）
    batch_ok = False
    if public_id:
        try:
            if on_progress:
                on_progress({
                    "type": "phase_detail",
                    "status": "running",
                    "message": f"正在调用 BatchDeletePublicIp 批量删除 {len(segment_ids)} 个网段…",
                })
            resp = client.batch_delete_public_ip(public_id, segment_ids)
            if is_success_response(resp):
                tid = str(resp.get("TaskId", "")).strip()
                order_audit = int((resp.get("Data") or {}).get("OrderAudit", 0) or (resp.get("Data") or {}).get("order_audit", 0))
                if on_progress:
                    audit_hint = "（需要订单审核）" if order_audit else ""
                    on_progress({
                        "type": "phase_detail",
                        "status": "running",
                        "message": f"BatchDeletePublicIp 已提交{audit_hint}，TaskId={tid or '-'}，等待任务完成…",
                    })
                if _task_id_enqueued(tid):
                    wait_for_async_task(
                        client,
                        tid,
                        timeout_seconds=wait_timeout_seconds,
                        poll_interval=poll_interval,
                        on_progress=on_progress,
                        progress_message="等待批量删除公网段任务",
                        fail_prefix="批量删除公网段任务失败",
                        timeout_prefix="等待批量删除公网段任务超时",
                    )
                submitted = list(segment_ids)
                batch_ok = True
                if on_progress:
                    on_progress({
                        "type": "phase_detail",
                        "status": "running",
                        "message": f"BatchDeletePublicIp 完成，共提交 {len(submitted)} 个网段",
                    })
        except Exception as exc:  # noqa: BLE001
            if on_progress:
                on_progress({
                    "type": "phase_detail",
                    "status": "running",
                    "message": f"BatchDeletePublicIp 失败（{exc}），回退到逐条删除…",
                })

    # 回退：逐条 DeletePublicIp
    if not batch_ok:
        numbers = segment_numbers or {}
        total = len(segment_ids)
        for index, segment_id in enumerate(segment_ids, start=1):
            seg_cidr = labels.get(segment_id, segment_id[:8] + "…")
            qty = numbers.get(segment_id) or ipv4_count_for_segment_cidr(seg_cidr)

            if on_progress:
                on_progress({
                    "type": "segment",
                    "status": "running",
                    "segment_cidr": seg_cidr,
                    "index": index,
                    "total": total,
                    "message": f"正在删除 {seg_cidr}（{index}/{total}）…",
                })

            resp = attempt_delete_public_ip_segment(
                client,
                segment_id,
                public_id=public_id,
                byoip_id=byoip_id,
                number=qty,
            )
            if not is_success_response(resp):
                if on_progress:
                    on_progress({
                        "type": "segment",
                        "status": "failed",
                        "segment_cidr": seg_cidr,
                        "index": index,
                        "total": total,
                        "message": str(resp.get("Message", resp)),
                    })
                raise RuntimeError(f"DeletePublicIp 失败: {resp.get('Message', resp)}")

            if not delete_public_ip_task_enqueued(resp):
                err = format_delete_public_ip_failure(resp, segment_cidr=seg_cidr)
                if on_progress:
                    on_progress({
                        "type": "segment",
                        "status": "failed",
                        "segment_cidr": seg_cidr,
                        "index": index,
                        "total": total,
                        "message": err[:200],
                    })
                raise RuntimeError(err)

            tid = str(resp.get("TaskId", "")).strip()
            if _task_id_enqueued(tid):
                wait_for_delete_task(
                    client, tid,
                    timeout_seconds=wait_timeout_seconds,
                    poll_interval=poll_interval,
                    on_progress=on_progress,
                    segment_cidr=seg_cidr,
                )

            submitted.append(segment_id)
            if on_progress:
                on_progress({
                    "type": "segment",
                    "status": "done",
                    "segment_cidr": seg_cidr,
                    "index": index,
                    "total": total,
                    "message": f"已提交删除 {seg_cidr}"
                    + (f"（TaskId={tid}）" if _task_id_enqueued(tid) else ""),
                })

    if on_progress:
        on_progress({
            "type": "phase_detail",
            "status": "running",
            "message": "等待所有公网段从 VDC 中移除…",
        })

    wait_segments_cleared(
        client,
        byoip_cidr,
        submitted,
        vdc_id=vdc_id,
        timeout_seconds=wait_timeout_seconds,
        poll_interval=poll_interval,
        on_progress=on_progress,
        segment_labels=labels,
    )
    return submitted


def withdraw_wait_options(config_path: str) -> Dict[str, int]:
    cfg = load_config(config_path)
    web = cfg.get("web") or {}
    return {
        "wait_timeout_seconds": int(web.get("withdraw_delete_wait_seconds", 300)),
        "poll_interval": int(web.get("withdraw_delete_poll_seconds", 5)),
    }
