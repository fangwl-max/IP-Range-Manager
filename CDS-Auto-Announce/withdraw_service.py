"""撤播流程与进度事件（NDJSON 流式输出）。"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Iterator, List, Optional

from byoip_service import find_classic_segments_within_byoip
from ip_announce_system import CapitalOnlineClient, is_success_response
from public_ipv4_release import (
    ipv4_count_for_segment_cidr,
    release_classic_segments_for_withdraw,
    withdraw_wait_options,
)
from public_ipv4_service import build_vdc_public_index
from rule_builder import normalize_cidr_input

ProgressFn = Optional[Callable[[Dict[str, Any]], None]]

BROADCASTING_BYOIP_STATUSES = frozenset({"broadcasted", "broadcasting", "creating", "processing"})
WITHDRAWN_BYOIP_STATUSES = frozenset({"unbroadcasted", "revoked"})
WITHDRAWN_BYOIP_STATUS_ZH = frozenset({"未广播", "已撤销", "撤销"})


def is_byoip_withdrawn_status(status: str, status_zh: str = "") -> bool:
    """BYOIP 是否处于可删除的撤播态（非广播中/创建中）。"""
    s = str(status or "").strip().lower()
    zh = str(status_zh or "").strip()
    if s in BROADCASTING_BYOIP_STATUSES:
        return False
    if zh in {"已广播", "广播中", "创建中", "处理中"}:
        return False
    if s in WITHDRAWN_BYOIP_STATUSES:
        return True
    if zh in WITHDRAWN_BYOIP_STATUS_ZH:
        return True
    # 已明确非广播态且存在状态值时，允许尝试删除（如 failed 等）
    return bool(s or zh)


def _find_byoip_item(client: CapitalOnlineClient, normalized: str) -> Optional[Dict[str, Any]]:
    address, mask = normalized.split("/", 1) if "/" in normalized else (normalized, "")
    resp = client.describe_byoip_list(keyword=address, show_all=True)
    if not _api_ok(resp):
        raise RuntimeError(f"DescribeBYOIPList 调用失败: {resp}")
    for item in ((resp.get("Data") or {}).get("ByoipList")) or []:
        if str(item.get("Address", "")) == address and str(item.get("Mask", "")) == str(mask):
            return item
    return None


def _remaining_classic_segments(
    client: CapitalOnlineClient,
    normalized: str,
    *,
    vdc_id: str = "",
    public_id: str = "",
    vdc_resp: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, str]]:
    resp = vdc_resp if vdc_resp is not None else client.describe_vdc()
    if not _api_ok(resp):
        raise RuntimeError(f"DescribeVdc 调用失败: {resp}")
    return find_classic_segments_within_byoip(
        resp, normalized, vdc_id=vdc_id, public_id=public_id
    )


def _emit(fn: ProgressFn, event: Dict[str, Any]) -> None:
    if fn:
        fn(event)


def _api_ok(resp: Dict[str, Any]) -> bool:
    code = str(resp.get("Code", "")).upper()
    success = resp.get("Success")
    return code in {"SUCCESS", "OK"} and (success is None or success is True)


def withdraw_one_cidr(
    client: CapitalOnlineClient,
    *,
    cidr: str,
    config_path: str,
    dry_run: bool,
    delete_byoip: bool = False,
    on_progress: ProgressFn = None,
) -> Dict[str, Any]:
    """单网段撤播：删除经典公网段 → UndoBroadcastBYOIP →（可选）DeleteBYOIP。"""
    normalized = normalize_cidr_input(cidr)
    steps: List[Dict[str, Any]] = []

    _emit(
        on_progress,
        {
            "type": "phase",
            "cidr": normalized,
            "phase": "delete_ip",
            "label": "购买 IP 删除",
            "status": "running",
            "message": "正在查询需删除的经典公网段…",
            "completed": False,
        },
    )

    address, mask = normalized.split("/", 1) if "/" in normalized else (normalized, "")
    byoip = _find_byoip_item(client, normalized)

    vdc_id = str(byoip.get("VdcId", "")) if byoip else ""
    vdc_resp = client.describe_vdc()
    if not _api_ok(vdc_resp):
        raise RuntimeError(f"DescribeVdc 调用失败: {vdc_resp}")

    segments = find_classic_segments_within_byoip(vdc_resp, normalized, vdc_id=vdc_id)
    byoip_id = str(byoip.get("Id", "")) if byoip else ""
    public_id = ""
    if vdc_id:
        public_id = str((build_vdc_public_index(vdc_resp).get(vdc_id) or {}).get("public_id", ""))
    segment_labels = {s["segment_id"]: s["cidr"] for s in segments}
    segment_numbers = {
        s["segment_id"]: ipv4_count_for_segment_cidr(s["cidr"]) for s in segments
    }
    wait_opts = withdraw_wait_options(config_path) if config_path else {}
    wait_timeout = wait_opts.get("wait_timeout_seconds", 300)
    poll_interval = wait_opts.get("poll_interval", 5)
    detached_ids: List[str] = []

    if not segments:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "delete_ip",
                "label": "购买 IP 删除",
                "status": "done",
                "message": "无需删除（未挂载经典公网 /25 段）",
                "completed": True,
                "segment_total": 0,
                "segment_done": 0,
            },
        )
        steps.append(
            {
                "phase": "delete_ip",
                "ok": True,
                "message": "无需删除经典公网段",
                "segment_total": 0,
            }
        )
    elif dry_run:
        for i, seg in enumerate(segments, start=1):
            _emit(
                on_progress,
                {
                    "type": "segment",
                    "cidr": normalized,
                    "phase": "delete_ip",
                    "segment_cidr": seg["cidr"],
                    "index": i,
                    "total": len(segments),
                    "status": "done",
                    "message": f"[演练] 将删除 {seg['cidr']}",
                },
            )
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "delete_ip",
                "label": "购买 IP 删除",
                "status": "done",
                "message": f"[演练] 将删除 {len(segments)} 个经典公网段",
                "completed": True,
                "segment_total": len(segments),
                "segment_done": len(segments),
            },
        )
        steps.append(
            {
                "phase": "delete_ip",
                "ok": True,
                "message": f"[演练] 将删除 {len(segments)} 段",
                "segment_total": len(segments),
            }
        )
        detached_ids = [s["segment_id"] for s in segments]
    else:

        def release_progress(event: Dict[str, Any]) -> None:
            event.setdefault("cidr", normalized)
            event.setdefault("phase", "delete_ip")
            _emit(on_progress, event)

        detached_ids = release_classic_segments_for_withdraw(
            client,
            byoip_cidr=normalized,
            segment_ids=[s["segment_id"] for s in segments],
            segment_labels=segment_labels,
            segment_numbers=segment_numbers,
            vdc_id=vdc_id,
            public_id=public_id,
            byoip_id=byoip_id,
            dry_run=False,
            wait_timeout_seconds=wait_timeout,
            poll_interval=poll_interval,
            on_progress=release_progress,
        )
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "delete_ip",
                "label": "购买 IP 删除",
                "status": "done",
                "message": f"已完成，共删除 {len(detached_ids)} 个经典公网段",
                "completed": True,
                "segment_total": len(segments),
                "segment_done": len(detached_ids),
            },
        )
        steps.append(
            {
                "phase": "delete_ip",
                "ok": True,
                "message": f"已删除 {len(detached_ids)} 个经典公网段",
                "segment_total": len(segments),
            }
        )

    unbroadcasted = False
    byoip_status = str(byoip.get("Status", "")).lower() if byoip else ""

    if not byoip:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "unbroadcast",
                "label": "撤播 IP 段",
                "status": "done",
                "message": "跳过（未找到 BYOIP 记录）",
                "completed": True,
            },
        )
        steps.append({"phase": "unbroadcast", "ok": True, "message": "未找到 BYOIP，已跳过撤播"})
    elif byoip_status not in {"broadcasted", "broadcasting"}:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "unbroadcast",
                "label": "撤播 IP 段",
                "status": "done",
                "message": f"跳过（当前状态：{byoip_status or '-'}）",
                "completed": True,
            },
        )
        steps.append(
            {
                "phase": "unbroadcast",
                "ok": True,
                "message": f"当前非广播态（{byoip_status}），无需 UndoBroadcast",
            }
        )
    else:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "unbroadcast",
                "label": "撤播 IP 段",
                "status": "running",
                "message": "正在调用 UndoBroadcastBYOIP…",
                "completed": False,
            },
        )
        if dry_run:
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "unbroadcast",
                    "label": "撤播 IP 段",
                    "status": "done",
                    "message": "[演练] 将执行 UndoBroadcastBYOIP",
                    "completed": True,
                },
            )
            steps.append({"phase": "unbroadcast", "ok": True, "message": "[演练] 将撤播"})
            unbroadcasted = True
        else:
            undo_resp = client.undo_broadcast_byoip(str(byoip["Id"]))
            if not _api_ok(undo_resp):
                _emit(
                    on_progress,
                    {
                        "type": "phase",
                        "cidr": normalized,
                        "phase": "unbroadcast",
                        "label": "撤播 IP 段",
                        "status": "failed",
                        "message": str(undo_resp.get("Message", undo_resp)),
                        "completed": False,
                    },
                )
                raise RuntimeError(f"UndoBroadcastBYOIP 调用失败: {undo_resp}")
            unbroadcasted = True
            task_id = str(undo_resp.get("TaskId", "") or "").strip()
            msg = "UndoBroadcastBYOIP 已提交"
            if task_id and task_id != "0":
                msg += f"（任务 ID: {task_id}）"
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "unbroadcast",
                    "label": "撤播 IP 段",
                    "status": "done",
                    "message": msg,
                    "completed": True,
                },
            )
            steps.append({"phase": "unbroadcast", "ok": True, "message": msg})

    byoip_deleted = False
    if not delete_byoip:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "delete_byoip",
                "label": "删除 BYOIP 地址",
                "status": "done",
                "message": "已跳过（未勾选删除 BYOIP）",
                "completed": True,
            },
        )
        steps.append({"phase": "delete_byoip", "ok": True, "message": "未启用 BYOIP 删除"})
    elif not byoip:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "delete_byoip",
                "label": "删除 BYOIP 地址",
                "status": "done",
                "message": "跳过（未找到 BYOIP 记录）",
                "completed": True,
            },
        )
        steps.append({"phase": "delete_byoip", "ok": True, "message": "未找到 BYOIP，无需删除"})
    else:
        _emit(
            on_progress,
            {
                "type": "phase",
                "cidr": normalized,
                "phase": "delete_byoip",
                "label": "删除 BYOIP 地址",
                "status": "running",
                "message": "正在校验是否可删除 BYOIP…",
                "completed": False,
            },
        )
        current_byoip = _find_byoip_item(client, normalized) or byoip
        byoip_id = str(current_byoip.get("Id", ""))
        cur_vdc_id = str(current_byoip.get("VdcId", "")) or vdc_id
        fresh_vdc = client.describe_vdc()
        if not _api_ok(fresh_vdc):
            raise RuntimeError(f"DescribeVdc 调用失败: {fresh_vdc}")
        cur_public_id = ""
        if cur_vdc_id:
            cur_public_id = str(
                (build_vdc_public_index(fresh_vdc).get(cur_vdc_id) or {}).get("public_id", "")
            )
        remaining = _remaining_classic_segments(
            client,
            normalized,
            vdc_id=cur_vdc_id,
            public_id=cur_public_id,
            vdc_resp=fresh_vdc,
        )
        cur_status = str(current_byoip.get("Status", ""))
        cur_status_zh = str(current_byoip.get("StatusZh", "")).strip()

        if remaining:
            seg_list = ", ".join(s["cidr"] for s in remaining[:3])
            suffix = f" 等 {len(remaining)} 段" if len(remaining) > 3 else ""
            msg = f"跳过：仍有经典公网段未删除（{seg_list}{suffix}）"
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "delete_byoip",
                    "label": "删除 BYOIP 地址",
                    "status": "done",
                    "message": msg,
                    "completed": True,
                },
            )
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
        elif not is_byoip_withdrawn_status(cur_status, cur_status_zh):
            label = cur_status_zh or cur_status or "-"
            msg = f"跳过：BYOIP 仍处于「{label}」，非撤播态"
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "delete_byoip",
                    "label": "删除 BYOIP 地址",
                    "status": "done",
                    "message": msg,
                    "completed": True,
                },
            )
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
        elif dry_run:
            msg = "[演练] 将调用 DeleteBYOIP 删除 BYOIP 地址"
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "delete_byoip",
                    "label": "删除 BYOIP 地址",
                    "status": "done",
                    "message": msg,
                    "completed": True,
                },
            )
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
            byoip_deleted = True
        else:
            del_resp = client.delete_byoip(byoip_id)
            if not _api_ok(del_resp):
                _emit(
                    on_progress,
                    {
                        "type": "phase",
                        "cidr": normalized,
                        "phase": "delete_byoip",
                        "label": "删除 BYOIP 地址",
                        "status": "failed",
                        "message": str(del_resp.get("Message", del_resp)),
                        "completed": False,
                    },
                )
                raise RuntimeError(f"DeleteBYOIP 调用失败: {del_resp}")
            byoip_deleted = True
            task_id = str(del_resp.get("TaskId", "") or "").strip()
            msg = "DeleteBYOIP 已提交，BYOIP 地址已删除"
            if task_id and task_id != "0":
                msg += f"（任务 ID: {task_id}）"
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "delete_byoip",
                    "label": "删除 BYOIP 地址",
                    "status": "done",
                    "message": msg,
                    "completed": True,
                },
            )
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})

    # 撤播成功后删除本地 LOA 文件（正式目录 + 临时目录均清理）
    loa_deleted = False
    loa_deleted_paths: List[str] = []
    if config_path:
        try:
            from ip_announce_system import load_config as _load_config
            from loa_service import LoaService
            _cfg = _load_config(config_path)
            _loa_svc = LoaService(_cfg)
            for _loa_path in [_loa_svc.permanent_path(normalized), _loa_svc.temp_path(normalized)]:
                if _loa_path.is_file():
                    if not dry_run:
                        _loa_path.unlink(missing_ok=True)
                    loa_deleted_paths.append(str(_loa_path))
                    loa_deleted = True
            if loa_deleted:
                _msg = (
                    f"[演练] 将删除 LOA 文件：{', '.join(loa_deleted_paths)}"
                    if dry_run
                    else f"已删除 LOA 文件：{', '.join(loa_deleted_paths)}"
                )
            else:
                _msg = "无本地 LOA 文件（已清理或从未下载）"
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "delete_loa",
                    "label": "LOA 文件清理",
                    "status": "done",
                    "message": _msg,
                    "completed": True,
                },
            )
            steps.append({"phase": "delete_loa", "ok": True, "message": _msg})
        except Exception as _exc:  # noqa: BLE001
            _emit(
                on_progress,
                {
                    "type": "phase",
                    "cidr": normalized,
                    "phase": "delete_loa",
                    "label": "LOA 文件清理",
                    "status": "done",
                    "message": f"LOA 清理跳过（{_exc}）",
                    "completed": True,
                },
            )
            steps.append({"phase": "delete_loa", "ok": True, "message": f"LOA 清理跳过（{_exc}）"})

    return {
        "cidr": normalized,
        "detached_segments": len(detached_ids) if segments else 0,
        "detached_segment_ids": detached_ids if segments else [],
        "byoip_found": bool(byoip),
        "unbroadcasted": unbroadcasted,
        "byoip_deleted": byoip_deleted,
        "loa_deleted": loa_deleted,
        "loa_deleted_paths": loa_deleted_paths,
        "steps": steps,
    }


def _prepare_cidr_for_withdraw(
    client,
    normalized,
    *,
    wait_opts=None,
):
    """查询单个 CIDR 的 BYOIP 信息和经典公网段，返回上下文字典供两阶段使用。"""
    from byoip_service import find_classic_segments_within_byoip
    from public_ipv4_service import build_vdc_public_index
    from public_ipv4_release import ipv4_count_for_segment_cidr

    address, mask = normalized.split("/", 1) if "/" in normalized else (normalized, "")
    byoip = _find_byoip_item(client, normalized)
    vdc_id = str(byoip.get("VdcId", "")) if byoip else ""
    vdc_resp = client.describe_vdc()
    if not _api_ok(vdc_resp):
        raise RuntimeError(f"DescribeVdc 调用失败: {vdc_resp}")
    segments = find_classic_segments_within_byoip(vdc_resp, normalized, vdc_id=vdc_id)
    byoip_id = str(byoip.get("Id", "")) if byoip else ""
    public_id = ""
    if vdc_id:
        public_id = str((build_vdc_public_index(vdc_resp).get(vdc_id) or {}).get("public_id", ""))
    segment_labels = {s["segment_id"]: s["cidr"] for s in segments}
    segment_numbers = {s["segment_id"]: ipv4_count_for_segment_cidr(s["cidr"]) for s in segments}
    wo = wait_opts or {}
    return {
        "normalized": normalized,
        "byoip": byoip,
        "vdc_id": vdc_id,
        "byoip_id": byoip_id,
        "public_id": public_id,
        "segments": segments,
        "segment_labels": segment_labels,
        "segment_numbers": segment_numbers,
        "wait_timeout": wo.get("wait_timeout_seconds", 300),
        "poll_interval": wo.get("poll_interval", 5),
    }


def _delete_segments_for_ctx(client, ctx, *, dry_run, on_progress=None):
    """阶段一：删除单个 CIDR 的 /25 段，返回 detached_ids 列表。"""
    from public_ipv4_release import release_classic_segments_for_withdraw
    normalized = ctx["normalized"]
    segments = ctx["segments"]
    steps = []
    detached_ids = []

    if not segments:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_ip",
            "label": "购买 IP 删除", "status": "done",
            "message": "无需删除（未挂载经典公网 /25 段）",
            "completed": True, "segment_total": 0, "segment_done": 0,
        })
        steps.append({"phase": "delete_ip", "ok": True, "message": "无需删除经典公网段", "segment_total": 0})
    elif dry_run:
        for i, seg in enumerate(segments, start=1):
            _emit(on_progress, {
                "type": "segment", "cidr": normalized, "phase": "delete_ip",
                "segment_cidr": seg["cidr"], "index": i, "total": len(segments),
                "status": "done", "message": f"[演练] 将删除 {seg['cidr']}",
            })
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_ip",
            "label": "购买 IP 删除", "status": "done",
            "message": f"[演练] 将删除 {len(segments)} 个经典公网段",
            "completed": True, "segment_total": len(segments), "segment_done": len(segments),
        })
        steps.append({"phase": "delete_ip", "ok": True, "message": f"[演练] 将删除 {len(segments)} 段", "segment_total": len(segments)})
        detached_ids = [s["segment_id"] for s in segments]
    else:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_ip",
            "label": "购买 IP 删除", "status": "running",
            "message": f"正在删除 {len(segments)} 个经典公网段…", "completed": False,
        })
        def release_progress(event):
            event.setdefault("cidr", normalized)
            event.setdefault("phase", "delete_ip")
            _emit(on_progress, event)
        detached_ids = release_classic_segments_for_withdraw(
            client,
            byoip_cidr=normalized,
            segment_ids=[s["segment_id"] for s in segments],
            segment_labels=ctx["segment_labels"],
            segment_numbers=ctx["segment_numbers"],
            vdc_id=ctx["vdc_id"],
            public_id=ctx["public_id"],
            byoip_id=ctx["byoip_id"],
            dry_run=False,
            wait_timeout_seconds=ctx["wait_timeout"],
            poll_interval=ctx["poll_interval"],
            on_progress=release_progress,
        )
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_ip",
            "label": "购买 IP 删除", "status": "done",
            "message": f"已完成，共删除 {len(detached_ids)} 个经典公网段",
            "completed": True, "segment_total": len(segments), "segment_done": len(detached_ids),
        })
        steps.append({"phase": "delete_ip", "ok": True, "message": f"已删除 {len(detached_ids)} 个经典公网段", "segment_total": len(segments)})

    ctx["detached_ids"] = detached_ids
    ctx["delete_ip_steps"] = steps
    return detached_ids


def _unbroadcast_cidr(client, ctx, *, dry_run, on_progress=None):
    """阶段二：对单个 CIDR 执行 UndoBroadcastBYOIP，将结果写入 ctx。"""
    normalized = ctx["normalized"]
    byoip = ctx["byoip"]
    byoip_status = str(byoip.get("Status", "")).lower() if byoip else ""
    steps = list(ctx.get("delete_ip_steps", []))
    unbroadcasted = False

    if not byoip:
        _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "unbroadcast",
            "label": "撤播 IP 段", "status": "done", "message": "跳过（未找到 BYOIP 记录）", "completed": True})
        steps.append({"phase": "unbroadcast", "ok": True, "message": "未找到 BYOIP，已跳过撤播"})
    elif byoip_status not in {"broadcasted", "broadcasting"}:
        _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "unbroadcast",
            "label": "撤播 IP 段", "status": "done",
            "message": f"跳过（当前状态：{byoip_status or '-'}）", "completed": True})
        steps.append({"phase": "unbroadcast", "ok": True, "message": f"当前非广播态（{byoip_status}），无需 UndoBroadcast"})
    else:
        _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "unbroadcast",
            "label": "撤播 IP 段", "status": "running", "message": "正在调用 UndoBroadcastBYOIP…", "completed": False})
        if dry_run:
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "unbroadcast",
                "label": "撤播 IP 段", "status": "done", "message": "[演练] 将执行 UndoBroadcastBYOIP", "completed": True})
            steps.append({"phase": "unbroadcast", "ok": True, "message": "[演练] 将撤播"})
            unbroadcasted = True
        else:
            undo_resp = client.undo_broadcast_byoip(str(byoip["Id"]))
            if not _api_ok(undo_resp):
                _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "unbroadcast",
                    "label": "撤播 IP 段", "status": "failed",
                    "message": str(undo_resp.get("Message", undo_resp)), "completed": False})
                raise RuntimeError(f"UndoBroadcastBYOIP 调用失败: {undo_resp}")
            unbroadcasted = True
            task_id = str(undo_resp.get("TaskId", "") or "").strip()
            msg = "UndoBroadcastBYOIP 已提交"
            if task_id and task_id != "0":
                msg += f"（任务 ID: {task_id}）"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "unbroadcast",
                "label": "撤播 IP 段", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "unbroadcast", "ok": True, "message": msg})

    ctx["unbroadcasted"] = unbroadcasted
    ctx["unbroadcast_steps"] = steps
    return unbroadcasted


def _delete_byoip_cidr(client, ctx, *, dry_run, delete_byoip, on_progress=None):
    """阶段三：对单个 CIDR 执行 DeleteBYOIP（如启用），将结果写入 ctx。"""
    from public_ipv4_service import build_vdc_public_index as _bvpi
    normalized = ctx["normalized"]
    byoip = ctx["byoip"]
    steps = list(ctx.get("unbroadcast_steps", ctx.get("delete_ip_steps", [])))
    byoip_deleted = False

    if not delete_byoip:
        _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
            "label": "删除 BYOIP 地址", "status": "done", "message": "已跳过（未勾选删除 BYOIP）", "completed": True})
        steps.append({"phase": "delete_byoip", "ok": True, "message": "未启用 BYOIP 删除"})
    elif not byoip:
        _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
            "label": "删除 BYOIP 地址", "status": "done", "message": "跳过（未找到 BYOIP 记录）", "completed": True})
        steps.append({"phase": "delete_byoip", "ok": True, "message": "未找到 BYOIP，无需删除"})
    else:
        _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
            "label": "删除 BYOIP 地址", "status": "running", "message": "正在校验是否可删除 BYOIP…", "completed": False})
        current_byoip = _find_byoip_item(client, normalized) or byoip
        byoip_id = str(current_byoip.get("Id", ""))
        cur_vdc_id = str(current_byoip.get("VdcId", "")) or ctx["vdc_id"]
        fresh_vdc = client.describe_vdc()
        if not _api_ok(fresh_vdc):
            raise RuntimeError(f"DescribeVdc 调用失败: {fresh_vdc}")
        cur_public_id = ""
        if cur_vdc_id:
            cur_public_id = str((_bvpi(fresh_vdc).get(cur_vdc_id) or {}).get("public_id", ""))
        remaining = _remaining_classic_segments(client, normalized, vdc_id=cur_vdc_id, public_id=cur_public_id, vdc_resp=fresh_vdc)
        cur_status = str(current_byoip.get("Status", ""))
        cur_status_zh = str(current_byoip.get("StatusZh", "")).strip()
        if remaining:
            seg_list = ", ".join(s["cidr"] for s in remaining[:3])
            suffix = f" 等 {len(remaining)} 段" if len(remaining) > 3 else ""
            msg = f"跳过：仍有经典公网段未删除（{seg_list}{suffix}）"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
                "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
        elif not is_byoip_withdrawn_status(cur_status, cur_status_zh):
            label = cur_status_zh or cur_status or "-"
            msg = f"跳过：BYOIP 仍处于「{label}」，非撤播态"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
                "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
        elif dry_run:
            msg = "[演练] 将调用 DeleteBYOIP 删除 BYOIP 地址"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
                "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
            byoip_deleted = True
        else:
            del_resp = client.delete_byoip(byoip_id)
            if not _api_ok(del_resp):
                _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
                    "label": "删除 BYOIP 地址", "status": "failed",
                    "message": str(del_resp.get("Message", del_resp)), "completed": False})
                raise RuntimeError(f"DeleteBYOIP 调用失败: {del_resp}")
            byoip_deleted = True
            task_id = str(del_resp.get("TaskId", "") or "").strip()
            msg = "DeleteBYOIP 已提交，BYOIP 地址已删除"
            if task_id and task_id != "0":
                msg += f"（任务 ID: {task_id}）"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip",
                "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})

    ctx["byoip_deleted"] = byoip_deleted
    ctx["delete_byoip_steps"] = steps
    return byoip_deleted


def _cleanup_loa_cidr(ctx, *, dry_run, config_path, on_progress=None):
    """阶段四：清理单个 CIDR 的本地 LOA 文件，返回最终 result dict。"""
    normalized = ctx["normalized"]
    byoip = ctx["byoip"]
    segments = ctx["segments"]
    detached_ids = ctx.get("detached_ids", [])
    steps = list(ctx.get("delete_byoip_steps", ctx.get("unbroadcast_steps", ctx.get("delete_ip_steps", []))))
    loa_deleted = False
    loa_deleted_paths = []

    if config_path:
        try:
            from ip_announce_system import load_config as _load_config
            from loa_service import LoaService
            _cfg = _load_config(config_path)
            _loa_svc = LoaService(_cfg)
            for _loa_path in [_loa_svc.permanent_path(normalized), _loa_svc.temp_path(normalized)]:
                if _loa_path.is_file():
                    if not dry_run:
                        _loa_path.unlink(missing_ok=True)
                    loa_deleted_paths.append(str(_loa_path))
                    loa_deleted = True
            _msg = (f"[演练] 将删除 LOA 文件：{', '.join(loa_deleted_paths)}" if dry_run
                    else (f"已删除 LOA 文件：{', '.join(loa_deleted_paths)}" if loa_deleted
                          else "无本地 LOA 文件（已清理或从未下载）"))
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_loa",
                "label": "LOA 文件清理", "status": "done", "message": _msg, "completed": True})
            steps.append({"phase": "delete_loa", "ok": True, "message": _msg})
        except Exception as _exc:
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_loa",
                "label": "LOA 文件清理", "status": "done",
                "message": f"LOA 清理跳过（{_exc}）", "completed": True})
            steps.append({"phase": "delete_loa", "ok": True, "message": f"LOA 清理跳过（{_exc}）"})

    return {
        "cidr": normalized,
        "detached_segments": len(detached_ids) if segments else 0,
        "detached_segment_ids": detached_ids if segments else [],
        "byoip_found": bool(byoip),
        "unbroadcasted": ctx.get("unbroadcasted", False),
        "byoip_deleted": ctx.get("byoip_deleted", False),
        "loa_deleted": loa_deleted,
        "loa_deleted_paths": loa_deleted_paths,
        "steps": steps,
    }

def _unbroadcast_and_cleanup(client, ctx, *, dry_run, delete_byoip, config_path, on_progress=None):
    """阶段二：UndoBroadcast → DeleteBYOIP → 清理 LOA。返回最终 result dict。"""
    normalized = ctx["normalized"]
    byoip = ctx["byoip"]
    byoip_status = str(byoip.get("Status", "")).lower() if byoip else ""
    detached_ids = ctx.get("detached_ids", [])
    segments = ctx["segments"]
    steps = list(ctx.get("delete_ip_steps", []))
    unbroadcasted = False

    if not byoip:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "unbroadcast",
            "label": "撤播 IP 段", "status": "done",
            "message": "跳过（未找到 BYOIP 记录）", "completed": True,
        })
        steps.append({"phase": "unbroadcast", "ok": True, "message": "未找到 BYOIP，已跳过撤播"})
    elif byoip_status not in {"broadcasted", "broadcasting"}:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "unbroadcast",
            "label": "撤播 IP 段", "status": "done",
            "message": f"跳过（当前状态：{byoip_status or '-'}）", "completed": True,
        })
        steps.append({"phase": "unbroadcast", "ok": True, "message": f"当前非广播态（{byoip_status}），无需 UndoBroadcast"})
    else:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "unbroadcast",
            "label": "撤播 IP 段", "status": "running",
            "message": "正在调用 UndoBroadcastBYOIP…", "completed": False,
        })
        if dry_run:
            _emit(on_progress, {
                "type": "phase", "cidr": normalized, "phase": "unbroadcast",
                "label": "撤播 IP 段", "status": "done",
                "message": "[演练] 将执行 UndoBroadcastBYOIP", "completed": True,
            })
            steps.append({"phase": "unbroadcast", "ok": True, "message": "[演练] 将撤播"})
            unbroadcasted = True
        else:
            undo_resp = client.undo_broadcast_byoip(str(byoip["Id"]))
            if not _api_ok(undo_resp):
                _emit(on_progress, {
                    "type": "phase", "cidr": normalized, "phase": "unbroadcast",
                    "label": "撤播 IP 段", "status": "failed",
                    "message": str(undo_resp.get("Message", undo_resp)), "completed": False,
                })
                raise RuntimeError(f"UndoBroadcastBYOIP 调用失败: {undo_resp}")
            unbroadcasted = True
            task_id = str(undo_resp.get("TaskId", "") or "").strip()
            msg = "UndoBroadcastBYOIP 已提交"
            if task_id and task_id != "0":
                msg += f"（任务 ID: {task_id}）"
            _emit(on_progress, {
                "type": "phase", "cidr": normalized, "phase": "unbroadcast",
                "label": "撤播 IP 段", "status": "done",
                "message": msg, "completed": True,
            })
            steps.append({"phase": "unbroadcast", "ok": True, "message": msg})

    byoip_deleted = False
    if not delete_byoip:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_byoip",
            "label": "删除 BYOIP 地址", "status": "done",
            "message": "已跳过（未勾选删除 BYOIP）", "completed": True,
        })
        steps.append({"phase": "delete_byoip", "ok": True, "message": "未启用 BYOIP 删除"})
    elif not byoip:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_byoip",
            "label": "删除 BYOIP 地址", "status": "done",
            "message": "跳过（未找到 BYOIP 记录）", "completed": True,
        })
        steps.append({"phase": "delete_byoip", "ok": True, "message": "未找到 BYOIP，无需删除"})
    else:
        _emit(on_progress, {
            "type": "phase", "cidr": normalized, "phase": "delete_byoip",
            "label": "删除 BYOIP 地址", "status": "running",
            "message": "正在校验是否可删除 BYOIP…", "completed": False,
        })
        from public_ipv4_service import build_vdc_public_index as _bvpi
        current_byoip = _find_byoip_item(client, normalized) or byoip
        byoip_id = str(current_byoip.get("Id", ""))
        cur_vdc_id = str(current_byoip.get("VdcId", "")) or ctx["vdc_id"]
        fresh_vdc = client.describe_vdc()
        if not _api_ok(fresh_vdc):
            raise RuntimeError(f"DescribeVdc 调用失败: {fresh_vdc}")
        cur_public_id = ""
        if cur_vdc_id:
            cur_public_id = str((_bvpi(fresh_vdc).get(cur_vdc_id) or {}).get("public_id", ""))
        remaining = _remaining_classic_segments(client, normalized, vdc_id=cur_vdc_id, public_id=cur_public_id, vdc_resp=fresh_vdc)
        cur_status = str(current_byoip.get("Status", ""))
        cur_status_zh = str(current_byoip.get("StatusZh", "")).strip()
        if remaining:
            seg_list = ", ".join(s["cidr"] for s in remaining[:3])
            suffix = f" 等 {len(remaining)} 段" if len(remaining) > 3 else ""
            msg = f"跳过：仍有经典公网段未删除（{seg_list}{suffix}）"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip", "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
        elif not is_byoip_withdrawn_status(cur_status, cur_status_zh):
            label = cur_status_zh or cur_status or "-"
            msg = f"跳过：BYOIP 仍处于「{label}」，非撤播态"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip", "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
        elif dry_run:
            msg = "[演练] 将调用 DeleteBYOIP 删除 BYOIP 地址"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip", "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})
            byoip_deleted = True
        else:
            del_resp = client.delete_byoip(byoip_id)
            if not _api_ok(del_resp):
                _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip", "label": "删除 BYOIP 地址", "status": "failed", "message": str(del_resp.get("Message", del_resp)), "completed": False})
                raise RuntimeError(f"DeleteBYOIP 调用失败: {del_resp}")
            byoip_deleted = True
            task_id = str(del_resp.get("TaskId", "") or "").strip()
            msg = "DeleteBYOIP 已提交，BYOIP 地址已删除"
            if task_id and task_id != "0":
                msg += f"（任务 ID: {task_id}）"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_byoip", "label": "删除 BYOIP 地址", "status": "done", "message": msg, "completed": True})
            steps.append({"phase": "delete_byoip", "ok": True, "message": msg})

    # 清理 LOA 文件
    loa_deleted = False
    loa_deleted_paths = []
    if config_path:
        try:
            from ip_announce_system import load_config as _load_config
            from loa_service import LoaService
            _cfg = _load_config(config_path)
            _loa_svc = LoaService(_cfg)
            for _loa_path in [_loa_svc.permanent_path(normalized), _loa_svc.temp_path(normalized)]:
                if _loa_path.is_file():
                    if not dry_run:
                        _loa_path.unlink(missing_ok=True)
                    loa_deleted_paths.append(str(_loa_path))
                    loa_deleted = True
            if loa_deleted:
                _msg = (f"[演练] 将删除 LOA 文件：{', '.join(loa_deleted_paths)}" if dry_run else f"已删除 LOA 文件：{', '.join(loa_deleted_paths)}")
            else:
                _msg = "无本地 LOA 文件（已清理或从未下载）"
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_loa", "label": "LOA 文件清理", "status": "done", "message": _msg, "completed": True})
            steps.append({"phase": "delete_loa", "ok": True, "message": _msg})
        except Exception as _exc:
            _emit(on_progress, {"type": "phase", "cidr": normalized, "phase": "delete_loa", "label": "LOA 文件清理", "status": "done", "message": f"LOA 清理跳过（{_exc}）", "completed": True})
            steps.append({"phase": "delete_loa", "ok": True, "message": f"LOA 清理跳过（{_exc}）"})

    return {
        "cidr": normalized,
        "detached_segments": len(detached_ids) if segments else 0,
        "detached_segment_ids": detached_ids if segments else [],
        "byoip_found": bool(byoip),
        "unbroadcasted": unbroadcasted,
        "byoip_deleted": byoip_deleted,
        "loa_deleted": loa_deleted,
        "loa_deleted_paths": loa_deleted_paths,
        "steps": steps,
    }

def iter_withdraw_events(
    client,
    cidrs,
    *,
    config_path,
    dry_run,
    delete_byoip=False,
    on_upstream_invalidate=None,
):
    """四阶段批量撤播（全部先批量处理再进入下一阶段）：
    阶段一：所有 CIDR 统一删除 /25 经典公网段；
    阶段二：所有 CIDR 统一执行 UndoBroadcastBYOIP；
    阶段三：所有 CIDR 统一执行 DeleteBYOIP（如启用）；
    阶段四：逐条清理 LOA，输出最终结果。
    全程实时流式输出进度，不缓冲等待。
    """
    import queue as _queue
    import threading as _threading
    from stream_keepalive import KEEPALIVE_LINE, iter_queue_with_keepalive

    total = len(cidrs)
    yield json.dumps(
        {"type": "batch_start", "total": total, "dry_run": dry_run, "delete_byoip": delete_byoip},
        ensure_ascii=False,
    ) + "\n"

    wait_opts = withdraw_wait_options(config_path) if config_path else {}

    # ── 收集所有 CIDR 的上下文（BYOIP + 段信息）──
    yield json.dumps(
        {"type": "phase_global", "phase": "collect", "status": "running",
         "message": f"正在查询 {total} 个网段的公网段信息…"},
        ensure_ascii=False,
    ) + "\n"

    ctx_map = {}
    prepare_errors = {}
    for cidr in cidrs:
        try:
            normalized = normalize_cidr_input(cidr)
            ctx = _prepare_cidr_for_withdraw(client, normalized, wait_opts=wait_opts)
            ctx_map[normalized] = ctx
        except Exception as exc:
            prepare_errors[cidr] = str(exc)

    yield json.dumps(
        {"type": "phase_global", "phase": "collect", "status": "done",
         "message": f"信息收集完成，共 {len(ctx_map)} 个网段有效，{len(prepare_errors)} 个失败",
         "completed": True},
        ensure_ascii=False,
    ) + "\n"

    def _run_per_cidr_phase(phase_fn, phase_label, phase_name, fn_kwargs):
        """对所有有效 CIDR 执行同一阶段。
        策略：同一 VDC 内串行（避免首云 VDC 并发冲突），不同 VDC 之间并发。
        """
        valid = [(n, c) for n, c in ctx_map.items() if n not in prepare_errors]
        if not valid:
            return
        yield json.dumps(
            {"type": "phase_global", "phase": phase_name, "status": "running",
             "message": f"{phase_label}（共 {len(valid)} 个网段，跨 VDC 并发）…"},
            ensure_ascii=False,
        ) + "\n"

        # 按 VDC 分组：同 VDC 串行，不同 VDC 并发
        from collections import defaultdict
        vdc_groups = defaultdict(list)
        for normalized, ctx in valid:
            vdc_key = ctx.get("vdc_id") or ctx.get("public_id") or normalized
            vdc_groups[vdc_key].append((normalized, ctx))

        # 每个 VDC 组启动一个线程，组内串行执行
        group_queues = {}
        group_holders = {}
        for vdc_key, items in vdc_groups.items():
            gq = _queue.Queue()
            group_queues[vdc_key] = gq
            group_holders[vdc_key] = {}

            def _group_worker(group_items=items, q=gq, h=group_holders[vdc_key]):
                for normalized, ctx in group_items:
                    try:
                        phase_fn(client, ctx,
                                 on_progress=lambda ev, n=normalized: q.put(("phase", ev)),
                                 **fn_kwargs)
                        q.put(("item_done", normalized))
                    except Exception as exc:
                        h[normalized] = exc
                        q.put(("item_error", normalized))
                q.put(("group_done", None))

            _threading.Thread(target=_group_worker, daemon=True).start()

        # 并发读取所有组的队列，直到所有组结束
        finished_groups = set()
        while len(finished_groups) < len(vdc_groups):
            any_progress = False
            for vdc_key, gq in group_queues.items():
                if vdc_key in finished_groups:
                    continue
                while True:
                    try:
                        kind, payload = gq.get_nowait()
                    except _queue.Empty:
                        break
                    any_progress = True
                    if kind == "phase":
                        yield json.dumps(payload, ensure_ascii=False) + "\n"
                    elif kind == "item_error":
                        normalized = payload
                        prepare_errors[normalized] = str(
                            group_holders[vdc_key].get(normalized, f"{phase_label}失败")
                        )
                    elif kind == "group_done":
                        finished_groups.add(vdc_key)
                        break
            if not any_progress:
                import time as _time
                _time.sleep(0.3)
                yield KEEPALIVE_LINE

        failed_n = len([n for n, _ in valid if n in prepare_errors])
        yield json.dumps(
            {"type": "phase_global", "phase": phase_name, "status": "done",
             "message": f"{phase_label}完成（{len(valid) - failed_n} 成功，{failed_n} 失败）",
             "completed": True},
            ensure_ascii=False,
        ) + "\n"

    # ── 阶段一：按 PublicId 合并所有 SegmentId，一次 BatchDeletePublicIp 搞定同 VDC 所有段 ──
    total_segs = sum(len(c["segments"]) for c in ctx_map.values() if c["normalized"] not in prepare_errors)
    if total_segs > 0:
        yield json.dumps(
            {"type": "phase_global", "phase": "delete_ip_all", "status": "running",
             "message": f"阶段一：批量删除所有网段的 /25 经典公网段（共 {total_segs} 个，按公网合并一次提交）…"},
            ensure_ascii=False,
        ) + "\n"

        # 按 public_id 合并同一公网下的所有段
        from collections import defaultdict
        public_id_groups = defaultdict(lambda: {"segment_ids": [], "segment_labels": {}, "segment_numbers": {}, "cidrs": [], "ctx_list": []})
        no_public_cidrs = []
        for normalized, ctx in ctx_map.items():
            if normalized in prepare_errors:
                continue
            pid = ctx.get("public_id", "")
            if not pid or not ctx["segments"]:
                if ctx["segments"]:
                    no_public_cidrs.append(normalized)
                else:
                    # 无段也走单 CIDR 流程（写入空结果）
                    ctx["detached_ids"] = []
                    ctx["delete_ip_steps"] = [{"phase": "delete_ip", "ok": True, "message": "无需删除（未挂载经典公网 /25 段）", "segment_total": 0}]
                continue
            g = public_id_groups[pid]
            g["segment_ids"].extend([s["segment_id"] for s in ctx["segments"]])
            g["segment_labels"].update(ctx["segment_labels"])
            g["segment_numbers"].update(ctx["segment_numbers"])
            g["cidrs"].append(normalized)
            g["ctx_list"].append(ctx)
            # 发出该 CIDR 的 delete_ip 开始进度
            yield json.dumps({
                "type": "phase", "cidr": normalized, "phase": "delete_ip",
                "label": "购买 IP 删除", "status": "running",
                "message": f"正在合并至公网 {pid[:8]}… 批量删除 {len(ctx['segments'])} 个 /25 段…",
                "completed": False,
            }, ensure_ascii=False) + "\n"

        # 按 public_id 分组并发（不同公网并发，同公网一次 BatchDelete）
        group_q = _queue.Queue()
        group_holders = {}

        for pid, g in public_id_groups.items():
            group_holders[pid] = {}

            def _batch_worker(p=pid, grp=g, q=group_q, h=group_holders):
                from public_ipv4_release import release_classic_segments_for_withdraw
                try:
                    def _progress(ev):
                        ev["_pid"] = p
                        q.put(("phase", ev))
                    byoip_cidr = grp["cidrs"][0] if grp["cidrs"] else ""
                    vdc_id = grp["ctx_list"][0].get("vdc_id", "") if grp["ctx_list"] else ""
                    byoip_id = grp["ctx_list"][0].get("byoip_id", "") if grp["ctx_list"] else ""
                    wait_t = grp["ctx_list"][0].get("wait_timeout", 300) if grp["ctx_list"] else 300
                    poll_i = grp["ctx_list"][0].get("poll_interval", 5) if grp["ctx_list"] else 5
                    if dry_run:
                        submitted = list(grp["segment_ids"])
                    else:
                        submitted = release_classic_segments_for_withdraw(
                            client,
                            byoip_cidr=byoip_cidr,
                            segment_ids=grp["segment_ids"],
                            segment_labels=grp["segment_labels"],
                            segment_numbers=grp["segment_numbers"],
                            vdc_id=vdc_id,
                            public_id=p,
                            byoip_id=byoip_id,
                            dry_run=False,
                            wait_timeout_seconds=wait_t,
                            poll_interval=poll_i,
                            on_progress=_progress,
                        )
                    h[p] = {"ok": True, "submitted": submitted}
                    q.put(("group_done", p))
                except Exception as exc:
                    h[p] = {"ok": False, "error": str(exc)}
                    q.put(("group_error", p))

            _threading.Thread(target=_batch_worker, daemon=True).start()

        # 读取进度直到所有 public_id 组完成
        finished_groups = set()
        total_groups = len(public_id_groups)
        while len(finished_groups) < total_groups:
            try:
                kind, payload = group_q.get(timeout=15)
            except _queue.Empty:
                yield KEEPALIVE_LINE
                continue
            if kind == "phase":
                ev = dict(payload)
                ev.pop("_pid", None)
                yield json.dumps(ev, ensure_ascii=False) + "\n"
            elif kind in ("group_done", "group_error"):
                pid = payload
                finished_groups.add(pid)
                grp = public_id_groups[pid]
                result = group_holders.get(pid, {})
                if result.get("ok"):
                    submitted_ids = result.get("submitted", [])
                    for ctx in grp["ctx_list"]:
                        n = ctx["normalized"]
                        ctx_segs = [s["segment_id"] for s in ctx["segments"]]
                        ctx["detached_ids"] = [sid for sid in submitted_ids if sid in set(ctx_segs)]
                        ctx["delete_ip_steps"] = [{"phase": "delete_ip", "ok": True,
                            "message": f"已删除 {len(ctx['detached_ids'])} 个经典公网段（公网合并批量提交）",
                            "segment_total": len(ctx["segments"])}]
                        yield json.dumps({
                            "type": "phase", "cidr": n, "phase": "delete_ip",
                            "label": "购买 IP 删除", "status": "done",
                            "message": f"完成，删除 {len(ctx['detached_ids'])} 个 /25 段",
                            "completed": True,
                        }, ensure_ascii=False) + "\n"
                else:
                    err = result.get("error", "批量删除失败")
                    for ctx in grp["ctx_list"]:
                        n = ctx["normalized"]
                        prepare_errors[n] = err
                        yield json.dumps({
                            "type": "phase", "cidr": n, "phase": "delete_ip",
                            "label": "购买 IP 删除", "status": "failed",
                            "message": err, "completed": False,
                        }, ensure_ascii=False) + "\n"

        # 无 public_id 的 CIDR 降级为单条处理
        for normalized in no_public_cidrs:
            ctx = ctx_map[normalized]
            eq = _queue.Queue()
            holder = {}
            def _fallback(c=ctx, q=eq, h=holder):
                try:
                    _delete_segments_for_ctx(client, c, dry_run=dry_run,
                                             on_progress=lambda ev: q.put(("phase", ev)))
                    q.put(("done", None))
                except Exception as exc:
                    h["error"] = exc
                    q.put(("error", None))
            _threading.Thread(target=_fallback, daemon=True).start()
            for kind, payload in iter_queue_with_keepalive(eq):
                if kind == "keepalive":
                    yield KEEPALIVE_LINE
                elif kind == "phase":
                    yield json.dumps(payload, ensure_ascii=False) + "\n"
                elif kind in ("done", "error"):
                    if kind == "error":
                        prepare_errors[normalized] = str(holder.get("error", "删除失败"))
                    break

        yield json.dumps(
            {"type": "phase_global", "phase": "delete_ip_all", "status": "done",
             "message": f"阶段一完成：所有网段 /25 经典公网段已删除", "completed": True},
            ensure_ascii=False,
        ) + "\n"
    else:
        yield json.dumps(
            {"type": "phase_global", "phase": "delete_ip_all", "status": "done",
             "message": "阶段一：无需删除经典公网段（所有网段均未挂载 /25）", "completed": True},
            ensure_ascii=False,
        ) + "\n"

    # ── 阶段二：统一 UndoBroadcastBYOIP ──
    yield json.dumps(
        {"type": "phase_global", "phase": "unbroadcast_all", "status": "running",
         "message": f"阶段二：统一执行 UndoBroadcastBYOIP（共 {len(ctx_map)} 个网段）…"},
        ensure_ascii=False,
    ) + "\n"
    for line in _run_per_cidr_phase(
        _unbroadcast_cidr, "阶段二 UndoBroadcast", "unbroadcast_all",
        {"dry_run": dry_run}
    ):
        yield line

    # ── 阶段三：统一 DeleteBYOIP（如启用）──
    if delete_byoip:
        yield json.dumps(
            {"type": "phase_global", "phase": "delete_byoip_all", "status": "running",
             "message": f"阶段三：统一执行 DeleteBYOIP（共 {len(ctx_map)} 个网段）…"},
            ensure_ascii=False,
        ) + "\n"
        for line in _run_per_cidr_phase(
            _delete_byoip_cidr, "阶段三 DeleteBYOIP", "delete_byoip_all",
            {"dry_run": dry_run, "delete_byoip": True}
        ):
            yield line
    else:
        # 未启用删除 BYOIP：向每个网段发送跳过的 phase 事件，更新前端进度显示
        for normalized, ctx in ctx_map.items():
            if normalized in prepare_errors:
                continue
            ctx["byoip_deleted"] = False
            skip_step = {"phase": "delete_byoip", "ok": True, "message": "未启用 BYOIP 删除（已跳过）"}
            ctx["delete_byoip_steps"] = list(
                ctx.get("unbroadcast_steps", ctx.get("delete_ip_steps", []))
            ) + [skip_step]
            yield json.dumps({
                "type": "phase", "cidr": normalized, "phase": "delete_byoip",
                "label": "删除 BYOIP 地址", "status": "done",
                "message": "已跳过（未勾选删除 BYOIP）", "completed": True,
            }, ensure_ascii=False) + "\n"
        yield json.dumps(
            {"type": "phase_global", "phase": "delete_byoip_all", "status": "done",
             "message": "阶段三：未勾选删除 BYOIP，已跳过", "completed": True},
            ensure_ascii=False,
        ) + "\n"

    # ── 阶段四：清理 LOA，输出各 CIDR 最终结果 ──
    yield json.dumps(
        {"type": "phase_global", "phase": "cleanup_loa", "status": "running",
         "message": "阶段四：清理 LOA 文件并汇总结果…"},
        ensure_ascii=False,
    ) + "\n"

    success_count = 0
    results = []

    for idx, cidr in enumerate(cidrs):
        normalized = normalize_cidr_input(cidr)
        yield json.dumps(
            {"type": "cidr_start", "index": idx, "total": total, "cidr": normalized},
            ensure_ascii=False,
        ) + "\n"

        if normalized not in ctx_map or normalized in prepare_errors:
            err = prepare_errors.get(normalized, prepare_errors.get(cidr, "前置阶段处理失败"))
            result = {"type": "cidr_result", "index": idx, "cidr": normalized, "ok": False, "error": err}
            results.append(result)
            yield json.dumps(result, ensure_ascii=False) + "\n"
            continue

        ctx = ctx_map[normalized]
        eq = _queue.Queue()
        holder = {}

        def _loa_worker(c=ctx, q=eq, h=holder):
            try:
                detail = _cleanup_loa_cidr(
                    c, dry_run=dry_run, config_path=config_path,
                    on_progress=lambda ev: q.put(("phase", ev)),
                )
                h["detail"] = detail
                q.put(("done", None))
            except Exception as exc:
                h["error"] = exc
                q.put(("error", None))

        t = _threading.Thread(target=_loa_worker, daemon=True)
        t.start()

        for kind, payload in iter_queue_with_keepalive(eq):
            if kind == "keepalive":
                yield KEEPALIVE_LINE
            elif kind == "phase":
                yield json.dumps(payload, ensure_ascii=False) + "\n"
            elif kind == "error":
                exc = holder.get("error") or RuntimeError("LOA 清理失败")
                result = {"type": "cidr_result", "index": idx, "cidr": normalized, "ok": False, "error": str(exc)}
                results.append(result)
                yield json.dumps(result, ensure_ascii=False) + "\n"
                break
            elif kind == "done":
                detail = holder["detail"]
                success_count += 1
                result = {
                    "type": "cidr_result", "index": idx, "cidr": detail["cidr"], "ok": True,
                    "message": (
                        f"撤播完成：删除经典公网 {detail['detached_segments']} 段，"
                        f"BYOIP撤播={'是' if detail['unbroadcasted'] else '否'}，"
                        f"BYOIP删除={'是' if detail.get('byoip_deleted') else '否'}，"
                        f"LOA删除={'是' if detail.get('loa_deleted') else '否'}"
                    ),
                    "steps": detail.get("steps", []),
                }
                results.append(result)
                yield json.dumps(result, ensure_ascii=False) + "\n"
                if on_upstream_invalidate and detail.get("cidr"):
                    on_upstream_invalidate(str(detail["cidr"]))
                break

    yield json.dumps(
        {"type": "batch_done", "total": total, "success_count": success_count, "results": results},
        ensure_ascii=False,
    ) + "\n"

