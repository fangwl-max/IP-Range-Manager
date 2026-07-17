"""批量宣告流程与进度事件（NDJSON 流式输出）。"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Iterator, List, Optional

InvalidateUpstreamFn = Optional[Callable[[str], None]]

from ip_announce_system import CapitalOnlineClient, Reconciler, load_config
from rule_builder import build_rule_from_form_row, normalize_cidr_input

ProgressFn = Optional[Callable[[Dict[str, Any]], None]]


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
) -> None:
    _emit(
        fn,
        {
            "type": "phase",
            "cidr": cidr,
            "phase": phase,
            "status": status,
            "message": message,
            "completed": completed,
        },
    )


def announce_one_row(
    client: CapitalOnlineClient,
    *,
    config_path: str,
    row: Dict[str, Any],
    index: int,
    sites: List[Dict[str, Any]],
    public_networks: List[Dict[str, Any]],
    dry_run: bool,
    stop_on_creating: bool,
    on_progress: ProgressFn = None,
) -> Dict[str, Any]:
    cfg = load_config(config_path)
    cidr_raw = str(row.get("cidr", "")).strip()
    site_id = str(row.get("site_id", "")).strip()
    asn = str(row.get("asn", "")).strip()
    normalized = normalize_cidr_input(cidr_raw) if cidr_raw else cidr_raw

    _phase(on_progress, cidr=normalized or cidr_raw, phase="prepare", status="running", message="校验区域、ASN 与 LOA…")
    try:
        rule = build_rule_from_form_row(
            cfg,
            cidr=cidr_raw,
            site_id=site_id,
            asn=asn,
            action="announce",
            sites=sites,
            public_networks=public_networks,
        )
    except Exception:
        _phase(on_progress, cidr=normalized or cidr_raw, phase="prepare", status="failed", message="校验失败", completed=True)
        raise

    _phase(
        on_progress,
        cidr=rule.cidr,
        phase="prepare",
        status="done",
        message=f"LOA 已就绪 · Pipe {rule.pipe_id[:8]}…",
        completed=True,
    )

    reconciler = Reconciler(client, dry_run=dry_run)

    if stop_on_creating:
        _phase(on_progress, cidr=rule.cidr, phase="create", status="running", message="提交 CreateBYOIPOneStep…")
        detail = reconciler._announce_flow_create_only(rule)  # noqa: SLF001
        _phase(
            on_progress,
            cidr=rule.cidr,
            phase="create",
            status="done",
            message="已提交创建" if detail.get("created") else "BYOIP 已存在，已进入创建流程",
            completed=True,
        )
        _phase(
            on_progress,
            cidr=rule.cidr,
            phase="wait_creating",
            status="done",
            message=f"当前状态：{detail.get('status_zh', '创建中')}",
            completed=True,
        )
        msg = (
            f"{'已提交创建' if detail.get('created') else '已在创建中'}，"
            f"状态：{detail.get('status_zh', '创建中')}"
        )
        return {
            "index": index,
            "cidr": rule.cidr,
            "ok": True,
            "message": msg,
            "byoip_id": detail.get("byoip_id"),
            "pipe_id": rule.pipe_id,
            "public_id": rule.public_id,
        }

    _phase(on_progress, cidr=rule.cidr, phase="create", status="running", message="检查/创建 BYOIP…")
    byoip_id = reconciler._ensure_created(rule)  # noqa: SLF001
    _phase(on_progress, cidr=rule.cidr, phase="create", status="done", message=f"BYOIP ID: {byoip_id[:12]}…", completed=True)

    _phase(on_progress, cidr=rule.cidr, phase="broadcast", status="running", message="等待可广播状态并提交 Broadcast…")
    byoip_item = reconciler._find_byoip(rule)  # noqa: SLF001
    if not byoip_item:
        _phase(on_progress, cidr=rule.cidr, phase="broadcast", status="failed", message="未查到 BYOIP", completed=True)
        raise RuntimeError(f"未查到 BYOIP: {rule.cidr}")
    reconciler._ensure_broadcasted(rule, byoip_item)  # noqa: SLF001
    _phase(on_progress, cidr=rule.cidr, phase="broadcast", status="done", message="广播已提交/已广播", completed=True)

    _phase(on_progress, cidr=rule.cidr, phase="attach", status="running", message="检查公网挂载…")
    reconciler._ensure_attached(rule, byoip_id)  # noqa: SLF001
    _phase(on_progress, cidr=rule.cidr, phase="attach", status="done", message="公网挂载完成", completed=True)

    return {
        "index": index,
        "cidr": rule.cidr,
        "ok": True,
        "message": f"宣告完成: {rule.cidr}",
        "byoip_id": byoip_id,
        "pipe_id": rule.pipe_id,
        "public_id": rule.public_id,
    }


def iter_announce_events(
    client: CapitalOnlineClient,
    rows: List[Dict[str, Any]],
    *,
    config_path: str,
    sites: List[Dict[str, Any]],
    public_networks: List[Dict[str, Any]],
    dry_run: bool,
    stop_on_creating: bool,
    on_upstream_invalidate: InvalidateUpstreamFn = None,
) -> Iterator[str]:
    total = len(rows)
    yield json.dumps(
        {
            "type": "batch_start",
            "total": total,
            "dry_run": dry_run,
            "stop_on_creating": stop_on_creating,
        },
        ensure_ascii=False,
    ) + "\n"

    success_count = 0
    results: List[Dict[str, Any]] = []

    for idx, row in enumerate(rows):
        cidr_hint = str(row.get("cidr", "")).strip() or f"行{idx + 1}"
        try:
            cidr_hint = normalize_cidr_input(cidr_hint)
        except ValueError:
            pass

        yield json.dumps(
            {"type": "cidr_start", "index": idx, "total": total, "cidr": cidr_hint},
            ensure_ascii=False,
        ) + "\n"

        buffer: List[str] = []

        def capture(ev: Dict[str, Any]) -> None:
            buffer.append(json.dumps(ev, ensure_ascii=False) + "\n")

        try:
            detail = announce_one_row(
                client,
                config_path=config_path,
                row=row,
                index=idx,
                sites=sites,
                public_networks=public_networks,
                dry_run=dry_run,
                stop_on_creating=stop_on_creating,
                on_progress=capture,
            )
            for line in buffer:
                yield line
            success_count += 1
            result = {"type": "cidr_result", **detail}
            results.append(result)
            yield json.dumps(result, ensure_ascii=False) + "\n"
            if on_upstream_invalidate and detail.get("ok") and detail.get("cidr"):
                on_upstream_invalidate(str(detail["cidr"]))
        except Exception as exc:  # noqa: BLE001
            for line in buffer:
                yield line
            result = {
                "type": "cidr_result",
                "index": idx,
                "cidr": cidr_hint,
                "ok": False,
                "error": str(exc),
            }
            results.append(result)
            yield json.dumps(result, ensure_ascii=False) + "\n"

    yield json.dumps(
        {
            "type": "batch_done",
            "total": total,
            "success_count": success_count,
            "results": results,
        },
        ensure_ascii=False,
    ) + "\n"
