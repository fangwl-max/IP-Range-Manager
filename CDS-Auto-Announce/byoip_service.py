"""首云自有公网 IP 上云（BYOIP）列表查询与缓存。"""
from __future__ import annotations

import ipaddress
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

from app_paths import default_byoip_list_cache_path
from ip_announce_system import CapitalOnlineClient, is_success_response, load_config
from bgp_tools_service import BgpToolsService
from loa_service import LoaService
from public_ipv4_service import enrich_items_purchase_meta

STATUS_LABELS = {
    "broadcasted": "已广播",
    "broadcasting": "广播中",
    "unbroadcasted": "未广播",
    "creating": "创建中",
    "processing": "处理中",
    "revoked": "已撤销",
    "failed": "失败",
}

STATUS_TONE = {
    "broadcasted": "ok",
    "broadcasting": "warn",
    "creating": "info",
    "processing": "info",
    "failed": "err",
    "revoked": "muted",
    "unbroadcasted": "muted",
}


def status_tone_for(status: str) -> str:
    return STATUS_TONE.get(str(status or "").strip().lower(), "muted")

STATUS_OPTION_ORDER = [
    "creating",
    "processing",
    "unbroadcasted",
    "revoked",
    "broadcasting",
    "broadcasted",
    "failed",
]


def _mask_str(mask: Any) -> str:
    return str(int(mask)) if str(mask).isdigit() else str(mask)


def mask_to_ipv4_count(prefixlen: int) -> int:
    """由经典公网网段掩码推导 IPv4 数量（与 AddPublicIp 的 Number 档位一致）。"""
    return 2 ** (32 - int(prefixlen))


def build_vdc_ipv4_index(vdc_resp: Dict[str, Any]) -> Dict[str, List[Tuple[str, int]]]:
    """按 VDC 汇总经典公网 Segments：[(segment_cidr, ipv4_count), ...]。"""
    index: Dict[str, List[Tuple[str, int]]] = {}
    if not is_success_response(vdc_resp):
        return index
    for vdc in vdc_resp.get("Data") or []:
        vdc_id = str(vdc.get("VdcId", ""))
        if not vdc_id:
            continue
        bucket = index.setdefault(vdc_id, [])
        for public_net in vdc.get("PublicNetwork") or []:
            for seg in public_net.get("Segments") or []:
                address = str(seg.get("Address", "")).strip()
                mask = seg.get("Mask")
                if not address or mask is None:
                    continue
                seg_cidr = f"{address}/{int(mask)}"
                bucket.append((seg_cidr, mask_to_ipv4_count(int(mask))))
    return index


def split_search_keyword(keyword: str) -> Tuple[str, str]:
    """拆分 API 关键字与本地筛选原文（支持 151.243.178.0/24 这类完整 CIDR）。"""
    raw = keyword.strip()
    if not raw:
        return "", ""
    if "/" in raw:
        addr = raw.split("/", 1)[0].strip()
        return addr or raw, raw
    return raw, raw


def item_matches_keyword(item: Dict[str, Any], keyword: str) -> bool:
    raw = keyword.strip()
    if not raw:
        return True
    kw = raw.lower()

    fields: List[str] = [
        str(item.get("cidr", "")),
        str(item.get("address", "")),
        str(item.get("mask", "")),
        str(item.get("asn", "")),
        str(item.get("site_name", "")),
        str(item.get("pipe_name", "")),
        str(item.get("vdc_name", "")),
    ]
    for seg in item.get("ipv4_segments") or []:
        fields.append(str(seg))

    blob = " ".join(f.lower() for f in fields if f)
    if kw in blob:
        return True

    if "/" in kw:
        try:
            want = ipaddress.ip_network(kw, strict=False)
            item_cidr = str(item.get("cidr", "")).strip()
            if item_cidr:
                have = ipaddress.ip_network(item_cidr, strict=False)
                if have == want:
                    return True
        except ValueError:
            pass
    return False


