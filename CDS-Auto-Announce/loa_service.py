"""LOA 文件上传、临时存放与正式目录解析。"""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from werkzeug.datastructures import FileStorage
from werkzeug.utils import secure_filename

from app_paths import get_config_dir, normalize_loa_path
from ip_announce_system import parse_cidr

ALLOWED_LOA_SUFFIX = {".pdf"}
DEFAULT_TEMP_TTL_HOURS = 72


def _loa_filename(address: str, mask: str) -> str:
    return f"{address}_{mask}.pdf"


class LoaService:
    def __init__(self, cfg: Dict[str, Any]):
        web_cfg = cfg.get("web") or {}
        config_dir = get_config_dir(cfg)
        self.permanent_dir = Path(
            normalize_loa_path(str(web_cfg.get("loa_dir", "./loa")), cfg)
        ).resolve()
        temp_rel = str(web_cfg.get("loa_temp_dir", "./data/loa_temp"))
        temp_path = Path(temp_rel)
        if not temp_path.is_absolute():
            temp_path = (config_dir / temp_rel).resolve()
        self.temp_dir = temp_path
        self.temp_ttl_hours = int(web_cfg.get("loa_temp_ttl_hours", DEFAULT_TEMP_TTL_HOURS))
        self.max_upload_mb = int(web_cfg.get("loa_max_upload_mb", 10))
        self.permanent_dir.mkdir(parents=True, exist_ok=True)
        self.temp_dir.mkdir(parents=True, exist_ok=True)

    def cleanup_temp(self) -> int:
        if self.temp_ttl_hours <= 0:
            return 0
        cutoff = time.time() - self.temp_ttl_hours * 3600
        removed = 0
        for path in self.temp_dir.glob("*.pdf"):
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink(missing_ok=True)
                    removed += 1
            except OSError:
                continue
        return removed

    def permanent_path(self, cidr: str) -> Path:
        address, mask = parse_cidr(cidr)
        return self.permanent_dir / _loa_filename(address, mask)

    def temp_path(self, cidr: str) -> Path:
        address, mask = parse_cidr(cidr)
        return self.temp_dir / _loa_filename(address, mask)

    def resolve_loa_path(self, cidr: str) -> Optional[str]:
        permanent = self.permanent_path(cidr)
        if permanent.is_file():
            return str(permanent)
        temp = self.temp_path(cidr)
        if temp.is_file():
            return str(temp)
        return None

    def loa_status(self, cidr: str) -> Dict[str, Any]:
        address, mask = parse_cidr(cidr)
        permanent = self.permanent_path(cidr)
        temp = self.temp_path(cidr)
        if permanent.is_file():
            return {
                "cidr": f"{address}/{mask}",
                "ready": True,
                "location": "permanent",
                "path": str(permanent),
                "size": permanent.stat().st_size,
                "updated_at": int(permanent.stat().st_mtime),
            }
        if temp.is_file():
            return {
                "cidr": f"{address}/{mask}",
                "ready": True,
                "location": "temp",
                "path": str(temp),
                "size": temp.stat().st_size,
                "updated_at": int(temp.stat().st_mtime),
            }
        return {
            "cidr": f"{address}/{mask}",
            "ready": False,
            "location": "none",
            "path": str(permanent),
            "expected_filename": _loa_filename(address, mask),
        }

    def _validate_upload(self, upload: FileStorage) -> None:
        if not upload or not upload.filename:
            raise ValueError("请选择 LOA 文件")
        name = secure_filename(upload.filename) or ""
        suffix = Path(name).suffix.lower()
        if suffix not in ALLOWED_LOA_SUFFIX:
            raise ValueError("仅支持 PDF 格式的 LOA 文件")
        upload.stream.seek(0, 2)
        size = upload.stream.tell()
        upload.stream.seek(0)
        max_bytes = self.max_upload_mb * 1024 * 1024
        if size > max_bytes:
            raise ValueError(f"文件过大，最大 {self.max_upload_mb} MB")

    def save_upload(self, cidr: str, upload: FileStorage, *, permanent: bool = False) -> Dict[str, Any]:
        self._validate_upload(upload)
        address, mask = parse_cidr(cidr)
        target = self.permanent_path(cidr) if permanent else self.temp_path(cidr)
        upload.save(str(target))
        self.cleanup_temp()
        status = self.loa_status(f"{address}/{mask}")
        status["saved_to"] = "permanent" if permanent else "temp"
        return status

    def promote_to_permanent(self, cidr: str) -> Dict[str, Any]:
        address, mask = parse_cidr(cidr)
        src = self.temp_path(cidr)
        if not src.is_file():
            raise ValueError("临时目录中不存在该网段的 LOA，请先上传")
        dst = self.permanent_path(cidr)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
        return self.loa_status(f"{address}/{mask}")

    def list_local_loa(self) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        seen: set[str] = set()
        for base, location in ((self.permanent_dir, "permanent"), (self.temp_dir, "temp")):
            for path in sorted(base.glob("*.pdf")):
                m = re.match(r"^(\d+\.\d+\.\d+\.\d+)_(\d+)\.pdf$", path.name, re.I)
                if not m:
                    continue
                cidr = f"{m.group(1)}/{m.group(2)}"
                if cidr in seen and location == "temp":
                    continue
                seen.add(cidr)
                items.append(
                    {
                        "cidr": cidr,
                        "location": location,
                        "path": str(path),
                        "size": path.stat().st_size,
                        "updated_at": int(path.stat().st_mtime),
                    }
                )
        return sorted(items, key=lambda x: x["cidr"])

    def cleanup_orphaned(
        self,
        active_cidrs: List[str],
        *,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """删除本地 LOA 目录中首云 BYOIP 列表里不存在的孤儿文件。

        active_cidrs: 从首云 DescribeBYOIPList 拿到的所有 CIDR（normalized 格式，如 1.2.3.0/24）
        dry_run=True 时只返回待删列表，不实际删除。
        """
        # 标准化比较集合
        active_set: set[str] = set()
        for c in active_cidrs:
            try:
                addr, mask = c.strip().split("/", 1)
                active_set.add(f"{addr.strip()}/{mask.strip()}")
            except ValueError:
                pass

        deleted: List[Dict[str, Any]] = []
        skipped: List[Dict[str, Any]] = []

        for base, location in ((self.permanent_dir, "permanent"), (self.temp_dir, "temp")):
            for path in sorted(base.glob("*.pdf")):
                m = re.match(r"^(\d+\.\d+\.\d+\.\d+)_(\d+)\.pdf$", path.name, re.I)
                if not m:
                    continue
                cidr = f"{m.group(1)}/{m.group(2)}"
                if cidr in active_set:
                    skipped.append({"cidr": cidr, "location": location, "path": str(path)})
                    continue
                entry = {
                    "cidr": cidr,
                    "location": location,
                    "path": str(path),
                    "size": path.stat().st_size,
                }
                if not dry_run:
                    path.unlink(missing_ok=True)
                deleted.append(entry)

        return {
            "dry_run": dry_run,
            "deleted_count": len(deleted),
            "skipped_count": len(skipped),
            "deleted": deleted,
            "skipped": skipped,
        }
