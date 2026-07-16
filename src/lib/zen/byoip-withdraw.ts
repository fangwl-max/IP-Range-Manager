import { apiVersion } from "./credentials";
import { describeBmcCidrRow } from "./describe-cidr";
import { normalizeIpv4Cidr, parseUserIpSegment } from "./iputil";
import type { ByoipWithdrawEvent, ByoipWithdrawRequest } from "./types";
import { unwrapResponse, bmcCall } from "./zenlayer";

function normalizeCidr(raw: string): string {
  const t = raw.trim();
  return parseUserIpSegment(t)?.displayCidr ?? normalizeIpv4Cidr(t) ?? t;
}

/**
 * VOB 取消宣告（BMC）
 * 1. DescribeCidrBlocks 查找 cidrBlockId
 * 2. 检查 instanceIds 是否为空，有绑定实例则跳过
 * 3. TerminateCidrBlock 归还/删除 CIDR
 */
export async function* runByoipWithdraw(
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

  for (let i = 0; i < tasks.length; i++) {
    const rawCidr = tasks[i].cidrBlock.trim();
    const cidr = normalizeCidr(rawCidr);

    yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "lookup" };
    yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 查询 BMC DescribeCidrBlocks...` };

    try {
      let cidrRow = await describeBmcCidrRow(cidr, accessKeyId, secret, ver);
      if (!cidrRow && rawCidr !== cidr) {
        cidrRow = await describeBmcCidrRow(rawCidr, accessKeyId, secret, ver);
      }

      if (!cidrRow) {
        yield { type: "log", level: "warn", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 未找到对应 CIDR，跳过` };
        yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, dryRun: opts.dryRun, deleted: false, message: "未找到 CIDR" };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "error" };
        continue;
      }

      const cidrId = String(cidrRow.cidrBlockId ?? cidrRow.cidrId ?? "");
      const status = String(cidrRow.status ?? "");
      const zoneId = String(cidrRow.zoneId ?? "");
      const instanceIds = (cidrRow.instanceIds as string[] | undefined) ?? [];
      const usedCount = instanceIds.length;

      yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] 找到 cidrBlockId=${cidrId} zoneId=${zoneId} status=${status} 绑定实例=${usedCount}` };

      if (!cidrId) throw new Error("响应缺少 cidrBlockId");


      // CREATE_FAILED: 宣告失败，无法通过 TerminateCidrBlock 取消，给出明确提示
      if (status === "CREATE_FAILED") {
        const skipMsg = `该 CIDR 宣告状态为 CREATE_FAILED（宣告失败），无法取消，请在 Zenlayer 控制台手动处理。`;
        yield { type: "log", level: "warn", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ${skipMsg}` };
        yield { type: "segment_skipped", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId: zoneId, usedCount: 0, message: skipMsg };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "skipped" };
        continue;
      }
      // 有绑定实例 → 跳过并提示
      if (usedCount > 0) {
        const skipMsg = `该 CIDR 仍有 ${usedCount} 个绑定实例，无法删除。请先解绑实例再操作。`;
        yield { type: "log", level: "warn", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ${skipMsg}` };
        yield { type: "segment_skipped", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId: zoneId, usedCount, message: skipMsg };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "skipped" };
        continue;
      }

      yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "deleting" };

      if (opts.dryRun) {
        yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] [演练] 将调用 BMC TerminateCidrBlock cidrBlockId=${cidrId}` };
        yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId: zoneId, dryRun: true, deleted: false, message: "演练模式未实际删除" };
        yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "done" };
        continue;
      }

      const del = await bmcCall("TerminateCidrBlock", { cidrBlockId: cidrId }, accessKeyId, secret, ver);
      unwrapResponse(del);
      yield { type: "log", level: "info", message: `[段 ${i + 1}/${tasks.length} ${cidr}] BMC TerminateCidrBlock 成功 cidrBlockId=${cidrId}` };
      yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, cidrId, regionId: zoneId, dryRun: false, deleted: true };
      yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "done" };

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      yield { type: "log", level: "error", message: `[段 ${i + 1}/${tasks.length} ${cidr}] ${msg}` };
      yield { type: "segment_done", segmentIndex: i, segmentTotal: tasks.length, cidr, dryRun: opts.dryRun, deleted: false, message: msg };
      yield { type: "segment_phase", segmentIndex: i, segmentTotal: tasks.length, cidr, phase: "error" };
    }
  }
}