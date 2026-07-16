import type { IPSegment, ProjectGroup, Supplier, UsageAreaOption } from '../types';

type MasterItem = { id: string; name: string };

/** 各类连字符统一为 ASCII `-`，便于与表单/粘贴来源一致 */
function normalizeHyphens(s: string): string {
  return s.replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
}

/**
 * 用于名称对齐的「拉丁骨架」：去掉汉字与替换字符后，再只保留 A-Za-z0-9 与连字符。
 * 这样可匹配：A组-JUMP、A�-JUMP、以及 UTF-8 被误读为 Latin-1 产生的 Aç»¿-JUMP 等乱码。
 */
function asciiSkeleton(s: string): string {
  let t = normalizeHyphens(s)
    .replace(/\uFFFD/g, '')
    .replace(/[\u4e00-\u9fff]/g, '')
    .replace(/\s+/g, '');
  // 去掉误读产生的 Latin-1 等杂字符，使与「仅汉字差异」的规范名落在同一骨架上
  t = t.replace(/[^A-Za-z0-9\-]/g, '');
  return t;
}

/**
 * 使用地区专用匹配键：保留汉字，只去掉 � 与 UTF-8 误读产生的杂字节，避免「ZEN达拉斯」与「ZEN华盛顿」被错误合并。
 */
export function usageAreaMatchKey(s: string): string {
  return normalizeHyphens(s)
    .replace(/\uFFFD/g, '')
    .replace(/\s+/g, '')
    .replace(/[^\u4e00-\u9fffA-Za-z0-9\-]/g, '');
}

/**
 * 将原始字符串与主数据列表对齐，修复乱码/替换字符/缺失汉字导致的展示问题。
 * @param matchKey 供应商/项目组用默认 asciiSkeleton；使用地区请传 usageAreaMatchKey。
 */
export function resolveMasterLabel(
  raw: string | undefined,
  masters: MasterItem[],
  matchKey: (s: string) => string = asciiSkeleton,
): string {
  const t = String(raw ?? '').trim();
  if (!t) return t;

  const byId = masters.find((m) => m.id === t);
  if (byId) return byId.name;

  if (masters.some((m) => m.name === t)) return t;

  const sk = matchKey(t);
  if (!sk) return t;

  const matches = masters.filter((m) => matchKey(m.name) === sk);
  if (matches.length === 1) return matches[0].name;
  if (matches.length > 1) {
    const noReplacement = matches.filter((m) => !/\uFFFD/.test(m.name));
    const pool = noReplacement.length ? noReplacement : matches;
    pool.sort((a, b) => b.name.length - a.name.length);
    return pool[0].name;
  }

  return t;
}

function uniqueMastersFromStrings(values: (string | undefined)[]): MasterItem[] {
  const out: MasterItem[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({ id: s, name: s });
  }
  return out;
}

export function buildSupplierMasters(suppliers: Supplier[], segments: IPSegment[]): MasterItem[] {
  const fromConfig = suppliers.map((s) => ({ id: s.id, name: s.name }));
  const fromSegments = uniqueMastersFromStrings(segments.map((seg) => seg.supplier));
  return dedupeMastersByKey(mergeMasterLists(fromConfig, fromSegments), asciiSkeleton);
}

export function buildUsageAreaMasters(areas: UsageAreaOption[], segments: IPSegment[]): MasterItem[] {
  const fromConfig = areas.map((a) => ({ id: a.id, name: a.name }));
  const fromSegments = uniqueMastersFromStrings(segments.map((seg) => seg.usageArea));
  return dedupeMastersByKey(mergeMasterLists(fromConfig, fromSegments), usageAreaMatchKey);
}

export function buildProjectGroupMasters(groups: ProjectGroup[], segments: IPSegment[]): MasterItem[] {
  const fromConfig = groups.map((g) => ({ id: g.id, name: g.name }));
  const fromSegments: string[] = [];
  for (const seg of segments) {
    (seg.projectGroups || []).forEach((x) => fromSegments.push(x));
    (seg.history || []).forEach((h) => fromSegments.push(h.projectGroup));
  }
  return dedupeMastersByKey(mergeMasterLists(fromConfig, uniqueMastersFromStrings(fromSegments)), asciiSkeleton);
}

function mergeMasterLists(a: MasterItem[], b: MasterItem[]): MasterItem[] {
  const seen = new Set<string>();
  const out: MasterItem[] = [];
  for (const m of [...a, ...b]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/** 同骨架多条（规范名 + 乱码）时保留更可信的一条 */
function pickBetterMasterLabel(a: MasterItem, b: MasterItem): MasterItem {
  const score = (m: MasterItem) => {
    let s = 0;
    if (!/\uFFFD/.test(m.name)) s += 100_000;
    const cjk = (m.name.match(/[\u4e00-\u9fff]/g) || []).length;
    s += cjk * 1_000;
    s += m.name.length;
    return s;
  };
  return score(a) >= score(b) ? a : b;
}

/**
 * 同一匹配键只保留一条规范名称，避免乱码与正确名同时存在于 masters 导致聚合拆行。
 */
function dedupeMastersByKey(masters: MasterItem[], matchKey: (s: string) => string): MasterItem[] {
  const bySk = new Map<string, MasterItem>();
  const noSkeleton: MasterItem[] = [];

  for (const m of masters) {
    const sk = matchKey(m.name);
    if (!sk) {
      noSkeleton.push(m);
      continue;
    }
    const prev = bySk.get(sk);
    if (!prev) {
      bySk.set(sk, m);
      continue;
    }
    bySk.set(sk, pickBetterMasterLabel(prev, m));
  }

  return [...noSkeleton, ...Array.from(bySk.values())];
}
