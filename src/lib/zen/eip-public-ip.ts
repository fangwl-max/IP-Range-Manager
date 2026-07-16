/**
 * DescribeEips 返回�?EipInfo（见官方文档）以 publicIpAddresses 为主�? * 示例响应�?eipGeoRefs[].ip、blockInfoList[].ip 与公�?IP 一致，可作兜底�? * publicIpAddresses[0] 若为对象，直�?String() 会得�?"[object Object]"�? */

function stripIpv4Port(host: string): string {
  const t = host.trim();
  const lastColon = t.lastIndexOf(":");
  if (lastColon <= 0) return t;
  const tail = t.slice(lastColon + 1);
  if (/^\d{1,5}$/.test(tail)) return t.slice(0, lastColon).trim();
  return t;
}

function isDottedIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function ipv4FromString(v: string): string {
  const t = v.trim();
  if (!t) return "";
  const noCidr = (t.split("/")[0] ?? "").trim();
  const host = stripIpv4Port(noCidr);
  return isDottedIpv4(host) ? host : "";
}

function ipv4FromAddressEntry(item: unknown): string {
  if (typeof item === "string") return ipv4FromString(item);
  if (!item || typeof item !== "object") return "";
  const o = item as Record<string, unknown>;
  for (const key of [
    "publicIpAddress",
    "publicIp",
    "ipAddress",
    "ip",
    "address",
    "ipv4",
  ]) {
    const v = o[key];
    if (typeof v === "string") {
      const s = ipv4FromString(v);
      if (s) return s;
    }
  }
  return "";
}

function firstIpv4FromObjectList(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const ip = (item as Record<string, unknown>).ip;
    if (typeof ip === "string") {
      const s = ipv4FromString(ip);
      if (s) return s;
    }
  }
  return "";
}

/** �?DescribeEips dataSet 单行解析可用于匹配的 IPv4 字符串（�?/掩码、无端口后缀�?*/
export function extractPublicIpFromEipApiRow(r: Record<string, unknown>): string {
  const addrs = r.publicIpAddresses ?? r.public_ip_addresses;
  if (Array.isArray(addrs)) {
    for (const item of addrs) {
      const s = ipv4FromAddressEntry(item);
      if (s) return s;
    }
  }

  for (const key of [
    "publicIp",
    "public_ip",
    "publicIPv4",
    "ipAddress",
    "ip_address",
    "ip",
  ]) {
    const v = r[key];
    if (typeof v === "string") {
      const s = ipv4FromString(v);
      if (s) return s;
    }
  }

  const geo = firstIpv4FromObjectList(r.eipGeoRefs ?? r.eip_geo_refs);
  if (geo) return geo;
  const block = firstIpv4FromObjectList(r.blockInfoList ?? r.block_info_list);
  if (block) return block;

  return "";
}
