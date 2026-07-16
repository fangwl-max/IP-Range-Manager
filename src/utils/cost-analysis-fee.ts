import dayjs from 'dayjs';
import type { IPSegment } from '../types';
import { getEffectiveProjectGroups } from './history-overlap';

/** 单笔入账：首期（购买月/首个账单日）| 后续续费账单 */
export type CostChargeKind = 'newPurchase' | 'renewal';

export type CostChargeKindFilter = 'all' | CostChargeKind;

export interface CostAnalysisFilters {
  supplier: string | null;
  usageArea: string | null;
  chargeKind: CostChargeKindFilter;
  /** 二次筛选：仅统计归属该项目组的费用份额 */
  projectGroup: string | null;
}

export function classifyChargeKindByAnchorIndex(anchorIndex: number): CostChargeKind {
  return anchorIndex === 0 ? 'newPurchase' : 'renewal';
}

/** 按日历天折算：购买日所在自然月为「新购」，之后各月为「续费」 */
export function classifyChargeKindByMonthKey(segment: IPSegment, monthKey: string): CostChargeKind {
  if (!segment.purchaseDate) return 'renewal';
  const purchaseMonth = dayjs(segment.purchaseDate).format('YYYY-MM');
  return monthKey === purchaseMonth ? 'newPurchase' : 'renewal';
}

export function chargeKindMatchesFilter(
  kind: CostChargeKind,
  filter: CostChargeKindFilter
): boolean {
  return filter === 'all' || filter === kind;
}

export function segmentPassesCostSegmentFilters(
  segment: IPSegment,
  filters: CostAnalysisFilters,
  resolvers: {
    supplier: (r: string | undefined) => string;
    usageArea: (r: string | undefined) => string;
    projectGroup: (r: string | undefined) => string;
  }
): boolean {
  if (filters.supplier && resolvers.supplier(segment.supplier) !== filters.supplier) {
    return false;
  }
  if (filters.usageArea && resolvers.usageArea(segment.usageArea) !== filters.usageArea) {
    return false;
  }
  if (filters.projectGroup) {
    const pgs = getEffectiveProjectGroups(segment).map((g) => resolvers.projectGroup(g));
    if (!pgs.includes(filters.projectGroup)) return false;
  }
  return true;
}

/** 多项目组时仅计入筛选项目组对应份额；未设筛选则全额 */
export function feeAmountForProjectGroupFilter(
  lump: number,
  pgLabels: string[],
  projectGroupFilter: string | null
): number {
  if (!projectGroupFilter) return lump;
  if (pgLabels.length === 0) return 0;
  if (!pgLabels.includes(projectGroupFilter)) return 0;
  return lump / pgLabels.length;
}
