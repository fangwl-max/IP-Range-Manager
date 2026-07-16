import { DEFAULT_REGION_CITY_HINTS } from "./constants";
import { unwrapResponse, zecCall, bmcCall } from "./zenlayer";

/** ??Zenlayer regionId ???? na-central-2?????? DescribeBandwidthClusters.cityName */
function looksLikeRegionId(s: string): boolean {
  return /^[a-z]{2,}(?:-[a-z0-9]+)+$/i.test(s.trim());
}

/**
 * ?????????? DescribeBandwidthClusters.cityName?? * - ???????`asia-southeast-1(Hong Kong)` ??Hong Kong
 * - ??????????regionId ?????API ???? `Dallas`??????????
 */
export function extractCityFromRegionTitle(title: string): string | null {
  const t = title.trim();
  if (!t) return null;
  const m = /\(([^)]+)\)\s*$/.exec(t);
  if (m) return m[1].trim();
  if (!looksLikeRegionId(t)) return t;
  return null;
}

export async function getCityForRegion(
  regionId: string,
  ak: string,
  sk: string,
  ver: string
): Promise<string | null> {
  const data = await zecCall(
    "DescribeSubnetRegions",
    { regionIds: [regionId] },
    ak,
    sk,
    ver
  );
  const inner = unwrapResponse(data);
  const set =
    (inner.regionSet as {
      regionId?: string;
      regionTitle?: string;
      regionName?: string;
    }[]) || [];
  const row = set.find((r) => r.regionId === regionId);
  const title = row?.regionTitle || row?.regionName || "";
  if (title) {
    const c = extractCityFromRegionTitle(title);
    if (c) return c;
  }
  return DEFAULT_REGION_CITY_HINTS[regionId] || null;
}

export type ByoipRegionRow = {
  regionId: string;
  network: string;
  netmask?: number;
  ipType?: string;
};

export async function fetchByoipRegionRows(
  ak: string,
  sk: string,
  ver: string
): Promise<ByoipRegionRow[]> {
  const data = await zecCall("DescribeByoipRegions", {}, ak, sk, ver);
  const inner = unwrapResponse(data);
  const raw = (inner.regions as ByoipRegionRow[]) || [];
  return raw.filter((r) => (r.ipType || "IPv4") === "IPv4");
}

export type BmcByoipRegionRow = {
  regionId: string;
  ipType?: string;
};

/** BMC BYOIP ?????DescribeByoipRegions via BMC? */
export async function fetchBmcByoipRegions(
  ak: string,
  sk: string,
  ver: string
): Promise<BmcByoipRegionRow[]> {
  const data = await bmcCall("DescribeByoipRegions", {}, ak, sk, ver);
  const inner = unwrapResponse(data);
  const raw = (inner.regions as BmcByoipRegionRow[]) || [];
  return raw.filter((r) => !r.ipType || r.ipType.toUpperCase() === "IPV4");
}

export type BmcZoneRow = {
  zoneId: string;
  zoneName: string;
  cityName: string;
  areaName: string;
  isByoipEnabled?: boolean;
  isCloudRouterAvailable?: boolean;
};

/**
 * ?? DescribeZones ???? BYOIP ? BMC ????isByoipEnabled=true?
 */
export async function fetchBmcByoipZones(
  ak: string,
  sk: string,
  ver: string
): Promise<BmcZoneRow[]> {
  const data = await bmcCall("DescribeZones", {}, ak, sk, ver);
  const inner = unwrapResponse(data);
  const zones = (inner.zoneSet as BmcZoneRow[]) || [];
  return zones.filter((z) => z.isByoipEnabled === true);
}

export type BmcPublicVirtualInterface = {
  publicVirtualInterfaceId: string;
  publicVirtualInterfaceName?: string;
  regionId?: string;
  status?: string;
};

/** ?? BMC ?? VLAN ???DescribePublicVirtualInterfaces via BMC? */
export async function fetchBmcPublicVirtualInterfaces(
  ak: string,
  sk: string,
  ver: string
): Promise<BmcPublicVirtualInterface[]> {
  try {
    const data = await bmcCall("DescribePublicVirtualInterfaces", { pageSize: 100, pageNum: 1 }, ak, sk, ver);
    const inner = unwrapResponse(data);
    const raw = (inner.dataSet ?? inner.data ?? inner.list ?? []) as BmcPublicVirtualInterface[];
    return raw;
  } catch {
    return [];
  }
}

export async function fetchRegionLabels(
  regionIds: string[],
  ak: string,
  sk: string,
  ver: string
): Promise<Map<string, string>> {
  const ids = [...new Set(regionIds.filter(Boolean))];
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const data = await zecCall("DescribeSubnetRegions", { regionIds: ids }, ak, sk, ver);
  const inner = unwrapResponse(data);
  const set =
    (inner.regionSet as {
      regionId?: string;
      regionTitle?: string;
      regionName?: string;
    }[]) || [];
  for (const r of set) {
    if (r.regionId) {
      map.set(r.regionId, r.regionTitle || r.regionName || r.regionId);
    }
  }
  return map;
}
