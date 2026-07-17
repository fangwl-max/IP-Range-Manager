import argparse
import os
import sys
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import requests
from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, session, stream_with_context, url_for

from app_paths import default_config_path, default_web_host, default_web_port, get_config_dir, resolve_config_path
from auth_store import (
    PERM_ANNOUNCE,
    PERM_PURCHASE_SLASH25,
    PERM_WITHDRAW,
    PERMISSION_LABELS,
    ROLE_ADMIN,
    AuthStore,
)
from byoip_service import ByoipService, find_classic_segment_ids_within_byoip
from ip_announce_system import CapitalOnlineClient, Reconciler, load_config, parse_cidr
from ipxo_loa_service import IpxoLoaService
from loa_service import LoaService
from meta_service import MetaService
from announce_service import iter_announce_events
from withdraw_service import iter_withdraw_events, withdraw_one_cidr
from public_ipv4_service import (
    iter_purchase_events,
    purchase_classic_ipv4,
    purchase_dual_slash25_classic_ipv4,
    purchase_ipv4_batch,
)
from rule_builder import build_rule_from_form_row, normalize_cidr_input

SESSION_USER_KEY = "withdraw_username"
SESSION_ROLE_KEY = "withdraw_role"


class CapitalOnlineProvider:
    name = "capitalonline"

    def __init__(self, cfg: Dict[str, Any], dry_run: bool):
        self.client = CapitalOnlineClient(cfg)
        self.reconciler = Reconciler(self.client, dry_run=dry_run)

    def announce(self, rule, *, stop_on_creating: bool = False) -> Optional[Dict[str, Any]]:
        return self.reconciler._announce_flow(rule, stop_on_creating=stop_on_creating)  # noqa: SLF001

    def withdraw(self, rule) -> None:
        self.reconciler._withdraw_flow(rule)  # noqa: SLF001

    @staticmethod
    def _api_ok(resp: Dict[str, Any]) -> bool:
        code = str(resp.get("Code", "")).upper()
        success = resp.get("Success")
        return code in {"SUCCESS", "OK"} and (success is None or success is True)

    def _execute_write(self, title: str, fn, *args):
        if self.reconciler.dry_run:
            return {"Code": "OK", "Success": True, "Message": f"dry-run: {title}"}
        resp = fn(*args)
        if not self._api_ok(resp):
            raise RuntimeError(f"{title} 调用失败: {resp}")
        return resp

    def _find_byoip_by_cidr(self, cidr: str) -> Dict[str, Any]:
        address, mask = parse_cidr(cidr)
        resp = self.client.describe_byoip_list(keyword=address, show_all=True)
        if not self._api_ok(resp):
            raise RuntimeError(f"DescribeBYOIPList 调用失败: {resp}")
        for item in (((resp.get("Data") or {}).get("ByoipList")) or []):
            if str(item.get("Address", "")) == address and str(item.get("Mask", "")) == str(mask):
                return item
        return {}

    def _find_segment_ids_by_cidr(
        self,
        cidr: str,
        *,
        vdc_id: str = "",
        public_id: str = "",
    ) -> List[str]:
        resp = self.client.describe_vdc()
        if not self._api_ok(resp):
            raise RuntimeError(f"DescribeVdc 调用失败: {resp}")
        return find_classic_segment_ids_within_byoip(
            resp,
            cidr,
            vdc_id=vdc_id,
            public_id=public_id,
        )

    def withdraw_by_cidr(
        self,
        cidr: str,
        *,
        config_path: str = "",
        delete_byoip: bool = False,
    ) -> Dict[str, Any]:
        return withdraw_one_cidr(
            self.client,
            cidr=cidr,
            config_path=config_path,
            dry_run=self.reconciler.dry_run,
            delete_byoip=delete_byoip,
        )


