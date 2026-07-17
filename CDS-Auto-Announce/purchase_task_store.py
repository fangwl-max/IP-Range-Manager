"""进程内共享的购买任务状态单例 + 任务队列 + 取消/超时机制。

功能：
- 任务队列：多人下发的任务自动排队，按顺序串行执行
- 取消：任意用户可发起取消，当前任务在下一个"检查点"感知并提前终止
- 超时自动解锁：任务超过 MAX_TASK_SECONDS 未结束，看门狗自动将其标记为 cancelled
  并让队列继续推进，防止卡死
"""
from __future__ import annotations

import queue
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

# 单个任务最长允许运行时间（秒）；超时后看门狗自动取消并解锁队列
MAX_TASK_SECONDS = 900  # 15 分钟，与 gunicorn timeout 一致


# ---------------------------------------------------------------------------
# 单任务数据结构
# ---------------------------------------------------------------------------

class PurchaseTask:
    """一条排队的购买任务。"""

    def __init__(
        self,
        items: List[Dict[str, Any]],
        config_path: str,
        operator: str = "",
    ) -> None:
        self.task_id: str = str(uuid.uuid4())
        self.items = items
        self.config_path = config_path
        self.operator = operator
        self.queued_at: float = time.time()
        # 取消事件：iter_purchase_events 轮询此 event.is_set()
        self.cancel_event: threading.Event = threading.Event()
        # 结果回调 queue（worker 向 stream 推事件）
        self.event_q: queue.Queue = queue.Queue()
        # 任务状态（仅用于 snapshot）
        self.status: str = "queued"   # queued | running | done | cancelled | error
        self.started_at: float = 0.0
        self.finished_at: float = 0.0
        self.total: int = len(items)
        self.success_count: int = 0
        self.dry_run: bool = False
        self.current_hint: str = "排队等待中…"
        self.phases: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self.cidr_order: List[str] = []
        self.cidr_results: Dict[str, Dict[str, Any]] = {}

    def is_cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def cancel(self) -> None:
        self.cancel_event.set()


# ---------------------------------------------------------------------------
# 主管理器
# ---------------------------------------------------------------------------

class PurchaseTaskManager:
    """
    线程安全的购买任务管理器（进程级单例）。

    队列设计：
    - _pending_q：待执行的 PurchaseTask，由 _worker_thread 串行消费
    - _current：当前正在执行的 PurchaseTask（None 表示空闲）
    - _history：最近 10 条已完成/已取消任务，供 snapshot 展示
    """

    HISTORY_SIZE = 10

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending_q: queue.Queue[PurchaseTask] = queue.Queue()
        self._current: Optional[PurchaseTask] = None
        self._history: List[PurchaseTask] = []

        # 看门狗线程（守护）：定期检查当前任务是否超时
        self._watchdog = threading.Thread(target=self._watchdog_loop, daemon=True)
        self._watchdog.start()

        # Worker 线程（守护）：串行消费队列
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker.start()

    # ------------------------------------------------------------------
    # 公开 API
    # ------------------------------------------------------------------

    def enqueue(self, task: PurchaseTask) -> Dict[str, Any]:
        """将任务入队，返回任务 ID 和当前队列位置。"""
        self._pending_q.put(task)
        position = self._pending_q.qsize()
        return {
            "task_id": task.task_id,
            "position": position,
            "queued_at": int(task.queued_at),
        }

    def cancel(self, task_id: str) -> bool:
        """取消指定任务（正在执行或排队中均可）。返回是否找到该任务。"""
        with self._lock:
            cur = self._current
        if cur and cur.task_id == task_id:
            cur.cancel()
            return True
        # 尝试从 pending 队列里找（需要遍历，代价低——队列通常很短）
        pending = list(self._pending_q.queue)  # type: ignore[attr-defined]
        for t in pending:
            if t.task_id == task_id:
                t.cancel()
                t.status = "cancelled"
                t.finished_at = time.time()
                t.current_hint = "已取消（排队中取消）"
                return True
        return False

    def cancel_current(self) -> bool:
        """取消当前正在执行的任务。"""
        with self._lock:
            cur = self._current
        if cur:
            cur.cancel()
            return True
        return False

    def snapshot(self) -> Dict[str, Any]:
        """返回当前任务 + 队列 + 历史的快照。"""
        with self._lock:
            cur = self._current
            pending = list(self._pending_q.queue)  # type: ignore[attr-defined]
            history = list(self._history)

        def _task_dict(t: PurchaseTask, position: int = 0) -> Dict[str, Any]:
            elapsed = 0.0
            if t.started_at:
                end = t.finished_at if t.finished_at else time.time()
                elapsed = round(end - t.started_at, 1)
            return {
                "task_id": t.task_id,
                "status": t.status,
                "operator": t.operator,
                "queued_at": int(t.queued_at),
                "started_at": int(t.started_at) if t.started_at else None,
                "finished_at": int(t.finished_at) if t.finished_at else None,
                "elapsed_seconds": elapsed,
                "total": t.total,
                "success_count": t.success_count,
                "dry_run": t.dry_run,
                "current_hint": t.current_hint,
                "cidr_order": list(t.cidr_order),
                "phases": {c: dict(p) for c, p in t.phases.items()},
                "cidr_results": dict(t.cidr_results),
                "position": position,
            }

        return {
            "current": _task_dict(cur) if cur else None,
            "queue": [_task_dict(t, i + 1) for i, t in enumerate(pending) if not t.is_cancelled()],
            "queue_length": sum(1 for t in pending if not t.is_cancelled()),
            "history": [_task_dict(t) for t in reversed(history)],
        }

    # ------------------------------------------------------------------
    # 内部接收事件（由 iter_purchase_events 写入当前任务）
    # ------------------------------------------------------------------

    def on_event(self, task_id: str, ev: Dict[str, Any]) -> None:
        with self._lock:
            cur = self._current
        if not cur or cur.task_id != task_id:
            return
        t = cur.ev_type = ev.get("type", "")
        _apply_event_to_task(cur, ev)

    # ------------------------------------------------------------------
    # Worker 线程：串行消费队列
    # ------------------------------------------------------------------

    def _worker_loop(self) -> None:
        while True:
            task = self._pending_q.get()
            # 如果任务在排队时已被取消，跳过
            if task.is_cancelled():
                task.status = "cancelled"
                task.finished_at = time.time()
                self._push_history(task)
                self._pending_q.task_done()
                continue

            with self._lock:
                self._current = task

            task.status = "running"
            task.started_at = time.time()

            try:
                self._run_task(task)
            except Exception as exc:  # noqa: BLE001
                task.status = "error"
                task.current_hint = f"任务异常: {exc}"
            finally:
                task.finished_at = time.time()
                if task.status == "running":
                    task.status = "done"
                with self._lock:
                    self._current = None
                self._push_history(task)
                self._pending_q.task_done()

    def _run_task(self, task: PurchaseTask) -> None:
        """在 worker 线程里同步执行任务，产生的事件推入 task.event_q。"""
        from public_ipv4_service import iter_purchase_events_internal

        task.event_q.put(("start", None))
        try:
            for ev in iter_purchase_events_internal(
                task.config_path,
                task.items,
                operator=task.operator,
                cancel_event=task.cancel_event,
                on_event=lambda e: _apply_event_to_task(task, e),
            ):
                if task.is_cancelled():
                    break
                task.event_q.put(("event", ev))
        except Exception as exc:  # noqa: BLE001
            import json as _json
            err_ev = _json.dumps({"type": "task_error", "error": str(exc)}, ensure_ascii=False) + "\n"
            task.event_q.put(("event", err_ev))
        finally:
            if task.is_cancelled():
                task.status = "cancelled"
                task.current_hint = "已取消"
                import json as _json
                cancel_ev = _json.dumps({"type": "task_cancelled"}, ensure_ascii=False) + "\n"
                task.event_q.put(("event", cancel_ev))
            task.event_q.put(("done", None))

    def _push_history(self, task: PurchaseTask) -> None:
        with self._lock:
            self._history.append(task)
            if len(self._history) > self.HISTORY_SIZE:
                self._history.pop(0)

    # ------------------------------------------------------------------
    # 看门狗：超时自动取消当前任务
    # ------------------------------------------------------------------

    def _watchdog_loop(self) -> None:
        while True:
            time.sleep(30)
            with self._lock:
                cur = self._current
            if cur and cur.started_at and cur.status == "running":
                elapsed = time.time() - cur.started_at
                if elapsed > MAX_TASK_SECONDS:
                    cur.cancel()
                    cur.current_hint = f"任务超时（>{MAX_TASK_SECONDS}s），已自动取消"


