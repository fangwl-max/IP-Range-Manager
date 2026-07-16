function parseIPv4(ip: string): number {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) throw new Error(`非法 IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) throw new Error(`非法 IPv4: ${ip}`);
    n = ((n << 8) | o) >>> 0;
  }
  return n;
}

function formatIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/**
 * 在网段内生成将用于创�?EIP 的地址列表（可分配主机位，与常�?/24=254 一致）�? * - /24�?1�?254（排除网络地址 .0 与广�?.255），与控制台「弹�?IPv4」可建数量一致�? * - /31：按 RFC 3021，两端均可能用于主机（不套用 +1）�? * - 末段 &lt; minLastOctet 的会跳过（需多保留地址时可�?minLastOctet=2）�? */
export function* iterEipHostIps(
  cidr: string,
  minLastOctet: number
): Generator<string> {
  const [ipPart, bitsStr] = cidr.trim().split("/");
  const prefix = parseInt(bitsStr ?? "32", 10);
  if (prefix < 0 || prefix > 32) throw new Error("非法掩码");
  const ipNum = parseIPv4(ipPart);
  const mask = (((0xffffffff << (32 - prefix)) >>> 0) >>> 0) as number;
  const network = (ipNum & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  let start: number;
  let end: number;
  if (prefix === 32) {
    start = network;
    end = network;
  } else if (prefix === 31) {
    start = network;
    end = broadcast;
  } else {
    start = network + 1;
    end = broadcast - 1;
  }
  for (let n = start; n <= end; n++) {
    const last = n & 255;
    if (last >= minLastOctet) yield formatIPv4(n);
  }
}

/** �?iterEipHostIps 一致的可分配主机数量（用于 DescribeEips 列表早停上限，如 /24 �?254�?*/
export function countAssignableHostSlots(cidr: string, minLastOctet: number): number {
  return [...iterEipHostIps(cidr, minLastOctet)].length;
}

/** 例：147.90.76.2 �?EIP-147.90.76-2（前三段带点，末段用连字符） */
export function eipResourceName(ipv4: string): string {
  const parts = ipv4.trim().split(".");
  if (parts.length !== 4) throw new Error(`非法 IPv4: ${ipv4}`);
  const nums: number[] = [];
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) throw new Error(`非法 IPv4: ${ipv4}`);
    nums.push(o);
  }
  const [a, b, c, d] = nums;
  return `EIP-${a}.${b}.${c}-${d}`;
}

/**
 * �?CIDR 网络号前三段 + �?0 递增的序号命名（与创建顺序一致）�? * 例：147.90.76.0/24 �?首条对应 .1，序号为 0�?53（名�?EIP-147.90.76-0 �?-253�? */
export function eipSequentialName(cidr: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`非法序号: ${index}`);
  const [ipPart, bitsStr] = cidr.trim().split("/");
  const prefix = parseInt(bitsStr ?? "32", 10);
  if (prefix < 0 || prefix > 32) throw new Error("非法掩码");
  const ipNum = parseIPv4(ipPart);
  const mask = (((0xffffffff << (32 - prefix)) >>> 0) >>> 0) as number;
  const network = (ipNum & mask) >>> 0;
  const a = network >>> 24;
  const b = (network >>> 16) & 255;
  const c = (network >>> 8) & 255;
  return `EIP-${a}.${b}.${c}-${index}`;
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 判断 IPv4 是否落在给定 CIDR 内（含网络号与广播规则与 iterEipHostIps 一致） */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const t = cidr.trim().split("/");
  if (t.length !== 2) return false;
  const prefix = parseInt(t[1] ?? "", 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;
  try {
    const ipNum = parseIPv4(ip);
    const cidrHost = parseIPv4(t[0]!);
    const mask = (((0xffffffff << (32 - prefix)) >>> 0) >>> 0) as number;
    return ((ipNum & mask) >>> 0) === ((cidrHost & mask) >>> 0);
  } catch {
    return false;
  }
}

/**
 * �?IPv4 CIDR 规范为「网络地址/前缀」，用于判断多行是否同一网段�? * 非法格式返回 null。支持省略第四段�?03.0.113/24 �?203.0.113.0/24�? */
export function normalizeIpv4Cidr(cidr: string): string | null {
  const t = cidr.trim();
  const slash = t.indexOf("/");
  if (slash < 0) return null;
  const ipPartRaw = t.slice(0, slash).trim();
  const bitsStr = t.slice(slash + 1).trim();
  const prefix = parseInt(bitsStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  const dotParts = ipPartRaw.split(".").filter((p) => p.length > 0);
  const ipPart =
    dotParts.length === 3 ? `${ipPartRaw}.0` : ipPartRaw;
  try {
    const ipNum = parseIPv4(ipPart);
    const mask = (((0xffffffff << (32 - prefix)) >>> 0) >>> 0) as number;
    const network = (ipNum & mask) >>> 0;
    return `${formatIPv4(network)}/${prefix}`;
  } catch {
    return null;
  }
}

/**
 * 解析用户输入�?IP「段」（删除/续跑列表与控制台习惯一致）�? * - 可无掩码�?03.0.113�?03.0.113.0 �?按前三段匹配任意 203.0.113.*（等价一�?/24 主机面）
 * - 可带掩码�?03.0.113.0/24�?03.0.113/24 �?标准 CIDR 精确匹配
 * - �?/24 前缀（如 /25）必须用「地址/掩码」形式，仍走 CIDR 精确匹配
 */
export function parseUserIpSegment(input: string): {
  displayCidr: string;
  matchPublicIp: (ip: string) => boolean;
} | null {
  let raw = input.trim();
  if (!raw) return null;

  // handle trailing-dot notation, e.g. '155.117.118.' == '155.117.118'
  const triDot = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.$/);
  if (triDot) raw = `${triDot[1]}.${triDot[2]}.${triDot[3]}`;

  const slashIdx = raw.indexOf("/");
  if (slashIdx >= 0) {
    const ipPartRaw = raw.slice(0, slashIdx).trim();
    const bitsStr = raw.slice(slashIdx + 1).trim();
    const prefix = parseInt(bitsStr, 10);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
    const dotParts = ipPartRaw.split(".").filter((p) => p.length > 0);
    const ipPart =
      dotParts.length === 3 ? `${ipPartRaw}.0` : ipPartRaw;
    const norm = normalizeIpv4Cidr(`${ipPart}/${prefix}`);
    if (!norm) return null;
    return {
      displayCidr: norm,
      matchPublicIp: (ip: string) => {
        const host = (ip.trim().split("/")[0] ?? "").trim();
        return ipv4InCidr(host, norm);
      },
    };
  }

  const dotParts = raw.split(".").map((p) => p.trim()).filter((p) => p.length > 0);
  if (dotParts.length < 3 || dotParts.length > 4) return null;
  const nums: number[] = [];
  for (const p of dotParts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    nums.push(o);
  }
  const a = nums[0]!;
  const b = nums[1]!;
  const c = nums[2]!;
  const displayCidr = `${a}.${b}.${c}.0/24`;
  return {
    displayCidr,
    matchPublicIp: (ip: string) => {
      const host = (ip.trim().split("/")[0] ?? "").trim();
      const parts = host.split(".");
      if (parts.length !== 4) return false;
      const o0 = Number(parts[0]);
      const o1 = Number(parts[1]);
      const o2 = Number(parts[2]);
      if (
        ![o0, o1, o2].every(
          (x) => Number.isInteger(x) && x >= 0 && x <= 255
        )
      ) {
        return false;
      }
      return o0 === a && o1 === b && o2 === c;
    },
  };
}

/**
 * DescribeEips �?name 支持模糊匹配（官方文档）�? * 由规范网段得到前三段，用于首�?0 命中时的补拉列表�? */
export function describeEipsNameHintFromDisplayCidr(displayCidr: string): string | null {
  const host = (displayCidr.trim().split("/")[0] ?? "").trim();
  const parts = host.split(".").filter((p) => p.length > 0);
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return null;
  }
  return `${nums[0]}.${nums[1]}.${nums[2]}`;
}
