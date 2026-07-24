"""从 IPXO Billing API 拉取 LOA PDF 并写入本地 loa 目录。"""
from __future__ import annotations

import io
import os
import re
import time
import zipfile
from typing import Any, Dict, List, Optional, Tuple

import requests

from ip_announce_system import parse_cidr
from loa_service import LoaService


def _normalize_asn(value: str) -> str:
    text = value.strip().upper()
    if text.startswith("AS"):
        text = text[2:]
    text = re.sub(r"\s+", "", text)
    if not text.isdigit():
        raise ValueError(f"ASN 格式错误: {value}")
    return text

DEFAULT_TOKEN_URL = "https://hydra.ipxo.com/oauth2/token"
DEFAULT_API_BASE = "https://apigw.ipxo.com/billing/v1"
DEFAULT_SCOPE = "billing"
LOA_STATUSES_QUERY = [("statuses[0]", "Active"), ("statuses[1]", "Pending")]
SERVICE_STATUS_PRIORITY = {"active": 0, "pending": 1, "suspended": 2, "terminated": 9}
LOA_STATUS_PRIORITY = {"active": 0, "pending": 1}


class IpxoLoaService:
    def __init__(self, cfg: Dict[str, Any]):
        ipxo = cfg.get("ipxo") or {}
        self.enabled = bool(ipxo.get("enabled", False))
        self.client_id = str(
            os.environ.get("IPXO_CLIENT_ID", ipxo.get("client_id", ""))
        ).strip()
        self.client_secret = str(
            os.environ.get("IPXO_CLIENT_SECRET", ipxo.get("client_secret", ""))
        ).strip()
        self.tenant_uuid = str(
            os.environ.get("IPXO_TENANT_UUID", ipxo.get("tenant_uuid", ""))
        ).strip()
        self.token_url = str(ipxo.get("token_url", DEFAULT_TOKEN_URL)).strip()
        self.api_base = str(ipxo.get("api_base", DEFAULT_API_BASE)).rstrip("/")
        self.scope = str(ipxo.get("scope", DEFAULT_SCOPE)).strip()
        self.timeout = int(ipxo.get("timeout_seconds", 60))
        self.download_timeout = int(ipxo.get("download_timeout_seconds", 120))
        self._token: str = ""
        self._token_expires_at: float = 0.0
        self._services_cache: Optional[List[Dict[str, Any]]] = None
        self._services_cached_at: float = 0.0
        self._services_cache_ttl = int(ipxo.get("services_cache_seconds", 120))

    def is_configured(self) -> bool:
        return bool(
            self.enabled and self.client_id and self.client_secret and self.tenant_uuid
        )

    def _require_configured(self) -> None:
        if not self.is_configured():
            raise ValueError(
                "IPXO 未启用或缺少 client_id / client_secret / tenant_uuid，"
                "请在 config.yaml 的 ipxo 段配置"
            )

    def _access_token(self) -> str:
        self._require_configured()
        now = time.time()
        if self._token and now < self._token_expires_at - 60:
            return self._token
        resp = requests.post(
            self.token_url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "scope": self.scope,
            },
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        self._token = str(data["access_token"])
        expires_in = int(data.get("expires_in", 3600))
        self._token_expires_at = now + expires_in
        return self._token

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self._access_token()}",
            "Accept": "application/pdf, application/json",
        }

    def _tenant_url(self, path: str) -> str:
        suffix = path if path.startswith("/") else f"/{path}"
        return f"{self.api_base}/{self.tenant_uuid}{suffix}"

    def _fetch_services_page(
        self, *, page: int = 1, per_page: int = 100, extra_params: Optional[Dict[str, Any]] = None
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        params: Dict[str, Any] = {"page": page, "per_page": per_page}
        if extra_params:
            params.update(extra_params)
        resp = requests.get(
            self._tenant_url("/market/ipv4/services"),
            headers=self._headers(),
            params=params,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        payload = resp.json()
        return list(payload.get("data") or []), dict(payload.get("meta") or {})

    def _list_services(self, *, force: bool = False) -> List[Dict[str, Any]]:
        now = time.time()
        if (
            not force
            and self._services_cache is not None
            and now - self._services_cached_at < self._services_cache_ttl
        ):
            return self._services_cache

        services: List[Dict[str, Any]] = []
        page = 1
        while page <= 200:
            batch, meta = self._fetch_services_page(page=page, per_page=100)
            if not batch:
                break
            services.extend(batch)
            last_page = int(meta.get("last_page") or page)
            if page >= last_page:
                break
            page += 1

        self._services_cache = services
        self._services_cached_at = now
        return services

    def _find_services_by_address(self, network_address: str) -> List[Dict[str, Any]]:
        """按网络地址查询（IPXO 支持 address 参数，避免全量翻页）。"""
        resp = requests.get(
            self._tenant_url("/market/ipv4/services"),
            headers=self._headers(),
            params={"address": network_address, "per_page": 100},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return list(resp.json().get("data") or [])

    @staticmethod
    def _service_cidr(item: Dict[str, Any]) -> str:
        billing = item.get("billing_service") or {}
        address = str(billing.get("address", "")).strip()
        prefix = billing.get("cidr")
        if not address or prefix is None:
            return ""
        return f"{address}/{prefix}"

    def find_service(self, cidr: str) -> Dict[str, Any]:
        address, mask = parse_cidr(cidr)
        target = f"{address}/{mask}"
        matches: List[Dict[str, Any]] = []
        for item in self._find_services_by_address(address):
            if self._service_cidr(item) == target:
                matches.append(item)
        if not matches:
            for item in self._list_services(force=True):
                if self._service_cidr(item) == target:
                    matches.append(item)
        if not matches:
            raise ValueError(
                f"IPXO 账号下未找到租赁网段 {target}（已按 address 查询并扫描全部订阅）"
            )
        matches.sort(
            key=lambda x: SERVICE_STATUS_PRIORITY.get(
                str((x.get("billing_service") or {}).get("status", "")).lower(),
                5,
            )
        )
        return matches[0]

    def list_loas(self, service_uuid: str) -> List[Dict[str, Any]]:
        params = list(LOA_STATUSES_QUERY)
        resp = requests.get(
            self._tenant_url(f"/market/ipv4/services/{service_uuid}/loa"),
            headers=self._headers(),
            params=params,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return list(resp.json().get("data") or [])

    @staticmethod
    def _pick_loa(loas: List[Dict[str, Any]], asn: str) -> Dict[str, Any]:
        if not loas:
            raise ValueError("该网段在 IPXO 上尚无 Active/Pending 状态的 LOA")
        normalized_asn = _normalize_asn(asn) if asn else ""

        def sort_key(item: Dict[str, Any]) -> Tuple[int, int]:
            status = str(item.get("status", "")).lower()
            status_rank = LOA_STATUS_PRIORITY.get(status, 5)
            asn_rank = 0
            if normalized_asn:
                item_asn = str(item.get("asn", "")).strip()
                asn_rank = 0 if item_asn == normalized_asn else 1
            return (asn_rank, status_rank)

        return sorted(loas, key=sort_key)[0]

    @staticmethod
    def _extract_pdf_from_payload(content: bytes, loa_uuid: str) -> bytes:
        if content.startswith(b"%PDF"):
            return content
        if content.startswith(b"PK"):
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                pdf_names = [n for n in archive.namelist() if n.lower().endswith(".pdf")]
                if not pdf_names:
                    raise ValueError("IPXO 返回的 ZIP 中未包含 PDF 文件")
                preferred = [n for n in pdf_names if loa_uuid and loa_uuid in n]
                chosen = preferred[0] if preferred else pdf_names[0]
                pdf = archive.read(chosen)
                if not pdf.startswith(b"%PDF"):
                    raise ValueError(f"IPXO ZIP 内文件不是有效 PDF: {chosen}")
                return pdf
        raise ValueError("IPXO 返回的内容既不是 PDF 也不是 LOA 文档 ZIP")

    def download_loa_pdf(self, service_uuid: str, loa_uuid: str) -> bytes:
        resp = requests.get(
            self._tenant_url(f"/market/ipv4/services/{service_uuid}/loa/download"),
            headers=self._headers(),
            params={"loa_uuid": loa_uuid},
            timeout=self.download_timeout,
        )
        if resp.status_code == 204 or not resp.content:
            raise ValueError(
                "IPXO 返回空内容（网段或 LOA 可能已终止），请在 IPXO 门户确认 LOA 仍为 Active"
            )
        if resp.status_code >= 400:
            detail = resp.text[:500] if resp.text else ""
            raise ValueError(
                f"IPXO LOA 下载失败 (HTTP {resp.status_code}): {detail}"
            )
        return self._extract_pdf_from_payload(resp.content, loa_uuid)

    def fetch_and_save(
        self,
        cfg: Dict[str, Any],
        cidr: str,
        *,
        asn: str = "",
        permanent: bool = True,
        force: bool = False,
    ) -> Dict[str, Any]:
        """从 IPXO 拉取 LOA 并保存到本地。

        force=True 时始终重新从 IPXO 获取，并覆盖本地已有文件（用于 ASN 变更等场景）。
        force=False 时若本地已有文件则直接返回本地缓存（旧行为，供手动调用场景使用）。
        """
        self._require_configured()
        address, mask = parse_cidr(cidr)
        normalized = f"{address}/{mask}"

        loa_service = LoaService(cfg)

        # 非强制模式：本地有文件直接返回，不调用 IPXO
        if not force:
            existing = loa_service.resolve_loa_path(normalized)
            if existing:
                status = loa_service.loa_status(normalized)
                status["source"] = "local"
                return status

        # 强制模式或本地无文件：始终从 IPXO 拉取最新 LOA
        service = self.find_service(normalized)
        billing = service.get("billing_service") or {}
        service_uuid = str(billing.get("uuid", ""))
        service_status = str(billing.get("status", ""))
        loas = self.list_loas(service_uuid)
        loa = self._pick_loa(loas, asn)
        loa_uuid = str(loa.get("uuid", ""))
        pdf = self.download_loa_pdf(service_uuid, loa_uuid)

        target = (
            loa_service.permanent_path(normalized)
            if permanent
            else loa_service.temp_path(normalized)
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(pdf)

        status = loa_service.loa_status(normalized)
        status["source"] = "ipxo"
        status["ipxo_service_uuid"] = service_uuid
        status["ipxo_service_status"] = service_status
        status["ipxo_loa_uuid"] = loa_uuid
        status["ipxo_loa_status"] = loa.get("status")
        status["ipxo_asn"] = loa.get("asn")
        return status


def ensure_loa_from_ipxo(
    cfg: Dict[str, Any],
    cidr: str,
    *,
    asn: str = "",
    force: bool = True,
) -> Optional[str]:
    """若启用 IPXO，则从 IPXO 拉取 LOA 并返回本地路径。

    force=True（默认）：始终重新从 IPXO 拉取，覆盖本地已有文件，确保 ASN 变更后能获取最新 LOA。
    force=False：本地有文件则直接返回，不请求 IPXO。
    """
    client = IpxoLoaService(cfg)
    if not client.is_configured():
        return None
    ipxo_cfg = cfg.get("ipxo") or {}
    if not bool(ipxo_cfg.get("auto_fetch_on_announce", True)):
        return None
    status = client.fetch_and_save(cfg, cidr, asn=asn, permanent=True, force=force)
    return str(status.get("path", ""))
