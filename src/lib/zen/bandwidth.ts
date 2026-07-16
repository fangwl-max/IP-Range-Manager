import {
  bandwidthRowMatchesCityLabel,
  cityNameQueryCandidates,
} from "./city-bandwidth-query";
import { DEFAULT_REGION_CITY_HINTS } from "./constants";
import { getCityForRegion } from "./region-meta";
import type { ZenJob } from "./types";
import { trafficCall, unwrapResponse } from "./zenlayer";

const BANDWIDTH_CLUSTER_SCAN_MAX_PAGES = 50;
/** DescribeBandwidthClusters 列表分页上限，防止 totalCount 异常时死循环 */
const BANDWIDTH_CLUSTER_LIST_MAX_PAGES = 500;

function nameMatches(hint: string, rowName: string): boolean {
  const a = hint.trim().toLowerCase();
  const b = (rowName || "").trim().toLowerCase();
  if (!a) return true;
  return a === b || a.includes(b) || b.includes(a);
}

export async function listBandwidthClusters(
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  opts: { cityName?: string; clusterNameFuzzy?: string }
): Promise<Record<string, unknown>[]> {
  const pageSize = 100;
  let page = 1;
  const all: Record<string, unknown>[] = [];
  while (page <= BANDWIDTH_CLUSTER_LIST_MAX_PAGES) {
    const req: Record<string, unknown> = { pageNum: page, pageSize };
    if (opts.cityName) req.cityName = opts.cityName;
    if (opts.clusterNameFuzzy) req.bandwidthClusterName = opts.clusterNameFuzzy;
    const data = await trafficCall(
      "DescribeBandwidthClusters",
      req,
      accessKeyId,
      secret,
      apiVersion,
      60000
    );
    const inner = unwrapResponse(data);
    const batch = (inner.dataSet as Record<string, unknown>[]) || [];
    const rawTotal = inner.totalCount ?? inner.total;
    const t = Number(rawTotal);
    /** totalCount 缺失或非正时不能用「已拉够」判断，否则 all >= NaN 恒假会导致无限翻页 */
    const totalCap = Number.isFinite(t) && t > 0 ? t : null;

    all.push(...batch);
    if (!batch.length) break;
    if (totalCap !== null && all.length >= totalCap) break;
    if (batch.length < pageSize) break;
    page += 1;
  }
  return all;
}

/** 不传 cityName 分页拉取，用 Subnet 面板城市文案与各行 cityName/location 宽松对齐（最后手段） */
async function listBandwidthClustersMatchingCityLabel(
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  subnetCityLabel: string
): Promise<Record<string, unknown>[]> {
  const pageSize = 100;
  const byId = new Map<string, Record<string, unknown>>();

  for (let page = 1; page <= BANDWIDTH_CLUSTER_SCAN_MAX_PAGES; page++) {
    const data = await trafficCall(
      "DescribeBandwidthClusters",
      { pageNum: page, pageSize },
      accessKeyId,
      secret,
      apiVersion,
      60000
    );
    const inner = unwrapResponse(data);
    const batch = (inner.dataSet as Record<string, unknown>[]) || [];
    if (!batch.length) break;
    for (const row of batch) {
      if (bandwidthRowMatchesCityLabel(row, subnetCityLabel)) {
        const id = row.bandwidthClusterId;
        if (id) byId.set(String(id), row);
      }
    }
    const total = Number(inner.totalCount ?? 0);
    if (batch.length < pageSize || page * pageSize >= total) break;
  }
  return [...byId.values()];
}

/**
 * 按 DescribeSubnetRegions 得到的城市文案解析带宽组：多 cityName 变体 → 仍失败则分页扫描宽松匹配。
 */
async function listBandwidthClustersBySubnetCityLabel(
  subnetCityLabel: string,
  regionId: string,
  accessKeyId: string,
  secret: string,
  apiVersion: string,
  clusterNameFuzzy: string | undefined
): Promise<Record<string, unknown>[]> {
  const candidates = cityNameQueryCandidates(subnetCityLabel, regionId);
  const cityNamesToTry: (string | undefined)[] =
    candidates.length > 0 ? candidates : [undefined];

  for (const cityName of cityNamesToTry) {
    let rows = await listBandwidthClusters(accessKeyId, secret, apiVersion, {
      cityName,
      clusterNameFuzzy,
    });
    if (clusterNameFuzzy) {
      rows = rows.filter((r) =>
        nameMatches(clusterNameFuzzy, String(r.bandwidthClusterName ?? ""))
      );
    }
    if (rows.length) return rows;
  }

  if (!subnetCityLabel.trim()) return [];

  let loose = await listBandwidthClustersMatchingCityLabel(
    accessKeyId,
    secret,
    apiVersion,
    subnetCityLabel
  );
  if (clusterNameFuzzy) {
    loose = loose.filter((r) =>
      nameMatches(clusterNameFuzzy, String(r.bandwidthClusterName ?? ""))
    );
  }
  return loose;
}

