"""流式 NDJSON 响应保活（避免 gunicorn/代理因长时间无数据断开连接）。"""
from __future__ import annotations

import json
import queue
from typing import Any, Iterator, Tuple

KEEPALIVE_INTERVAL_SECONDS = 15.0

KEEPALIVE_LINE = json.dumps({"type": "keepalive"}, ensure_ascii=False) + "\n"


def iter_queue_with_keepalive(
    event_q: queue.Queue,
    *,
    keepalive_seconds: float = KEEPALIVE_INTERVAL_SECONDS,
) -> Iterator[Tuple[str, Any]]:
    """从队列读取 (kind, payload)；超时则 yield ('keepalive', None) 供外层发送心跳行。"""
    while True:
        try:
            yield event_q.get(timeout=max(1.0, keepalive_seconds))
        except queue.Empty:
            yield ("keepalive", None)