def resolve_classic_ipv4_info(
    *,
    vdc_id: str,
    byoip_cidr: str,
    vdc_index: Dict[str, List[Tuple[str, int]]],
) -> Tuple[Optional[int], str, bool, List[str]]:
    """
    匹配 BYOIP 所在 VDC 下、落在该网段内的经典公网 IPv4 块。
    返回 (合计数量, 展示文案, 是否已挂载, 经典公网 segment CIDR 列表)。
    """
    if not vdc_id or not byoip_cidr:
        return None, "-", False, []
    try:
        byoip_net = ipaddress.ip_network(byoip_cidr, strict=False)
    except ValueError:
        return None, "-", False, []

    counts: List[int] = []
    segment_cidrs: List[str] = []
    for seg_cidr, count in vdc_index.get(vdc_id, []):
        try:
            seg_net = ipaddress.ip_network(seg_cidr, strict=False)
        except ValueError:
            continue
        if seg_net.subnet_of(byoip_net) or seg_net == byoip_net:
            counts.append(count)
            segment_cidrs.append(seg_cidr)

    if not counts:
        return None, "-", False, []

    segment_cidrs = sorted(segment_cidrs, key=lambda c: (ipaddress.ip_network(c, strict=False).network_address, c))
    total = sum(counts)
    if len(counts) == 1:
        label = str(counts[0])
    elif len(set(counts)) == 1:
        label = f"{counts[0]}×{len(counts)}"
    else:
        label = "+".join(str(c) for c in counts)
    return total, label, True, segment_cidrs


def find_classic_segments_within_byoip(
    vdc_resp: Dict[str, Any],
    byoip_cidr: str,
    *,
    vdc_id: str = "",
    public_id: str = "",
) -> List[Dict[str, str]]:
    """
    查找落在 BYOIP 网段内的经典公网段（含新购 /25）。
    返回 [{"segment_id", "cidr"}, ...]。
    """
    if not is_success_response(vdc_resp):
        return []
    try:
        byoip_net = ipaddress.ip_network(byoip_cidr, strict=False)
    except ValueError:
        return []

    want_vdc = str(vdc_id or "").strip()
    want_public = str(public_id or "").strip()
    rows: List[Dict[str, str]] = []
    seen: Set[str] = set()

    for vdc in vdc_resp.get("Data") or []:
        vid = str(vdc.get("VdcId", ""))
        if want_vdc and vid != want_vdc:
            continue
        for public_net in vdc.get("PublicNetwork") or []:
            pid = str(public_net.get("PublicId", ""))
            if want_public and pid != want_public:
                continue
            for seg in public_net.get("Segments") or []:
                address = str(seg.get("Address", "")).strip()
                mask = seg.get("Mask")
                if not address or mask is None:
                    continue
                try:
                    seg_net = ipaddress.ip_network(f"{address}/{int(mask)}", strict=False)
                except ValueError:
                    continue
                if not (seg_net.subnet_of(byoip_net) or seg_net == byoip_net):
                    continue
                seg_id = str(seg.get("SegmentId", "")).strip()
                if seg_id and seg_id not in seen:
                    seen.add(seg_id)
                    rows.append({"segment_id": seg_id, "cidr": str(seg_net)})
    rows.sort(key=lambda r: r["cidr"])
    return rows


def find_classic_segment_ids_within_byoip(
    vdc_resp: Dict[str, Any],
    byoip_cidr: str,
    *,
    vdc_id: str = "",
    public_id: str = "",
) -> List[str]:
    """查找落在 BYOIP 网段内的经典公网 SegmentId（含新购的 /25 等子网段）。"""
    return [
        row["segment_id"]
        for row in find_classic_segments_within_byoip(
            vdc_resp, byoip_cidr, vdc_id=vdc_id, public_id=public_id
        )
    ]