function pickClusterForNetwork(
  rows: Record<string, unknown>[],
  networkType: string
): Record<string, unknown> {
  const byNt = rows.filter((r) => String(r.networkLineType ?? "") === networkType);
  if (byNt.length === 1) return byNt[0];
  const hint = networkType === "PremiumBGP" ? "premium" : "standard";
  const byName = rows.filter((r) =>
    String(r.bandwidthClusterName ?? "")
      .toLowerCase()
      .includes(hint)
  );
  if (byName.length === 1) return byName[0];
  if (rows.length === 1) return rows[0];
  const preview = rows.slice(0, 10).map((r) => ({
    bandwidthClusterId: r.bandwidthClusterId,
    bandwidthClusterName: r.bandwidthClusterName,
    networkLineType: r.networkLineType,
  }));
  throw new Error(
    `同一城市下多个合并带宽组，无法自动唯一选定。请设置 ZENLAYER_BANDWIDTH_CLUSTER_ID、在任务中填写 bandwidthClusterId，或填写 cityName + bandwidthClusterName 收窄查询。候选: ${JSON.stringify(preview)}`
  );
}

/**
 * 从**已有**合并带宽组中解析 ID：仅调用 DescribeSubnetRegions / DescribeBandwidthClusters **查询**，
 * **不会**调用 CreateBandwidthCluster。
 *
 * 优先级：job.bandwidthClusterId → 手动 city/name查询 → 按 regionId 自动查城市并列举 → env 退路。
 */
export async function resolveBandwidthClusterId(
  job: ZenJob,
  regionId: string,
  envFallback: string | undefined,
  accessKeyId: string,
  secret: string,
  apiVersion: string
): Promise<string> {
  const direct = job.bandwidthClusterId?.trim();
  if (direct) return direct;

  const manualCity = job.cityName?.trim();
  const manualName = job.bandwidthClusterName?.trim();
  if (manualCity || manualName) {
    const city = manualCity || DEFAULT_REGION_CITY_HINTS[regionId];
    if (!city && !manualName) {
      const fb = envFallback?.trim();
      if (fb) return fb;
      throw new Error("手动模式请填写城市或带宽组名称");
    }
    const rows = await listBandwidthClustersBySubnetCityLabel(
      city || "",
      regionId,
      accessKeyId,
      secret,
      apiVersion,
      manualName || undefined
    );
    if (rows.length === 1) {
      const id = rows[0].bandwidthClusterId;
      if (!id) throw new Error("带宽组记录缺少 bandwidthClusterId");
      return String(id);
    }
    if (!rows.length) {
      throw new Error("未匹配到共享带宽包，请检查城市与名称");
    }
    const preview = rows.slice(0, 12).map((r) => ({
      bandwidthClusterId: r.bandwidthClusterId,
      bandwidthClusterName: r.bandwidthClusterName,
    }));
    throw new Error(`匹配到多个带宽组: ${JSON.stringify(preview)}`);
  }

  const city = await getCityForRegion(regionId, accessKeyId, secret, apiVersion);
  if (!city) {
    const fb = envFallback?.trim();
    if (fb) return fb;
    throw new Error(
      `无法解析地域对应城市（DescribeSubnetRegions 无括号地名），regionId=${regionId}`
    );
  }

  const rows = await listBandwidthClustersBySubnetCityLabel(
    city,
    regionId,
    accessKeyId,
    secret,
    apiVersion,
    undefined
  );
  if (!rows.length) {
    const fb = envFallback?.trim();
    if (fb) return fb;
    throw new Error(
      `城市「${city}」下未查询到共享带宽包（DescribeBandwidthClusters）；已尝试名称变体与列表扫描，仍无匹配请检查该地域是否已创建合并带宽组或填写 bandwidthClusterId`
    );
  }

  const picked = pickClusterForNetwork(rows, job.networkType);
  const id = picked.bandwidthClusterId;
  if (!id) throw new Error("带宽组记录缺少 bandwidthClusterId");
  return String(id);
}