# ---------------------------------------------------------------------------
# 事件应用到 PurchaseTask
# ---------------------------------------------------------------------------

def _apply_event_to_task(task: PurchaseTask, ev: Dict[str, Any]) -> None:
    """将单条 NDJSON 事件解析并更新 PurchaseTask 状态。"""
    t = ev.get("type", "")

    if t == "batch_start":
        task.dry_run = bool(ev.get("dry_run", False))
        task.total = int(ev.get("total") or task.total)
        task.current_hint = f"共 {task.total} 个网段{'（演练）' if task.dry_run else ''}，准备中…"

    elif t == "cidr_start":
        cidr = str(ev.get("cidr", ""))
        if cidr and cidr not in task.phases:
            task.cidr_order.append(cidr)
            task.phases[cidr] = {}
        task.current_hint = f"[{(ev.get('index') or 0) + 1}/{task.total}] {cidr}：开始…"

    elif t == "phase":
        cidr = str(ev.get("cidr", ""))
        phase = str(ev.get("phase", ""))
        step = int(ev.get("step") or 0)
        key = f"{phase}_{step}" if step else phase
        status = "done" if ev.get("completed") else ev.get("status", "running")
        task.phases.setdefault(cidr, {})[key] = {
            "phase": phase,
            "step": step,
            "status": status,
            "message": str(ev.get("message", "")),
        }
        task.current_hint = f"[{cidr}] {phase}：{ev.get('message', '')}"

    elif t == "cidr_result":
        cidr = str(ev.get("cidr", ""))
        task.cidr_results[cidr] = {
            "ok": bool(ev.get("ok")),
            "message": str(ev.get("message", "")),
            "error": str(ev.get("error", "")),
        }
        if ev.get("ok"):
            task.success_count += 1

    elif t == "batch_done":
        task.success_count = int(ev.get("success_count") or task.success_count)
        task.current_hint = f"全部完成：成功 {task.success_count} / {task.total}"
        task.status = "done"


# ---------------------------------------------------------------------------
# 进程级单例
# ---------------------------------------------------------------------------

_manager = PurchaseTaskManager()


def get_purchase_task_manager() -> PurchaseTaskManager:
    return _manager
