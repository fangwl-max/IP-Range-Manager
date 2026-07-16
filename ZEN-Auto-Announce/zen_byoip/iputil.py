from __future__ import annotations

import ipaddress
from typing import Iterator


def iter_eip_host_ips(cidr: str, *, min_last_octet: int = 0) -> Iterator[str]:
    """
    生成将用于创建弹性 IPv4 的公网地址字符串列表。
    -常见 /24：含网络地址 .0 至广播前一位 .254（末段 0～254），与「少一个」的期望一致。
    - /31、/32 按 ipaddress 惯例处理。
    - 末段 < min_last_octet 的跳过（要保留 .0/.1 时可设 min_last_octet=2）。
    """
    net = ipaddress.ip_network(cidr.strip(), strict=False)
    if net.version != 4:
        raise ValueError("当前仅支持 IPv4 CIDR")
    if net.prefixlen == 32:
        host = net.network_address
        if int(host.packed[-1]) >= min_last_octet:
            yield str(host)
        return
    if net.prefixlen == 31:
        for host in net.hosts():
            if int(host.packed[-1]) >= min_last_octet:
                yield str(host)
        return
    for addr in net:
        if addr == net.broadcast_address:
            continue
        if int(addr.packed[-1]) >= min_last_octet:
            yield str(addr)


def eip_resource_name(ipv4: str) -> str:
    """例：147.90.76.2 → EIP-147.90.76-2（前三段带点，末段连字符）。"""
    parts = ipv4.strip().split(".")
    if len(parts) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
        raise ValueError(f"非法 IPv4: {ipv4}")
    a, b, c, d = (int(p) for p in parts)
    return f"EIP-{a}.{b}.{c}-{d}"


def eip_sequential_name(cidr: str, index: int) -> str:
    """按 CIDR 网络号前三段 + 从 0 递增序号命名，与创建顺序一致。"""
    if index < 0 or not isinstance(index, int):
        raise ValueError(f"非法序号: {index}")
    net = ipaddress.ip_network(cidr.strip(), strict=False)
    if net.version != 4:
        raise ValueError("当前仅支持 IPv4 CIDR")
    host = net.network_address
    a, b, c = (int(x) for x in host.packed[:3])
    return f"EIP-{a}.{b}.{c}-{index}"
