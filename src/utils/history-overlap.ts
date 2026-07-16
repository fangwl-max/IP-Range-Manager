import dayjs from 'dayjs';
import type { IPSegment, IPSegmentHistory } from '../types';

function historyStart(h: IPSegmentHistory): dayjs.Dayjs {
  return dayjs(h.startDate).startOf('day');
}

/**
 * 历程条目的有效结束日（含当天）。
 * 无 endDate 时：有取消时间则到取消日，否则到 referenceNow（用于「进行中」与另一条历程比是否重叠）。
 */
function historyEnd(
  h: IPSegmentHistory,
  segment: IPSegment,
  referenceNow: dayjs.Dayjs,
): dayjs.Dayjs {
  if (h.endDate) {
    return dayjs(h.endDate).endOf('day');
  }
  if (segment.cancellationDate) {
    return dayjs(segment.cancellationDate).endOf('day');
  }
  return referenceNow.endOf('day');
}

/**
 * 若上一条历程有结束日，且与本条「原始」开始日为同一日历日，则本条费用从**次日**起计（当日归上一条项目组）。
 * clippedStart：已做购买日等裁剪后的开始日。
 */
export function effectiveHistoryStartForFee(
  sortedHistory: IPSegmentHistory[],
  index: number,
  rawHistoryStart: dayjs.Dayjs,
  clippedStart: dayjs.Dayjs,
): dayjs.Dayjs {
  if (index <= 0) return clippedStart;
  const prev = sortedHistory[index - 1];
  if (prev.endDate && rawHistoryStart.isSame(dayjs(prev.endDate), 'day')) {
    const dayAfterHandoff = rawHistoryStart.add(1, 'day').startOf('day');
    return clippedStart.isAfter(dayAfterHandoff, 'day') ? clippedStart : dayAfterHandoff;
  }
  return clippedStart;
}

/**
 * 是否存在至少两条历程，其有效时间段在日历上**真正重叠**（不含：上一条结束日=下一条开始日的衔接日）。
 * 用于费用统计与「仅历程时间重叠」筛选。
 */
export function segmentHasOverlappingHistory(
  segment: IPSegment,
  referenceNow: dayjs.Dayjs = dayjs(),
): boolean {
  const hist = segment.history;
  if (!hist || hist.length < 2) {
    return false;
  }
  const sorted = [...hist].sort(
    (a, b) => dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf(),
  );
  for (let i = 0; i < sorted.length; i++) {
    const startA = historyStart(sorted[i]);
    const endA = historyEnd(sorted[i], segment, referenceNow);
    for (let j = i + 1; j < sorted.length; j++) {
      const startB = historyStart(sorted[j]);
      const endB = historyEnd(sorted[j], segment, referenceNow);
      const start = startA.isAfter(startB) ? startA : startB;
      const end = endA.isBefore(endB) ? endA : endB;
      if (start.isAfter(end, 'day')) {
        continue;
      }
      // 交集仅一天，且为上一条结束日=下一条开始日（衔接）→ 不算重叠
      if (start.isSame(end, 'day')) {
        const handoff =
          j === i + 1 &&
          Boolean(sorted[i].endDate) &&
          dayjs(sorted[i].endDate).isSame(dayjs(sorted[j].startDate), 'day');
        if (handoff) {
          continue;
        }
      }
      return true;
    }
  }
  return false;
}

/**
 * 从历程中解析「当前」项目组（与列表展示、存储字段 projectGroups 对齐）。
 * - 若有未结束历程（无 endDate），取开始日最晚的一条；
 * - 否则若某天落在某条闭区间内，取该条；
 * - 若无法从历程唯一确定（例如全部为已结束且今天不在任一段内），返回 null，由调用方回退到 segment.projectGroups。
 */
export function getProjectGroupsFromHistorySync(segment: IPSegment): string[] | null {
  const hist = segment.history;
  if (!hist?.length) return null;

  const sorted = [...hist].sort((a, b) => dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf());
  const now = dayjs().startOf('day');

  const open = sorted.filter((h) => !h.endDate);
  if (open.length) {
    const latestOpen = open.reduce((a, b) =>
      dayjs(a.startDate).isAfter(dayjs(b.startDate), 'day') ? a : b,
    );
    const g = String(latestOpen.projectGroup ?? '').trim();
    return g ? [g] : null;
  }

  for (let i = sorted.length - 1; i >= 0; i--) {
    const h = sorted[i];
    if (!h.endDate) continue;
    const start = dayjs(h.startDate).startOf('day');
    const end = dayjs(h.endDate).endOf('day');
    if (!now.isBefore(start, 'day') && !now.isAfter(end, 'day')) {
      const g = String(h.projectGroup ?? '').trim();
      return g ? [g] : null;
    }
  }

  return null;
}

/** 列表/导出用：优先历程中的当前项目组，否则 segment.projectGroups */
export function getEffectiveProjectGroups(segment: IPSegment): string[] {
  const fromHist = getProjectGroupsFromHistorySync(segment);
  if (fromHist !== null && fromHist.length > 0) return fromHist;
  return segment.projectGroups || [];
}
