import { apiVersion } from "./credentials";
import { normalizeIpv4Cidr, parseUserIpSegment } from "./iputil";
import type { BmcByoipAnnounceRequest, ByoipAnnounceEvent } from "./types";
import { unwrapResponse, bmcCall } from "./zenlayer";

const POLL_MAX = 360;
const POLL_SEC = 5;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeCidr(raw: string): string {
  const t = raw.trim();
  return parseUserIpSegment(t)?.displayCidr ?? normalizeIpv4Cidr(t) ?? t;
}

/**
 * VOB 宣告（BMC）：
 * 每个 job 含一个 cidrBlock 和多个 zone-VLAN 对（zones[]）。
 * 每个 zone 独立调用 BMC CreateByoip，参数：cidr, asn, ipType, publicVirtualInterfaceId。
 * 宣告是异步的，CreateByoip 成功后 CIDR 将在控制台的对应 zone 显示。
 */
export async function* runByoipAnnounce(
  opts: BmcByoipAnnounceRequest,
  accessKeyId: string,
  secret: string
): AsyncGenerator<ByoipAnnounceEvent> {
  const ver = apiVersion();
  const jobs = opts.jobs;
  if (!jobs.length) {
    yield { type: "error", message: "请至少填写一条 VOB 宣告任务" };
    return;
  }

  for (let ji = 0; ji < jobs.length; ji++) {
    const job = jobs[ji];
    const cidr = normalizeCidr(job.cidrBlock);
    const zones = job.zones || [];

    yield { type: "job_start", index: ji, total: jobs.length, cidr };

    if (!zones.length) {
      yield { type: "log", level: "warn", message: `[任务 ${ji + 1}] ${cidr} 未配置任何可用区，跳过` };
      yield { type: "job_done", index: ji, cidr };
      continue;
    }

    if (opts.dryRun) {
      for (const z of zones) {
        yield {
          type: "log",
          level: "info",
          message: `[演练] BMC CreateByoip：cidr=${cidr} asn=${job.asn} zoneId=${z.zoneId} publicVirtualInterfaceId=${z.publicVirtualInterfaceId}`,
        };
      }
      yield { type: "job_done", index: ji, cidr };
      continue;
    }

    yield {
      type: "step",
      step: "create_byoip",
      title: `VOB 宣告（${zones.length} 个可用区）`,
      detail: zones.map((z) => z.zoneId).join(", "),
    };

    let allOk = true;
    for (const z of zones) {
      yield {
        type: "log",
        level: "info",
        message: `[任务 ${ji + 1} ${cidr}] 宣告到 zoneId=${z.zoneId} pviId=${z.publicVirtualInterfaceId}`,
      };
      try {
        const cr = await bmcCall(
          "CreateByoip",
          {
            cidr,
            asn: job.asn,
            ipType: job.ipType ?? "IPV4",
            publicVirtualInterfaceId: z.publicVirtualInterfaceId,
          },
          accessKeyId,
          secret,
          ver
        );
        const inner = unwrapResponse(cr);
        yield {
          type: "log",
          level: "info",
          message: `  ✓ zoneId=${z.zoneId} byoipId=${inner.byoipId ?? "-"} cidrBlockId=${inner.cidrBlockId ?? "-"}`,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.includes("OPERATION_DENIED_BYOIP_DUPLICATED") ||
          msg.includes("INVALID_BYOIP_IS_ALREADY_EXIST")
        ) {
          yield {
            type: "log",
            level: "info",
            message: `  ⚠ zoneId=${z.zoneId} 已存在（跳过）`,
          };
        } else {
          yield {
            type: "log",
            level: "error",
            message: `  ✗ zoneId=${z.zoneId} 失败：${msg}`,
          };
          allOk = false;
        }
      }
    }

    if (!allOk) {
      yield { type: "error", message: `任务 ${ji + 1} ${cidr} 部分可用区宣告失败，请查看日志` };
    }

    // CreateByoip 是异步 API，无需轮询 CIDR 状态，宣告提交即完成
    yield {
      type: "log",
      level: "info",
      message: `[任务 ${ji + 1} ${cidr}] 所有可用区 CreateByoip 已提交，CIDR 将在控制台异步就绪`,
    };
    yield { type: "job_done", index: ji, cidr };
  }

  yield { type: "pipeline_done" };
}
