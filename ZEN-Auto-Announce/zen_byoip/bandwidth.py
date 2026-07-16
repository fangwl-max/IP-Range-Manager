from __future__ import annotations

import json
import re
from typing import Any

from zen_byoip.client import traffic_call, unwrap_response

# ZEC regionId -> DescribeBandwidthClusters 的 cityName（与控制台「地区」下展示的带宽组一致时可对上）。
DEFAULT_REGION_CITY_HINTS: dict[str, str] = {
    "europe-central-1": "Frankfurt",
    "na-central-2": "Dallas",
}

BANDWIDTH_CLUSTER_SCAN_MAX_PAGES = 50


def _dedupe_insensitive(order: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in order:
        s = raw.strip()
        if not s:
            continue
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
    return out


def city_name_query_candidates(primary: str, region_id: str) -> list[str]:
    """Subnet 地域文案与 DescribeBandwidthClusters.cityName 不一致时，生成多组查询串。"""
    parts: list[str] = []
    hint = DEFAULT_REGION_CITY_HINTS.get(region_id)
    if hint:
        parts.append(hint)
    p = primary.strip()
    if p:
        parts.append(p)
        parts.append(p.replace(",", ""))
        no_period = p.replace(".", "").strip()
        parts.append(re.sub(r"\s+", " ", no_period.replace(",", " ")).strip())
        if no_period != p:
            parts.append(no_period)
        before_comma = p.split(",")[0].strip()
        if before_comma:
            parts.append(before_comma)
    return _dedupe_insensitive(parts)


def _significant_tokens_from_city_label(label: str) -> list[str]:
    cleaned = re.sub(r"\s+", " ", label.replace(".", "").replace(",", " ")).strip()
    toks: list[str] = []
    for w in cleaned.lower().split():
        a = "".join(c for c in w if c.isalnum())
        if len(a) >= 2:
            toks.append(a)
    return list(dict.fromkeys(toks))


def _bandwidth_row_matches_city_label(row: dict[str, Any], subnet_city_label: str) -> bool:
    tokens = _significant_tokens_from_city_label(subnet_city_label)
    if not tokens:
        return False
    blob = " ".join(
        [
            str(row.get("cityName") or "").lower(),
            str(row.get("location") or "").lower(),
            str(row.get("bandwidthClusterName") or "").lower(),
        ]
    )
    return all(t in blob for t in tokens)


def list_bandwidth_clusters_matching_city_label(
    *,
    subnet_city_label: str,
    ak: str,
    sk: str,
    ver: str,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """不传 cityName 分页拉取，按城市文案宽松匹配（最后手段）。"""
    by_id: dict[str, dict[str, Any]] = {}
    for page in range(1, BANDWIDTH_CLUSTER_SCAN_MAX_PAGES + 1):
        batch, total = fetch_bandwidth_clusters_page(
            page_num=page,
            page_size=page_size,
            city_name=None,
            cluster_name_fuzzy=None,
            ak=ak,
            sk=sk,
            ver=ver,
        )
        if not batch:
            break
        for row in batch:
            if _bandwidth_row_matches_city_label(row, subnet_city_label):
                cid = row.get("bandwidthClusterId")
                if cid:
                    by_id[str(cid)] = row
        if len(batch) < page_size or page * page_size >= total:
            break
    return list(by_id.values())


def list_bandwidth_clusters_by_subnet_city_label(
    *,
    subnet_city_label: str,
    region_id: str,
    cluster_name_fuzzy: str | None,
    ak: str,
    sk: str,
    ver: str,
) -> list[dict[str, Any]]:
    candidates = city_name_query_candidates(subnet_city_label, region_id)
    city_names_to_try: list[str | None] = candidates if candidates else [None]

    for city_name in city_names_to_try:
        rows = list_bandwidth_clusters(
            city_name=city_name,
            cluster_name_fuzzy=cluster_name_fuzzy,
            ak=ak,
            sk=sk,
            ver=ver,
        )
        if cluster_name_fuzzy and str(cluster_name_fuzzy).strip():
            nh = str(cluster_name_fuzzy).strip()
            rows = [r for r in rows if _name_matches(nh, str(r.get("bandwidthClusterName") or ""))]
        if rows:
            return rows

    if not subnet_city_label.strip():
        return []

    loose = list_bandwidth_clusters_matching_city_label(
        subnet_city_label=subnet_city_label, ak=ak, sk=sk, ver=ver
    )
    if cluster_name_fuzzy and str(cluster_name_fuzzy).strip():
        nh = str(cluster_name_fuzzy).strip()
        loose = [r for r in loose if _name_matches(nh, str(r.get("bandwidthClusterName") or ""))]
    return loose


def fetch_bandwidth_clusters_page(
    *,
    page_num: int,
    page_size: int,
    city_name: str | None,
    cluster_name_fuzzy: str | None,
    ak: str,
    sk: str,
    ver: str,
) -> tuple[list[dict[str, Any]], int]:
    req: dict[str, Any] = {"pageNum": page_num, "pageSize": page_size}
    if city_name:
        req["cityName"] = city_name
    if cluster_name_fuzzy:
        req["bandwidthClusterName"] = cluster_name_fuzzy
    data = traffic_call(
        "DescribeBandwidthClusters",
        req,
        access_key_id=ak,
        access_key_password=sk,
        api_version=ver,
        timeout=60,
    )
    inner = unwrap_response(data)
    rows = list(inner.get("dataSet") or [])
    total = int(inner.get("totalCount") or 0)
    return rows, total


def list_bandwidth_clusters(
    *,
    city_name: str | None = None,
    cluster_name_fuzzy: str | None = None,
    ak: str,
    sk: str,
    ver: str,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """分页拉取共享带宽包列表。文档: DescribeBandwidthClusters（仅查询，不创建）。"""
    all_rows: list[dict[str, Any]] = []
    page = 1
    total = None
    while True:
        batch, t = fetch_bandwidth_clusters_page(
            page_num=page,
            page_size=page_size,
            city_name=city_name,
            cluster_name_fuzzy=cluster_name_fuzzy,
            ak=ak,
            sk=sk,
            ver=ver,
        )
        if total is None:
            total = t
        all_rows.extend(batch)
        if not batch or len(all_rows) >= total:
            break
        page += 1
    return all_rows


def _name_matches(hint: str, row_name: str) -> bool:
    a = hint.strip().lower()
    b = (row_name or "").strip().lower()
    if not a:
        return True
    return a == b or a in b or b in a


def resolve_bandwidth_cluster_id(
    job: dict[str, Any],
    region_id: str,
    *,
    env_fallback: str | None,
    region_city_hints: dict[str, str] | None,
    ak: str,
    sk: str,
    ver: str,
) -> str:
    """
    解析**已有**共享带宽包 ID：仅调用 DescribeBandwidthClusters 查询列表，不调用 CreateBandwidthCluster。

    优先级：
    1) job.bandwidthClusterId / job.clusterId
    2) job.cityName（或内置 region映射）+ 可选 job.bandwidthClusterName 查询
    3) 环境变量 ZENLAYER_BANDWIDTH_CLUSTER_ID
    """
    hints = region_city_hints if region_city_hints is not None else DEFAULT_REGION_CITY_HINTS

    direct = job.get("bandwidthClusterId") or job.get("clusterId")
    if direct and str(direct).strip():
        return str(direct).strip()

    city = job.get("cityName") or hints.get(region_id)
    name_hint = job.get("bandwidthClusterName")

    if not city and not name_hint:
        if env_fallback:
            return env_fallback.strip()
        raise RuntimeError(
            "未指定带宽组：请在任务中增加 bandwidthClusterId，"
            "或同时提供 cityName（控制台选区后看到的城市，如 Frankfurt）"
            "与 bandwidthClusterName（如下拉中的 Frankfurt-Cogent），"
            "或在 .env 设置 ZENLAYER_BANDWIDTH_CLUSTER_ID。"
        )

    rows = list_bandwidth_clusters_by_subnet_city_label(
        subnet_city_label=str(city).strip() if city else "",
        region_id=region_id,
        cluster_name_fuzzy=str(name_hint).strip() if name_hint else None,
        ak=ak,
        sk=sk,
        ver=ver,
    )

    if len(rows) == 1:
        cid = rows[0].get("bandwidthClusterId")
        if not cid:
            raise RuntimeError(f"带宽组记录缺少 bandwidthClusterId: {rows[0]}")
        return str(cid)

    if not rows:
        city_q = city or ""
        raise RuntimeError(
            "未匹配到任何共享带宽包。请运行: python -m zen_byoip.cli --list-bandwidth-clusters "
            f'--city-name "{city_q}" 核对 cityName / 名称后，在任务里填写 bandwidthClusterName。'
        )

    preview = [
        {
            "bandwidthClusterId": r.get("bandwidthClusterId"),
            "bandwidthClusterName": r.get("bandwidthClusterName"),
            "location": r.get("location"),
        }
        for r in rows[:20]
    ]
    raise RuntimeError(
        "匹配到多个共享带宽包，请在任务中收紧 bandwidthClusterName（例如控制台完整名称）。"
        f" 候选（最多 20 条）: {json.dumps(preview, ensure_ascii=False)}"
    )