def enrich_items_with_classic_ipv4(
    items: List[Dict[str, Any]],
    vdc_index: Dict[str, List[Tuple[str, int]]],
) -> None:
    for item in items:
        total, label, mounted, segments = resolve_classic_ipv4_info(
            vdc_id=str(item.get("vdc_id", "")),
            byoip_cidr=str(item.get("cidr", "")),
            vdc_index=vdc_index,
        )
        item["ipv4_count"] = total
        item["ipv4_count_label"] = label
        item["ipv4_segments"] = segments
        item["classic_public_mounted"] = mounted


def normalize_byoip_item(raw: Dict[str, Any]) -> Dict[str, Any]:
    address = str(raw.get("Address", ""))
    mask = _mask_str(raw.get("Mask", ""))
    cidr = str(raw.get("AddressStr", "")).strip() or (f"{address}/{mask}" if address and mask else "")
    status = str(raw.get("Status", "")).lower()
    return {
        "id": str(raw.get("Id", "")),
        "cidr": cidr,
        "address": address,
        "mask": mask,
        "asn": str(raw.get("Asn", "")),
        "status": status,
        "status_label": str(raw.get("StatusZh", "")) or STATUS_LABELS.get(status, status or "-"),
        "status_tone": status_tone_for(status),
        "site_id": str(raw.get("SiteId", "")),
        "site_name": str(raw.get("SiteName", "")),
        "pipe_id": str(raw.get("PipeId", "")),
        "pipe_name": str(raw.get("PipeName", "")),
        "vdc_id": str(raw.get("VdcId", "")),
        "vdc_name": str(raw.get("VdcName", "")),
        "vdc_project_id": str(raw.get("VdcProjectId", "")),
        "ip_number_options": raw.get("IpNumList") or [],
    }


def build_status_options(
    items: List[Dict[str, Any]],
    status_stats: Optional[Dict[str, int]] = None,
) -> List[Dict[str, str]]:
    seen: set[str] = set()
    options: List[Dict[str, str]] = []

    def add_option(value: str, label: str) -> None:
        key = value.strip().lower()
        if not key or key in seen:
            return
        seen.add(key)
        options.append({"value": key, "label": label or key})

    for key in STATUS_OPTION_ORDER:
        if key in STATUS_LABELS:
            add_option(key, STATUS_LABELS[key])

    for row in items:
        status = str(row.get("status", "")).strip().lower()
        if status:
            add_option(status, str(row.get("status_label", "")) or STATUS_LABELS.get(status, status))

    for key in sorted((status_stats or {}).keys()):
        if key:
            add_option(key, STATUS_LABELS.get(key, key))

    return options


