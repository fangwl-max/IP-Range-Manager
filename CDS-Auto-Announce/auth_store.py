"""撤播管理员账号存储（JSON + 密码哈希 + 角色与细粒度权限）。"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from werkzeug.security import check_password_hash, generate_password_hash

ROLE_ADMIN = "admin"
ROLE_OPERATOR = "operator"
VALID_ROLES = {ROLE_ADMIN, ROLE_OPERATOR}

PERM_ANNOUNCE = "announce"
PERM_WITHDRAW = "withdraw"
PERM_PURCHASE_SLASH25 = "purchase_slash25"

ALL_PERMISSIONS = [PERM_ANNOUNCE, PERM_WITHDRAW, PERM_PURCHASE_SLASH25]
PERMISSION_LABELS: Dict[str, str] = {
    PERM_ANNOUNCE: "宣告",
    PERM_WITHDRAW: "撤播",
    PERM_PURCHASE_SLASH25: "/25 IP 购买",
}
DEFAULT_OPERATOR_PERMISSIONS = [PERM_WITHDRAW]


class AuthStore:
    def __init__(self, store_path: Path):
        self.store_path = store_path

    def _load_raw(self) -> Dict[str, Any]:
        if not self.store_path.exists():
            return {"users": {}}
        with self.store_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {"users": {}}
        users = data.get("users")
        if not isinstance(users, dict):
            data["users"] = {}
        return data

    def _save_raw(self, data: Dict[str, Any]) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.store_path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        tmp.replace(self.store_path)

    @staticmethod
    def _normalize_role(role: str, default: str = ROLE_OPERATOR) -> str:
        value = (role or default).strip().lower()
        return value if value in VALID_ROLES else default

    @staticmethod
    def _normalize_permissions(raw: Any) -> List[str]:
        if not isinstance(raw, list):
            return []
        seen: set[str] = set()
        result: List[str] = []
        for item in raw:
            key = str(item or "").strip().lower()
            if key in ALL_PERMISSIONS and key not in seen:
                seen.add(key)
                result.append(key)
        return result

    def migrate_roles(self, super_admin_username: str) -> None:
        data = self._load_raw()
        users = data.get("users") or {}
        super_user = (super_admin_username or "").strip()
        changed = False
        for username, meta in users.items():
            if not isinstance(meta, dict):
                continue
            if meta.get("role") in VALID_ROLES:
                continue
            meta["role"] = ROLE_ADMIN if username == super_user else ROLE_OPERATOR
            changed = True
        if changed:
            self._save_raw(data)

    def migrate_permissions(self) -> None:
        data = self._load_raw()
        users = data.get("users") or {}
        changed = False
        for _username, meta in users.items():
            if not isinstance(meta, dict):
                continue
            if isinstance(meta.get("permissions"), list):
                normalized = self._normalize_permissions(meta.get("permissions"))
                if normalized != meta.get("permissions"):
                    meta["permissions"] = normalized
                    changed = True
                continue
            role = self._normalize_role(str(meta.get("role", ROLE_OPERATOR)))
            meta["permissions"] = (
                list(ALL_PERMISSIONS)
                if role == ROLE_ADMIN
                else list(DEFAULT_OPERATOR_PERMISSIONS)
            )
            changed = True
        if changed:
            self._save_raw(data)

    def ensure_bootstrap(self, default_user: str, default_pass: str) -> None:
        data = self._load_raw()
        if data.get("users"):
            return
        user = (default_user or "").strip()
        pwd = default_pass or ""
        if not user or not pwd:
            return
        data["users"][user] = {
            "password_hash": generate_password_hash(pwd),
            "created_at": int(time.time()),
            "role": ROLE_ADMIN,
            "permissions": list(ALL_PERMISSIONS),
        }
        self._save_raw(data)

    def get_role(self, username: str) -> str:
        user = (username or "").strip()
        meta = (self._load_raw().get("users") or {}).get(user) or {}
        return self._normalize_role(str(meta.get("role", ROLE_OPERATOR)))

    def is_admin(self, username: str) -> bool:
        return self.get_role(username) == ROLE_ADMIN

    def get_permissions(self, username: str) -> List[str]:
        user = (username or "").strip()
        if not user:
            return []
        if self.is_admin(user):
            return list(ALL_PERMISSIONS)
        meta = (self._load_raw().get("users") or {}).get(user) or {}
        perms = self._normalize_permissions(meta.get("permissions"))
        if perms:
            return perms
        return list(DEFAULT_OPERATOR_PERMISSIONS)

    def has_permission(self, username: str, permission: str) -> bool:
        perm = str(permission or "").strip().lower()
        if perm not in ALL_PERMISSIONS:
            return False
        return perm in self.get_permissions(username)

    @staticmethod
    def permission_labels(permissions: List[str]) -> List[str]:
        return [PERMISSION_LABELS.get(p, p) for p in permissions]

    def list_users(self) -> List[Dict[str, Any]]:
        data = self._load_raw()
        items: List[Dict[str, Any]] = []
        for username, meta in sorted((data.get("users") or {}).items()):
            role = self._normalize_role(str((meta or {}).get("role", ROLE_OPERATOR)))
            permissions = self.get_permissions(username)
            items.append(
                {
                    "username": username,
                    "role": role,
                    "role_label": "超级管理员" if role == ROLE_ADMIN else "操作员",
                    "permissions": permissions,
                    "permission_labels": self.permission_labels(permissions),
                    "created_at": int((meta or {}).get("created_at", 0)),
                }
            )
        return items

    def user_exists(self, username: str) -> bool:
        return username in (self._load_raw().get("users") or {})

    def verify(self, username: str, password: str) -> bool:
        user = (username or "").strip()
        if not user or not password:
            return False
        meta = (self._load_raw().get("users") or {}).get(user)
        if not meta:
            return False
        stored = str(meta.get("password_hash", ""))
        return bool(stored) and check_password_hash(stored, password)

    def create_user(
        self,
        username: str,
        password: str,
        role: str = ROLE_OPERATOR,
        permissions: Optional[List[str]] = None,
    ) -> None:
        user = (username or "").strip()
        if not user:
            raise ValueError("用户名不能为空")
        if len(user) < 2:
            raise ValueError("用户名至少 2 个字符")
        if not password:
            raise ValueError("密码不能为空")
        if len(password) < 4:
            raise ValueError("密码至少 4 个字符")
        normalized_role = self._normalize_role(role)
        if normalized_role == ROLE_ADMIN:
            normalized_permissions = list(ALL_PERMISSIONS)
        else:
            normalized_permissions = self._normalize_permissions(
                permissions if permissions is not None else DEFAULT_OPERATOR_PERMISSIONS
            )
            if not normalized_permissions:
                raise ValueError("请至少勾选一项权限")
        data = self._load_raw()
        users = data.setdefault("users", {})
        if user in users:
            raise ValueError(f"用户「{user}」已存在")
        users[user] = {
            "password_hash": generate_password_hash(password),
            "created_at": int(time.time()),
            "role": normalized_role,
            "permissions": normalized_permissions,
        }
        self._save_raw(data)

    def update_password(self, username: str, password: str) -> None:
        user = (username or "").strip()
        if not user:
            raise ValueError("用户名不能为空")
        if not password:
            raise ValueError("密码不能为空")
        if len(password) < 4:
            raise ValueError("密码至少 4 个字符")
        data = self._load_raw()
        users = data.get("users") or {}
        if user not in users:
            raise ValueError(f"用户「{user}」不存在")
        users[user]["password_hash"] = generate_password_hash(password)
        self._save_raw(data)

    def update_role(self, username: str, role: str) -> None:
        user = (username or "").strip()
        normalized_role = self._normalize_role(role)
        data = self._load_raw()
        users = data.get("users") or {}
        if user not in users:
            raise ValueError(f"用户「{user}」不存在")
        if user == self._sole_admin_username(users) and normalized_role != ROLE_ADMIN:
            raise ValueError("至少保留一个超级管理员账号")
        users[user]["role"] = normalized_role
        if normalized_role == ROLE_ADMIN:
            users[user]["permissions"] = list(ALL_PERMISSIONS)
        elif not self._normalize_permissions(users[user].get("permissions")):
            users[user]["permissions"] = list(DEFAULT_OPERATOR_PERMISSIONS)
        self._save_raw(data)

    def update_permissions(self, username: str, permissions: List[str]) -> None:
        user = (username or "").strip()
        normalized = self._normalize_permissions(permissions)
        data = self._load_raw()
        users = data.get("users") or {}
        if user not in users:
            raise ValueError(f"用户「{user}」不存在")
        role = self._normalize_role(str(users[user].get("role", ROLE_OPERATOR)))
        if role == ROLE_ADMIN:
            users[user]["permissions"] = list(ALL_PERMISSIONS)
        else:
            if not normalized:
                raise ValueError("请至少勾选一项权限")
            users[user]["permissions"] = normalized
        self._save_raw(data)

    def _sole_admin_username(self, users: Dict[str, Any]) -> Optional[str]:
        admins = [
            name
            for name, meta in users.items()
            if self._normalize_role(str((meta or {}).get("role", ROLE_OPERATOR))) == ROLE_ADMIN
        ]
        return admins[0] if len(admins) == 1 else None

    def delete_user(self, username: str) -> None:
        user = (username or "").strip()
        data = self._load_raw()
        users = data.get("users") or {}
        if user not in users:
            raise ValueError(f"用户「{user}」不存在")
        if len(users) <= 1:
            raise ValueError("至少保留一个管理员账号")
        if self._normalize_role(str(users[user].get("role", ROLE_OPERATOR))) == ROLE_ADMIN:
            admin_count = sum(
                1
                for meta in users.values()
                if self._normalize_role(str((meta or {}).get("role", ROLE_OPERATOR))) == ROLE_ADMIN
            )
            if admin_count <= 1:
                raise ValueError("至少保留一个超级管理员账号")
        del users[user]
        self._save_raw(data)

