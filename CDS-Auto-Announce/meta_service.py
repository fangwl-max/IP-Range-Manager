"""缓存并加载首云元数据（站点、公网）。"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from app_paths import default_meta_options_cache_path
from ip_announce_system import (
    CapitalOnlineClient,
    build_create_options_payload,
    build_public_network_payload,
    load_config,
)
from site_policy import enrich_sites_metadata

DEFAULT_META_CACHE_SECONDS = 300


class MetaService:
    def __init__(self, config_path: str, cache_seconds: Optional[int] = None):
        self.config_path = config_path
        cfg = load_config(self.config_path)
        web_cfg = cfg.get("web") or {}
        configured = web_cfg.get("meta_options_cache_seconds")
        if cache_seconds is not None:
            self.cache_seconds = int(cache_seconds)
        elif configured is not None:
            self.cache_seconds = int(configured)
        else:
            self.cache_seconds = DEFAULT_META_CACHE_SECONDS
        self.cache_path: Path = default_meta_options_cache_path()
        self._cache: Dict[str, Any] = {}
        self._cached_at = 0.0
        self._load_disk_cache()

    def invalidate_cache(self) -> None:
        self._cache = {}
        self._cached_at = 0.0
        try:
            self.cache_path.unlink(missing_ok=True)
        except OSError:
            pass

    def _is_fresh(self) -> bool:
        if self.cache_seconds <= 0:
            return False
        return bool(self._cache) and (time.time() - self._cached_at) < self.cache_seconds

    def _load_disk_cache(self) -> None:
        if not self.cache_path.is_file():
            return
        try:
            raw = json.loads(self.cache_path.read_text(encoding="utf-8"))
            cached_at = float(raw.get("_cached_at", 0) or 0)
            payload = raw.get("payload")
            if not isinstance(payload, dict):
                return
            if self.cache_seconds > 0 and (time.time() - cached_at) >= self.cache_seconds:
                return
            self._cache = payload
            self._cached_at = cached_at
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            self._cache = {}
            self._cached_at = 0.0

    def _save_disk_cache(self) -> None:
        if self.cache_seconds <= 0 or not self._cache:
            return
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps(
                    {"_cached_at": self._cached_at, "payload": self._cache},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
        except OSError:
            pass

    def _decorate_cache_meta(self, payload: Dict[str, Any], *, cached: bool) -> Dict[str, Any]:
        out = dict(payload)
        out["cached"] = cached
        if cached and self._cached_at:
            out["cache_age_seconds"] = int(max(0, time.time() - self._cached_at))
        else:
            out.pop("cache_age_seconds", None)
        return out

    def _fetch_from_api(self) -> Dict[str, Any]:
        cfg = load_config(self.config_path)
        client = CapitalOnlineClient(cfg)
        sites: List[Dict[str, Any]] = []
        public_networks: List[Dict[str, Any]] = []
        errors: List[str] = []

        try:
            create_resp = client.describe_byoip_site_create_options()
            create_payload = build_create_options_payload(create_resp)
            if create_payload.get("ok"):
                sites = create_payload.get("sites") or []
            else:
                errors.append(create_payload.get("error", "查询站点失败"))
        except (requests.RequestException, RuntimeError) as exc:
            errors.append(f"查询站点失败: {exc}")

        try:
            vdc_resp = client.describe_vdc()
            public_payload = build_public_network_payload(vdc_resp)
            if public_payload.get("ok"):
                public_networks = public_payload.get("public_networks") or []
            else:
                errors.append(public_payload.get("error", "查询公网失败"))
        except (requests.RequestException, RuntimeError) as exc:
            errors.append(f"查询公网失败: {exc}")

        sites, global_asns = enrich_sites_metadata(sites)
        return {
            "ok": not errors or bool(sites),
            "sites": sites,
            "global_asns": global_asns,
            "public_networks": public_networks,
            "errors": errors,
            "refreshed_at": int(time.time()),
            "source": "DescribeBYOIPSiteCreateOptions+DescribeVdc",
        }

    def load(self, force: bool = False) -> Dict[str, Any]:
        if not force and self._is_fresh():
            return self._decorate_cache_meta(self._cache, cached=True)

        if not force and not self._cache:
            self._load_disk_cache()
        if not force and self._is_fresh():
            return self._decorate_cache_meta(self._cache, cached=True)

        payload = self._fetch_from_api()
        self._cache = payload
        self._cached_at = time.time()
        self._save_disk_cache()
        return self._decorate_cache_meta(payload, cached=False)

    def get_sites_and_public(self) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        payload = self.load()
        return payload.get("sites") or [], payload.get("public_networks") or []