def parse_withdraw_cidrs(text: str) -> List[str]:
    items: List[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        for part in line.replace("，", ",").split(","):
            cidr = part.strip()
            if cidr:
                items.append(normalize_cidr_input(cidr))
    deduped: List[str] = []
    seen = set()
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def withdraw_users_store_path(cfg: Dict[str, Any]) -> Path:
    web_cfg = cfg.get("web") or {}
    rel = str(web_cfg.get("withdraw_users_file", "data/withdraw_users.json"))
    config_dir = get_config_dir(cfg)
    p = Path(rel)
    if p.is_absolute():
        return p.resolve()
    return (config_dir / p).resolve()


def default_super_admin_user(cfg: Dict[str, Any]) -> str:
    web_cfg = cfg.get("web") or {}
    return os.environ.get("IP_ANNOUNCE_WITHDRAW_USER", str(web_cfg.get("withdraw_admin_user", ""))).strip()


def bootstrap_withdraw_auth(cfg: Dict[str, Any]) -> AuthStore:
    web_cfg = cfg.get("web") or {}
    store = AuthStore(withdraw_users_store_path(cfg))
    super_user = default_super_admin_user(cfg)
    default_pass = os.environ.get(
        "IP_ANNOUNCE_WITHDRAW_PASSWORD", str(web_cfg.get("withdraw_admin_password", ""))
    )
    store.ensure_bootstrap(super_user, default_pass)
    store.migrate_roles(super_user)
    store.migrate_permissions()
    return store


def get_logged_in_user() -> Optional[str]:
    user = session.get(SESSION_USER_KEY)
    return str(user) if user else None


def get_logged_in_role() -> Optional[str]:
    role = session.get(SESSION_ROLE_KEY)
    return str(role) if role else None


def can_manage_accounts(role: Optional[str] = None) -> bool:
    return (role or get_logged_in_role()) == ROLE_ADMIN


def require_withdraw_login(f: Callable) -> Callable:
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not get_logged_in_user():
            return jsonify({"ok": False, "error": "请先登录撤播管理员账号"}), 401
        return f(*args, **kwargs)

    return wrapper


def require_account_admin(f: Callable) -> Callable:
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not get_logged_in_user():
            return jsonify({"ok": False, "error": "请先登录撤播管理员账号"}), 401
        if not can_manage_accounts():
            return jsonify({"ok": False, "error": "无账号管理权限，请联系超级管理员"}), 403
        return f(*args, **kwargs)

    return wrapper


PUBLIC_ENDPOINTS = frozenset(
    {
        "login_page",
        "api_auth_login",
        "api_auth_me",
        "api_auth_logout",
        "static",
    }
)


def safe_next_url(raw: Optional[str]) -> str:
    """登录后跳转路径（仅允许站内相对路径）。"""
    if not raw:
        return "/"
    path = str(raw).strip()
    if not path.startswith("/") or path.startswith("//"):
        return "/"
    return path


def request_wants_json() -> bool:
    if request.path.startswith("/api/"):
        return True
    accept = request.accept_mimetypes
    return bool(
        accept.best_match(["application/json", "text/html"]) == "application/json"
        and accept["application/json"] > accept["text/html"]
    )


def create_app(config_path: str) -> Flask:
    app = Flask(__name__)
    resolved_config = str(resolve_config_path(config_path))
    cfg = load_config(resolved_config)
    web_cfg = cfg.get("web") or {}
    app.secret_key = os.environ.get(
        "IP_ANNOUNCE_SECRET_KEY",
        str(web_cfg.get("secret_key", "ip-announce-dashboard-change-me")),
    )
    app.config["CONFIG_PATH"] = resolved_config
    app.config["MAX_CONTENT_LENGTH"] = int(web_cfg.get("loa_max_upload_mb", 10)) * 1024 * 1024
    meta_service = MetaService(resolved_config)
    byoip_service = ByoipService(resolved_config)
    loa_service = LoaService(cfg)
    loa_service.cleanup_temp()

    def _load_cfg() -> Dict[str, Any]:
        return load_config(app.config["CONFIG_PATH"])

    def _loa_service() -> LoaService:
        return LoaService(_load_cfg())

    def _invalidate_upstream_cache(cidr: str) -> None:
        try:
            normalized = normalize_cidr_input(str(cidr).strip())
        except ValueError:
            return
        byoip_service.bgp_tools.invalidate_upstream(normalized)

    def _sync_upstream_to_list_cache(svc: Any, cidr: str, upstream: Dict[str, Any]) -> None:
        """将单条上游查询结果写回 byoip_list 内存缓存，避免刷新列表时丢失已查到的数据。"""
        try:
            cached_items = (svc._cache or {}).get("items") or []
            for item in cached_items:
                if item.get("cidr", "").strip() == cidr:
                    for k, v in upstream.items():
                        if k.startswith("upstream_"):
                            item[k] = v
                    break
        except Exception:  # noqa: BLE001
            pass

    def _auth_store() -> AuthStore:
        return bootstrap_withdraw_auth(_load_cfg())

    def _current_permissions() -> List[str]:
        user = get_logged_in_user()
        if not user:
            return []
        return _auth_store().get_permissions(user)

    def _has_permission(perm: str) -> bool:
        user = get_logged_in_user()
        if not user:
            return False
        return _auth_store().has_permission(user, perm)

    def require_permission(perm: str) -> Callable:
        def decorator(f: Callable) -> Callable:
            @wraps(f)
            def wrapper(*args, **kwargs):
                if not get_logged_in_user():
                    return jsonify({"ok": False, "error": "请先登录"}), 401
                if not _has_permission(perm):
                    label = PERMISSION_LABELS.get(perm, perm)
                    return jsonify({"ok": False, "error": f"无「{label}」权限，请联系超级管理员"}), 403
                return f(*args, **kwargs)

            return wrapper

        return decorator

    @app.before_request
    def require_login_for_app():
        endpoint = request.endpoint or ""
        if endpoint in PUBLIC_ENDPOINTS:
            return None
        if get_logged_in_user():
            return None
        if request_wants_json():
            return jsonify({"ok": False, "error": "请先登录", "login_url": url_for("login_page")}), 401
        next_path = request.full_path.rstrip("?") if request.query_string else request.path
        return redirect(url_for("login_page", next=safe_next_url(next_path)))

    @app.context_processor
    def inject_globals():
        role = get_logged_in_role()
        perms = _current_permissions()
        return {
            "current_user": get_logged_in_user(),
            "current_role": role,
            "can_manage_accounts": can_manage_accounts(role),
            "current_permissions": perms,
            "can_announce": PERM_ANNOUNCE in perms,
            "can_withdraw": PERM_WITHDRAW in perms,
            "can_purchase_slash25": PERM_PURCHASE_SLASH25 in perms,
        }

    @app.get("/")
    def index():
        cfg = _load_cfg()
        dry_run = bool(cfg["automation"].get("dry_run", True))
        return render_template("announce.html", dry_run=dry_run, active_page="announce")

    @app.get("/announced")
    def announced_page():
        cfg = _load_cfg()
        dry_run = bool(cfg["automation"].get("dry_run", True))
        default_purchase = int((cfg.get("web") or {}).get("default_purchase_ip_number", 128))
        return render_template(
            "announced.html",
            dry_run=dry_run,
            active_page="announced",
            default_purchase_ip_number=default_purchase,
        )

    @app.get("/withdraw")
    def withdraw_page():
        cfg = _load_cfg()
        dry_run = bool(cfg["automation"].get("dry_run", True))
        return render_template("withdraw.html", dry_run=dry_run, active_page="withdraw")

    @app.get("/login")
    def login_page():
        if get_logged_in_user():
            return redirect(safe_next_url(request.args.get("next")))
        cfg = _load_cfg()
        dry_run = bool(cfg["automation"].get("dry_run", True))
        return render_template("login.html", dry_run=dry_run, active_page="login")

    @app.get("/admin/accounts")
    def accounts_page():
        cfg = _load_cfg()
        dry_run = bool(cfg["automation"].get("dry_run", True))
        return render_template("accounts.html", dry_run=dry_run, active_page="accounts")

    @app.get("/api/auth/me")
    def api_auth_me():
        user = get_logged_in_user()
        role = get_logged_in_role()
        store = _auth_store()
        permissions = store.get_permissions(user) if user else []
        return jsonify(
            {
                "ok": True,
                "logged_in": bool(user),
                "username": user,
                "role": role,
                "role_label": "超级管理员" if role == ROLE_ADMIN else "操作员" if role else "",
                "permissions": permissions,
                "can_manage_accounts": can_manage_accounts(role),
                "can_announce": store.has_permission(user, PERM_ANNOUNCE) if user else False,
                "can_withdraw": store.has_permission(user, PERM_WITHDRAW) if user else False,
                "can_purchase_slash25": store.has_permission(user, PERM_PURCHASE_SLASH25) if user else False,
            }
        )

    @app.post("/api/auth/login")
    def api_auth_login():
        body = request.get_json(silent=True) or {}
        username = str(body.get("username", "")).strip()
        password = str(body.get("password", ""))
        if not username or not password:
            return jsonify({"ok": False, "error": "请输入账号和密码"}), 400
        store = _auth_store()
        if not store.verify(username, password):
            return jsonify({"ok": False, "error": "账号或密码错误"}), 401
        session[SESSION_USER_KEY] = username
        session[SESSION_ROLE_KEY] = store.get_role(username)
        session.permanent = True
        role = session[SESSION_ROLE_KEY]
        permissions = store.get_permissions(username)
        return jsonify(
            {
                "ok": True,
                "username": username,
                "role": role,
                "permissions": permissions,
                "can_manage_accounts": can_manage_accounts(role),
                "can_announce": store.has_permission(username, PERM_ANNOUNCE),
                "can_withdraw": store.has_permission(username, PERM_WITHDRAW),
                "can_purchase_slash25": store.has_permission(username, PERM_PURCHASE_SLASH25),
            }
        )

    @app.post("/api/auth/logout")
    def api_auth_logout():
        session.pop(SESSION_USER_KEY, None)
        session.pop(SESSION_ROLE_KEY, None)
        return jsonify({"ok": True})

    @app.get("/api/admin/users")
    @require_account_admin
    def api_admin_users_list():
        store = _auth_store()
        return jsonify({"ok": True, "users": store.list_users(), "permission_defs": PERMISSION_LABELS})

    @app.post("/api/admin/users")
    @require_withdraw_login
    def api_admin_users_mutate():
        body = request.get_json(silent=True) or {}
        action = str(body.get("action", "")).strip().lower()
        current_user = get_logged_in_user() or ""
        store = _auth_store()
        try:
            if action == "update_password":
                target = str(body.get("username", "")).strip() or current_user
                if target != current_user and not can_manage_accounts():
                    return jsonify({"ok": False, "error": "仅可修改自己的密码"}), 403
                store.update_password(target, str(body.get("password", "")))
                if target == current_user:
                    return jsonify({"ok": True, "message": "密码已更新"})
                return jsonify({"ok": True, "users": store.list_users()})

            if not can_manage_accounts():
                return jsonify({"ok": False, "error": "无账号管理权限，请联系超级管理员"}), 403

            if action == "create":
                store.create_user(
                    str(body.get("username", "")),
                    str(body.get("password", "")),
                    role=str(body.get("role", "operator")),
                    permissions=body.get("permissions"),
                )
            elif action == "update_role":
                store.update_role(str(body.get("username", "")), str(body.get("role", "")))
            elif action == "update_permissions":
                store.update_permissions(
                    str(body.get("username", "")),
                    list(body.get("permissions") or []),
                )
            elif action == "delete":
                if str(body.get("username", "")).strip() == current_user:
                    return jsonify({"ok": False, "error": "不能删除当前登录账号"}), 400
                store.delete_user(str(body.get("username", "")))
            else:
                return jsonify({"ok": False, "error": "未知操作"}), 400
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "users": store.list_users()})

    @app.get("/api/meta/options")
    def api_meta_options():
        try:
            payload = meta_service.load(force=request.args.get("refresh") == "1")
            return jsonify(payload)
        except FileNotFoundError as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": f"配置文件不存在: {exc}",
                    "sites": [],
                    "global_asns": [],
                    "errors": [str(exc)],
                }
            ), 500
        except Exception as exc:  # noqa: BLE001
            return jsonify(
                {
                    "ok": False,
                    "error": f"元数据加载异常: {exc}",
                    "sites": [],
                    "global_asns": [],
                    "errors": [str(exc)],
                }
            ), 500

    @app.get("/api/byoip/list")
    def api_byoip_list():
        try:
            payload = byoip_service.fetch_all(
                force=request.args.get("refresh") == "1",
                keyword=str(request.args.get("keyword", "")),
                status_filter=str(request.args.get("status", "")),
            )
            return jsonify(payload)
        except FileNotFoundError as exc:
            return jsonify(
                {
                    "ok": False,
                    "error": f"配置文件不存在: {exc}",
                    "items": [],
                    "errors": [str(exc)],
                }
            ), 500
        except Exception as exc:  # noqa: BLE001
            return jsonify(
                {
                    "ok": False,
                    "error": f"列表加载异常: {exc}",
                    "items": [],
                    "errors": [str(exc)],
                }
            ), 500

    @app.post("/api/byoip/purchase-ipv4")
    @require_permission(PERM_PURCHASE_SLASH25)
    def api_byoip_purchase_ipv4():
        body = request.get_json(silent=True) or {}
        cidr = str(body.get("cidr", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供 cidr"}), 400
        try:
            cidr = normalize_cidr_input(cidr)
            cfg = _load_cfg()
            public_id = str(body.get("public_id", "")).strip()
            mode = str(body.get("mode", "")).strip().lower()
            existing_slash25 = int(body.get("existing_slash25", 0) or 0)
            address, mask = parse_cidr(cidr)
            if mode == "dual_slash25" or str(mask) == "24":
                result = purchase_dual_slash25_classic_ipv4(
                    app.config["CONFIG_PATH"],
                    cidr=cidr,
                    public_id=public_id,
                    existing_slash25=existing_slash25,
                )
            else:
                default_qty = int((cfg.get("web") or {}).get("default_purchase_ip_number", 128))
                number = body.get("number", default_qty)
                result = purchase_classic_ipv4(
                    app.config["CONFIG_PATH"],
                    cidr=cidr,
                    number=number,
                    public_id=public_id,
                )
            byoip_service.invalidate_cache()
            return jsonify(result)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except RuntimeError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        except requests.RequestException as exc:
            from ip_announce_system import format_requests_error

            return jsonify(
                {"ok": False, "error": format_requests_error(exc, action="新购双 /25")}
            ), 502

    @app.post("/api/byoip/purchase-ipv4/batch")
    @require_permission(PERM_PURCHASE_SLASH25)
    def api_byoip_purchase_ipv4_batch():
        body = request.get_json(silent=True) or {}
        raw_items = body.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            return jsonify({"ok": False, "error": "请提供 items 数组（至少一条网段）"}), 400
        try:
            result = purchase_ipv4_batch(app.config["CONFIG_PATH"], raw_items)
            byoip_service.invalidate_cache()
            return jsonify(result)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except RuntimeError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 502
        except requests.RequestException as exc:
            from ip_announce_system import format_requests_error

            return jsonify(
                {"ok": False, "error": format_requests_error(exc, action="批量新购")}
            ), 502

    @app.post("/api/byoip/purchase-ipv4/stream")
    @require_permission(PERM_PURCHASE_SLASH25)
    def api_byoip_purchase_ipv4_stream():
        """流式新购进度（NDJSON）。任务入队后按顺序串行执行，支持多人并发排队。"""
        body = request.get_json(silent=True) or {}
        raw_items = body.get("items")
        if not isinstance(raw_items, list) or not raw_items:
            cidr = str(body.get("cidr", "")).strip()
            if cidr:
                raw_items = [body]
            else:
                return jsonify({"ok": False, "error": "请提供 items 数组或 cidr"}), 400

        operator = get_logged_in_user() or ""

        def generate():
            try:
                yield from iter_purchase_events(app.config["CONFIG_PATH"], raw_items, operator=operator)
            finally:
                byoip_service.invalidate_cache()

        return Response(
            stream_with_context(generate()),
            mimetype="application/x-ndjson; charset=utf-8",
        )

    @app.get("/api/byoip/purchase-ipv4/task-status")
    def api_byoip_purchase_task_status():
        """返回任务队列完整快照（当前任务 + 排队 + 历史），供所有标签页轮询。"""
        from purchase_task_store import get_purchase_task_manager
        snap = get_purchase_task_manager().snapshot()
        return jsonify({"ok": True, **snap})

    @app.post("/api/byoip/purchase-ipv4/cancel")
    @require_permission(PERM_PURCHASE_SLASH25)
    def api_byoip_purchase_cancel():
        """取消正在执行或排队中的购买任务。"""
        from purchase_task_store import get_purchase_task_manager
        body = request.get_json(silent=True) or {}
        task_id = str(body.get("task_id", "")).strip()
        manager = get_purchase_task_manager()
        if task_id:
            found = manager.cancel(task_id)
        else:
            # 不传 task_id 则取消当前正在运行的任务
            found = manager.cancel_current()
        if found:
            return jsonify({"ok": True, "message": "已发送取消信号，任务将在当前步骤完成后停止"})
        return jsonify({"ok": False, "error": "未找到指定任务"}), 404

    @app.get("/api/bgp-tools/upstream")
    def api_bgp_tools_upstream():
        cidr = str(request.args.get("cidr", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供 cidr 参数"}), 400
        try:
            cidr = normalize_cidr_input(cidr)
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        try:
            payload = byoip_service.bgp_tools.fetch_upstream(
                cidr,
                force=request.args.get("refresh") == "1",
            )
            # 查询完成后将结果同步回 byoip_list 缓存，使下次刷新列表时直接带有最新上游数据
            _sync_upstream_to_list_cache(byoip_service, cidr, payload)
            return jsonify({"ok": True, **payload})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(exc)}), 500

    @app.get("/api/loa/status")
    def api_loa_status():
        cidr = str(request.args.get("cidr", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供 cidr 参数"}), 400
        try:
            status = _loa_service().loa_status(normalize_cidr_input(cidr))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, **status})

    @app.post("/api/loa/upload")
    def api_loa_upload():
        cidr = str(request.form.get("cidr", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供网段 cidr"}), 400
        upload = request.files.get("file")
        permanent = str(request.form.get("permanent", "")).lower() in {"1", "true", "yes"}
        try:
            status = _loa_service().save_upload(
                normalize_cidr_input(cidr),
                upload,
                permanent=permanent,
            )
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, **status})

    @app.post("/api/loa/promote")
    def api_loa_promote():
        body = request.get_json(silent=True) or {}
        cidr = str(body.get("cidr", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供 cidr"}), 400
        try:
            status = _loa_service().promote_to_permanent(normalize_cidr_input(cidr))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, **status})

    @app.post("/api/loa/fetch-ipxo")
    def api_loa_fetch_ipxo():
        body = request.get_json(silent=True) or {}
        cidr = str(body.get("cidr", request.form.get("cidr", ""))).strip()
        asn = str(body.get("asn", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供 cidr"}), 400
        cfg = _load_cfg()
        try:
            status = IpxoLoaService(cfg).fetch_and_save(
                cfg,
                normalize_cidr_input(cidr),
                asn=asn,
                permanent=bool(body.get("permanent", True)),
            )
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except requests.RequestException as exc:
            return jsonify({"ok": False, "error": f"IPXO 请求失败: {exc}"}), 502
        return jsonify({"ok": True, **status})

    @app.get("/api/loa/download")
    def api_loa_download():
        cidr = str(request.args.get("cidr", "")).strip()
        if not cidr:
            return jsonify({"ok": False, "error": "请提供 cidr 参数"}), 400
        try:
            path = _loa_service().resolve_loa_path(normalize_cidr_input(cidr))
        except ValueError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        if not path:
            return jsonify({"ok": False, "error": "本地未找到该网段的 LOA 文件"}), 404
        return send_file(path, as_attachment=True, download_name=Path(path).name)

    @app.post("/api/loa/cleanup-orphaned")
    @require_permission(PERM_ANNOUNCE)
    def api_loa_cleanup_orphaned():
        """删除本地 LOA 目录中首云 BYOIP 列表里不存在的孤儿文件。

        body: { "dry_run": true/false }
        干跑模式只返回待删列表，不实际删除。
        """
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run", False))
        try:
            # 1. 拉取首云当前所有 BYOIP 记录（强制刷新，确保最新）
            payload = byoip_service.fetch_all(force=True)
            active_cidrs = [
                item["cidr"]
                for item in (payload.get("items") or [])
                if item.get("cidr")
            ]
            # 2. 执行孤儿清理
            result = _loa_service().cleanup_orphaned(active_cidrs, dry_run=dry_run)
            result["active_count"] = len(active_cidrs)
            result["ok"] = True
            return jsonify(result)
        except Exception as exc:  # noqa: BLE001
            return jsonify({"ok": False, "error": str(exc)}), 500

    @app.post("/api/announce/stream")
    @require_permission(PERM_ANNOUNCE)
    def api_announce_stream():
        """流式宣告进度（NDJSON，每行一个事件）。"""
        cfg = load_config(app.config["CONFIG_PATH"])
        dry_run = bool(cfg["automation"].get("dry_run", True))
        body = request.get_json(silent=True) or {}
        rows = body.get("rows") or []
        if not isinstance(rows, list) or not rows:
            return jsonify({"ok": False, "error": "请至少添加一条 IP 段"}), 400
        stop_on_creating = bool(body.get("stop_on_creating", True))
        sites, public_networks = meta_service.get_sites_and_public()
        client = CapitalOnlineClient(cfg)

        def generate():
            yield from iter_announce_events(
                client,
                rows,
                config_path=app.config["CONFIG_PATH"],
                sites=sites,
                public_networks=public_networks,
                dry_run=dry_run,
                stop_on_creating=stop_on_creating,
                on_upstream_invalidate=_invalidate_upstream_cache,
            )

        return Response(
            stream_with_context(generate()),
            mimetype="application/x-ndjson; charset=utf-8",
        )

    @app.post("/api/withdraw/stream")
    @require_permission(PERM_WITHDRAW)
    def api_withdraw_stream():
        """流式撤播进度（NDJSON，每行一个事件）。"""
        cfg = load_config(app.config["CONFIG_PATH"])
        dry_run = bool(cfg["automation"].get("dry_run", True))
        body = request.get_json(silent=True) or {}
        cidrs = parse_withdraw_cidrs(str(body.get("withdraw_text", "")))
        if not cidrs:
            return jsonify({"ok": False, "error": "请在文本框输入至少一个 IP 段"}), 400
        web_cfg = cfg.get("web") or {}
        delete_byoip = bool(
            body.get(
                "delete_byoip",
                web_cfg.get("auto_delete_byoip_on_withdraw", False),
            )
        )

        client = CapitalOnlineClient(cfg)

        def generate():
            yield from iter_withdraw_events(
                client,
                cidrs,
                config_path=app.config["CONFIG_PATH"],
                dry_run=dry_run,
                delete_byoip=delete_byoip,
                on_upstream_invalidate=_invalidate_upstream_cache,
            )

        return Response(
            stream_with_context(generate()),
            mimetype="application/x-ndjson; charset=utf-8",
        )

    @app.post("/api/batch")
    def api_batch():
        cfg = load_config(app.config["CONFIG_PATH"])
        dry_run = bool(cfg["automation"].get("dry_run", True))
        body = request.get_json(silent=True) or {}
        action = str(body.get("action", "announce")).strip().lower()

        if action not in {"announce", "withdraw"}:
            return jsonify({"ok": False, "error": "action 仅支持 announce 或 withdraw"}), 400

        if action == "announce":
            if not get_logged_in_user():
                return jsonify({"ok": False, "error": "请先登录后再执行宣告"}), 401
            if not _has_permission(PERM_ANNOUNCE):
                return jsonify({"ok": False, "error": "无「宣告」权限，请联系超级管理员"}), 403
        elif action == "withdraw":
            if not get_logged_in_user():
                return jsonify({"ok": False, "error": "请先登录撤播管理员账号"}), 401
            if not _has_permission(PERM_WITHDRAW):
                return jsonify({"ok": False, "error": "无「撤播」权限，请联系超级管理员"}), 403

        sites, public_networks = meta_service.get_sites_and_public()
        provider = CapitalOnlineProvider(cfg, dry_run=dry_run)
        results: List[Dict[str, Any]] = []

        if action == "announce":
            rows = body.get("rows") or []
            stop_on_creating = bool(body.get("stop_on_creating", True))
            if not rows:
                return jsonify({"ok": False, "error": "请至少添加一条 IP 段"}), 400
            for idx, row in enumerate(rows):
                cidr = str(row.get("cidr", "")).strip()
                site_id = str(row.get("site_id", "")).strip()
                asn = str(row.get("asn", "")).strip()
                try:
                    if not site_id:
                        raise ValueError("请选择区域")
                    if not asn:
                        raise ValueError("请填写源 ASN")
                    rule = build_rule_from_form_row(
                        cfg,
                        cidr=cidr,
                        site_id=site_id,
                        asn=asn,
                        action=action,
                        sites=sites,
                        public_networks=public_networks,
                    )
                    detail = provider.announce(rule, stop_on_creating=stop_on_creating)
                    if detail:
                        action_word = "已提交创建" if detail.get("created") else "已在创建中"
                        msg = f"{action_word}，当前状态：{detail.get('status_zh', '创建中')}"
                    else:
                        msg = f"已提交宣告: {rule.cidr}"
                    results.append(
                        {
                            "index": idx,
                            "cidr": rule.cidr,
                            "ok": True,
                            "message": msg,
                            "pipe_id": rule.pipe_id,
                            "public_id": rule.public_id,
                            **({"byoip_id": detail["byoip_id"]} if detail else {}),
                        }
                    )
                    _invalidate_upstream_cache(rule.cidr)
                except Exception as exc:  # noqa: BLE001
                    results.append(
                        {
                            "index": idx,
                            "cidr": cidr,
                            "ok": False,
                            "error": str(exc),
                        }
                    )
        else:
            withdraw_text = str(body.get("withdraw_text", ""))
            cidrs = parse_withdraw_cidrs(withdraw_text)
            if not cidrs:
                return jsonify({"ok": False, "error": "请在文本框输入至少一个 IP 段"}), 400
            web_cfg = cfg.get("web") or {}
            delete_byoip = bool(
                body.get(
                    "delete_byoip",
                    web_cfg.get("auto_delete_byoip_on_withdraw", False),
                )
            )
            for idx, cidr in enumerate(cidrs):
                try:
                    detail = provider.withdraw_by_cidr(
                        cidr,
                        config_path=app.config["CONFIG_PATH"],
                        delete_byoip=delete_byoip,
                    )
                    results.append(
                        {
                            "index": idx,
                            "cidr": detail["cidr"],
                            "ok": True,
                            "message": (
                                f"已提交撤播: {detail['cidr']} | "
                                f"已删除经典公网段数={detail['detached_segments']} | "
                                f"BYOIP存在={detail['byoip_found']} | "
                                f"已撤播={detail['unbroadcasted']} | "
                                f"BYOIP已删除={detail.get('byoip_deleted', False)}"
                            ),
                        }
                    )
                    _invalidate_upstream_cache(detail["cidr"])
                except Exception as exc:  # noqa: BLE001
                    results.append(
                        {
                            "index": idx,
                            "cidr": cidr,
                            "ok": False,
                            "error": str(exc),
                        }
                    )

        success_count = sum(1 for item in results if item.get("ok"))
        return jsonify(
            {
                "ok": success_count == len(results),
                "action": action,
                "dry_run": dry_run,
                "success_count": success_count,
                "total": len(results),
                "results": results,
            }
        )

    return app


def _env_flag(name: str) -> bool:
    return str(os.environ.get(name, "")).strip().lower() in {"1", "true", "yes", "on"}


def _should_use_dev_reload(host: str, explicit_reload: bool) -> bool:
    if _env_flag("IP_ANNOUNCE_NO_RELOAD"):
        return False
    if explicit_reload or _env_flag("IP_ANNOUNCE_RELOAD"):
        return True
    # 本机开发默认开启：改 .py / 模板后自动重启，无需手动杀旧进程
    if sys.platform == "win32" and str(host).strip() in {"127.0.0.1", "localhost"}:
        return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="IP段宣告/撤播 Web 控制台")
    parser.add_argument("--config", default=default_config_path(), help="配置文件路径")
    parser.add_argument("--host", default=None, help="监听地址")
    parser.add_argument("--port", type=int, default=None, help="监听端口，默认 9010")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="开发模式：代码/模板变更后自动重启（也可用环境变量 IP_ANNOUNCE_RELOAD=1）",
    )
    parser.add_argument(
        "--no-reload",
        action="store_true",
        help="禁用自动重载（等价于 IP_ANNOUNCE_NO_RELOAD=1）",
    )
    args = parser.parse_args()

    if args.no_reload:
        os.environ["IP_ANNOUNCE_NO_RELOAD"] = "1"

    cfg = load_config(args.config)
    web_cfg = cfg.get("web") or {}
    host = args.host or web_cfg.get("host") or default_web_host()
    port = args.port or int(web_cfg.get("port", default_web_port()))
    use_reload = _should_use_dev_reload(host, args.reload)

    app = create_app(args.config)
    if use_reload:
        app.config["TEMPLATES_AUTO_RELOAD"] = True
        print(
            f"[dev] 已启用自动重载 · http://{host}:{port} · 修改 .py/模板后保存即生效",
            flush=True,
        )
    else:
        print(f"服务启动 · http://{host}:{port}（未启用自动重载，改代码需重启进程）", flush=True)

    app.run(host=host, port=port, debug=use_reload, use_reloader=use_reload)


if __name__ == "__main__":
    main()
