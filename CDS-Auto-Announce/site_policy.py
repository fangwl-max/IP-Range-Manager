"""站点可选策略（区域禁用规则）。"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

# 新加坡 B/C/D/E/F 节点禁止选择
_DISABLED_SG_PATTERN = re.compile(
    r"(?:新加坡|singapore)\s*[BCDEF]\s*$",
    re.IGNORECASE,
)


def is_site_disabled(site_name: str) -> bool:
    name = (site_name or "").strip()
    if not name:
        return False
    if _DISABLED_SG_PATTERN.search(name):
        return True
    # 兼容：新加坡B / 新加坡 B / 名称以 B~F 结尾且包含新加坡关键字
    if re.search(r"[BCDEF]\s*$", name, re.IGNORECASE):
        if "新加坡" in name or "新加" in name or "singapore" in name.lower():
            return True
    upper = name.upper().replace(" ", "")
    for suffix in ("B", "C", "D", "E", "F"):
        if upper.endswith(f"新加坡{suffix}") or upper.endswith(f"SINGAPORE{suffix}"):
            return True
    return False


def enrich_sites_metadata(sites: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    all_asns: set[str] = set()
    enriched: List[Dict[str, Any]] = []

    for site in sites:
        as_set = {str(x) for x in (site.get("as_list") or []) if str(x)}
        for pipe in site.get("pipes") or []:
            asn = str(pipe.get("asn", "")).strip()
            if asn:
                as_set.add(asn)

        as_list = sorted(as_set, key=lambda x: (0, int(x)) if x.isdigit() else (1, x))
        site_name = str(site.get("site_name", ""))
        item = dict(site)
        item["as_list"] = as_list
        item["asn_count"] = len(as_list)
        item["disabled"] = is_site_disabled(site_name)
        enriched.append(item)
        all_asns.update(as_list)

    global_asns = sorted(all_asns, key=lambda x: (0, int(x)) if x.isdigit() else (1, x))
    return enriched, global_asns
