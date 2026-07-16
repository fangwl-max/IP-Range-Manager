from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Mapping

from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ZEC_ENDPOINT = "https://console.zenlayer.com/api/v2/zec"
TRAFFIC_ENDPOINT = "https://console.zenlayer.com/api/v2/traffic"
DEFAULT_API_VERSION = "2022-11-20"
HOST = "console.zenlayer.com"
CONTENT_TYPE = "application/json; charset=utf-8"


def _sha256_hex_lower(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().lower()


def _build_authorization(
    access_key_id: str,
    access_key_password: str,
    body: str,
    timestamp: int,
) -> str:
    payload_hash = _sha256_hex_lower(body.encode("utf-8"))
    canonical_headers = f"content-type:{CONTENT_TYPE}\nhost:{HOST}\n"
    signed_headers = "content-type;host"
    canonical_request = "\n".join(
        (
            "POST",
            "/",
            "",
            canonical_headers,
            signed_headers,
            payload_hash,
        )
    )
    hashed_canonical = _sha256_hex_lower(canonical_request.encode("utf-8"))
    string_to_sign = f"ZC2-HMAC-SHA256\n{timestamp}\n{hashed_canonical}"
    signature = hmac.new(
        access_key_password.encode("utf-8"),
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest().lower()
    return (
        f"ZC2-HMAC-SHA256 Credential={access_key_id}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )


def signed_post(
    endpoint_url: str,
    action: str,
    payload: Mapping[str, Any],
    *,
    access_key_id: str,
    access_key_password: str,
    api_version: str = DEFAULT_API_VERSION,
    timeout: int = 120,
) -> dict[str, Any]:
    """
    Zenlayer Open API 2.0：POST JSON + ZC2-HMAC-SHA256。
    文档: https://docs.console.zenlayer.com/api-reference/cn/api-introduction/instruction/authorization/sign.md
    """
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    ts = int(time.time())
    auth = _build_authorization(access_key_id, access_key_password, body, ts)
    req = Request(
        endpoint_url,
        data=body.encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": CONTENT_TYPE,
            "Host": HOST,
            "Authorization": auth,
            "X-ZC-Action": action,
            "X-ZC-Timestamp": str(ts),
            "X-ZC-Version": api_version,
            "X-ZC-Signature-Method": "ZC2-HMAC-SHA256",
        },
    )
    try:
        with urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Zenlayer API HTTP {e.code} for {action}: {err_body or e.reason}"
        ) from e
    except URLError as e:
        raise RuntimeError(f"Zenlayer API 网络错误 ({action}): {e.reason}") from e

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Zenlayer API 返回非 JSON ({action}): {raw[:500]}") from e

    if isinstance(data, dict) and data.get("code"):
        raise RuntimeError(
            f"Zenlayer API 业务错误 ({action}): code={data.get('code')} message={data.get('message', data)}"
        )
    return data


def zec_call(
    action: str,
    payload: Mapping[str, Any],
    *,
    access_key_id: str,
    access_key_password: str,
    api_version: str = DEFAULT_API_VERSION,
    timeout: int = 120,
) -> dict[str, Any]:
    """ZEC：`POST /api/v2/zec`。"""
    return signed_post(
        ZEC_ENDPOINT,
        action,
        payload,
        access_key_id=access_key_id,
        access_key_password=access_key_password,
        api_version=api_version,
        timeout=timeout,
    )


def traffic_call(
    action: str,
    payload: Mapping[str, Any],
    *,
    access_key_id: str,
    access_key_password: str,
    api_version: str = DEFAULT_API_VERSION,
    timeout: int = 120,
) -> dict[str, Any]:
    """Traffic（共享带宽包/带宽组）：`POST /api/v2/traffic`。"""
    return signed_post(
        TRAFFIC_ENDPOINT,
        action,
        payload,
        access_key_id=access_key_id,
        access_key_password=access_key_password,
        api_version=api_version,
        timeout=timeout,
    )


def unwrap_response(data: dict[str, Any]) -> dict[str, Any]:
    """部分接口业务字段在 response 下。"""
    inner = data.get("response")
    if isinstance(inner, dict):
        return inner
    return data
