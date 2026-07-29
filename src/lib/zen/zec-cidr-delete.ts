import { apiVersion } from "./credentials";
import { normalizeIpv4Cidr, parseUserIpSegment } from "./iputil";
import type { ByoipWithdrawEvent, ByoipWithdrawRequest } from "./types";
import { unwrapResponse, zecCall } from "./zenlayer";

function normalizeCidr(raw: string): string {
  const t = raw.trim();
  return parseUserIpSegment(t)?.displayCidr ?? normalizeIpv4Cidr(t) ?? t;
}

/**
 * ZEC CIDR 删除
 * 1. DescribeCidrs 在指定/全部 region 中查找 cidrId
 * 2. 检查 usedCount > 0 → 跳过（有 EIP 未释放）
 * 3. DeleteCidr 删除
 */
export async function* runZecCidrDelete(
  opts: ByoipWithdrawRequest,
  accessKeyId: string,
  secret: string
): AsyncGenerator<ByoipWithdrawEvent> {
  const ver = apiVersion();
  const tasks = (opts.tasks || []).filter((t) => t.cidrBlock?.trim());
  if (!tasks.length) {
    yield { type: "error", message: "请至少填写一个 CIDR" };
    return;
  }

  const scanRegionIds = (opts.scanRegionIds || []).filter(Boolean);

  for (let i = 0; i < tasks.length; i++) {
    const rawCidr = tasks[i].cidrBlock.trim();
    const cidr = normalizeCidr(rawCidr);
    const taskRegion = tasks[i].regionId?.trim();

    yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "lookup" };
    yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 查询 ZEC DescribeCidrs...` };

    try {
      let cidrRow: Record<string, unknown> | null = null;

      const regionsToSearch = taskRegion ? [taskRegion] : scanRegionIds;

      if (regionsToSearch.length === 0) {
        yield { type: "log", level: "error", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 无可搜索的 region` };
        yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, dryRun: opts.dryRun, deleted: false, message: "无可搜索的 region" };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "error" };
        continue;
      }

      for (const rid of regionsToSearch) {
        try {
          const data = await zecCall(
            "DescribeCidrs",
            { cidrBlock: cidr, regionId: rid, pageSize: 20, pageNum: 1 },
            accessKeyId, secret, ver
          );
          const inner = unwrapResponse(data);
          const rows = (inner.dataSet as Record<string, unknown>[]) || [];
          const match = rows.find((r) => r.cidrBlock === cidr);
          if (match) {
            cidrRow = match;
            break;
          }
        } catch { /* try next region */ }
      }

      if (!cidrRow && rawCidr !== cidr) {
        for (const rid of regionsToSearch) {
          try {
            const data = await zecCall(
              "DescribeCidrs",
              { cidrBlock: rawCidr, regionId: rid, pageSize: 20, pageNum: 1 },
              accessKeyId, secret, ver
            );
            const inner = unwrapResponse(data);
            const rows = (inner.dataSet as Record<string, unknown>[]) || [];
            const match = rows.find((r) => r.cidrBlock === rawCidr);
            if (match) {
              cidrRow = match;
              break;
            }
          } catch { /* try next region */ }
        }
      }

      if (!cidrRow) {
        yield { type: "log", level: "warn", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 未找到对应 CIDR，跳过` };
        yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, dryRun: opts.dryRun, deleted: false, message: "未找到 CIDR" };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "error" };
        continue;
      }

      const cidrId = String(cidrRow.cidrId ?? "");
      const status = String(cidrRow.status ?? "");
      const regionId = String(cidrRow.regionId ?? "");
      const usedCount = Number(cidrRow.usedCount ?? (cidrRow as any).used_count ?? 0);
      const totalCount = Number(cidrRow.totalCount ?? (cidrRow as any).total_count ?? 0);

      yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 找到 cidrId=${cidrId} regionId=${regionId} status=${status} 已用EIP=${usedCount}/${totalCount}` };

      if (!cidrId) throw new Error("响应缺少 cidrId");

      if (status === "CREATE_FAILED") {
        const skipMsg = `该 CIDR 状态为 CREATE_FAILED（创建失败），无法删除，请在 Zenlayer 控制台手动处理。`;
        yield { type: "log", level: "warn", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ${skipMsg}` };
        yield { type: "segment_skipped", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId, usedCount: 0, message: skipMsg };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "skipped" };
        continue;
      }

      if (usedCount > 0) {
        const skipMsg = `该 CIDR 仍有 ${usedCount} 个已分配 EIP，无法删除。请先在「EIP 删除」中释放后再操作。`;
        yield { type: "log", level: "warn", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ${skipMsg}` };
        yield { type: "segment_skipped", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId, usedCount, message: skipMsg };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "skipped" };
        continue;
      }

      yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "deleting" };

      if (opts.dryRun) {
        yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] [演练] 将调用 ZEC DeleteCidr cidrId=${cidrId}` };
        yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId, dryRun: true, deleted: false, message: "演练模式未实际删除" };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "done" };
        continue;
      }

      const del = await zecCall("DeleteCidr", { cidrId }, accessKeyId, secret, ver);
      unwrapResponse(del);
      yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ZEC DeleteCidr 成功 cidrId=${cidrId}` };
      yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId, dryRun: false, deleted: true };
      yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "done" };

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      yield { type: "log", level: "error", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ${msg}` };
      yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, dryRun: opts.dryRun, deleted: false, message: msg };
      yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "error" };
    }
  }
}
