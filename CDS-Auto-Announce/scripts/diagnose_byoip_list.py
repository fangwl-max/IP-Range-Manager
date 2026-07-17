#!/usr/bin/env python3
"""
诊断工具（仅供排查使用，非主流程模块）。
在服务器上直接运行，用于排查 /api/byoip/list 接口失败原因。

用法：
  python scripts/diagnose_byoip_list.py --config /path/to/config.yaml
"""
from __future__ import annotations

import json
import os
import sys
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app_paths import default_config_path  # noqa: E402
from byoip_service import ByoipService  # noqa: E402


def main() -> int:
    config_path = os.environ.get("IP_ANNOUNCE_CONFIG", default_config_path())
    print(f"config: {config_path}")
    print(f"exists: {os.path.isfile(config_path)}")
    try:
        svc = ByoipService(config_path)
        payload = svc.fetch_all(force=True)
        print(json.dumps(payload, ensure_ascii=False, indent=2)[:4000])
        if payload.get("errors"):
            print("\n[WARN] errors:", payload["errors"])
        return 0 if payload.get("ok", True) or payload.get("items") is not None else 1
    except Exception:
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
