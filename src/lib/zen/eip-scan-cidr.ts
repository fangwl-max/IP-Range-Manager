import { extractPublicIpFromEipApiRow } from "./eip-public-ip";
import { describeEipsNameHintFromDisplayCidr, parseUserIpSegment } from "./iputil";
import { unwrapResponse, zecCall } from "./zenlayer";

/** 中断后重跑：分页 DescribeEips，收集落在该 CIDR 内的公网 IP（用于跳过已创建 EIP�?*/
function eipResumeScanEnabled(): boolean {
  const v = process.env.ZENLAYER_EIP_RESUME_SCAN?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

function eipResumeScanMaxPages(): number {
  const n = Number(process.env.ZENLAYER_EIP_RESUME_SCAN_MAX_PAGES?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.min(200, Math.floor(n));
  return 60;
}

function resumeScanPageSize(): number {
  const n = Number(process.env.ZENLAYER_EIP_LIST_PAGE_SIZE?.trim());
  if (Number.isFinite(n) && n >= 10) return Math.min(500, Math.floor(n));
  return 100;
}

export { eipResumeScanEnabled };

/**
 * 扫描某地域下已分配、且公网 IP 落在 cidrBlock 内的 EIP（续跑时排除这些主机位）�? * 大账号可�?ZENLAYER_EIP_RESUME_SCAN=0 或调�?ZENLAYER_EIP_RESUME_SCAN_MAX_PAGES�? */
export async function collectExistingEipPublicIpsInCidr(
  regionId: string,
  cidrBlock: string,
  ak: string,
  sk: string,
  ver: string
): Promise<Set<string>> {
  const seg = parseUserIpSegment(cidrBlock);
  if (!seg) return new Set();
  const { matchPublicIp, displayCidr } = seg;
  const out = new Set<string>();
  const pageSize = resumeScanPageSize();
  const maxPages = eipResumeScanMaxPages();
  const nameHint = describeEipsNameHintFromDisplayCidr(displayCidr);

  const pull = async (extra: Record<string, unknown>) => {
    for (let page = 1; page <= maxPages; page++) {
      const data = await zecCall(
        "DescribeEips",
        { regionId, pageNum: page, pageSize, ...extra },
        ak,
        sk,
        ver,
        60_000
      );
      const inner = unwrapResponse(data);
      const rows = (inner.dataSet as Record<string, unknown>[]) || [];
      if (!rows.length) break;
      for (const r of rows) {
        const ip = extractPublicIpFromEipApiRow(r as Record<string, unknown>);
        if (ip && matchPublicIp(ip)) out.add(ip);
      }
      const total = Number(inner.totalCount ?? inner.total ?? 0);
      const cap = Number.isFinite(total) && total > 0 ? total : null;
      if (!cap && rows.length < pageSize) break;
      if (cap !== null && page * pageSize >= cap) break;
      if (cap !== null && rows.length < pageSize) break;
    }
  };

  const mergeFull = process.env.ZENLAYER_EIP_LIST_MERGE_FULL_AFTER_NAME?.trim() === "1";

  if (nameHint) {
    await pull({ name: nameHint });
    if (out.size === 0 || mergeFull) await pull({});
  } else {
    await pull({});
  }
  return out;
}
