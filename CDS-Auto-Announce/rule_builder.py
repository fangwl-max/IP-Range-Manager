"""根据 Web 表单行构建 PrefixRule。"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app_paths import normalize_loa_path
from ip_announce_system import PrefixRule, parse_cidr
from ipxo_loa_service import ensure_loa_from_ipxo
from loa_service import LoaService
from site_policy import is_site_disabled


def normalize_cidr_input(value: str, default_mask: str = "24") -> str:
    text = value.strip()
    if not text:
        raise ValueError("IP 前缀不能为空")
    if "/" not in text:
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", text):
            return f"{text}/{default_mask}"
        raise ValueError(f"IP 前缀格式错误: {value}")
    address, mask = parse_cidr(text)
    return f"{address}/{mask}"


def normalize_asn_input(value: str) -> str:
    text = value.strip().upper()
    if text.startswith("AS"):
        text = text[2:]
    text = re.sub(r"\s+", "", text)
    if not text.isdigit():
        raise ValueError(f"ASN 格式错误: {value}")
    return text


def loa_path_for_cidr(cfg: Dict[str, Any], cidr: str) -> str:
    web_cfg = cfg.get("web") or {}
    loa_dir = str(web_cfg.get("loa_dir", "./loa"))
    address, mask = parse_cidr(cidr)
    filename = f"{address}_{mask}.pdf"
    rel = f"{loa_dir.rstrip('/')}/{filename}"
    return normalize_loa_path(rel, cfg)


def find_pipe_for_site_asn(sites: List[Dict[str, Any]], site_id: str, asn: str) -> Optional[Dict[str, str]]:
    normalized = normalize_asn_input(asn)
    for site in sites:
        if site.get("site_id") != site_id:
            continue
        for pipe in site.get("pipes") or []:
            if normalize_asn_input(str(pipe.get("asn", ""))) == normalized:
                return pipe
    return None


def find_public_for_vdc(public_networks: List[Dict[str, Any]], vdc_id: str) -> Optional[Dict[str, Any]]:
    for item in public_networks:
        if item.get("vdc_id") == vdc_id:
            return item
    return None


def build_rule_from_form_row(
    cfg: Dict[str, Any],
    *,
    cidr: str,
    site_id: str,
    asn: str,
    action: str,
    sites: List[Dict[str, Any]],
    public_networks: List[Dict[str, Any]],
    provider: str = "capitalonline",
) -> PrefixRule:
    normalized_cidr = normalize_cidr_input(cidr)
    normalized_asn = normalize_asn_input(asn)
    site_item = next((s for s in sites if s.get("site_id") == site_id), None)
    if site_item and site_item.get("disabled"):
        site_name = site_item.get("site_name", site_id)
        raise ValueError(f"区域「{site_name}」禁止选择")
    pipe = find_pipe_for_site_asn(sites, site_id, normalized_asn)
    if not pipe:
        raise ValueError(f"未找到站点 {site_id} 下 ASN={asn} 对应的 Pipe，请检查区域与 ASN")

    vdc_id = str(pipe.get("vdc_id", ""))
    public = find_public_for_vdc(public_networks, vdc_id)
    if not public:
        raise ValueError(f"未找到 VDC {vdc_id} 对应的公网 PublicId")

    web_cfg = cfg.get("web") or {}
    auto_cfg = cfg.get("automation") or {}
    desired = "announced" if action == "announce" else "withdrawn"
    auto_create = bool(web_cfg.get("auto_create_on_announce", True)) if action == "announce" else False

    loa_service = LoaService(cfg)
    if action == "announce" and auto_create:
        try:
            # force=True：始终重新从 IPXO 拉取最新 LOA，覆盖本地旧文件
            # 确保 ASN 变更后不会沿用缓存的旧 LOA
            ensure_loa_from_ipxo(cfg, normalized_cidr, asn=normalized_asn, force=True)
        except ValueError as exc:
            raise ValueError(f"IPXO 自动获取 LOA 失败（{normalized_cidr}）：{exc}") from exc

    loa_path = loa_service.resolve_loa_path(normalized_cidr) or loa_path_for_cidr(cfg, normalized_cidr)
    if action == "announce" and auto_create:
        if not loa_service.resolve_loa_path(normalized_cidr):
            expected = loa_service.permanent_path(normalized_cidr).name
            raise ValueError(
                f"缺少 LOA 文件（{normalized_cidr}），请先上传 PDF、配置 IPXO 自动拉取，"
                f"或放入 loa 目录：{expected}"
            )

    return PrefixRule(
        cidr=normalized_cidr,
        desired_state=desired,
        pipe_id=str(pipe["pipe_id"]),
        public_id=str(public["public_id"]),
        site_id=site_id,
        asn=normalized_asn,
        loa_file=loa_path,
        ip_number=int(web_cfg.get("default_ip_number", auto_cfg.get("default_ip_number", 4))),
        project_id=str(web_cfg.get("project_id", "0-0")),
        subject_id=str(web_cfg.get("subject_id", "")),
        region_id=str(public.get("region_id", "")),
        auto_create=auto_create,
        auto_delete_when_withdrawn=bool(web_cfg.get("auto_delete_when_withdrawn", False)),
    )
