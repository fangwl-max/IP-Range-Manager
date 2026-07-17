"""从 bgp.tools Connectivity（pathimg 实时图）解析上游 Tier1 接收情况。"""
from __future__ import annotations

import ipaddress
import json
import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from app_paths import default_bgp_upstream_cache_path

# 与 https://bgp.tools/kb/what-is-a-upstream 一致
TIER1_ASNS = {
    6762, 12956, 2914, 3356, 6453, 701, 6461, 3257, 1299, 3491,
    7018, 3320, 5511, 6830, 174, 6939,
}

USER_AGENT = (
    "Mozilla/5.0 (compatible; ip-announce-console/1.0; +https://bgp.tools/) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
# 超过 9 个 Tier1 上游接收即视为已接受（即 count > 9，至少 10 个）
ACCEPT_THRESHOLD = 9
# pathimg 中 Tier1 列节点 x1 通常 >= 450；中间列为 GTT 等中转
TIER1_COLUMN_MIN_X = 450
AREA_RE = re.compile(
    r'href="/search\?q=AS(\d+)"\s+title="([^"]*)".*?coords="(\d+),',
    re.IGNORECASE | re.DOTALL,
)


def connectivity_url(cidr: str) -> str:
    return f"https://bgp.tools/prefix/{cidr}#connectivity"


def _is_ipv4_prefix(cidr: str) -> bool:
    try:
        return ipaddress.ip_network(cidr, strict=False).version == 4
    except ValueError:
        return True


def _pathimg_slug(cidr: str) -> str:
    return cidr.strip().replace("/", "_")


def parse_pathimg_tier1_providers(html: str, *, ipv4: bool = True) -> List[Dict[str, str]]:
    """解析 pathimg map HTML，返回 Connectivity 图中 Tier1 ISP 列的供应商。"""
    providers: List[Dict[str, str]] = []
    seen: set[int] = set()
    for match in AREA_RE.finditer(html):
        asn = int(match.group(1))
        name = match.group(2).strip()
        x1 = int(match.group(3))
        if asn not in TIER1_ASNS or x1 < TIER1_COLUMN_MIN_X:
            continue
        if ipv4 and asn == 6939:
            continue
        if asn in seen:
            continue
        seen.add(asn)
        providers.append({"asn": str(asn), "name": name})
    providers.sort(key=lambda p: int(p["asn"]))
    return providers


def default_upstream_pending(cidr: str) -> Dict[str, Any]:
    return {
        "upstream_count": None,
        "upstream_accepted": False,
        "upstream_label": "查询中…",
        "upstream_providers": [],
        "upstream_url": connectivity_url(cidr),
        "upstream_error": "",
        "upstream_pending": True,
        "upstream_source": "bgp.tools/pathimg",
    }


def is_upstream_pinned(entry: Dict[str, Any]) -> bool:
    """已接受且无错误的上游结果长期缓存，直至手动刷新或宣告/撤播后失效。"""
    if entry.get("upstream_pinned") is True:
        return True
    if entry.get("upstream_pinned") is False:
        return False
    err = str(entry.get("upstream_error") or "").strip()
    if err:
        return False
    label = str(entry.get("upstream_label") or "")
    if label in {"查询失败", "查询中…"}:
        return False
    if not entry.get("upstream_accepted"):
        return False
    count = entry.get("upstream_count")
    if count is None:
        return False
    try:
        return int(count) > ACCEPT_THRESHOLD
    except (TypeError, ValueError):
        return False


def finalize_upstream_entry(cidr: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    """从缓存条目按当前 ACCEPT_THRESHOLD 重算已接受/未接受（避免改阈值后旧缓存不生效）。"""
    out = dict(entry)
    err = str(out.get("upstream_error") or "")
    label = str(out.get("upstream_label") or "")
    if err or label in {"查询失败", "查询中…"}:
        return out
    providers = out.get("upstream_providers")
    if isinstance(providers, list) and providers:
        return build_upstream_payload(cidr, providers, error=err)
    count = out.get("upstream_count")
    if count is None:
        return out
    try:
        n = int(count)
    except (TypeError, ValueError):
        return out
    accepted = n > ACCEPT_THRESHOLD
    if err:
        text = "查询失败"
    elif accepted:
        text = f"已接受（{n}）"
    else:
        text = f"未接受（{n}）"
    out["upstream_count"] = n
    out["upstream_accepted"] = accepted
    out["upstream_label"] = text
    return out


def build_upstream_payload(
    cidr: str,
    providers: List[Dict[str, str]],
    *,
    error: str = "",
) -> Dict[str, Any]:
    count = len(providers)
    accepted = count > ACCEPT_THRESHOLD
    if error:
        label = "查询失败"
    elif accepted:
        label = f"已接受（{count}）"
    else:
        label = f"未接受（{count}）"
    pinned = accepted and not error
    return {
        "upstream_count": count,
        "upstream_accepted": accepted,
        "upstream_label": label,
        "upstream_providers": providers,
        "upstream_url": connectivity_url(cidr),
        "upstream_error": error,
        "upstream_source": "bgp.tools/pathimg",
        "upstream_pinned": pinned,
        "upstream_cached": False,
    }


def _diagnose_empty_pathimg(html: str) -> str:
    """仅在疑似抓取失败时返回错误文案；真实无上游时返回空串（显示 未接受（0））。"""
    text = html or ""
    if "coords=" in text:
        return ""
    if len(text) < 800:
        return "bgp.tools 响应过短，机房 IP 可能被限流；可将 Windows 开发机的 data/bgp_upstream_cache.json 复制到服务器同路径"
    lower = text.lower()
    if "cf-browser-verification" in lower or "just a moment" in lower:
        return "bgp.tools 要求浏览器验证（Cloudflare），服务器无法直接抓取；请复制 Windows 的 data/bgp_upstream_cache.json"
    return "pathimg 页面无连通图数据，可能被限流；请复制 Windows 的 data/bgp_upstream_cache.json 到服务器"


class BgpToolsService:
    def __init__(
        self,
        cache_path: Optional[str] = None,
        cache_seconds: int = 3600,
        proxy: Optional[str] = None,
    ):
        self.cache_seconds = cache_seconds
        self.cache_path = Path(cache_path) if cache_path else default_bgp_upstream_cache_path()
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._proxies: Optional[Dict[str, str]] = (
            {"http": proxy, "https": proxy} if proxy else None
        )
        self._load_disk_cache()

    def _load_disk_cache(self) -> None:
        if not self.cache_path.exists():
            return
        try:
            raw = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                self._cache = raw
        except (OSError, json.JSONDecodeError):
            self._cache = {}

    def _save_disk_cache(self) -> None:
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps(self._cache, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _cache_get(self, cidr: str, *, force: bool) -> Optional[Dict[str, Any]]:
        if force:
            return None
        entry = self._cache.get(cidr)
        if not entry:
            return None
        if is_upstream_pinned(entry):
            return entry
        if self.cache_seconds > 0 and time.time() - float(entry.get("_cached_at", 0)) > self.cache_seconds:
            return None
        return entry

    def _cache_put(self, cidr: str, payload: Dict[str, Any]) -> None:
        stored = dict(payload)
        stored["_cached_at"] = time.time()
        if is_upstream_pinned(stored):
            stored["upstream_pinned"] = True
        else:
            stored["upstream_pinned"] = False
        self._cache[cidr] = stored

    def invalidate_upstream(self, cidr: str) -> bool:
        """宣告/撤播后清除该网段上游缓存，下次将重新查询 bgp.tools。"""
        key = cidr.strip()
        if not key or key not in self._cache:
            return False
        del self._cache[key]
        self._save_disk_cache()
        return True

    @staticmethod
    def _public_upstream_fields(cidr: str, entry: Dict[str, Any], *, from_cache: bool) -> Dict[str, Any]:
        out = finalize_upstream_entry(cidr, dict(entry))
        out.pop("_cached_at", None)
        out["upstream_cached"] = from_cache
        out["upstream_pinned"] = is_upstream_pinned(entry)
        return out

    def fetch_upstream(self, cidr: str, *, force: bool = False) -> Dict[str, Any]:
        cidr = cidr.strip()
        cached = self._cache_get(cidr, force=force)
        if cached:
            return self._public_upstream_fields(cidr, dict(cached), from_cache=True)

        slug = _pathimg_slug(cidr)
        url = f"https://bgp.tools/pathimg/rt-{slug}?map=true&{uuid.uuid4()}"
        headers = {
            "User-Agent": USER_AGENT,
            "Referer": f"https://bgp.tools/prefix/{cidr}",
            "Accept": "text/html,*/*",
        }
        try:
            resp = requests.get(url, headers=headers, timeout=45, proxies=self._proxies)
            resp.raise_for_status()
            html = resp.text or ""
            providers = parse_pathimg_tier1_providers(html, ipv4=_is_ipv4_prefix(cidr))
            parse_err = ""
            if not providers:
                parse_err = _diagnose_empty_pathimg(html)
            payload = build_upstream_payload(cidr, providers, error=parse_err)
        except requests.RequestException as exc:
            payload = build_upstream_payload(cidr, [], error=str(exc))

        self._cache_put(cidr, payload)
        self._save_disk_cache()
        return self._public_upstream_fields(cidr, payload, from_cache=False)

    def apply_cached_upstream(self, items: List[Dict[str, Any]]) -> None:
        """仅合并本地缓存，不发起网络请求（避免列表接口长时间阻塞）。"""
        for item in items:
            cidr = str(item.get("cidr", "")).strip()
            if not cidr:
                continue
            cached = self._cache_get(cidr, force=False)
            if cached:
                out = self._public_upstream_fields(cidr, dict(cached), from_cache=True)
                out["upstream_pending"] = False
                item.update(out)
            else:
                item.update(default_upstream_pending(cidr))

    def enrich_items(
        self,
        items: List[Dict[str, Any]],
        *,
        force: bool = False,
        max_workers: int = 4,
    ) -> None:
        if not items:
            return
        futures: Dict[Any, Dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            for item in items:
                cidr = str(item.get("cidr", "")).strip()
                if not cidr:
                    continue
                futures[pool.submit(self.fetch_upstream, cidr, force=force)] = item
            for fut in as_completed(futures):
                item = futures[fut]
                try:
                    upstream = fut.result()
                except Exception as exc:  # noqa: BLE001
                    upstream = build_upstream_payload(str(item.get("cidr", "")), [], error=str(exc))
                item.update(upstream)
