import argparse
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urlencode

import requests
import yaml

from app_paths import attach_config_meta, normalize_loa_path, resolve_config_path


def percent_encode(value: Any) -> str:
    text = str(value)
    return quote(text, safe="~")


def resolve_api_timeout(api_cfg: Dict[str, Any]) -> Tuple[float, float]:
    """(connect_timeout, read_timeout) 秒。"""
    single = float(api_cfg.get("timeout_seconds", 20))
    connect = float(api_cfg.get("connect_timeout_seconds", single))
    read = float(api_cfg.get("read_timeout_seconds", max(single, 60.0)))
    return connect, read


def format_requests_error(exc: requests.RequestException, *, action: str = "") -> str:
    """将 requests 异常转为可读中文说明。"""
    raw = str(exc)
    prefix = f"{action}：" if action else ""
    lowered = raw.lower()
    if isinstance(exc, requests.ConnectTimeout) or "connecttimeout" in lowered.replace(" ", ""):
        return (
            prefix
            + "连接首云 OpenAPI（cdsapi.capitalonline.net:443）超时，尚未建立 HTTPS 连接。"
            "请检查本机出口网络、代理/防火墙，或在可直连首云的机房服务器上重试；"
            "也可在 config.yaml 的 api 段增大 connect_timeout_seconds。"
        )
    if isinstance(exc, requests.ReadTimeout) or "read timed out" in lowered:
        return prefix + "首云 API 响应超时，请稍后重试或增大 read_timeout_seconds。"
    if isinstance(exc, requests.ConnectionError):
        if "timed out" in lowered:
            return format_requests_error(
                requests.ConnectTimeout(raw), action=action.rstrip("：")
            )
        return (
            prefix
            + "无法连接首云 API，请检查 DNS、代理与防火墙是否放行 cdsapi.capitalonline.net:443。"
        )
    if len(raw) > 320:
        raw = raw[:320] + "…"
    return prefix + ("请求首云 API 失败：" + raw if raw else "请求首云 API 失败")


def parse_cidr(cidr: str) -> Tuple[str, str]:
    if "/" not in cidr:
        raise ValueError(f"CIDR格式错误: {cidr}")
    address, mask = cidr.split("/", 1)
    return address.strip(), mask.strip()


@dataclass
class PrefixRule:
    cidr: str
    desired_state: str
    pipe_id: str
    public_id: str
    site_id: str
    asn: str
    loa_file: str
    ip_number: int
    project_id: str
    subject_id: str
    region_id: str
    auto_create: bool
    auto_delete_when_withdrawn: bool

    @property
    def address(self) -> str:
        return parse_cidr(self.cidr)[0]

    @property
    def mask(self) -> str:
        return parse_cidr(self.cidr)[1]