def build_byoip_list_payload(
    items: List[Dict[str, Any]],
    *,
    loa_service: Optional[LoaService] = None,
    errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    enriched: List[Dict[str, Any]] = []
    for item in items:
        row = dict(item)
        if loa_service and row.get("cidr"):
            try:
                loa = loa_service.loa_status(row["cidr"])
                row["loa_ready"] = loa.get("ready", False)
                row["loa_location"] = loa.get("location", "none")
            except (ValueError, OSError):
                row["loa_ready"] = False
                row["loa_location"] = "none"
        enriched.append(row)

    status_stats: Dict[str, int] = {}
    for row in enriched:
        key = row.get("status") or "unknown"
        status_stats[key] = status_stats.get(key, 0) + 1

    return {
        "ok": not errors,
        "items": enriched,
        "total": len(enriched),
        "status_stats": status_stats,
        "status_options": build_status_options(enriched, status_stats),
        "errors": errors or [],
        "refreshed_at": int(time.time()),
        "source": "DescribeBYOIPList+DescribeVdc",
    }


DEFAULT_LIST_CACHE_SECONDS = 300


class ByoipService:
    def __init__(
        self,
        config_path: str,
        cache_seconds: Optional[int] = None,
        bgp_tools_service: Optional[BgpToolsService] = None,
    ):
        self.config_path = config_path
        cfg = load_config(self.config_path)
        web_cfg = cfg.get("web") or {}
        configured = web_cfg.get("byoip_list_cache_seconds")
        if cache_seconds is not None:
            self.cache_seconds = int(cache_seconds)
        elif configured is not None:
            self.cache_seconds = int(configured)
        else:
            self.cache_seconds = DEFAULT_LIST_CACHE_SECONDS
        self.list_cache_path: Path = default_byoip_list_cache_path()
        bgp_cache_seconds = int(web_cfg.get("bgp_upstream_cache_seconds", 3600))
        bgp_proxy = str(web_cfg.get("bgp_tools_proxy") or "").strip() or None
        self.bgp_tools = bgp_tools_service or BgpToolsService(
            cache_seconds=bgp_cache_seconds,
            proxy=bgp_proxy,
        )
        self._cache: Dict[str, Any] = {}
        self._cached_at = 0.0
        self._load_disk_list_cache()

    def invalidate_cache(self) -> None:
        self._cache = {}
        self._cached_at = 0.0
        try:
            self.list_cache_path.unlink(missing_ok=True)
        except OSError:
            pass

    def default_purchase_ip_number(self) -> int:
        cfg = load_config(self.config_path)
        value = int((cfg.get("web") or {}).get("default_purchase_ip_number", 128))
        return value if value > 0 else 128

    def _is_fresh(self) -> bool:
        if self.cache_seconds <= 0:
            return False
        return bool(self._cache) and (time.time() - self._cached_at) < self.cache_seconds

    def _load_disk_list_cache(self) -> None:
        if not self.list_cache_path.is_file():
            return
        try:
            raw = json.loads(self.list_cache_path.read_text(encoding="utf-8"))
            cached_at = float(raw.get("_cached_at", 0) or 0)
            payload = raw.get("payload")
            if not isinstance(payload, dict) or not payload.get("items"):
                return
            if self.cache_seconds > 0 and (time.time() - cached_at) >= self.cache_seconds:
                return
            self._cache = payload
            self._cached_at = cached_at
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            self._cache = {}
            self._cached_at = 0.0

    def _save_disk_list_cache(self, payload: Dict[str, Any]) -> None:
        if self.cache_seconds <= 0:
            return
        try:
            self.list_cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.list_cache_path.write_text(
                json.dumps(
                    {"_cached_at": self._cached_at, "payload": payload},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError:
            pass

    @staticmethod
    def _refresh_loa_fields(items: List[Dict[str, Any]], loa_service: LoaService) -> None:
        for row in items:
            cidr = str(row.get("cidr", "")).strip()
            if not cidr:
                continue
            try:
                loa = loa_service.loa_status(cidr)
                row["loa_ready"] = loa.get("ready", False)
                row["loa_location"] = loa.get("location", "none")
            except (ValueError, OSError):
                row["loa_ready"] = False
                row["loa_location"] = "none"

    def _decorate_cache_meta(self, payload: Dict[str, Any], *, cached: bool) -> Dict[str, Any]:
        out = dict(payload)
        out["cached"] = cached
        if cached and self._cached_at:
            out["cache_age_seconds"] = int(max(0, time.time() - self._cached_at))
        else:
            out.pop("cache_age_seconds", None)
        return out

    def _filter_cached_payload(
        self,
        payload: Dict[str, Any],
        *,
        keyword: str,
        status_filter: str,
        loa_service: LoaService,
    ) -> Dict[str, Any]:
        items = [dict(x) for x in (payload.get("items") or [])]
        if status_filter:
            want = status_filter.strip().lower()
            items = [x for x in items if str(x.get("status", "")).lower() == want]
        raw_keyword = keyword.strip()
        if raw_keyword:
            items = [x for x in items if item_matches_keyword(x, raw_keyword)]
        self._refresh_loa_fields(items, loa_service)
        out = dict(payload)
        out["items"] = items
        out["total"] = len(items)
        return self._decorate_cache_meta(out, cached=True)

    def _serve_from_cache(
        self,
        *,
        keyword: str,
        status_filter: str,
        loa_service: LoaService,
    ) -> Dict[str, Any]:
        if keyword.strip() or status_filter.strip():
            return self._filter_cached_payload(
                self._cache,
                keyword=keyword,
                status_filter=status_filter,
                loa_service=loa_service,
            )
        items = [dict(x) for x in (self._cache.get("items") or [])]
        self._refresh_loa_fields(items, loa_service)
        out = dict(self._cache)
        out["items"] = items
        return self._decorate_cache_meta(out, cached=True)

    def fetch_all(
        self,
        *,
        force: bool = False,
        keyword: str = "",
        status_filter: str = "",
    ) -> Dict[str, Any]:
        cfg = load_config(self.config_path)
        loa_service = LoaService(cfg)

        if not force and self._is_fresh():
            return self._serve_from_cache(
                keyword=keyword,
                status_filter=status_filter,
                loa_service=loa_service,
            )

        if not force and not self._cache:
            self._load_disk_list_cache()
        if not force and self._is_fresh():
            return self._serve_from_cache(
                keyword=keyword,
                status_filter=status_filter,
                loa_service=loa_service,
            )

        client = CapitalOnlineClient(cfg)
        errors: List[str] = []
        all_items: List[Dict[str, Any]] = []
        page = 1
        page_size = 100

        while True:
            try:
                resp = client.describe_byoip_list(
                    keyword="",
                    show_all=True,
                    page=page,
                    page_size=page_size,
                )
            except (requests.RequestException, RuntimeError) as exc:
                errors.append(f"查询 BYOIP 列表失败: {exc}")
                break

            if not is_success_response(resp):
                errors.append(f"DescribeBYOIPList 失败: {resp.get('Message', resp)}")
                break

            batch = (((resp.get("Data") or {}).get("ByoipList")) or [])
            for raw in batch:
                all_items.append(normalize_byoip_item(raw))

            total = int((resp.get("Data") or {}).get("Total", 0) or 0)
            if not batch or len(all_items) >= total:
                break
            page += 1
            if page > 50:
                break

        try:
            vdc_resp = client.describe_vdc()
            if not is_success_response(vdc_resp):
                errors.append(f"DescribeVdc 失败: {vdc_resp.get('Message', vdc_resp)}")
            else:
                enrich_items_with_classic_ipv4(all_items, build_vdc_ipv4_index(vdc_resp))
                enrich_items_purchase_meta(
                    all_items,
                    vdc_resp,
                    default_number=self.default_purchase_ip_number(),
                )
        except (requests.RequestException, RuntimeError) as exc:
            errors.append(f"查询经典公网 IPv4 数量失败: {exc}")

        if all_items:
            self.bgp_tools.apply_cached_upstream(all_items)

        full_payload = build_byoip_list_payload(all_items, loa_service=loa_service, errors=errors)
        self._cache = full_payload
        self._cached_at = time.time()
        self._save_disk_list_cache(full_payload)

        # 触发后台批量查询上游接收，完成后回写缓存（不阻塞当前响应）
        if all_items:
            import threading as _threading
            def _bg_enrich():
                try:
                    items_copy = [dict(x) for x in (self._cache.get("items") or [])]
                    self.bgp_tools.enrich_items(items_copy, force=False)
                    # 将查询结果合并回缓存
                    cidr_map = {x["cidr"]: x for x in items_copy if x.get("cidr")}
                    cached_items = self._cache.get("items") or []
                    for item in cached_items:
                        cidr = item.get("cidr", "")
                        if cidr in cidr_map:
                            upstream_keys = [k for k in cidr_map[cidr] if k.startswith("upstream_")]
                            for k in upstream_keys:
                                item[k] = cidr_map[cidr][k]
                    self._save_disk_list_cache(self._cache)
                except Exception:  # noqa: BLE001
                    pass
            _threading.Thread(target=_bg_enrich, daemon=True).start()

        if keyword.strip() or status_filter.strip():
            return self._filter_cached_payload(
                full_payload,
                keyword=keyword,
                status_filter=status_filter,
                loa_service=loa_service,
            )
        return self._decorate_cache_meta(full_payload, cached=False)
