import { unwrapResponse, zecCall, bmcCall } from "./zenlayer";

export async function describeCidrRow(
  cidrBlock: string,
  regionId: string,
  ak: string,
  sk: string,
  ver: string
): Promise<Record<string, unknown> | null> {
  const data = await zecCall(
    "DescribeCidrs",
    { cidrBlock, regionId, pageSize: 20, pageNum: 1 },
    ak,
    sk,
    ver
  );
  const inner = unwrapResponse(data);
  const rows = (inner.dataSet as Record<string, unknown>[]) || [];
  return (
    rows.find(
      (r) => r.cidrBlock === cidrBlock && r.regionId === regionId
    ) || null
  );
}

/**
 * BMC 版：通过 DescribeCidrBlocks 查询 CIDR 行。
 * 响应字段：cidrBlockId, cidrBlockName, cidrBlock, zoneId, instanceIds, status
 *
 * 注意：CREATE_FAILED 状态的记录其 cidrBlock 字段为空字符串，
 * 因此不能用 cidrBlock 参数过滤，改为全量查询后按 cidrBlockName 匹配。
 */
export async function describeBmcCidrRow(
  cidrBlock: string,
  ak: string,
  sk: string,
  ver: string
): Promise<Record<string, unknown> | null> {
  try {
    const data = await bmcCall(
      "DescribeCidrBlocks",
      { pageSize: 100, pageNum: 1 },
      ak,
      sk,
      ver
    );
    const inner = unwrapResponse(data);
    const rows = (inner.dataSet as Record<string, unknown>[]) || [];
    // cidrBlock 字段在 CREATE_FAILED 时为空，用 cidrBlockName 作为备用匹配
    return (
      rows.find(
        (r) => r.cidrBlock === cidrBlock || r.cidrBlockName === cidrBlock
      ) || null
    );
  } catch {
    return null;
  }
}
