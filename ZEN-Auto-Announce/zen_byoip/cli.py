from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from zen_byoip.bandwidth import list_bandwidth_clusters, resolve_bandwidth_cluster_id
from zen_byoip.client import unwrap_response, zec_call
from zen_byoip.config import api_version, load_cluster_id_optional, load_credentials
from zen_byoip.eip_admin import (
    eip_delete_concurrency,
    eip_delete_max_rounds,
    eip_delete_retry_delay_sec,
    is_transient_eip_delete_error,
    release_eip_safe,
    search_eip_rows_by_ip_query_paged,
)
from zen_byoip.iputil import eip_sequential_name, iter_eip_host_ips

BATCH_SIZE = 254
POLL_INTERVAL_SEC = 5
POLL_MAX_ATTEMPTS = 360


def _eip_bandwidth_mbps() -> int:
    raw = os.environ.get("ZENLAYER_EIP_BANDWIDTH_MBPS", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return int(raw)
    return 10_000


def _create_eips_max_amount() -> int:
    """单次 CreateEips 的 amount 上限；默认 100。控制台里同批 EIP 名称可能相同；设 1 则逐条唯一名称。"""
    raw = os.environ.get("ZENLAYER_CREATE_EIPS_MAX_AMOUNT", "").strip()
    if raw.isdigit() and int(raw) >= 1:
        return min(500, int(raw))
    return 100


def _eip_cap_by_cidr_quota() -> bool:
    """是否按 DescribeCidrs 的 totalCount-usedCount 截断创建数量（默认开启）。"""
    v = os.environ.get("ZENLAYER_EIP_CAP_BY_CIDR_QUOTA", "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _cidr_available_slots(cidr_row: dict[str, Any]) -> int | None:
    """CIDR 剩余可分配数量；接口未返回或无法解析时为 None。"""
    t, u = cidr_row.get("totalCount"), cidr_row.get("usedCount")
    if t is None or u is None:
        return None
    try:
        ti, ui = int(t), int(u)
    except (TypeError, ValueError):
        return None
    return max(0, ti - ui)


def _format_cidr_insufficient_hint(exc: BaseException) -> str:
    s = str(exc)
    if "OPERATION_DENIED_CIDR_IP_INSUFFICIENT" in s or "CIDR_IP_INSUFFICIENT" in s:
        return (
            f"{s}\n"
            "说明：该 CIDR 剩余可分配的公网 IP 少于本次要创建的数量。"
            "请减少本段要建的数量、释放已占用地址，或把 ZENLAYER_CREATE_EIPS_MAX_AMOUNT 调小后重试。"
        )
    return s


def _chunks(xs: list[str], n: int) -> list[list[str]]:
    return [xs[i : i + n] for i in range(0, len(xs), n)]


def cmd_quote(
    *,
    cidr: str,
    network_type: str,
    region_id: str,
    ak: str,
    sk: str,
    ver: str,
) -> None:
    payload = {
        "byoipList": [
            {
                "cidrBlock": cidr,
                "networkType": network_type,
                "regionId": region_id,
            }
        ]
    }
    data = zec_call(
        "DescribeByoipPrice",
        payload,
        access_key_id=ak,
        access_key_password=sk,
        api_version=ver,
    )
    inner = unwrap_response(data)
    prices = inner.get("byoipPrices") or data.get("byoipPrices")
    print(json.dumps(prices or inner, ensure_ascii=False, indent=2))


def wait_cidr_available(
    *,
    cidr_block: str,
    region_id: str,
    ak: str,
    sk: str,
    ver: str,
) -> dict[str, Any]:
    for attempt in range(1, POLL_MAX_ATTEMPTS + 1):
        data = zec_call(
            "DescribeCidrs",
            {"cidrBlock": cidr_block, "regionId": region_id, "pageSize": 20, "pageNum": 1},
            access_key_id=ak,
            access_key_password=sk,
            api_version=ver,
        )
        inner = unwrap_response(data)
        rows = inner.get("dataSet") or []
        for row in rows:
            if row.get("cidrBlock") == cidr_block and row.get("regionId") == region_id:
                status = row.get("status")
                if status == "AVAILABLE":
                    return row
                if status == "FAILED":
                    raise RuntimeError(f"CIDR 创建失败: {row}")
        print(
            f"[等待 CIDR 就绪] 第 {attempt}/{POLL_MAX_ATTEMPTS} 次轮询（每 {POLL_INTERVAL_SEC}s）…",
            flush=True,
        )
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"CIDR {cidr_block} 在 {POLL_MAX_ATTEMPTS * POLL_INTERVAL_SEC}s 内未变为 AVAILABLE")


def _describe_eips_public_by_ids(
    *,
    region_id: str,
    eip_ids: list[str],
    ak: str,
    sk: str,
    ver: str,
) -> list[str]:
    """CreateEips 不传 publicIp 时，用 DescribeEips 取实际公网地址。"""
    if not eip_ids:
        return []
    data = zec_call(
        "DescribeEips",
        {
            "regionId": region_id,
            "eipIds": eip_ids,
            "pageSize": min(1000, max(20, len(eip_ids))),
            "pageNum": 1,
        },
        access_key_id=ak,
        access_key_password=sk,
        api_version=ver,
    )
    inner = unwrap_response(data)
    rows = inner.get("dataSet") or []
    by_id: dict[str, str] = {}
    for r in rows:
        eid = str(r.get("eipId") or "")
        addrs = r.get("publicIpAddresses") or []
        if eid and isinstance(addrs, list) and addrs:
            by_id[eid] = str(addrs[0])
    return [by_id.get(i, "") for i in eip_ids]


def create_byoip_and_wait(
    *,
    cidr: str,
    network_type: str,
    region_id: str,
    asn: int,
    ak: str,
    sk: str,
    ver: str,
) -> dict[str, Any]:
    payload = {
        "byoipList": [
            {
                "cidrBlock": cidr,
                "networkType": network_type,
                "regionId": region_id,
                "asn": asn,
            }
        ]
    }
    print("[1/2] 提交 CreateByoip …", flush=True)
    try:
        data = zec_call(
            "CreateByoip",
            payload,
            access_key_id=ak,
            access_key_password=sk,
            api_version=ver,
        )
    except RuntimeError as e:
        if "INVALID_BYOIP_IS_ALREADY_EXIST" in str(e):
            print(
                "[1/2] CreateByoip 跳过：该 BYOIP 已在控制台存在，直接进入等待 CIDR AVAILABLE …",
                flush=True,
            )
        else:
            raise
    else:
        inner = unwrap_response(data)
        rpki = inner.get("rpkiFailedList") or []
        irr = inner.get("irrFailedList") or []
        if rpki or irr:
            raise RuntimeError(f"BYOIP 校验失败: RPKI={rpki} IRR={irr}")
        print(f"CreateByoip 已受理: byoipIds={inner.get('byoipIds')}", flush=True)
    print("[1/2] 等待 CIDR 状态 AVAILABLE …", flush=True)
    return wait_cidr_available(
        cidr_block=cidr, region_id=region_id, ak=ak, sk=sk, ver=ver
    )


def create_eips_for_ips(
    *,
    cidr_block: str,
    region_id: str,
    cidr_id: str,
    cluster_id: str,
    public_ips: list[str],
    ak: str,
    sk: str,
    ver: str,
    dry_run: bool,
) -> None:
    batches = _chunks(public_ips, BATCH_SIZE)
    max_amt = _create_eips_max_amount()
    print(
        f"[2/2] 创建弹性 IPv4：共 {len(public_ips)} 个地址，"
        f"每批最多 {BATCH_SIZE} 个，共 {len(batches)} 批；"
        f"计费方式 BandwidthCluster（合并带宽组），clusterId={cluster_id}；"
        f"单次 CreateEips amount 至多 {max_amt}（ZENLAYER_CREATE_EIPS_MAX_AMOUNT；设 1 则逐条且名称唯一）；"
        f"批量时控制台名称可能相同",
        flush=True,
    )
    global_idx = 0
    bw = _eip_bandwidth_mbps()
    total = len(public_ips)
    for bi, batch in enumerate(batches, start=1):
        first_name = eip_sequential_name(cidr_block, global_idx)
        last_name = eip_sequential_name(cidr_block, global_idx + len(batch) - 1)
        print(
            f"  —— 第 {bi}/{len(batches)} 批：名称自 {first_name} 至 {last_name}（本批 {len(batch)} 个）",
            flush=True,
        )
        if dry_run:
            global_idx += len(batch)
            continue
        for sub in _chunks(batch, max_amt):
            amt = len(sub)
            base_idx = global_idx
            seq_name = eip_sequential_name(cidr_block, base_idx)
            print(
                f"  CreateEips [{base_idx + 1}…{base_idx + amt}/{total}] "
                f"name={seq_name} amount={amt} …",
                flush=True,
            )
            try:
                body = {
                    "regionId": region_id,
                    "name": seq_name,
                    "amount": amt,
                    "internetChargeType": "BandwidthCluster",
                    "bandwidth": bw,
                    "cidrId": cidr_id,
                    "clusterId": cluster_id,
                }
                data = zec_call(
                    "CreateEips",
                    body,
                    access_key_id=ak,
                    access_key_password=sk,
                    api_version=ver,
                    timeout=120,
                )
                inner = unwrap_response(data)
                eip_ids = inner.get("eipIds") or []
                if not isinstance(eip_ids, list) or len(eip_ids) != amt:
                    got = len(eip_ids) if isinstance(eip_ids, list) else 0
                    raise RuntimeError(
                        f"CreateEips 期望 eipIds 数量={amt}，实际={got}: "
                        f"{json.dumps(inner, ensure_ascii=False)[:900]}"
                    )
                str_ids = [str(x) for x in eip_ids]
                resolved = _describe_eips_public_by_ids(
                    region_id=region_id,
                    eip_ids=str_ids,
                    ak=ak,
                    sk=sk,
                    ver=ver,
                )
            except Exception as e:
                raise RuntimeError(_format_cidr_insufficient_hint(e)) from e
            for j, planned in enumerate(sub):
                ip = resolved[j] or planned
                print(
                    f"    → [{base_idx + j + 1}/{total}] publicIp={ip} eipId={str_ids[j]}",
                    flush=True,
                )
            global_idx += amt


def run_one_job(
    job: dict[str, Any],
    *,
    ak: str,
    sk: str,
    ver: str,
    env_cluster_fallback: str | None,
    skip_byoip: bool,
    existing_cidr_id: str | None,
    quote_only: bool,
    eip_only: bool,
    min_last_octet: int,
    dry_run: bool,
) -> None:
    cidr = job["cidrBlock"]
    network_type = job["networkType"]
    region_id = job["regionId"]
    asn = int(job["asn"])

    if quote_only:
        cmd_quote(
            cidr=cidr,
            network_type=network_type,
            region_id=region_id,
            ak=ak,
            sk=sk,
            ver=ver,
        )
        return

    cluster_id = resolve_bandwidth_cluster_id(
        job,
        region_id,
        env_fallback=env_cluster_fallback,
        region_city_hints=None,
        ak=ak,
        sk=sk,
        ver=ver,
    )
    print(
        f"[带宽组] 已通过 DescribeBandwidthClusters 匹配已有合并带宽组 clusterId={cluster_id} "
        f"（未调用 CreateBandwidthCluster；CreateEips 为 BandwidthCluster 且传 bandwidth={_eip_bandwidth_mbps()}Mbps）",
        flush=True,
    )

    if eip_only:
        if not existing_cidr_id:
            raise SystemExit("eip-only 模式需要 --cidr-id")
        data = zec_call(
            "DescribeCidrs",
            {
                "cidrIds": [existing_cidr_id],
                "regionId": region_id,
                "pageSize": 10,
                "pageNum": 1,
            },
            access_key_id=ak,
            access_key_password=sk,
            api_version=ver,
        )
        inner = unwrap_response(data)
        rows = inner.get("dataSet") or []
        cidr_row = next((r for r in rows if r.get("cidrId") == existing_cidr_id), None)
        if not cidr_row:
            cidr_row = {
                "cidrId": existing_cidr_id,
                "cidrBlock": cidr,
                "regionId": region_id,
            }
            print(
                "[警告] DescribeCidrs 未返回该 cidrId 详情，将仅按 --cidr 推导 IP 列表。",
                flush=True,
            )
    elif skip_byoip:
        print("[1/2] 跳过 CreateByoip，查询已有 CIDR …", flush=True)
        cidr_row = wait_cidr_available(
            cidr_block=cidr, region_id=region_id, ak=ak, sk=sk, ver=ver
        )
    else:
        cidr_row = create_byoip_and_wait(
            cidr=cidr,
            network_type=network_type,
            region_id=region_id,
            asn=asn,
            ak=ak,
            sk=sk,
            ver=ver,
        )

    cidr_id = cidr_row.get("cidrId")
    if not cidr_id:
        raise RuntimeError(f"无法解析 cidrId: {cidr_row}")

    ips = list(iter_eip_host_ips(cidr, min_last_octet=min_last_octet))
    if not ips:
        raise RuntimeError("没有可创建的 IP（请检查 CIDR 与 --min-last-octet）")

    avail = _cidr_available_slots(cidr_row) if _eip_cap_by_cidr_quota() else None
    if avail is not None:
        print(
            f"CIDR 配额: totalCount={cidr_row.get('totalCount')} usedCount={cidr_row.get('usedCount')} "
            f"剩余可分配约 {avail}；网段推导 {len(ips)} 个（ZENLAYER_EIP_CAP_BY_CIDR_QUOTA）",
            flush=True,
        )
        if avail == 0:
            print("剩余可分配为 0，跳过创建。", flush=True)
            print("全部流程结束。", flush=True)
            return
        if len(ips) > avail:
            print(
                f"按剩余配额将创建数量从 {len(ips)} 截断为 {avail}。",
                flush=True,
            )
            ips = ips[:avail]
    elif _eip_cap_by_cidr_quota():
        print(
            "[提示] DescribeCidrs 未返回 totalCount/usedCount，无法按配额截断，仍按推导列表创建。",
            flush=True,
        )

    create_eips_for_ips(
        cidr_block=cidr,
        region_id=region_id,
        cidr_id=cidr_id,
        cluster_id=cluster_id,
        public_ips=ips,
        ak=ak,
        sk=sk,
        ver=ver,
        dry_run=dry_run,
    )
    print("全部流程结束。", flush=True)


def main_delete_eips(argv: list[str]) -> None:
    p = argparse.ArgumentParser(
        prog="python -m zen_byoip.cli delete-eips",
        description=(
            "按地域 DescribeEips 后，用公网 IP 子串模糊匹配并删除："
            "仅当接口返回无 instanceId/nicId/associatedId 时删除，不解绑；"
            "仍有关联或解绑进行中会报错。"
        ),
    )
    p.add_argument("--region-id", required=True, help="regionId，与控制台一致")
    p.add_argument(
        "--ip-query",
        required=True,
        help="公网 IPv4 模糊匹配子串，至少 2 个字符",
    )
    p.add_argument(
        "-y",
        action="store_true",
        help="跳过交互确认（危险，仅脚本自动化时使用）",
    )
    a = p.parse_args(argv)
    q = a.ip_query.strip()
    if len(q) < 2:
        raise SystemExit("--ip-query 至少 2 个字符")
    ak, sk = load_credentials()
    ver = api_version()
    print(f"[DescribeEips] 分页检索地域 {a.region_id}（边扫边匹配）…", flush=True)
    matched, pages, match_cap, page_cap = search_eip_rows_by_ip_query_paged(
        region_id=a.region_id,
        ip_query=q,
        ak=ak,
        sk=sk,
        ver=ver,
    )
    print(
        f"已扫 {pages} 页，公网 IP 含「{q}」的共 {len(matched)} 条"
        f"{'（已达预览匹配上限，已停止继续查询）' if match_cap else ''}"
        f"{'（未扫完全地域，可设置 ZENLAYER_EIP_LIST_MAX_PAGES）' if page_cap else ''}。",
        flush=True,
    )
    show_n = 80
    for r in matched[:show_n]:
        addrs = r.get("publicIpAddresses") or []
        ip = str(addrs[0]) if isinstance(addrs, list) and addrs else ""
        print(
            f"  eipId={r.get('eipId')} ip={ip} name={r.get('name') or r.get('eipName')}",
            flush=True,
        )
    if len(matched) > show_n:
        print(f"  … 另有 {len(matched) - show_n} 条未显示", flush=True)
    if not matched:
        return
    if not a.y:
        confirm = input('输入「确认删除」后回车以执行删除，其它直接回车取消: ').strip()
        if confirm != "确认删除":
            print("已取消。", flush=True)
            return
    workers = eip_delete_concurrency()
    max_rounds = eip_delete_max_rounds()
    retry_delay = eip_delete_retry_delay_sec()
    print(
        f"[DeleteEip] 并发 {workers}；瞬时失败间隔 {retry_delay}s 最多重试 {max_rounds} 轮"
        f"（ZENLAYER_EIP_DELETE_RETRY_DELAY_MS / ZENLAYER_EIP_DELETE_MAX_ROUNDS）…",
        flush=True,
    )

    all_eids = [str(r.get("eipId") or "") for r in matched]
    all_eids = [e for e in all_eids if e]
    skip_n = sum(1 for r in matched if not str(r.get("eipId") or "").strip())
    pending: set[str] = set(all_eids)
    last_error: dict[str, str] = {}
    ok_n = 0
    round_n = 0

    def _delete_one_eid(eid: str, treat_missing: bool) -> tuple[str, str, Any]:
        try:
            release_eip_safe(
                region_id=a.region_id,
                eip_id=eid,
                ak=ak,
                sk=sk,
                ver=ver,
                treat_missing_describe_as_deleted=treat_missing,
            )
            return eid, "ok", None
        except Exception as ex:
            return eid, "fail", ex

    total = len(all_eids)
    while pending:
        round_n += 1
        if round_n > max_rounds:
            for eid in pending:
                print(
                    f"[fail] {eid}: {last_error.get(eid, '已达最大重试轮数')}",
                    flush=True,
                )
            break
        if round_n > 1:
            print(
                f"[重试] 第 {round_n}/{max_rounds} 轮，待处理 {len(pending)} 条，"
                f"等待 {retry_delay}s …",
                flush=True,
            )
            time.sleep(retry_delay)

        treat_missing = round_n > 1
        batch = list(pending)
        pending.clear()
        with ThreadPoolExecutor(max_workers=workers) as pool:
            future_map = {pool.submit(_delete_one_eid, eid, treat_missing): eid for eid in batch}
            for fut in as_completed(future_map):
                eid, status, ex = fut.result()
                if status == "ok":
                    ok_n += 1
                    tag = f"（第 {round_n} 轮）" if round_n > 1 else ""
                    print(f"[ok] 已删除 {eid}{tag}", flush=True)
                    continue
                msg = str(ex)
                last_error[eid] = msg
                print(f"[fail] {eid}: {ex}（第 {round_n} 轮）", flush=True)
                if round_n < max_rounds and is_transient_eip_delete_error(msg):
                    pending.add(eid)

    fail_n = total - ok_n
    print(
        f"完成：成功 {ok_n}，失败 {fail_n}，跳过 {skip_n}，合计 {len(matched)}（共 {round_n} 轮）。",
        flush=True,
    )


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(
        description="Zenlayer BYOIP 宣告 + 从 CIDR 批量创建弹性 IPv4（合并带宽组计费）"
    )
    p.add_argument("--cidr", help="IPv4 CIDR，如 1.2.3.0/24")
    p.add_argument(
        "--network-type",
        default="PremiumBGP",
        help="BYOIP/EIP 线路类型，如 PremiumBGP、StandardBGP",
    )
    p.add_argument("--region", dest="region_id", help="regionId，如 asia-southeast-1")
    p.add_argument("--asn", type=int, help="源 ASN（整数）")
    p.add_argument(
        "--batch-file",
        type=Path,
        help="JSON 数组；每项含 cidrBlock,networkType,regionId,asn，及 bandwidthClusterId（或依赖 .env 的 ZENLAYER_BANDWIDTH_CLUSTER_ID）",
    )
    p.add_argument(
        "--skip-byoip",
        action="store_true",
        help="不调用 CreateByoip，仅等待已有 CIDR 变为 AVAILABLE 后继续 EIP",
    )
    p.add_argument(
        "--cidr-id",
        dest="cidr_id",
        help="仅创建 EIP：直接使用该 cidrId（需与 --cidr/--region 一致）",
    )
    p.add_argument(
        "--quote-only",
        action="store_true",
        help="仅询价 DescribeByoipPrice后退出",
    )
    p.add_argument(
        "--min-last-octet",
        type=int,
        default=0,
        help="只创建末段≥该值的地址（默认 0：/24 为 .0～.254；要保留网关可设 2）",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="仅打印步骤，不调用 CreateEips",
    )
    p.add_argument(
        "--bandwidth-cluster-id",
        dest="bandwidth_cluster_id",
        help="共享带宽包 ID（与控制台合并带宽组一致，优先级最高）",
    )
    p.add_argument(
        "--bandwidth-cluster-name",
        dest="bandwidth_cluster_name",
        help="共享带宽包名称（模糊匹配，如 Frankfurt-Cogent）；多区建议与 --city-name 同用",
    )
    p.add_argument(
        "--city-name",
        dest="city_name",
        help="DescribeBandwidthClusters 的 cityName（如 Frankfurt），与控制台选区后下拉一致",
    )
    p.add_argument(
        "--list-bandwidth-clusters",
        action="store_true",
        help="仅列出共享带宽包（DescribeBandwidthClusters），可用 --city-name / --bandwidth-cluster-name 过滤",
    )

    args = p.parse_args(argv)
    ak, sk = load_credentials()
    ver = api_version()

    if args.list_bandwidth_clusters:
        rows = list_bandwidth_clusters(
            city_name=args.city_name,
            cluster_name_fuzzy=args.bandwidth_cluster_name,
            ak=ak,
            sk=sk,
            ver=ver,
        )
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return

    env_cluster = None if args.quote_only else load_cluster_id_optional()

    jobs: list[dict[str, Any]] = []
    if args.batch_file:
        raw = args.batch_file.read_text(encoding="utf-8")
        jobs = json.loads(raw)
        if not isinstance(jobs, list):
            raise SystemExit("batch-file 顶层必须是 JSON 数组")
    else:
        if not args.cidr or not args.region_id or args.asn is None:
            raise SystemExit("请提供 --batch-file 或同时提供 --cidr --region --asn")
        one: dict[str, Any] = {
            "cidrBlock": args.cidr,
            "networkType": args.network_type,
            "regionId": args.region_id,
            "asn": args.asn,
        }
        if args.bandwidth_cluster_id:
            one["bandwidthClusterId"] = args.bandwidth_cluster_id
        if args.bandwidth_cluster_name:
            one["bandwidthClusterName"] = args.bandwidth_cluster_name
        if args.city_name:
            one["cityName"] = args.city_name
        jobs = [one]

    eip_only = bool(args.cidr_id)
    for idx, job in enumerate(jobs, start=1):
        if len(jobs) > 1:
            print(f"\n======== 任务 {idx}/{len(jobs)}: {job.get('cidrBlock')} ========\n", flush=True)
        run_one_job(
            job,
            ak=ak,
            sk=sk,
            ver=ver,
            env_cluster_fallback=env_cluster,
            skip_byoip=args.skip_byoip,
            existing_cidr_id=args.cidr_id,
            quote_only=args.quote_only,
            eip_only=eip_only,
            min_last_octet=args.min_last_octet,
            dry_run=args.dry_run,
        )


if __name__ == "__main__":
    try:
        av = sys.argv[1:]
        if av and av[0] == "delete-eips":
            main_delete_eips(av[1:])
        else:
            main(av)
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        sys.exit(130)
