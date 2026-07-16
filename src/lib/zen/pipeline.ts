import { resolveBandwidthClusterId } from "./bandwidth";
import { apiVersion, loadZenConfig } from "./credentials";
import { describeCidrRow } from "./describe-cidr";
import { extractPublicIpFromEipApiRow } from "./eip-public-ip";
import {
  collectExistingEipPublicIpsInCidr,
  eipResumeScanEnabled,
} from "./eip-scan-cidr";
import { chunk, eipSequentialName, iterEipHostIps } from "./iputil";
import type { PipelineRequest, ProgressEvent } from "./types";
import { parseCreateEipsReturnedIds, unwrapResponse, zecCall } from "./zenlayer";

/** ?????????????? EIP????????? */
const BATCH_SIZE = 254;
const POLL_MAX = 360;
const POLL_SEC = 5;

/** BandwidthCluster ???????? bandwidth?Mbps??? cidrId ????? networkLineType */
function eipBandwidthMbps(): number {
  const n = Number(process.env.ZENLAYER_EIP_BANDWIDTH_MBPS?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  return 10_000;
}

function eipMinLastOctet(): number {
  const raw = process.env.ZENLAYER_EIP_MIN_LAST_OCTET?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 255) return 0;
  return Math.floor(n);
}

/** ?? CreateEips ? amount????? 100?????????????? 1 ??????? */
function eipCreateMaxAmount(): number {
  const n = Number(process.env.ZENLAYER_CREATE_EIPS_MAX_AMOUNT?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.min(500, Math.floor(n));
  return 100;
}

/** ? DescribeCidrs totalCount-usedCount ??????????? */
function eipCapByCidrQuota(): boolean {
  const v = process.env.ZENLAYER_EIP_CAP_BY_CIDR_QUOTA?.trim().toLowerCase();
  if (v === undefined || v === "") return true;
  return !["0", "false", "no", "off"].includes(v);
}

/**
 * ???????????? DescribeEips?????????????? DescribeCidrs??
 * ?????????????????? + ?? + ???????? 0 ???????????
 */
function eipFastTryFirst(): boolean {
  const v = process.env.ZENLAYER_EIP_FAST_TRY?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

function cidrAvailableSlots(row: Record<string, unknown>): number | null {
  const t = row.totalCount;
  const u = row.usedCount;
  if (t === undefined || t === null || u === undefined || u === null) return null;
  const ti = Number(t);
  const ui = Number(u);
  if (!Number.isFinite(ti) || !Number.isFinite(ui)) return null;
  return Math.max(0, Math.floor(ti - ui));
}

function formatCidrInsufficientHint(message: string): string {
  if (
    message.includes("OPERATION_DENIED_CIDR_IP_INSUFFICIENT") ||
    message.includes("CIDR_IP_INSUFFICIENT")
  ) {
    return (
      `${message}\n` +
      "???? CIDR ??????? IP ????????????? DescribeCidrs ??????????????????????????"
    );
  }
  return message;
}

function isCidrInsufficientError(message: string): boolean {
  const s = message.toUpperCase();
  return (
    s.includes("CIDR_IP_INSUFFICIENT") ||
    s.includes("OPERATION_DENIED_CIDR_IP_INSUFFICIENT")
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** ???? eipId ???? IP???? publicIp ???/???? */
async function describeEipsPublicByIds(
  regionId: string,
  eipIds: string[],
  ak: string,
  sk: string,
  ver: string
): Promise<string[]> {
  if (!eipIds.length) return [];
  const data = await zecCall(
    "DescribeEips",
    {
      regionId,
      eipIds,
      pageSize: Math.min(1000, Math.max(20, eipIds.length)),
      pageNum: 1,
    },
    ak,
    sk,
    ver
  );
  const inner = unwrapResponse(data);
  const rows = (inner.dataSet as Record<string, unknown>[]) || [];
  const byId = new Map<string, string>();
  for (const r of rows) {
    const id = String(r.eipId ?? "");
    const ip = extractPublicIpFromEipApiRow(r as Record<string, unknown>);
    if (id && ip) byId.set(id, ip);
  }
  return eipIds.map((id) => byId.get(id) || "");
}

export async function* runPipeline(
  opts: PipelineRequest,
  accessKeyId: string,
  secret: string
): AsyncGenerator<ProgressEvent> {
  const ver = apiVersion();
  const cfg = loadZenConfig();
  const envCluster = cfg?.bandwidthClusterId?.trim() || process.env.ZENLAYER_BANDWIDTH_CLUSTER_ID?.trim();

  const jobs = opts.jobs;
  if (!jobs.length) {
    yield { type: "error", message: "??????? IP ???" };
    return;
  }

  for (let ji = 0; ji < jobs.length; ji++) {
    const job = jobs[ji];
    yield {
      type: "job_start",
      index: ji,
      total: jobs.length,
      cidr: job.cidrBlock,
    };

    yield {
      type: "step",
      step: "resolve_cluster",
      title: "???????",
      detail:
        "DescribeSubnetRegions ???? ? DescribeBandwidthClusters ??**??**?????????????????? CreateBandwidthCluster",
    };

    const clusterId = await resolveBandwidthClusterId(
      job,
      job.regionId,
      envCluster,
      accessKeyId,
      secret,
      ver
    );
    yield {
      type: "log",
      level: "info",
      message: `???????? clusterId=${clusterId}?BandwidthCluster?CreateEips ? bandwidth=${eipBandwidthMbps()}Mbps?? cidrId ????? networkLineType?`,
    };

    if (opts.dryRun) {
      yield {
        type: "log",
        level: "info",
        message: `[Dry-run] ?? CreateByoip / CreateEips???? EIP ???: ${[
          ...iterEipHostIps(job.cidrBlock, eipMinLastOctet()),
        ].length}`,
      };
      yield { type: "job_done", index: ji, cidr: job.cidrBlock };
      continue;
    }

    if (!opts.skipByoip) {
      yield {
        type: "step",
        step: "create_byoip",
        title: "?? BYOIP",
        detail: "CreateByoip ? ?? CIDR ?? AVAILABLE",
      };
      try {
        const cr = await zecCall(
          "CreateByoip",
          {
            byoipList: [
              {
                cidrBlock: job.cidrBlock,
                networkType: job.networkType,
                regionId: job.regionId,
                asn: job.asn,
              },
            ],
          },
          accessKeyId,
          secret,
          ver
        );
        const inner = unwrapResponse(cr);
        const rpki = (inner.rpkiFailedList as string[]) || [];
        const irr = (inner.irrFailedList as string[]) || [];
        if (rpki.length || irr.length) {
          throw new Error(`BYOIP ???? RPKI=${JSON.stringify(rpki)} IRR=${JSON.stringify(irr)}`);
        }
        yield {
          type: "log",
          level: "info",
          message: `CreateByoip ??? byoipIds=${JSON.stringify(inner.byoipIds)}`,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("INVALID_BYOIP_IS_ALREADY_EXIST")) {
          yield {
            type: "log",
            level: "info",
            message:
              "CreateByoip ??????????????INVALID_BYOIP_IS_ALREADY_EXIST??????? CIDR ????? EIP??????????????????",
          };
        } else {
          throw e;
        }
      }
    } else {
      yield {
        type: "step",
        step: "skip_byoip",
        title: "????",
        detail: "?? CIDR ??????? AVAILABLE",
      };
    }

    yield {
      type: "step",
      step: "wait_cidr",
      title: "?? CIDR ??",
      detail: `?? DescribeCidrs??? ${POLL_MAX} ?`,
    };

    let cidrRow: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= POLL_MAX; attempt++) {
      cidrRow = await describeCidrRow(
        job.cidrBlock,
        job.regionId,
        accessKeyId,
        secret,
        ver
      );
      const status = cidrRow ? String(cidrRow.status ?? "") : "";
      if (cidrRow && status === "AVAILABLE") break;
      if (status === "FAILED") {
        throw new Error(`CIDR ????: ${JSON.stringify(cidrRow)}`);
      }
      yield {
        type: "cidr_poll",
        attempt,
        max: POLL_MAX,
        status: status || "????",
      };
      await sleep(POLL_SEC * 1000);
    }

    if (!cidrRow || cidrRow.status !== "AVAILABLE") {
      throw new Error("?? CIDR AVAILABLE ??");
    }

    const cidrId = String(cidrRow.cidrId ?? "");
    if (!cidrId) throw new Error("?? cidrId");

    yield {
      type: "cidr_ready",
      cidrId,
      totalCount: cidrRow.totalCount as number | undefined,
      usedCount: cidrRow.usedCount as number | undefined,
    };

    const allHosts = [...iterEipHostIps(job.cidrBlock, eipMinLastOctet())];
    if (!allHosts.length) throw new Error("????? IP");
    const hostIndex = new Map(allHosts.map((ip, i) => [ip, i] as const));
    const seqFor = (ip: string) => hostIndex.get(ip) ?? 0;

    pathRetry: for (let modeTry = 0; ; modeTry++) {
      const useFastPath = eipFastTryFirst() && modeTry === 0;

      let ips: string[];
      if (useFastPath) {
        yield {
          type: "log",
          level: "info",
          message:
            "??????? DescribeEips ??????????? CreateEips??????? DescribeCidrs??????????????????",
        };
        ips = [...allHosts];
      } else {
        ips = [...allHosts];
        if (eipResumeScanEnabled()) {
          yield {
            type: "log",
            level: "info",
            message:
              "????????? DescribeEips ??????????? IP??? EIP ??????????????? CreateEips??",
          };
          try {
            const existing = await collectExistingEipPublicIpsInCidr(
              job.regionId,
              job.cidrBlock,
              accessKeyId,
              secret,
              ver
            );
            if (existing.size > 0) {
              ips = allHosts.filter((ip) => !existing.has(ip));
              yield {
                type: "log",
                level: "info",
                message: `???DescribeEips ????????? ${existing.size} ????? IP??????? ${ips.length} ???????????? DescribeCidrs ?????`,
              };
            }
          } catch (e) {
            yield {
              type: "log",
              level: "warn",
              message: `DescribeEips ??????????????? CIDR ?????${e instanceof Error ? e.message : String(e)}`,
            };
            ips = allHosts;
          }
        }

        if (eipCapByCidrQuota()) {
          const avail = cidrAvailableSlots(cidrRow);
          if (avail !== null) {
            yield {
              type: "log",
              level: "info",
              message: `DescribeCidrs ??: totalCount=${String(cidrRow.totalCount)} usedCount=${String(cidrRow.usedCount)} ?????? ${avail}?????? ${ips.length} ?`,
            };
            if (avail === 0) {
              yield {
                type: "log",
                level: "warn",
                message: "?????? 0????? CreateEips",
              };
              yield { type: "job_done", index: ji, cidr: job.cidrBlock };
              break pathRetry;
            }
            if (ips.length > avail) {
              yield {
                type: "log",
                level: "info",
                message: `??????????? ${ips.length} ??? ${avail}`,
              };
              ips = ips.slice(0, avail);
            }
          } else {
            yield {
              type: "log",
              level: "info",
              message:
                "DescribeCidrs ??? totalCount/usedCount?????????????????",
            };
          }
        }

        if (!ips.length) {
          yield {
            type: "log",
            level: "warn",
            message:
              "???????????????? IP????? CreateEips?????????",
          };
          yield { type: "job_done", index: ji, cidr: job.cidrBlock };
          break pathRetry;
        }
      }

      const refreshCidrBeforeBatch = !useFastPath;
      const batches = chunk(ips, BATCH_SIZE);
      const maxAmt = eipCreateMaxAmount();
      yield {
        type: "step",
        step: "create_eips",
        title: "?????? IPv4",
        detail: `? ${ips.length} ?????${eipMinLastOctet()}???? CreateEips amount?${maxAmt}?ZENLAYER_CREATE_EIPS_MAX_AMOUNT??${useFastPath ? "????" : "????"}?cidrId+BandwidthCluster??? ${eipBandwidthMbps()}Mbps`,
      };

      let done = 0;
      try {
        for (let bi = 0; bi < batches.length; bi++) {
          const batch = batches[bi];
          const firstName = eipSequentialName(job.cidrBlock, seqFor(batch[0]!));
          const lastName = eipSequentialName(
            job.cidrBlock,
            seqFor(batch[batch.length - 1]!)
          );

          yield {
            type: "eip_batch",
            batchIndex: bi + 1,
            batchTotal: batches.length,
            firstName,
            lastName,
            count: batch.length,
          };

          let offsetInBatch = 0;
          while (offsetInBatch < batch.length) {
            let sub = batch.slice(offsetInBatch, offsetInBatch + maxAmt);
            const idxFirst = seqFor(sub[0]!);

            if (eipCapByCidrQuota() && refreshCidrBeforeBatch) {
              const rowFresh = await describeCidrRow(
                job.cidrBlock,
                job.regionId,
                accessKeyId,
                secret,
                ver
              );
              if (rowFresh) {
                const availNow = cidrAvailableSlots(rowFresh);
                if (availNow !== null) {
                  if (availNow === 0) {
                    yield {
                      type: "log",
                      level: "warn",
                      message:
                        "DescribeCidrs ???????? 0?? /24 ???????????",
                    };
                    break;
                  }
                  if (sub.length > availNow) {
                    yield {
                      type: "log",
                      level: "info",
                      message: `??? DescribeCidrs ?? ${availNow}????? ${sub.length} ?? ${availNow}`,
                    };
                    sub = sub.slice(0, availNow);
                  }
                }
              }
            }

            if (sub.length === 0) break;

            const seqName = eipSequentialName(job.cidrBlock, idxFirst);

            for (let j = 0; j < sub.length; j++) {
              yield {
                type: "eip_attempt",
                current: done + j + 1,
                total: ips.length,
                ip: sub[j]!,
                name: eipSequentialName(job.cidrBlock, seqFor(sub[j]!)),
              };
            }

            let attempt = sub;
            let eipIds: string[] = [];
            for (;;) {
              const lo = seqFor(attempt[0]!) + 1;
              const hi = seqFor(attempt[attempt.length - 1]!) + 1;
              yield {
                type: "log",
                level: "info",
                message: `CreateEips ????? ${lo}?${hi} / ?? ${ips.length} name=${seqName} amount=${attempt.length}??? publicIp?`,
              };
              try {
                const createRes = await zecCall(
                  "CreateEips",
                  {
                    regionId: job.regionId,
                    name: seqName,
                    amount: attempt.length,
                    internetChargeType: "BandwidthCluster",
                    bandwidth: eipBandwidthMbps(),
                    cidrId,
                    clusterId,
                  },
                  accessKeyId,
                  secret,
                  ver,
                  120_000
                );
                eipIds = parseCreateEipsReturnedIds(createRes, attempt.length);
                break;
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!isCidrInsufficientError(msg) || attempt.length <= 1) {
                  throw new Error(formatCidrInsufficientHint(msg));
                }
                const row2 = await describeCidrRow(
                  job.cidrBlock,
                  job.regionId,
                  accessKeyId,
                  secret,
                  ver
                );
                const a2 = row2 ? cidrAvailableSlots(row2) : null;
                const nextLen =
                  a2 !== null
                    ? Math.min(Math.max(0, a2), attempt.length - 1)
                    : Math.max(1, Math.floor(attempt.length / 2));
                if (nextLen < 1) {
                  throw new Error(formatCidrInsufficientHint(msg));
                }
                yield {
                  type: "log",
                  level: "warn",
                  message: `CreateEips ????????? ${attempt.length} ?? ${nextLen} ???`,
                };
                attempt = attempt.slice(0, nextLen);
              }
            }

            if (eipIds.length === 0) break;

            const resolved = await describeEipsPublicByIds(
              job.regionId,
              eipIds,
              accessKeyId,
              secret,
              ver
            );
            for (let j = 0; j < eipIds.length; j++) {
              done += 1;
              const plannedIp = attempt[j]!;
              const ip = resolved[j] || plannedIp;
              yield {
                type: "eip_progress",
                current: done,
                total: ips.length,
                ip,
                name: eipSequentialName(job.cidrBlock, seqFor(plannedIp)),
              };
            }

            if (eipIds.length < attempt.length) {
              yield {
                type: "log",
                level: "warn",
                message: `CreateEips ???? ${eipIds.length}/${attempt.length}????????????`,
              };
            }

            offsetInBatch += eipIds.length;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (useFastPath) {
          yield {
            type: "log",
            level: "warn",
            message: `??????????${msg}???? DescribeEips ??????????????? EIP ????????`,
          };
          continue pathRetry;
        }
        throw e;
      }

      yield { type: "job_done", index: ji, cidr: job.cidrBlock };
      break pathRetry;
    }
  }

  yield { type: "pipeline_done" };
}
