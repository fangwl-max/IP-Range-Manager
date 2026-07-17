"""跨平台路径与运行环境工具（Windows / Linux Ubuntu）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

PROJECT_ROOT = Path(__file__).resolve().parent


def get_project_root() -> Path:
    return PROJECT_ROOT


def resolve_config_path(path: str) -> Path:
    p = Path(path)
    if p.is_absolute():
        return p.resolve()
    return (Path.cwd() / p).resolve()


def default_config_path() -> str:
    env_path = os.environ.get("IP_ANNOUNCE_CONFIG")
    if env_path:
        return str(resolve_config_path(env_path))
    return str((PROJECT_ROOT / "config.yaml").resolve())


def default_web_host() -> str:
    if os.environ.get("IP_ANNOUNCE_HOST"):
        return os.environ["IP_ANNOUNCE_HOST"]
    # Linux 虚拟机部署默认监听所有网卡，便于内网访问
    if sys.platform == "win32":
        return "127.0.0.1"
    return "0.0.0.0"


def default_web_port() -> int:
    return int(os.environ.get("IP_ANNOUNCE_PORT", "9010"))


def default_bgp_upstream_cache_path() -> Path:
    """bgp.tools 上游查询本地缓存（与 gunicorn WorkingDirectory 无关，固定相对项目根）。"""
    return (PROJECT_ROOT / "data" / "bgp_upstream_cache.json").resolve()


def default_byoip_list_cache_path() -> Path:
    """已宣告 BYOIP 列表磁盘缓存（多 gunicorn worker 共享）。"""
    return (PROJECT_ROOT / "data" / "byoip_list_cache.json").resolve()


def default_meta_options_cache_path() -> Path:
    """批量宣告页区域/ASN 元数据磁盘缓存。"""
    return (PROJECT_ROOT / "data" / "meta_options_cache.json").resolve()


def resolve_relative_path(path_str: str, config_dir: Path, project_root: Optional[Path] = None) -> str:
    """将配置中的相对路径解析为绝对路径（兼容 ./loa/xxx 与 loa/xxx）。"""
    raw = Path(path_str)
    if raw.is_absolute():
        return str(raw.resolve())

    root = project_root or PROJECT_ROOT
    bases = (config_dir, root, Path.cwd())
    for base in bases:
        candidate = (base / path_str).resolve()
        if candidate.exists():
            return str(candidate)
    return str((config_dir / path_str).resolve())


def attach_config_meta(cfg: Dict[str, Any], config_path: Path) -> Dict[str, Any]:
    cfg["_meta"] = {
        "config_path": str(config_path),
        "config_dir": str(config_path.parent),
        "project_root": str(PROJECT_ROOT),
    }
    return cfg


def get_config_dir(cfg: Dict[str, Any]) -> Path:
    meta = cfg.get("_meta") or {}
    return Path(meta.get("config_dir", PROJECT_ROOT))


def normalize_loa_path(loa_file: str, cfg: Dict[str, Any]) -> str:
    config_dir = get_config_dir(cfg)
    return resolve_relative_path(loa_file, config_dir)