class CapitalOnlineClient:
    def __init__(self, config: Dict[str, Any]):
        api_cfg = config["api"]
        self.ak = api_cfg["access_key_id"]
        self.sk = api_cfg["access_key_secret"]
        self.version = api_cfg.get("version", "2019-08-08")
        self.network_base_url = api_cfg["network_base_url"].rstrip("/")
        self.wan_service_base_url = api_cfg["wan_service_base_url"].rstrip("/")
        self.ccs_base_url = str(
            api_cfg.get("ccs_base_url", "https://cdsapi.capitalonline.net/ccs")
        ).rstrip("/")
        self.timeout = resolve_api_timeout(api_cfg)
        self.max_retries = max(0, int(api_cfg.get("max_retries", 2)))

    def _signed_url(
        self,
        action: str,
        method: str,
        base_url: str,
        query_params: Optional[Dict[str, Any]] = None,
    ) -> str:
        params: Dict[str, Any] = {
            "Action": action,
            "AccessKeyId": self.ak,
            "SignatureMethod": "HMAC-SHA1",
            "SignatureNonce": str(uuid.uuid1()),
            "SignatureVersion": "1.0",
            "Timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "Version": self.version,
        }
        if query_params:
            params.update(query_params)

        sorted_items = sorted(params.items(), key=lambda x: x[0])
        canonical = ""
        for key, value in sorted_items:
            canonical += f"&{percent_encode(key)}={percent_encode(value)}"
        string_to_sign = f"{method.upper()}&%2F&{percent_encode(canonical[1:])}"
        signature = base64.encodebytes(
            hmac.new(self.sk.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha1).digest()
        ).strip().decode("utf-8")
        params["Signature"] = signature
        return f"{base_url}/?{urlencode(params)}"

    @staticmethod
    def _http_error(action: str, resp: requests.Response) -> RuntimeError:
        detail = ""
        try:
            body = resp.json()
            if isinstance(body, dict):
                detail = str(
                    body.get("Message")
                    or body.get("message")
                    or body.get("Error")
                    or body.get("Code")
                    or body
                )
            else:
                detail = str(body)
        except ValueError:
            text = (resp.text or "").strip()
            detail = text[:800] if text else (resp.reason or "未知错误")
        return RuntimeError(f"{action} 失败 (HTTP {resp.status_code}): {detail}")

    def _http_request(self, action: str, method: str, url: str, **kwargs: Any) -> requests.Response:
        kwargs.setdefault("timeout", self.timeout)
        last_exc: Optional[requests.RequestException] = None
        for attempt in range(self.max_retries + 1):
            try:
                if method.upper() == "GET":
                    return requests.get(url, **kwargs)
                if method.upper() == "POST":
                    return requests.post(url, **kwargs)
                raise ValueError(f"不支持的 HTTP 方法: {method}")
            except (requests.Timeout, requests.ConnectionError) as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    time.sleep(min(2**attempt, 8))
                    continue
                raise RuntimeError(format_requests_error(exc, action=action)) from exc
        if last_exc:
            raise RuntimeError(format_requests_error(last_exc, action=action)) from last_exc
        raise RuntimeError(f"{action} 请求失败")

    def _get(self, action: str, query_params: Dict[str, Any], base_url: str) -> Dict[str, Any]:
        url = self._signed_url(action, "GET", base_url, query_params)
        resp = self._http_request(action, "GET", url)
        if not resp.ok:
            raise self._http_error(action, resp)
        return resp.json()

    def _post_json(
        self,
        action: str,
        body: Dict[str, Any],
        base_url: str,
        query_params: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = self._signed_url(action, "POST", base_url, query_params)
        resp = self._http_request(action, "POST", url, json=body)
        if not resp.ok:
            raise self._http_error(action, resp)
        return resp.json()

    def _post_form_with_file(
        self,
        action: str,
        form: Dict[str, Any],
        file_field_name: str,
        file_path: str,
        base_url: str,
    ) -> Dict[str, Any]:
        url = self._signed_url(action, "POST", base_url)
        with open(file_path, "rb") as f:
            files = {file_field_name: (os.path.basename(file_path), f, "application/pdf")}
            resp = self._http_request(action, "POST", url, data=form, files=files)
        if not resp.ok:
            raise self._http_error(action, resp)
        return resp.json()

    # 7.AddPublicIp
    def add_public_ip(self, public_id: str, byoip_id: str, number: int) -> Dict[str, Any]:
        return self._get(
            action="AddPublicIp",
            query_params={"PublicId": public_id, "ByoipId": byoip_id, "Number": str(number)},
            base_url=self.network_base_url,
        )

    # 11.RenewPublicNetwork — 已永久移除，严禁任何情况下操作自动续约

    # 8.DeletePublicIp
    def delete_public_ip(
        self,
        segment_id: str,
        *,
        public_id: str = "",
        byoip_id: str = "",
        number: int = 0,
        extra_query: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        query_params: Dict[str, Any] = {"SegmentId": segment_id}
        if public_id:
            query_params["PublicId"] = public_id
        if byoip_id:
            query_params["ByoipId"] = byoip_id
        if number > 0:
            query_params["Number"] = str(int(number))
        if extra_query:
            query_params.update(extra_query)
        return self._get(
            action="DeletePublicIp",
            query_params=query_params,
            base_url=self.network_base_url,
        )

    # BatchDeletePublicIp（支持删除包月资源的网段，POST 方式）
    def batch_delete_public_ip(
        self,
        public_id: str,
        segment_ids: List[str],
    ) -> Dict[str, Any]:
        """批量删除 VDC 公网下的公网 IP 网段（支持包月资源）。

        请求地址: api.capitalonline.net/network
        请求方法: POST
        """
        return self._post_json(
            action="BatchDeletePublicIp",
            body={"PublicId": public_id, "SegmentIds": list(segment_ids)},
            base_url=self.network_base_url,
        )

    def describe_task(self, task_id: str) -> Dict[str, Any]:
        return self._get(
            action="DescribeTask",
            query_params={"TaskId": str(task_id)},
            base_url=self.ccs_base_url,
        )

    # 23.DescribeBYOIPSiteCreateOptions
    def describe_byoip_site_create_options(self) -> Dict[str, Any]:
        return self._post_json(
            action="DescribeBYOIPSiteCreateOptions",
            body={},
            base_url=self.wan_service_base_url,
        )

    # 24.CreateBYOIPOneStep
    def create_byoip_one_step(
        self,
        pipe_id: str,
        site_id: str,
        asn: str,
        address: str,
        mask: str,
        loa_file: str,
        project_id: str = "",
        subject_id: str = "",
    ) -> Dict[str, Any]:
        form = {
            "PipeId": pipe_id,
            "SiteId": site_id,
            "As": asn,
            "Address": address,
            "Mask": mask,
        }
        if subject_id:
            form["SubjectId"] = subject_id
        if project_id:
            form["ProjectId"] = project_id

        return self._post_form_with_file(
            action="CreateBYOIPOneStep",
            form=form,
            file_field_name="file",
            file_path=loa_file,
            base_url=self.wan_service_base_url,
        )

    # 25.DeleteBYOIP
    def delete_byoip(self, byoip_id: str) -> Dict[str, Any]:
        return self._post_json(
            action="DeleteBYOIP",
            body={"ByoipId": byoip_id},
            base_url=self.wan_service_base_url,
        )

    # 26.BroadcastBYOIP
    def broadcast_byoip(self, byoip_id: str) -> Dict[str, Any]:
        return self._post_json(
            action="BroadcastBYOIP",
            body={"ByoipId": byoip_id},
            base_url=self.wan_service_base_url,
        )

    # 27.UndoBroadcastBYOIP
    def undo_broadcast_byoip(self, byoip_id: str) -> Dict[str, Any]:
        return self._post_json(
            action="UndoBroadcastBYOIP",
            body={"ByoipId": byoip_id},
            base_url=self.wan_service_base_url,
        )

    # 28.DescribeBYOIPList
    def describe_byoip_list(
        self,
        pipe_id: str = "",
        keyword: str = "",
        create_segment: Optional[bool] = None,
        show_all: bool = True,
        page: int = 1,
        page_size: int = 100,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {"ShowAll": show_all, "Page": page, "PageSize": page_size}
        if pipe_id:
            body["PipeId"] = pipe_id
        if keyword:
            body["Keyword"] = keyword
        if create_segment is not None:
            body["CreateSegment"] = create_segment
        return self._post_json(
            action="DescribeBYOIPList",
            body=body,
            base_url=self.wan_service_base_url,
        )

    # 用于匹配 DeletePublicIp 所需 segment_id
    def describe_vdc(self, region_id: str = "") -> Dict[str, Any]:
        query_params = {}
        if region_id:
            query_params["RegionId"] = region_id
        return self._get("DescribeVdc", query_params, self.network_base_url)


class Reconciler:
    def __init__(self, client: CapitalOnlineClient, dry_run: bool):
        self.client = client
        self.dry_run = dry_run

    @staticmethod
    def _is_ok(resp: Dict[str, Any]) -> bool:
        code = str(resp.get("Code", "")).upper()
        success = resp.get("Success")
        return code in {"SUCCESS", "OK"} and (success is None or success is True)

    def _call(self, title: str, fn, *args, **kwargs) -> Dict[str, Any]:
        if self.dry_run:
            print(f"[DRY-RUN] {title} args={args} kwargs={kwargs}")
            return {"Code": "OK", "Success": True, "Message": "dry-run"}
        print(f"[CALL] {title}")
        resp = fn(*args, **kwargs)
        print(f"[RESP] {title}: {resp}")
        return resp

    def _find_byoip(self, rule: PrefixRule) -> Optional[Dict[str, Any]]:
        resp = self._call(
            "DescribeBYOIPList",
            self.client.describe_byoip_list,
            pipe_id=rule.pipe_id,
            keyword=rule.address,
            show_all=True,
        )
        if not self._is_ok(resp):
            raise RuntimeError(f"DescribeBYOIPList失败: {resp}")

        items = (((resp.get("Data") or {}).get("ByoipList")) or [])
        for item in items:
            same_addr = str(item.get("Address", "")) == rule.address
            same_mask = str(item.get("Mask", "")) == str(rule.mask)
            same_pipe = str(item.get("PipeId", "")) == rule.pipe_id
            if same_addr and same_mask and same_pipe:
                return item
        return None

    def _find_segment_id_in_vdc(self, rule: PrefixRule) -> Optional[str]:
        ids = self._find_segment_ids_in_vdc(rule)
        return ids[0] if ids else None

    def _find_segment_ids_in_vdc(self, rule: PrefixRule) -> List[str]:
        from byoip_service import find_classic_segment_ids_within_byoip

        resp = self._call("DescribeVdc", self.client.describe_vdc, region_id=rule.region_id)
        if not self._is_ok(resp):
            raise RuntimeError(f"DescribeVdc失败: {resp}")
        byoip_item = self._find_byoip(rule)
        vdc_id = str(byoip_item.get("VdcId", "")) if byoip_item else ""
        return find_classic_segment_ids_within_byoip(
            resp,
            rule.cidr,
            vdc_id=vdc_id,
            public_id=rule.public_id,
        )

    def _ensure_created(self, rule: PrefixRule) -> str:
        exists = self._find_byoip(rule)
        if exists:
            return str(exists["Id"])
        if not rule.auto_create:
            raise RuntimeError(f"BYOIP不存在，且未启用auto_create: {rule.cidr}")
        if not os.path.exists(rule.loa_file):
            raise RuntimeError(f"LOA文件不存在: {rule.loa_file}")
        resp = self._call(
            "CreateBYOIPOneStep",
            self.client.create_byoip_one_step,
            pipe_id=rule.pipe_id,
            site_id=rule.site_id,
            asn=rule.asn,
            address=rule.address,
            mask=rule.mask,
            loa_file=rule.loa_file,
            project_id=rule.project_id,
            subject_id=rule.subject_id,
        )
        if not self._is_ok(resp):
            raise RuntimeError(f"CreateBYOIPOneStep失败: {resp}")
        data = resp.get("Data") or {}
        byoip_id = str(data.get("ByoipId", ""))
        if byoip_id:
            return byoip_id
        # 某些场景创建后接口仅返回任务，不返回ID，回查一次
        time.sleep(2)
        exists = self._find_byoip(rule)
        if not exists:
            raise RuntimeError("创建后未查询到BYOIP记录，请稍后重试")
        return str(exists["Id"])

    def _ensure_broadcasted(self, rule: PrefixRule, byoip_item: Dict[str, Any]) -> None:
        # 首云当前要求：仅 revoked 状态允许调用 BroadcastBYOIP。
        # 刚创建后的 BYOIP 可能短暂处于 creating/processing 等状态，需轮询等待。
        broadcastable_statuses = {"revoked"}
        status = str(byoip_item.get("Status", "")).lower()
        status_zh = str(byoip_item.get("StatusZh", "")).strip()
        if status == "broadcasted":
            return
        if status == "broadcasting":
            return

        if status not in broadcastable_statuses:
            deadline = time.time() + 45
            last_status = status
            last_status_zh = status_zh
            while time.time() < deadline:
                time.sleep(3)
                current = self._find_byoip(rule)
                if not current:
                    continue
                cur_status = str(current.get("Status", "")).lower()
                cur_status_zh = str(current.get("StatusZh", "")).strip()
                if cur_status in {"broadcasted", "broadcasting"}:
                    return
                if cur_status in broadcastable_statuses:
                    byoip_item = current
                    status = cur_status
                    status_zh = cur_status_zh
                    break
                last_status = cur_status
                last_status_zh = cur_status_zh
            else:
                raise RuntimeError(
                    "BroadcastBYOIP未执行：当前状态不允许广播。"
                    f"期望状态=revoked，当前状态={last_status or '-'}"
                    f"{('(' + last_status_zh + ')') if last_status_zh else ''}。"
                    "请稍后重试。"
                )

        byoip_id = str(byoip_item["Id"])
        resp = self._call("BroadcastBYOIP", self.client.broadcast_byoip, byoip_id)
        if not self._is_ok(resp):
            raise RuntimeError(f"BroadcastBYOIP失败: {resp}")

    def _ensure_unbroadcasted(self, byoip_id: str, current_status: str) -> None:
        if current_status.lower() not in {"broadcasted", "broadcasting"}:
            return
        resp = self._call("UndoBroadcastBYOIP", self.client.undo_broadcast_byoip, byoip_id)
        if not self._is_ok(resp):
            raise RuntimeError(f"UndoBroadcastBYOIP失败: {resp}")

    def _ensure_attached(self, rule: PrefixRule, byoip_id: str) -> None:
        seg_id = self._find_segment_id_in_vdc(rule)
        if seg_id:
            return
        resp = self._call(
            "AddPublicIp",
            self.client.add_public_ip,
            rule.public_id,
            byoip_id,
            rule.ip_number,
        )
        if not self._is_ok(resp):
            raise RuntimeError(f"AddPublicIp失败: {resp}")

    def _ensure_detached(self, rule: PrefixRule) -> None:
        from byoip_service import find_classic_segments_within_byoip
        from public_ipv4_release import (
            ipv4_count_for_segment_cidr,
            release_classic_segments_for_withdraw,
        )
        from public_ipv4_service import build_vdc_public_index

        byoip_item = self._find_byoip(rule)
        vdc_id = str(byoip_item.get("VdcId", "")) if byoip_item else ""
        byoip_id = str(byoip_item.get("Id", "")) if byoip_item else ""
        vdc_resp = self._call("DescribeVdc", self.client.describe_vdc, region_id=rule.region_id)
        segments = find_classic_segments_within_byoip(
            vdc_resp, rule.cidr, vdc_id=vdc_id, public_id=rule.public_id
        )
        if not segments:
            return
        public_id = str(rule.public_id or "").strip()
        if not public_id and vdc_id:
            public_id = str(
                (build_vdc_public_index(vdc_resp).get(vdc_id) or {}).get("public_id", "")
            )
        seg_ids = [s["segment_id"] for s in segments]
        if self.dry_run:
            for seg_id in seg_ids:
                self._call("DeletePublicIp", self.client.delete_public_ip, seg_id)
            return
        release_classic_segments_for_withdraw(
            self.client,
            byoip_cidr=rule.cidr,
            segment_ids=seg_ids,
            segment_labels={s["segment_id"]: s["cidr"] for s in segments},
            segment_numbers={
                s["segment_id"]: ipv4_count_for_segment_cidr(s["cidr"]) for s in segments
            },
            vdc_id=vdc_id,
            public_id=public_id,
            byoip_id=byoip_id,
            dry_run=False,
        )

    def _announce_flow(self, rule: PrefixRule, *, stop_on_creating: bool = False) -> Optional[Dict[str, Any]]:
        if stop_on_creating:
            return self._announce_flow_create_only(rule)
        byoip_id = self._ensure_created(rule)
        byoip_item = self._find_byoip(rule)
        if not byoip_item:
            raise RuntimeError(f"未查到BYOIP: {rule.cidr}")
        self._ensure_broadcasted(rule, byoip_item)
        self._ensure_attached(rule, byoip_id)
        print(f"[DONE] 已达到宣告状态: {rule.cidr}")
        return None

    @staticmethod
    def _is_creating_status(byoip_item: Dict[str, Any]) -> bool:
        status = str(byoip_item.get("Status", "")).lower()
        status_zh = str(byoip_item.get("StatusZh", "")).strip()
        return status == "creating" or status_zh == "创建中"

    def _announce_flow_create_only(self, rule: PrefixRule) -> Dict[str, Any]:
        existed_before = self._find_byoip(rule) is not None
        byoip_id = self._ensure_created(rule)
        if self.dry_run:
            return {
                "byoip_id": byoip_id or "dry-run",
                "status": "creating",
                "status_zh": "创建中",
                "created": not existed_before,
            }

        byoip_item = self._find_byoip(rule)
        if not byoip_item:
            raise RuntimeError(f"创建后未查询到 BYOIP 记录: {rule.cidr}")

        if not self._is_creating_status(byoip_item):
            deadline = time.time() + 30
            while time.time() < deadline:
                time.sleep(2)
                byoip_item = self._find_byoip(rule)
                if byoip_item and self._is_creating_status(byoip_item):
                    break
            else:
                current = self._find_byoip(rule) or byoip_item
                status_zh = str(current.get("StatusZh", "")).strip() or str(current.get("Status", ""))
                if existed_before:
                    raise RuntimeError(
                        f"BYOIP 已存在但当前状态为「{status_zh}」，非「创建中」"
                    )
                raise RuntimeError(f"创建后状态非「创建中」，当前：{status_zh}")

        status = str(byoip_item.get("Status", ""))
        status_zh = str(byoip_item.get("StatusZh", "")).strip() or "创建中"
        print(f"[DONE] 创建中即成功: {rule.cidr} status={status_zh}")
        return {
            "byoip_id": str(byoip_item.get("Id", byoip_id)),
            "status": status,
            "status_zh": status_zh,
            "created": not existed_before,
        }

    def _withdraw_flow(self, rule: PrefixRule) -> None:
        byoip_item = self._find_byoip(rule)
        self._ensure_detached(rule)
        if not byoip_item:
            print(f"[SKIP] BYOIP不存在，仅完成公网解绑检查: {rule.cidr}")
            return

        byoip_id = str(byoip_item["Id"])
        current_status = str(byoip_item.get("Status", ""))
        self._ensure_unbroadcasted(byoip_id, current_status)

        if rule.auto_delete_when_withdrawn:
            resp = self._call("DeleteBYOIP", self.client.delete_byoip, byoip_id)
            if not self._is_ok(resp):
                raise RuntimeError(f"DeleteBYOIP失败: {resp}")
        print(f"[DONE] 已达到撤播状态: {rule.cidr}")

    def reconcile_one(self, rule: PrefixRule) -> None:
        state = rule.desired_state.strip().lower()
        if state == "announced":
            self._announce_flow(rule)
            return
        if state == "withdrawn":
            self._withdraw_flow(rule)
            return
        raise ValueError(f"不支持的desired_state: {rule.desired_state}")


def load_config(path: str) -> Dict[str, Any]:
    config_path = resolve_config_path(path)
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    return attach_config_meta(cfg, config_path)


def parse_rules(cfg: Dict[str, Any]) -> List[PrefixRule]:
    raw_rules = cfg["automation"]["desired_prefixes"]
    rules: List[PrefixRule] = []
    for raw in raw_rules:
        rules.append(
            PrefixRule(
                cidr=str(raw["cidr"]),
                desired_state=str(raw["desired_state"]),
                pipe_id=str(raw["pipe_id"]),
                public_id=str(raw["public_id"]),
                site_id=str(raw["site_id"]),
                asn=str(raw["asn"]),
                loa_file=normalize_loa_path(str(raw["loa_file"]), cfg),
                ip_number=int(raw.get("ip_number", 4)),
                project_id=str(raw.get("project_id", "")),
                subject_id=str(raw.get("subject_id", "")),
                region_id=str(raw.get("region_id", "")),
                auto_create=bool(raw.get("auto_create", True)),
                auto_delete_when_withdrawn=bool(raw.get("auto_delete_when_withdrawn", False)),
            )
        )
    return rules


def run_once(config_path: str) -> None:
    cfg = load_config(config_path)
    dry_run = bool(cfg["automation"].get("dry_run", True))
    client = CapitalOnlineClient(cfg)
    reconciler = Reconciler(client, dry_run=dry_run)
    for rule in parse_rules(cfg):
        try:
            print(f"\n[RECONCILE] {rule.cidr} => {rule.desired_state}")
            reconciler.reconcile_one(rule)
        except Exception as exc:  # noqa: BLE001
            print(f"[ERROR] {rule.cidr}: {exc}")


def run_loop(config_path: str) -> None:
    while True:
        run_once(config_path)
        cfg = load_config(config_path)
        sleep_seconds = int(cfg["automation"].get("interval_seconds", 300))
        print(f"\n[SLEEP] {sleep_seconds}s 后进行下一轮")
        time.sleep(sleep_seconds)


def emit_output(payload: Dict[str, Any], output: str) -> None:
    if output == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if not payload.get("ok"):
        print(f"[ERROR] {payload.get('error', '查询失败')}")
        return
    print(payload.get("message", ""))


def is_success_response(resp: Dict[str, Any]) -> bool:
    code = str(resp.get("Code", "")).upper()
    success = resp.get("Success")
    return code in {"SUCCESS", "OK"} and (success is None or success is True)


def build_create_options_payload(resp: Dict[str, Any]) -> Dict[str, Any]:
    if not is_success_response(resp):
        return {"ok": False, "error": "查询可创建选项失败", "raw": resp}

    site_options = ((resp.get("Data") or {}).get("SiteOptions")) or []
    sites: List[Dict[str, Any]] = []
    lines = ["== 可创建节点 / ASN / Pipe 列表 =="]

    for idx, site in enumerate(site_options, start=1):
        site_id = str(site.get("SiteId", ""))
        site_name = str(site.get("SiteName", ""))
        as_list = [str(x) for x in (site.get("AsList") or [])]
        pipes: List[Dict[str, str]] = []

        lines.append(f"\n[{idx}] SiteName={site_name}  SiteId={site_id}")
        lines.append(f"    AsList={','.join(as_list) if as_list else '-'}")

        asn_resources = site.get("AsnResources") or []
        if not asn_resources:
            lines.append("    (无 AsnResources)")
        for asn_resource in asn_resources:
            asn = str(asn_resource.get("Asn", ""))
            pipe_list = asn_resource.get("PipeList") or []
            if not pipe_list:
                lines.append(f"    ASN={asn} -> (无可用 Pipe)")
                continue
            for pipe in pipe_list:
                pipe_id = str(pipe.get("PipeId", ""))
                pipe_name = str(pipe.get("PipeName", ""))
                vdc_id = str(pipe.get("VdcId", ""))
                vdc_name = str(pipe.get("VdcName", ""))
                pipes.append(
                    {
                        "asn": asn,
                        "pipe_id": pipe_id,
                        "pipe_name": pipe_name,
                        "vdc_id": vdc_id,
                        "vdc_name": vdc_name,
                    }
                )
                lines.append(
                    f"    ASN={asn}  PipeId={pipe_id}  PipeName={pipe_name}  "
                    f"VdcId={vdc_id}  VdcName={vdc_name}"
                )

        sites.append(
            {
                "site_id": site_id,
                "site_name": site_name,
                "as_list": as_list,
                "pipes": pipes,
            }
        )

    if not sites:
        return {"ok": True, "sites": [], "message": "[INFO] 未返回可创建选项"}

    return {"ok": True, "sites": sites, "message": "\n".join(lines)}


def build_public_network_payload(resp: Dict[str, Any], region_id: str = "") -> Dict[str, Any]:
    if not is_success_response(resp):
        return {"ok": False, "error": "查询公网资源失败", "raw": resp}

    vdc_list = resp.get("Data") or []
    public_networks: List[Dict[str, Any]] = []
    lines = ["== VDC 公网资源（PublicId / SegmentId）=="]

    for vdc in vdc_list:
        vdc_id = str(vdc.get("VdcId", ""))
        vdc_name = str(vdc.get("VdcName", ""))
        vdc_region = str(vdc.get("RegionId", ""))
        for public_net in (vdc.get("PublicNetwork") or []):
            public_id = str(public_net.get("PublicId", ""))
            public_name = str(public_net.get("Name", ""))
            segments_out: List[Dict[str, str]] = []

            lines.append(
                f"\nVdcName={vdc_name}  VdcId={vdc_id}  RegionId={vdc_region}  "
                f"PublicName={public_name}  PublicId={public_id}"
            )
            segments = public_net.get("Segments") or []
            if not segments:
                lines.append("    (无网段)")
            for seg in segments:
                address = str(seg.get("Address", ""))
                mask = str(seg.get("Mask", ""))
                gateway = str(seg.get("Gateway", ""))
                segment_id = str(seg.get("SegmentId", ""))
                segments_out.append(
                    {
                        "segment_id": segment_id,
                        "address": address,
                        "mask": mask,
                        "gateway": gateway,
                        "cidr": f"{address}/{mask}" if address and mask else "",
                    }
                )
                lines.append(
                    f"    SegmentId={segment_id}  CIDR={address}/{mask}  Gateway={gateway}"
                )

            public_networks.append(
                {
                    "vdc_id": vdc_id,
                    "vdc_name": vdc_name,
                    "region_id": vdc_region,
                    "public_id": public_id,
                    "public_name": public_name,
                    "segments": segments_out,
                }
            )

    if not public_networks:
        return {
            "ok": True,
            "region_id": region_id,
            "public_networks": [],
            "message": "[INFO] 未查询到 VDC 公网数据",
        }

    return {
        "ok": True,
        "region_id": region_id,
        "public_networks": public_networks,
        "message": "\n".join(lines),
    }


def run_list_create_options(config_path: str, output: str = "text") -> None:
    cfg = load_config(config_path)
    client = CapitalOnlineClient(cfg)
    try:
        resp = client.describe_byoip_site_create_options()
    except requests.RequestException as exc:
        payload = {"ok": False, "error": f"请求失败: {exc}"}
        if output == "json":
            emit_output(payload, output)
            return
        print(f"[ERROR] {payload['error']}")
        return

    payload = build_create_options_payload(resp)
    if output == "json":
        emit_output(payload, output)
        return
    if not payload.get("ok"):
        print("[ERROR] 查询可创建选项失败")
        print(json.dumps(payload.get("raw", payload), ensure_ascii=False, indent=2))
        return
    print(payload.get("message", ""))


def run_list_public_network(config_path: str, region_id: str = "", output: str = "text") -> None:
    cfg = load_config(config_path)
    client = CapitalOnlineClient(cfg)
    try:
        resp = client.describe_vdc(region_id=region_id)
    except requests.RequestException as exc:
        payload = {"ok": False, "error": f"请求失败: {exc}", "region_id": region_id}
        if output == "json":
            emit_output(payload, output)
            return
        print(f"[ERROR] {payload['error']}")
        return

    payload = build_public_network_payload(resp, region_id=region_id)
    if output == "json":
        emit_output(payload, output)
        return
    if not payload.get("ok"):
        print("[ERROR] 查询公网资源失败")
        print(json.dumps(payload.get("raw", payload), ensure_ascii=False, indent=2))
        return
    print(payload.get("message", ""))


def run_check_options(config_path: str, output: str = "text") -> None:
    run_list_create_options(config_path, output=output)


def main() -> None:
    from app_paths import default_config_path

    parser = argparse.ArgumentParser(description="首云 BYOIP 自动宣告/撤播系统")
    parser.add_argument(
        "--config",
        default=default_config_path(),
        help="配置文件路径，默认 ./config.yaml 或环境变量 IP_ANNOUNCE_CONFIG",
    )
    parser.add_argument(
        "--mode",
        required=True,
        choices=[
            "once",
            "loop",
            "check-options",
            "list-create-options",
            "list-public-network",
        ],
        help=(
            "once: 执行一轮；loop: 循环执行；check-options/list-create-options: 查询站点/ASN/Pipe；"
            "list-public-network: 查询 PublicId/SegmentId"
        ),
    )
    parser.add_argument(
        "--region-id",
        default="",
        help="用于 list-public-network 的可用区过滤，例如 CN_Beijing_A",
    )
    parser.add_argument(
        "--output",
        choices=["text", "json"],
        default="text",
        help="查询模式输出格式：text=人类可读，json=机器可读",
    )
    args = parser.parse_args()

    if args.mode == "once":
        run_once(args.config)
    elif args.mode == "loop":
        run_loop(args.config)
    elif args.mode in {"check-options", "list-create-options"}:
        run_check_options(args.config, output=args.output)
    elif args.mode == "list-public-network":
        run_list_public_network(args.config, region_id=args.region_id, output=args.output)


if __name__ == "__main__":
    main()
