from __future__ import annotations

import os
from typing import Any

from zen_byoip.client import unwrap_response, zec_call


def _row_public_ip(row: dict[str, Any]) -> str:
    addrs = row.get("publicIpAddresses") or []
    if isinstance(addrs, list) and addrs:
        return str(addrs[0])
    return ""


def _eip_list_max_pages() -> int:
    raw = os.environ.get("ZENLAYER_EIP_LIST_MAX_PAGES", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return min(500, int(raw))
    return 40


def _eip_list_page_timeout() -> int:
    raw = os.environ.get("ZENLAYER_EIP_LIST_PAGE_TIMEOUT_MS", "").strip()
    if raw.isdigit():
        ms = int(raw)
        if ms >= 5000:
            return max(5, min(120, ms // 1000))
    return 45


def _eip_list_page_size() -> int:
    raw = os.environ.get("ZENLAYER_EIP_LIST_PAGE_SIZE", "").strip()
    if raw.isdigit() and int(raw) >= 10:
        return min(500, int(raw))
    return 100


def _eip_preview_match_limit() -> int:
    """单段 /24 约 254 主机，匹配够即停，避免扫全地域。"""
    raw = os.environ.get("ZENLAYER_EIP_PREVIEW_MATCH_LIMIT", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return min(2048, int(raw))
    return 254


def search_eip_rows_by_ip_query_paged(
    *,
    region_id: str,
    ip_query: str,
    ak: str,
    sk: str,
    ver: str,
    max_matches: int = 500,
) -> tuple[list[dict[str, Any]], int, bool, bool]:
    """
    分页 DescribeEips，按公网 IP 子串边扫边匹配，避免全量拉取卡住。
     返回 (matched_rows, pages_scanned, match_list_capped, page_scan_capped)。
    """
    if max_matches is None:
        max_matches = _eip_preview_match_limit()
    q = ip_query.strip().lower()
    matched: list[dict[str, Any]] = []
    max_pages = _eip_list_max_pages()
    timeout_sec = _eip_list_page_timeout()
    page_size = _eip_list_page_size()
    page_num = 0
    last_rows = 0
    api_total: int | None = None

    while page_num < max_pages:
        page_num += 1
        data = zec_call(
            "DescribeEips",
            {"regionId": region_id, "pageNum": page_num, "pageSize": page_size},
            access_key_id=ak,
            access_key_password=sk,
            api_version=ver,
            timeout=timeout_sec,
        )
        inner = unwrap_response(data)
        if api_total is None:
            t = int(inner.get("totalCount") or inner.get("total") or 0)
            if t > 0:
                api_total = t
        rows = list(inner.get("dataSet") or [])
        last_rows = len(rows)
        if not rows:
            return matched, page_num, False, False
        for r in rows:
            ip = _row_public_ip(r)
            if ip and q in ip.lower():
                matched.append(r)
                if len(matched) >= max_matches:
                    print(
                        f"  DescribeEips 第 {page_num} 页：本页 {len(rows)} 条，累计匹配 {len(matched)} 条（已达上限 {max_matches}，停止翻页）",
                        flush=True,
                    )
                    return matched, page_num, True, False
        print(
            f"  DescribeEips 第 {page_num} 页：本页 {len(rows)} 条，累计匹配 {len(matched)} 条",
            flush=True,
        )
        if len(rows) < page_size:
            return matched, page_num, False, False
        if api_total is not None and page_num * page_size >= api_total:
            return matched, page_num, False, False

    page_capped = page_num >= max_pages and last_rows >= page_size
    return matched, page_num, False, page_capped


def assert_eip_ids_match_ip_query(
    *,
    region_id: str,
    eip_ids: list[str],
    ip_query: str,
    ak: str,
    sk: str,
    ver: str,
) -> None:
    q = ip_query.strip().lower()
    chunk_size = _eip_list_page_size()
    for i in range(0, len(eip_ids), chunk_size):
        chunk = eip_ids[i : i + chunk_size]
        data = zec_call(
            "DescribeEips",
            {
                "regionId": region_id,
                "eipIds": chunk,
                "pageNum": 1,
                "pageSize": chunk_size,
            },
            access_key_id=ak,
            access_key_password=sk,
            api_version=ver,
            timeout=60,
        )
        inner = unwrap_response(data)
        rows = list(inner.get("dataSet") or [])
        by_id = {str(r.get("eipId") or ""): r for r in rows}
        for eid in chunk:
            r = by_id.get(eid)
            if not r:
                raise RuntimeError(f"DescribeEips 未返回 {eid}，请重新查询后再删")
            ip = _row_public_ip(r)
            if q not in ip.lower():
                raise RuntimeError(
                    f"eipId {eid} 当前公网 IP「{ip}」不包含「{ip_query}」，请重新查询后再删"
                )


def filter_rows_by_ip_substring(rows: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    q = query.strip().lower()
    if not q:
        return []
    matched: list[dict[str, Any]] = []
    for r in rows:
        ip = _row_public_ip(r)
        if ip and q in ip.lower():
            matched.append(r)
    return matched


def _eip_nonempty_assoc_value(val: Any) -> bool:
    if val is None:
        return False
    s = str(val).strip()
    if not s or s == "-":
        return False
    if s.lower() in ("null", "none"):
        return False
    return True


def _eip_row_has_association(row: dict[str, Any]) -> bool:
    """与控制台「分配的资源」一致：DescribeEips 的关联 ID 任一非空即视为仍绑定。"""
    for key in ("associatedId", "instanceId", "nicId"):
        if _eip_nonempty_assoc_value(row.get(key)):
            return True
    return False


_EIP_TRANSITION_STATUSES = frozenset(
    {
        "UNACCOSCIATING",  # Zenlayer 文档拼写
        "UNASSOCIATING",
        "ASSOCIATING",
        "BINDING",
        "CREATING",
    }
)


def _describe_eip_row(
    *,
    region_id: str,
    eip_id: str,
    ak: str,
    sk: str,
    ver: str,
) -> dict[str, Any] | None:
    data = zec_call(
        "DescribeEips",
        {
            "regionId": region_id,
            "eipIds": [eip_id],
            "pageNum": 1,
            "pageSize": 10,
        },
        access_key_id=ak,
        access_key_password=sk,
        api_version=ver,
        timeout=60,
    )
    inner = unwrap_response(data)
    rows = list(inner.get("dataSet") or [])
    if not rows:
        return None
    r = rows[0]
    return r if isinstance(r, dict) else None


def delete_eip_if_unbound(
    *,
    region_id: str,
    eip_id: str,
    ak: str,
    sk: str,
    ver: str,
    treat_missing_describe_as_deleted: bool = False,
) -> None:
    """未关联实例/网卡时才 DeleteEip；不解绑。状态仅用于拦截「绑定/解绑进行中」。"""
    row = _describe_eip_row(
        region_id=region_id, eip_id=eip_id, ak=ak, sk=sk, ver=ver
    )
    if not row:
        if treat_missing_describe_as_deleted:
            return
        raise RuntimeError(
            f"DescribeEips 未返回 EIP {eip_id}，请核对 regionId 是否与控制台地域一致。"
        )
    st = str(row.get("status") or row.get("eipStatus") or "").strip()
    u = st.upper()
    if u in _EIP_TRANSITION_STATUSES:
        raise RuntimeError(
            f"EIP {eip_id} 状态为「{st}」（绑定/解绑进行中），请稍后再删；本工具不解绑。"
        )
    if _eip_row_has_association(row):
        raise RuntimeError(
            f"EIP {eip_id} 在接口中仍有关联资源（instanceId/nicId/associatedId），"
            "与控制台不一致时请稍后重试；若已绑定请先在控制台解绑。"
        )
    zec_call(
        "DeleteEip",
        {"eipId": eip_id},
        access_key_id=ak,
        access_key_password=sk,
        api_version=ver,
        timeout=120,
    )


def release_eip_safe(
    *,
    region_id: str,
    eip_id: str,
    ak: str,
    sk: str,
    ver: str,
    treat_missing_describe_as_deleted: bool = False,
) -> None:
    """兼容旧名：与 delete_eip_if_unbound 相同。"""
    delete_eip_if_unbound(
        region_id=region_id,
        eip_id=eip_id,
        ak=ak,
        sk=sk,
        ver=ver,
        treat_missing_describe_as_deleted=treat_missing_describe_as_deleted,
    )


def eip_delete_concurrency() -> int:
    """并行 DeleteEip 线程数，与 Web 端 ZENLAYER_EIP_DELETE_CONCURRENCY 一致。"""
    raw = os.environ.get("ZENLAYER_EIP_DELETE_CONCURRENCY", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return min(32, int(raw))
    return 8


def eip_delete_retry_delay_sec() -> float:
    """与 Web 端 ZENLAYER_EIP_DELETE_RETRY_DELAY_MS 一致（毫秒转秒）。"""
    raw = os.environ.get("ZENLAYER_EIP_DELETE_RETRY_DELAY_MS", "").strip()
    if raw.isdigit():
        ms = int(raw)
        if ms >= 0:
            return min(300.0, ms / 1000.0)
    return 5.0


def eip_delete_max_rounds() -> int:
    raw = os.environ.get("ZENLAYER_EIP_DELETE_MAX_ROUNDS", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return min(30, int(raw))
    return 10


def is_transient_eip_delete_error(message: str) -> bool:
    """HTTP 5xx、网络类错误可重试。"""
    s = message.lower()
    if "http 500" in s:
        return True
    if "internal_server_error" in s:
        return True
    if any(x in s for x in ("http 502", "http 503", "http 504")):
        return True
    if "网络错误" in s:
        return True
    if "urlerror" in s or "connection reset" in s or "timed out" in s:
        return True
    if "timeout" in s:
        return True
    return False
