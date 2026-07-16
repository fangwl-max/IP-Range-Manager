import { extractPublicIpFromEipApiRow } from "./eip-public-ip";
import {
  chunk,
  countAssignableHostSlots,
  describeEipsNameHintFromDisplayCidr,
  parseUserIpSegment,
} from "./iputil";
import type { EipDeleteEvent, EipDeleteRequest, EipDeleteTask } from "./types";
import { unwrapResponse, zecCall } from "./zenlayer";

function eipListPageSize(): number {
  const n = Number(process.env.ZENLAYER_EIP_LIST_PAGE_SIZE?.trim());
  if (Number.isFinite(n) && n >= 10) return Math.min(500, Math.floor(n));
  return 100;
}

function eipListMaxPages(): number {
  const n = Number(process.env.ZENLAYER_EIP_LIST_MAX_PAGES?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.min(500, Math.floor(n));
  return 40;
}

function eipListPageTimeoutMs(): number {
  const n = Number(process.env.ZENLAYER_EIP_LIST_PAGE_TIMEOUT_MS?.trim());
  if (Number.isFinite(n) && n >= 5000) return Math.min(120_000, Math.floor(n));
  return 45_000;
}

function eipDeleteConcurrency(): number {
  const n = Number(process.env.ZENLAYER_EIP_DELETE_CONCURRENCY?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.min(32, Math.floor(n));
  return 16;
}

function eipDeleteRetryDelayMs(): number {
  const n = Number(process.env.ZENLAYER_EIP_DELETE_RETRY_DELAY_MS?.trim());
  if (Number.isFinite(n) && n >= 0) return Math.min(120_000, Math.floor(n));
  return 2500;
}

/** ? 1 ???????????????? DescribeEips?????????? */
function eipDeleteListRound2(): boolean {
  return process.env.ZENLAYER_EIP_DELETE_LIST_ROUND2?.trim() === "1";
}

function eipListMergeFullAfterName(): boolean {
  return process.env.ZENLAYER_EIP_LIST_MERGE_FULL_AFTER_NAME?.trim() === "1";
}

function eipUnbindChunkSize(): number {
  const n = Number(process.env.ZENLAYER_EIP_UNBIND_CHUNK_SIZE?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.min(100, Math.floor(n));
  return 40;
}

function eipUnbindSettleMs(): number {
  const n = Number(process.env.ZENLAYER_EIP_UNBIND_SETTLE_MS?.trim());
  if (Number.isFinite(n) && n >= 0) return Math.min(60_000, Math.floor(n));
  return 2500;
}

function eipDeleteMaxRounds(): number {
  const n = Number(process.env.ZENLAYER_EIP_DELETE_MAX_ROUNDS?.trim());
  if (Number.isFinite(n) && n >= 1) return Math.min(30, Math.floor(n));
  return 10;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** ? pipeline ???????????? EIP????? */
function eipMinLastOctet(): number {
  const raw = process.env.ZENLAYER_EIP_MIN_LAST_OCTET?.trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 255) return 0;
  return Math.floor(n);
}

export type EipInCidrRow = {
  eipId: string;
  publicIp: string;
  name: string;
  status: string;
  associatedId: string;
  /** DescribeEips EipInfo.isDefault??? EIP ???? */
  isDefault: boolean;
};

function parseEipRow(r: Record<string, unknown>): EipInCidrRow | null {
  const eipId = String(
    r.eipId ?? r.eip_id ?? ""
  ).trim();
  if (!eipId) return null;
  const publicIp = extractPublicIpFromEipApiRow(r);
  const name = String(r.name ?? "").trim() || eipId;
  const status = String(r.status ?? "").trim();
  const associatedId = String(
    r.associatedId ??
      r.associated_id ??
      r.nicId ??
      r.nic_id ??
      ""
  ).trim();
  const isDefault = Boolean(r.isDefault ?? r.is_default);
  return { eipId, publicIp, name, status, associatedId, isDefault };
}

/** ????????????? DeleteEip */
function isEipUnboundForDelete(row: EipInCidrRow): boolean {
  if (row.associatedId) return false;
  const s = row.status.toUpperCase();
  if (s === "BINDED" || s === "BINDING" || s === "ASSOCIATING") return false;
  return true;
}

export type EipListPageYield =
  | {
      kind: "page";
      regionId: string;
      page: number;
      maxPages: number;
      pageSize: number;
      /** ?? dataSet ?? */
      apiRowCount: number;
      /** ??????? IP ?? cidrBlock ??????????????? */
      matchedInCidr: number;
      cap: number | null;
      /** DescribeEips ??? totalCount?????????? EIP ?????????? */
      apiTotalCount: number | null;
      /** ??? DescribeEips ????????? */
      describeListPass?: 1 | 2;
      /** name=??????all=? name ???DescribeEips ??? */
      describeListFilter?: "name" | "all";
    }
  | { kind: "done"; rows: EipInCidrRow[] };

/**
 * ?? DescribeEips?????? yield ?? page????????????????
 * @param maxMatches ?? CIDR ????????? /24?254??????????????
 */
export async function* iterateListEipsInCidrPages(
  regionId: string,
  matchPublicIp: (ip: string) => boolean,
  ak: string,
  sk: string,
  ver: string,
  maxMatches: number | null,
  describeNameHint: string | null = null
): AsyncGenerator<EipListPageYield> {
  const pageSize = eipListPageSize();
  const maxPages = eipListMaxPages();
  const timeoutMs = eipListPageTimeoutMs();
  const out: EipInCidrRow[] = [];
  const seen = new Set<string>();
  const hint = describeNameHint?.trim() || null;

  const runPass = async function* (
    listPass: 1 | 2,
    extra: Record<string, unknown>,
    describeListFilter: "name" | "all"
  ): AsyncGenerator<EipListPageYield> {
    for (let page = 1; page <= maxPages; page++) {
      if (maxMatches !== null && out.length >= maxMatches) break;

      const data = await zecCall(
        "DescribeEips",
        { regionId, pageNum: page, pageSize, ...extra },
        ak,
        sk,
        ver,
        timeoutMs
      );
      const inner = unwrapResponse(data);
      const rows = (inner.dataSet as Record<string, unknown>[]) || [];
      const totalRaw = Number(inner.totalCount ?? inner.total ?? 0);
      const apiTotalCount =
        Number.isFinite(totalRaw) && totalRaw > 0 ? Math.floor(totalRaw) : null;

      if (!rows.length) {
        yield {
          kind: "page",
          regionId,
          page,
          maxPages,
          pageSize,
          apiRowCount: 0,
          matchedInCidr: out.length,
          cap: maxMatches,
          apiTotalCount,
          describeListPass: listPass,
          describeListFilter,
        };
        break;
      }

      for (const r of rows) {
        if (maxMatches !== null && out.length >= maxMatches) break;
        const row = parseEipRow(r);
        if (!row?.publicIp || !matchPublicIp(row.publicIp)) continue;
        if (seen.has(row.eipId)) continue;
        seen.add(row.eipId);
        out.push(row);
      }

      yield {
        kind: "page",
        regionId,
        page,
        maxPages,
        pageSize,
        apiRowCount: rows.length,
        matchedInCidr: out.length,
        cap: maxMatches,
        apiTotalCount,
        describeListPass: listPass,
        describeListFilter,
      };

      if (!apiTotalCount && rows.length < pageSize) break;
      if (apiTotalCount !== null && page * pageSize >= apiTotalCount) break;
      if (apiTotalCount !== null && rows.length < pageSize) break;
    }
  };

  const mergeFull = eipListMergeFullAfterName();

  if (hint) {
    for await (const ev of runPass(1, { name: hint }, "name")) {
      yield ev;
    }
    const needFull =
      out.length === 0 ||
      (mergeFull && (maxMatches === null || out.length < maxMatches));
    if (needFull) {
      for await (const ev of runPass(2, {}, "all")) {
        yield ev;
      }
    }
  } else {
    for await (const ev of runPass(1, {}, "all")) {
      yield ev;
    }
  }

  yield { kind: "done", rows: out };
}

/**
 * @param maxMatches ?? CIDR ???????????????? /24?254?????????
 */
export async function listEipsInCidr(
  regionId: string,
  matchPublicIp: (ip: string) => boolean,
  ak: string,
  sk: string,
  ver: string,
  maxMatches: number | null = null,
  describeNameHint: string | null = null
): Promise<EipInCidrRow[]> {
  for await (const y of iterateListEipsInCidrPages(
    regionId,
    matchPublicIp,
    ak,
    sk,
    ver,
    maxMatches,
    describeNameHint
  )) {
    if (y.kind === "done") return y.rows;
  }
  return [];
}

function formatListPageLog(
  roundLabel: string,
  norm: string,
  y: Extract<EipListPageYield, { kind: "page" }>,
  extra: string
): string {
  const totalHint =
    y.apiTotalCount != null
      ? ` ? ???????? API totalCount?${y.apiTotalCount}???? EIP ????????`
      : "";
  return (
    `[delete] ${roundLabel} DescribeEips ???${y.regionId}?` +
    ` ?? ${y.page}/${y.maxPages}??? ${y.pageSize}?` +
    ` ? ?? dataSet ${y.apiRowCount} ?${totalHint}` +
    ` ? ???? ${norm} ???? ${y.matchedInCidr}` +
    (y.cap != null ? ` / ?????? ${y.cap}` : "") +
    (y.describeListFilter === "name"
      ? ` ? name ???DescribeEips?`
      : y.describeListFilter === "all"
        ? ` ? ????`
        : "") +
    (extra ? ` ? ${extra}` : "")
  );
}

/** ??????????????????? */
async function* forwardSegmentListOnce(
  segmentIndex: number,
  segmentTotal: number,
  reg: string,
  scanRegionIds: string[],
  matchPublicIp: (ip: string) => boolean,
  norm: string,
  describeNameHint: string | null,
  ak: string,
  sk: string,
  ver: string,
  cap: number | null,
  roundLabel: string,
  roundNum: 1 | 2
): AsyncGenerator<EipDeleteEvent, EipInCidrRow[]> {
  if (reg) {
    for await (const y of iterateListEipsInCidrPages(
      reg,
      matchPublicIp,
      ak,
      sk,
      ver,
      cap,
      describeNameHint
    )) {
      if (y.kind === "page") {
        yield {
          type: "log",
          level: "info",
          message: formatListPageLog(roundLabel, norm, y, "?????"),
        };
        yield {
          type: "segment_scan_progress",
          segmentIndex,
          segmentTotal,
          cidr: norm,
          round: roundNum,
          regionId: y.regionId,
          regionOrdinal: 1,
          regionTotal: 1,
          page: y.page,
          maxPages: y.maxPages,
          matched: y.matchedInCidr,
          cap,
          mergedTotal: null,
        };
      } else {
        return y.rows;
      }
    }
    return [];
  }

  const merged = new Map<string, EipInCidrRow>();
  for (let ri = 0; ri < scanRegionIds.length; ri++) {
    const rid = scanRegionIds[ri]!;
    if (cap !== null && merged.size >= cap) {
      yield {
        type: "log",
        level: "info",
        message: `[delete] ${roundLabel} ?????????????? ${cap}????? ${scanRegionIds.length - ri} ???`,
      };
      break;
    }
    const remain =
      cap !== null ? Math.max(0, cap - merged.size) : null;

    yield {
      type: "log",
      level: "info",
      message: `[delete] ${roundLabel} ??? ${ri + 1}/${scanRegionIds.length}??????${rid}??`,
    };

    for await (const y of iterateListEipsInCidrPages(
      rid,
      matchPublicIp,
      ak,
      sk,
      ver,
      remain,
      describeNameHint
    )) {
      if (y.kind === "page") {
        const mergedTotal = merged.size + y.matchedInCidr;
        yield {
          type: "log",
          level: "info",
          message: formatListPageLog(
            roundLabel,
            norm,
            y,
            `????? ${ri + 1}/${scanRegionIds.length} ? ??????? ${mergedTotal}`
          ),
        };
        yield {
          type: "segment_scan_progress",
          segmentIndex,
          segmentTotal,
          cidr: norm,
          round: roundNum,
          regionId: y.regionId,
          regionOrdinal: ri + 1,
          regionTotal: scanRegionIds.length,
          page: y.page,
          maxPages: y.maxPages,
          matched: y.matchedInCidr,
          cap,
          mergedTotal,
        };
      } else {
        for (const row of y.rows) merged.set(row.eipId, row);
      }
    }
  }

  return [...merged.values()];
}

/** ?????????????????????????? */
function segmentAssignableCap(normCidr: string): number | null {
  try {
    const n = countAssignableHostSlots(normCidr, eipMinLastOctet());
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function* runOneSegment(
  segmentIndex: number,
  segmentTotal: number,
  task: EipDeleteTask,
  scanRegionIds: string[],
  dryRun: boolean,
  unbindBeforeDelete: boolean,
  ak: string,
  sk: string,
  ver: string
): AsyncGenerator<EipDeleteEvent> {
  const rawCidr = task.cidrBlock.trim();
  const seg = parseUserIpSegment(rawCidr);
  if (!seg) {
    yield {
      type: "error",
      message: `? ${segmentIndex + 1} ?????????${rawCidr}????? 203.0.113?203.0.113.0?203.0.113.0/24`,
    };
    return;
  }
  const { displayCidr: norm, matchPublicIp } = seg;
  const describeNameHint = describeEipsNameHintFromDisplayCidr(norm);

  const reg = task.regionId.trim();
  if (!reg && scanRegionIds.length === 0) {
    yield {
      type: "error",
      message: `? ${segmentIndex + 1} ??????????????????????`,
    };
    return;
  }

  const regionHint = reg
    ? reg
    : `??????? ${scanRegionIds.length} ???????`;
  yield {
    type: "log",
    level: "info",
    message: `[delete] ?? ? ${segmentIndex + 1}/${segmentTotal} ??${norm} @ ${regionHint} ??`,
  };

  let rows: EipInCidrRow[];
  try {
    const cap = segmentAssignableCap(norm);
    if (cap !== null) {
      yield {
        type: "log",
        level: "info",
        message: `[delete] ??????? ${cap} ???????????????????????? x/y??????? DescribeEips ???????????ZENLAYER_EIP_MIN_LAST_OCTET ???????`,
      };
    }

    yield {
      type: "segment_phase",
      segmentIndex,
      segmentTotal,
      cidr: norm,
      phase: "listing",
    };

    const gen1 = forwardSegmentListOnce(
      segmentIndex,
      segmentTotal,
      reg,
      scanRegionIds,
      matchPublicIp,
      norm,
      describeNameHint,
      ak,
      sk,
      ver,
      cap,
      "?1?",
      1
    );
    while (true) {
      const n = await gen1.next();
      if (n.done) {
        rows = n.value;
        break;
      }
      yield n.value;
    }

    yield {
      type: "log",
      level: "info",
      message: `[delete] ? 1 ???????? ${norm} ? EIP ? ${rows.length} ?${cap !== null ? `????? ${cap}?` : ""}`,
    };

    if (eipDeleteListRound2() && cap !== null && rows.length < cap) {
      yield {
        type: "log",
        level: "info",
        message: `[delete] ??? ZENLAYER_EIP_DELETE_LIST_ROUND2=1??????? 2 ?????????`,
      };
      const gen2 = forwardSegmentListOnce(
        segmentIndex,
        segmentTotal,
        reg,
        scanRegionIds,
        matchPublicIp,
        norm,
        describeNameHint,
        ak,
        sk,
        ver,
        cap,
        "?2?",
        2
      );
      let second: EipInCidrRow[];
      while (true) {
        const n = await gen2.next();
        if (n.done) {
          second = n.value;
          break;
        }
        yield n.value;
      }
      const map = new Map(rows.map((r) => [r.eipId, r] as const));
      for (const r of second) map.set(r.eipId, r);
      rows = [...map.values()];
      yield {
        type: "log",
        level: "info",
        message: `[delete] ? 2 ?????? ${rows.length} ?`,
      };
    }
  } catch (e) {
    yield {
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    };
    return;
  }

  let targets = rows.filter((r) => isEipUnboundForDelete(r));
  const bound = rows.filter((r) => !isEipUnboundForDelete(r));

  if (unbindBeforeDelete && bound.length && !dryRun) {
    const defaultRows = bound.filter((r) => r.isDefault);
    for (const r of defaultRows.slice(0, 10)) {
      yield {
        type: "log",
        level: "warn",
        message: `[delete] ?????? EIP?${r.publicIp || "-"} ${r.eipId}`,
      };
    }
    if (defaultRows.length > 10) {
      yield {
        type: "log",
        level: "warn",
        message: `[delete] ? ?? ${defaultRows.length - 10} ??? EIP?????`,
      };
    }

    const toUnbind = bound.filter((r) => !r.isDefault).map((r) => r.eipId);
    if (toUnbind.length) {
      yield {
        type: "segment_phase",
        segmentIndex,
        segmentTotal,
        cidr: norm,
        phase: "unbinding",
      };
      yield {
        type: "log",
        level: "info",
        message: `[delete] ?????? ${toUnbind.length} ??UnassociateEipAddress??`,
      };
      const failedUnbind = new Set<string>();
      const uSize = eipUnbindChunkSize();
      for (const batch of chunk(toUnbind, uSize)) {
        try {
          const data = await zecCall(
            "UnassociateEipAddress",
            { eipIds: batch },
            ak,
            sk,
            ver,
            120_000
          );
          const inner = unwrapResponse(data);
          const raw = inner.failedEipIds ?? inner.failed_eip_ids;
          if (Array.isArray(raw)) {
            for (const id of raw) {
              const s = String(id).trim();
              if (s) failedUnbind.add(s);
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          yield {
            type: "log",
            level: "error",
            message: `[delete] UnassociateEipAddress ?????${msg.slice(0, 400)}`,
          };
          for (const id of batch) failedUnbind.add(id);
        }
      }
      for (const id of failedUnbind) {
        const row = bound.find((x) => x.eipId === id);
        yield {
          type: "log",
          level: "warn",
          message: `[delete] ?????????${row?.publicIp ?? "-"} ${id}`,
        };
      }
      const okIds = new Set(toUnbind.filter((id) => !failedUnbind.has(id)));
      targets = [
        ...targets,
        ...bound.filter((r) => okIds.has(r.eipId)),
      ];
      yield {
        type: "log",
        level: "info",
        message: `[delete] ?????????? ${eipUnbindSettleMs()}ms ??? DeleteEip?`,
      };
      await sleep(eipUnbindSettleMs());
    }
  } else if (unbindBeforeDelete && bound.length && dryRun) {
    const n = bound.filter((r) => !r.isDefault).length;
    yield {
      type: "log",
      level: "info",
      message: `[delete] ????????????????????? ${n} ???? EIP ?? UnassociateEipAddress`,
    };
  }

  const targetIds = new Set(targets.map((t) => t.eipId));
  const skippedRows = rows.filter((r) => !targetIds.has(r.eipId));
  const skippedBound = skippedRows.length;

  yield {
    type: "log",
    level: "info",
    message: `[delete] ????? ${rows.length} ? EIP????? ${targets.length} ???? ${skippedBound} ?`,
  };

  if (!dryRun && targets.length > 0) {
    yield {
      type: "segment_phase",
      segmentIndex,
      segmentTotal,
      cidr: norm,
      phase: "deleting",
    };
  }

  for (const r of skippedRows.slice(0, 20)) {
    const why = r.isDefault
      ? "?? EIP"
      : !unbindBeforeDelete
        ? "?????????????"
        : "?????????";
    yield {
      type: "log",
      level: "warn",
      message: `[delete] ???${r.publicIp || "-"} ${r.eipId} ? ${why}`,
    };
  }
  if (skippedRows.length > 20) {
    yield {
      type: "log",
      level: "warn",
      message: `[delete] ? ?? ${skippedRows.length - 20} ????????`,
    };
  }

  if (dryRun) {
    yield {
      type: "delete_done",
      deleted: 0,
      skippedBound,
      failed: 0,
      dryRun: true,
      deletableCount: targets.length,
      cidr: norm,
      segmentIndex,
      segmentTotal,
    };
    return;
  }

  if (!targets.length) {
    yield {
      type: "delete_done",
      deleted: 0,
      skippedBound,
      failed: 0,
      dryRun: false,
      deletableCount: 0,
      cidr: norm,
      segmentIndex,
      segmentTotal,
    };
    return;
  }

  const conc = eipDeleteConcurrency();
  const delayMs = eipDeleteRetryDelayMs();
  const maxRounds = eipDeleteMaxRounds();
  let deleted = 0;
  let failed = 0;
  let pending = targets.map((t) => t.eipId);

  for (let round = 1; round <= maxRounds && pending.length > 0; round++) {
    if (round > 1) {
      yield {
        type: "log",
        level: "info",
        message: `[delete] ? ${round} ????? ${pending.length} ???? ${delayMs}ms??`,
      };
      await sleep(delayMs);
    }

    const nextPending: string[] = [];
    const idToRow = new Map(targets.map((t) => [t.eipId, t] as const));

    for (let off = 0; off < pending.length; off += conc) {
      const chunk = pending.slice(off, off + conc);
      const results = await Promise.allSettled(
        chunk.map((eipId) =>
          zecCall("DeleteEip", { eipId }, ak, sk, ver, 120_000)
        )
      );

      for (let i = 0; i < chunk.length; i++) {
        const eipId = chunk[i]!;
        const r = results[i]!;
        const row = idToRow.get(eipId);
        const ip = row?.publicIp ?? "";

        if (r.status === "fulfilled") {
          deleted += 1;
          yield {
            type: "delete_progress",
            current: deleted,
            total: targets.length,
            eipId,
            ip,
            segmentIndex,
            segmentTotal,
            cidr: norm,
          };
        } else {
          const msg =
            r.reason instanceof Error ? r.reason.message : String(r.reason);
          const retriable =
            /5\d\d|timeout|超时|ECONNRESET|ETIMEDOUT|fetch failed|AbortError/i.test(
              msg
            );
          if (retriable) {
            nextPending.push(eipId);
            yield {
              type: "log",
              level: "warn",
              message: `[delete] ?????? ${ip} ${eipId}: ${msg.slice(0, 200)}`,
            };
          } else {
            failed += 1;
            yield {
              type: "log",
              level: "error",
              message: `[delete] ????????${ip} ${eipId}: ${msg.slice(0, 400)}`,
            };
          }
        }
      }
    }

    pending = nextPending;
  }

  if (pending.length) {
    failed += pending.length;
    yield {
      type: "log",
      level: "error",
      message: `[delete] ?????? ${maxRounds}??? ${pending.length} ??????`,
    };
  }

  yield {
    type: "delete_done",
    deleted,
    skippedBound,
    failed,
    dryRun: false,
    deletableCount: targets.length,
    cidr: norm,
    segmentIndex,
    segmentTotal,
  };
}

export async function* runEipDelete(
  req: EipDeleteRequest,
  ak: string,
  sk: string
): AsyncGenerator<EipDeleteEvent> {
  const ver = (await import("./credentials")).apiVersion();
  const tasks = req.tasks.filter(
    (t) => t.cidrBlock.trim().length > 0
  );
  if (!tasks.length) {
    yield { type: "error", message: "??????? CIDR" };
    return;
  }

  const scanRegionIds = req.scanRegionIds.filter(Boolean);
  for (const t of tasks) {
    if (!t.regionId.trim() && scanRegionIds.length === 0) {
      yield {
        type: "error",
        message:
          "??????????????????????????????????",
      };
      return;
    }
  }

  const totalSeg = tasks.length;
  for (let i = 0; i < totalSeg; i++) {
    yield* runOneSegment(
      i,
      totalSeg,
      tasks[i]!,
      scanRegionIds,
      req.dryRun,
      Boolean(req.unbindBeforeDelete),
      ak,
      sk,
      ver
    );
  }
}
