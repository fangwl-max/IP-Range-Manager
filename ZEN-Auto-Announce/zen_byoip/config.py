from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# 默认从项目根目录加载 .env（当前工作目录向上查找可选，这里简化为 CWD）
load_dotenv(Path.cwd() / ".env", override=False)


def _first_nonempty(*keys: str) -> str:
    for k in keys:
        v = os.environ.get(k)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    raise KeyError(",".join(keys))


def load_credentials() -> tuple[str, str]:
    """AccessKeyId + AccessKeyPassword。"""
    ak = _first_nonempty(
        "ZENLAYER_ACCESS_KEY_ID",
        "访问密钥ID",
        "ZENLAYER_AK",
        "ACCESS_KEY_ID",
    )
    sk = _first_nonempty(
        "ZENLAYER_ACCESS_KEY_PASSWORD",
        "访问密钥密码",
        "ZENLAYER_SK",
        "SECRET_ACCESS_KEY",
        "ACCESS_KEY_PASSWORD",
    )
    return ak, sk


def load_cluster_id() -> str:
    return _first_nonempty(
        "ZENLAYER_BANDWIDTH_CLUSTER_ID",
        "ZENLAYER_CLUSTER_ID",
    )


def load_cluster_id_optional() -> str | None:
    """全局默认带宽组 ID；多地域时建议在任务里写 cityName / bandwidthClusterName。"""
    for k in ("ZENLAYER_BANDWIDTH_CLUSTER_ID", "ZENLAYER_CLUSTER_ID"):
        v = os.environ.get(k)
        if v is not None and str(v).strip() != "":
            return str(v).strip()
    return None


def api_version() -> str:
    return os.environ.get("ZENLAYER_API_VERSION", "2022-11-20").strip()
