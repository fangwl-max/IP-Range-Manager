import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Tag,
  Space,
  Button,
  Typography,
  Select,
  Modal,
  Tooltip,
  Segmented,
} from 'antd';
import {
  DownloadOutlined,
  PieChartOutlined,
  BarChartOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ColumnsType } from 'antd/es/table';
import { IPSegment, ProjectGroup, Supplier, UsageAreaOption } from '../types';
import {
  ipSegmentStorage,
  projectGroupStorage,
  supplierStorage,
  usageAreaStorage,
} from '../utils/storage';
import {
  buildProjectGroupMasters,
  buildSupplierMasters,
  buildUsageAreaMasters,
  resolveMasterLabel,
  usageAreaMatchKey,
} from '../utils/displayNames';
import { effectiveHistoryStartForFee, getEffectiveProjectGroups, getProjectGroupsFromHistorySync } from '../utils/history-overlap';
import { applyMonthlyUsdWithOptionalIpxoFee } from '../utils/supplier-fee';
import {
  type CostAnalysisFilters,
  type CostChargeKind,
  chargeKindMatchesFilter,
  classifyChargeKindByAnchorIndex,
  classifyChargeKindByMonthKey,
  feeAmountForProjectGroupFilter,
  segmentPassesCostSegmentFilters,
} from '../utils/cost-analysis-fee';

const { Title, Text } = Typography;

// Interlir 供应商使用欧元，换算为美元的汇率（1 EUR ≈ X USD）
const EUR_TO_USD_RATE = 1.08;
const INTERLIR_SUPPLIER = 'Interlir';

/** 历程未覆盖当月全部天数、或无项目组字段时，差额计入此项，使项目组分项之和与当月总费用一致 */
const UNASSIGNED_PROJECT_GROUP_LABEL = '未归属项目组';

/** 月度趋势 / 按月分布：按日历天折算（原逻辑）| 按月账单日入账（仅在实际到达账单日后计入该自然月） */
export type MonthlyFeeStatisticMode = 'dailyProRata' | 'billingAnchors';

/**
 * 每期账单日从购买日开始按月递增。
 * - 上至「服务结束」（到期日或当日）为止。
 * - 若已填写取消续费日期：不产生**晚于该日**的任何账单锚点——服务虽可能存续到到期日（如约 5.7），但不会在 5.27 等后续续费日再记费用（与销售后「取消续费」语义一致）。
 */
function collectBillingAnchors(
  segment: IPSegment,
  endDateInclusive: dayjs.Dayjs
): dayjs.Dayjs[] {
  const purchaseDate = dayjs(segment.purchaseDate);
  if (!purchaseDate.isValid()) return [];

  const cancelCut = segment.cancellationDate?.trim()
    ? dayjs(segment.cancellationDate).startOf('day')
    : null;

  const out: dayjs.Dayjs[] = [];
  let cur = purchaseDate.startOf('day');
  let guard = 0;
  while (
    (cur.isBefore(endDateInclusive, 'day') || cur.isSame(endDateInclusive, 'day')) &&
    guard++ < 600
  ) {
    if (cancelCut?.isValid() && cur.startOf('day').isAfter(cancelCut, 'day')) break;

    out.push(cur);
    cur = cur.add(1, 'month').startOf('day');
  }
  return out;
}

/** 账单日到账：仅当「今天」已到或已过该账单日（含账单日当天），才把该笔计入统计；未到账单日前不计入该自然月（如 4/30 续费在 4/30 之前不会算进 4 月） */
function isBillingEffectiveForStats(anchor: dayjs.Dayjs, referenceNow: dayjs.Dayjs): boolean {
  const a = anchor.startOf('day');
  const n = referenceNow.startOf('day');
  return !n.isBefore(a, 'day');
}

/**
 * 入账月账单日所在项目组：先看历程是否覆盖账单日（含衔接日规则），否则用当前项目组列表均分兜底
 */
function resolveProjectGroupLabelsForBillingDay(
  segment: IPSegment,
  anchorDay: dayjs.Dayjs,
  nowRef: dayjs.Dayjs,
  projectGroupResolver: (r: string | undefined) => string,
  calculateCancelledExpiry: (s: IPSegment) => dayjs.Dayjs | null
): string[] {
  const d = anchorDay.startOf('day');
  const sortedHistory = [...(segment.history ?? [])].sort(
    (a, b) => dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
  );

  const expiryCut = (): dayjs.Dayjs | null => calculateCancelledExpiry(segment);

  if (sortedHistory.length > 0) {
    for (let idx = 0; idx < sortedHistory.length; idx++) {
      const history = sortedHistory[idx]!;
      const rawHistoryStart = dayjs(history.startDate);
      let historyStart = rawHistoryStart;
      let historyEnd = history.endDate
        ? dayjs(history.endDate).endOf('day')
        : segment.cancellationDate
          ? (() => {
              const exp = expiryCut();
              return exp ? exp.endOf('day') : nowRef.endOf('day');
            })()
          : nowRef.endOf('day');

      if (segment.multiPurchaseMarked && segment.purchaseDate) {
        const billingStart = dayjs(segment.purchaseDate);
        if (billingStart.isValid() && historyStart.isBefore(billingStart, 'day')) {
          historyStart = billingStart;
        }
      }
      historyStart = effectiveHistoryStartForFee(
        sortedHistory,
        idx,
        rawHistoryStart,
        historyStart
      );

      if (
        (d.isAfter(historyStart, 'day') || d.isSame(historyStart, 'day')) &&
        (d.isBefore(historyEnd, 'day') || d.isSame(historyEnd, 'day'))
      ) {
        return [projectGroupResolver(history.projectGroup)];
      }
    }
  }

  const pgs = segment.projectGroups ?? [];
  if (pgs.length === 0) return [];
  return pgs.map((g) => projectGroupResolver(g));
}

// 获取显示用月费用（美元）：Interlir 为欧元需转换
function getDisplayMonthlyPrice(segment: { monthlyPrice?: number; supplier?: unknown }): number {
  const price = segment.monthlyPrice || 0;
  if (String(segment.supplier ?? '').toLowerCase() === INTERLIR_SUPPLIER.toLowerCase()) {
    return price * EUR_TO_USD_RATE;
  }
  return price;
}

interface CostStatistics {
  totalCost: number;
  activeCost: number;
  cancelledButNotExpiredCost: number;
  cancelledCost: number;
  bySupplier: { [key: string]: { cost: number; count: number } };
  byUsageArea: { [key: string]: { cost: number; count: number } };
  byProjectGroup: { [key: string]: { cost: number; count: number } };
  monthlyTrend: { month: string; cost: number; costNewPurchase: number; costRenewal: number }[];
}

const CostAnalysis: React.FC = () => {
  const [ipSegments, setIpSegments] = useState<IPSegment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [usageAreas, setUsageAreas] = useState<UsageAreaOption[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [viewType, setViewType] = useState<
    'supplier' | 'usageArea' | 'projectGroup' | 'chargeKind'
  >('supplier');
  /** 费用分布内：按费用类型筛选（仅影响费用分布与月份详情，不影响月度趋势表） */
  const [distributionChargeKind, setDistributionChargeKind] =
    useState<CostAnalysisFilters['chargeKind']>('all');
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [isMonthDetailVisible, setIsMonthDetailVisible] = useState(false);
  /** 费用分布分类明细：月份 + 查看维度 + 分类键（与 distribution 中 key 一致） */
  const [categoryDetailModal, setCategoryDetailModal] = useState<{
    monthKey: string;
    viewKind: 'supplier' | 'usageArea' | 'projectGroup' | 'chargeKind';
    categoryKey: string;
  } | null>(null);
  const [detailTablePage, setDetailTablePage] = useState(1);
  const [detailTablePageSize, setDetailTablePageSize] = useState(20);
  /** 月度费用趋势与「按月份」分布的统计口径 */
  const [monthlyFeeMode, setMonthlyFeeMode] = useState<MonthlyFeeStatisticMode>('dailyProRata');
  /** 主筛选 */
  const [filterSupplier, setFilterSupplier] = useState<string | null>(null);
  const [filterUsageArea, setFilterUsageArea] = useState<string | null>(null);
  /** 二次筛选：项目组 */
  const [filterProjectGroup, setFilterProjectGroup] = useState<string | null>(null);
  /** 费用类型视图下的二级筛选 */
  const [chargeKindSubSupplier, setChargeKindSubSupplier] = useState<string | null>(null);
  const [chargeKindSubProjectGroup, setChargeKindSubProjectGroup] = useState<string | null>(null);
  const [chargeKindSubView, setChargeKindSubView] = useState<'supplier' | 'projectGroup'>('supplier');

  useEffect(() => {
    loadData();
  }, []);

  const labelResolvers = useMemo(() => {
    const sm = buildSupplierMasters(suppliers, ipSegments);
    const um = buildUsageAreaMasters(usageAreas, ipSegments);
    const pm = buildProjectGroupMasters(projectGroups, ipSegments);
    return {
      supplier: (r: string | undefined) => resolveMasterLabel(r, sm),
      usageArea: (r: string | undefined) => resolveMasterLabel(r, um, usageAreaMatchKey),
      projectGroup: (r: string | undefined) => resolveMasterLabel(r, pm),
    };
  }, [suppliers, usageAreas, projectGroups, ipSegments]);

  /** 顶部统计、月度趋势、明细表：不含费用类型筛选 */
  const baseCostFilters = useMemo<CostAnalysisFilters>(
    () => ({
      supplier: filterSupplier,
      usageArea: filterUsageArea,
      chargeKind: 'all',
      projectGroup: filterProjectGroup,
    }),
    [filterSupplier, filterUsageArea, filterProjectGroup]
  );

  /** 费用分布 / 月份详情：叠加费用类型（新购/续费） */
  const distributionCostFilters = useMemo<CostAnalysisFilters>(
    () => ({
      ...baseCostFilters,
      chargeKind: viewType === 'chargeKind' ? 'all' : distributionChargeKind,
    }),
    [baseCostFilters, distributionChargeKind, viewType]
  );

  const filterSupplierOptions = useMemo(() => {
    const set = new Set<string>();
    ipSegments.forEach((s) => {
      if (s.supplier) set.add(labelResolvers.supplier(s.supplier));
    });
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((v) => ({ label: v, value: v }));
  }, [ipSegments, labelResolvers]);

  const filterUsageAreaOptions = useMemo(() => {
    const set = new Set<string>();
    ipSegments.forEach((s) => {
      if (s.usageArea) set.add(labelResolvers.usageArea(s.usageArea));
    });
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((v) => ({ label: v, value: v }));
  }, [ipSegments, labelResolvers]);

  const filterProjectGroupOptions = useMemo(() => {
    const set = new Set<string>();
    ipSegments.forEach((s) => {
      getEffectiveProjectGroups(s).forEach((g) => set.add(labelResolvers.projectGroup(g)));
    });
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((v) => ({ label: v, value: v }));
  }, [ipSegments, labelResolvers]);

  const loadData = async () => {
    try {
      let segments = ipSegmentStorage.getAll() || [];
      let hasUpdates = false;

      // 有历程时：根据「当前」历程条目修正 projectGroups（与 IP 段管理保持一致，含仅一条「至今」）
      segments = segments.map((segment) => {
        const expectedPg = getProjectGroupsFromHistorySync(segment);
        if (expectedPg && expectedPg.length > 0) {
          const cur = segment.projectGroups?.[0];
          if (cur !== expectedPg[0]) {
            hasUpdates = true;
            return {
              ...segment,
              projectGroups: expectedPg,
              updatedAt: new Date().toISOString(),
            };
          }
        }
        return segment;
      });

      if (hasUpdates) {
        ipSegmentStorage.save(segments);
        // 同步到本地文件
        try {
          const { projectGroupStorage, supplierStorage, usageAreaStorage, asnStorage, asnGroupStorage } = await import('../utils/storage');
          await fetch('/api/save-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ipSegments: ipSegmentStorage.getAll(),
              projectGroups: projectGroupStorage.getAll(),
              suppliers: supplierStorage.getAll(),
              usageAreas: usageAreaStorage.getAll(),
              asns: asnStorage.getAll(),
              asnGroups: asnGroupStorage.getAll(),
              exportTime: new Date().toISOString(),
              version: '1.0.0',
            }, null, 2),
          });
        } catch (e) {
          console.warn('同步到文件失败:', e);
        }
      }

      setIpSegments(segments);
      setSuppliers(supplierStorage.getAll());
      setUsageAreas(usageAreaStorage.getAll());
      setProjectGroups(projectGroupStorage.getAll());
    } catch (error) {
      console.error('加载数据失败:', error);
      setIpSegments([]);
    }
  };

  // 计算已取消IP段的实际到期时间（与IPManagement.tsx中的逻辑保持一致）
  const calculateCancelledExpiryDate = (segment: IPSegment): dayjs.Dayjs | null => {
    if (!segment.cancellationDate || !segment.purchaseDate) {
      return null;
    }
    
    const cancellationDate = dayjs(segment.cancellationDate);
    const purchaseDate = dayjs(segment.purchaseDate);
    
    if (!cancellationDate.isValid() || !purchaseDate.isValid()) {
      return null;
    }
    
    // 如果续费时间存在
    if (segment.renewalDate) {
      const renewalDate = dayjs(segment.renewalDate);
      if (renewalDate.isValid()) {
        // 如果续费时间在取消时间之后，到期时间 = 续费时间
        // 例如：购买时间2025-10-28，取消时间2026-02-26，续费时间2026-02-28
        // 到期时间应该是2026-02-28（续费时间）
        if (renewalDate.isAfter(cancellationDate)) {
          return renewalDate;
        }
        // 如果续费时间在取消时间之前或等于取消时间，到期时间 = 续费时间 + 1个月
        // 例如：购买时间2026-01-05，取消时间2026-02-28，续费时间2026-02-05
        // 到期时间应该是2026-03-05（续费时间+1个月）
        if (renewalDate.isBefore(cancellationDate) || renewalDate.isSame(cancellationDate, 'day')) {
          return renewalDate.add(1, 'month');
        }
      }
    }
    
    // 如果没有续费时间，按照购买日和取消日计算到期时间
    const purchaseDay = purchaseDate.date(); // 购买时间的"日"（1-31）
    // 到期时间 = 取消时间所在月份的购买时间的"日"
    // 例如：购买时间2025-10-28，取消时间2026-02-26，到期时间应该是2026-02-28
    return cancellationDate.date(purchaseDay);
  };

  // 计算费用统计
  const statistics = useMemo<CostStatistics>(() => {
    const now = dayjs();
    const stats: CostStatistics = {
      totalCost: 0,
      activeCost: 0,
      cancelledButNotExpiredCost: 0,
      cancelledCost: 0,
      bySupplier: {},
      byUsageArea: {},
      byProjectGroup: {},
      monthlyTrend: [],
    };

    // 按状态分类统计（受主筛选 + 项目组二次筛选约束）
    ipSegments.forEach(segment => {
      if (!segmentPassesCostSegmentFilters(segment, baseCostFilters, labelResolvers)) {
        return;
      }
      const cost = applyMonthlyUsdWithOptionalIpxoFee(getDisplayMonthlyPrice(segment), segment.supplier);
      
      let isActive = false;
      let isCancelledButNotExpired = false;

      if (segment.renewalStatus === 'cancelled' || segment.cancellationDate) {
        // 已取消的IP段，需要计算实际到期时间来判断是否已到期
        const expiryDate = calculateCancelledExpiryDate(segment);
        if (expiryDate && expiryDate.isAfter(now)) {
          // 已取消但未到期
          stats.cancelledButNotExpiredCost += cost;
          isCancelledButNotExpired = true;
        } else {
          // 已取消并到期，不统计到费用分布中
          stats.cancelledCost += cost;
          return; // 跳过后续的分布统计
        }
      } else {
        stats.activeCost += cost;
        isActive = true;
      }

      // 只统计正常使用中和已取消但未到期的IP段
      if (isActive || isCancelledButNotExpired) {
        stats.totalCost += cost;

        // 按供应商统计（包含费用和数量）；名称与主数据对齐，避免乱码拆成多行
        if (segment.supplier) {
          const key = labelResolvers.supplier(segment.supplier);
          if (!stats.bySupplier[key]) {
            stats.bySupplier[key] = { cost: 0, count: 0 };
          }
          stats.bySupplier[key].cost += cost;
          stats.bySupplier[key].count += 1;
        }

        // 按使用地区统计（包含费用和数量）
        if (segment.usageArea) {
          const key = labelResolvers.usageArea(segment.usageArea);
          if (!stats.byUsageArea[key]) {
            stats.byUsageArea[key] = { cost: 0, count: 0 };
          }
          stats.byUsageArea[key].cost += cost;
          stats.byUsageArea[key].count += 1;
        }

        // 按项目组统计（包含费用和数量）
        // 如果有历程记录，需要根据历程记录计算费用分配
        if (segment.history && segment.history.length > 0) {
          // 有历程记录：按历程记录计算费用
          const sortedHistory = [...segment.history].sort((a, b) => 
            dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
          );
          
          // 计算每个项目组的使用天数
          const projectGroupDays: { [key: string]: number } = {};
          const purchaseDate = dayjs(segment.purchaseDate);
          const now = dayjs();
          
          // 确定结束日期
          let endDate = now;
          if (segment.cancellationDate) {
            const expiryDate = calculateCancelledExpiryDate(segment);
            if (expiryDate) {
              endDate = expiryDate;
            }
          }
          
          // 遍历历程记录，计算每个项目组的使用天数（衔接日归上一条）
          sortedHistory.forEach((history, idx) => {
            const rawStart = dayjs(history.startDate);
            const endDateForHistory = history.endDate ? dayjs(history.endDate) : endDate;
            
            // 确保开始日期不早于购买日期
            let actualStartDate = rawStart.isBefore(purchaseDate) ? purchaseDate : rawStart;
            actualStartDate = effectiveHistoryStartForFee(sortedHistory, idx, rawStart, actualStartDate);
            
            // 计算该历程记录的天数
            const days = Math.max(0, endDateForHistory.diff(actualStartDate, 'day') + 1);
            
            const pgKey = labelResolvers.projectGroup(history.projectGroup);
            if (!projectGroupDays[pgKey]) {
              projectGroupDays[pgKey] = 0;
            }
            projectGroupDays[pgKey] += days;
          });
          
          // 计算总天数
          const totalDays = Math.max(1, endDate.diff(purchaseDate, 'day') + 1);
          const sumPgDays = Object.values(projectGroupDays).reduce((a, b) => a + b, 0);

          if (sumPgDays === 0) {
            if (segment.projectGroups && segment.projectGroups.length > 0) {
              const n = segment.projectGroups.length;
              const share = cost / n;
              segment.projectGroups.forEach(group => {
                const gKey = labelResolvers.projectGroup(group);
                if (!stats.byProjectGroup[gKey]) {
                  stats.byProjectGroup[gKey] = { cost: 0, count: 0 };
                }
                stats.byProjectGroup[gKey].cost += share;
                stats.byProjectGroup[gKey].count += 1;
              });
            } else {
              const k = UNASSIGNED_PROJECT_GROUP_LABEL;
              if (!stats.byProjectGroup[k]) {
                stats.byProjectGroup[k] = { cost: 0, count: 0 };
              }
              stats.byProjectGroup[k].cost += cost;
              stats.byProjectGroup[k].count += 1;
            }
          } else if (sumPgDays <= totalDays) {
            Object.keys(projectGroupDays).forEach(group => {
              const days = projectGroupDays[group];
              const groupCost = (cost / totalDays) * days;

              if (!stats.byProjectGroup[group]) {
                stats.byProjectGroup[group] = { cost: 0, count: 0 };
              }
              stats.byProjectGroup[group].cost += groupCost;
              stats.byProjectGroup[group].count += 1;
            });
            if (sumPgDays < totalDays) {
              const remainder = (cost / totalDays) * (totalDays - sumPgDays);
              const k = UNASSIGNED_PROJECT_GROUP_LABEL;
              if (!stats.byProjectGroup[k]) {
                stats.byProjectGroup[k] = { cost: 0, count: 0 };
              }
              stats.byProjectGroup[k].cost += remainder;
              stats.byProjectGroup[k].count += 1;
            }
          } else {
            Object.keys(projectGroupDays).forEach(group => {
              const days = projectGroupDays[group];
              const groupCost = cost * (days / sumPgDays);

              if (!stats.byProjectGroup[group]) {
                stats.byProjectGroup[group] = { cost: 0, count: 0 };
              }
              stats.byProjectGroup[group].cost += groupCost;
              stats.byProjectGroup[group].count += 1;
            });
          }
        } else if (segment.projectGroups && segment.projectGroups.length > 0) {
          // 没有历程记录：多项目组时均分该段费用（避免每组都加全额导致分项之和 > 总费用）
          const n = segment.projectGroups.length;
          const share = cost / n;
          segment.projectGroups.forEach(group => {
            const gKey = labelResolvers.projectGroup(group);
            if (!stats.byProjectGroup[gKey]) {
              stats.byProjectGroup[gKey] = { cost: 0, count: 0 };
            }
            stats.byProjectGroup[gKey].cost += share;
            stats.byProjectGroup[gKey].count += 1;
          });
        }
      }
    });

    // 计算月度趋势（近12个月）
    const monthlyData: Record<string, { total: number; newPurchase: number; renewal: number }> = {};
    const addTrendFee = (monthKey: string, amount: number, kind: CostChargeKind) => {
      if (!Object.prototype.hasOwnProperty.call(monthlyData, monthKey) || amount <= 0) return;
      monthlyData[monthKey].total += amount;
      if (kind === 'newPurchase') monthlyData[monthKey].newPurchase += amount;
      else monthlyData[monthKey].renewal += amount;
    };
    for (let i = 11; i >= 0; i--) {
      const month = now.subtract(i, 'month');
      monthlyData[month.format('YYYY-MM')] = { total: 0, newPurchase: 0, renewal: 0 };
    }

    const getDaysInMonth = (year: number, month: number): number => {
      return dayjs(`${year}-${month}-01`).daysInMonth();
    };

    const fillTrendBillingAnchors = () => {
      ipSegments.forEach((segment) => {
        if (!segment.purchaseDate) return;
        if (!segmentPassesCostSegmentFilters(segment, baseCostFilters, labelResolvers)) return;
        const monthlyPrice = applyMonthlyUsdWithOptionalIpxoFee(
          getDisplayMonthlyPrice(segment),
          segment.supplier
        );
        let endDateCut = now;
        if (segment.cancellationDate) {
          const expiryDate = calculateCancelledExpiryDate(segment);
          if (expiryDate) endDateCut = expiryDate;
        }
        const anchors = collectBillingAnchors(segment, endDateCut);
        anchors.forEach((anchor, anchorIndex) => {
          if (!isBillingEffectiveForStats(anchor, now)) return;
          const kind = classifyChargeKindByAnchorIndex(anchorIndex);
          const monthKey = anchor.format('YYYY-MM');
          const pgLabels = resolveProjectGroupLabelsForBillingDay(
            segment,
            anchor,
            now,
            labelResolvers.projectGroup,
            calculateCancelledExpiryDate
          );
          const amount = feeAmountForProjectGroupFilter(
            monthlyPrice,
            pgLabels,
            baseCostFilters.projectGroup
          );
          addTrendFee(monthKey, amount, kind);
        });
      });
    };

    const fillTrendDailyProrata = () => {
      ipSegments.forEach((segment) => {
        if (!segment.purchaseDate) return;
        if (!segmentPassesCostSegmentFilters(segment, baseCostFilters, labelResolvers)) return;
        const purchaseDate = dayjs(segment.purchaseDate);
        const monthlyPrice = applyMonthlyUsdWithOptionalIpxoFee(
          getDisplayMonthlyPrice(segment),
          segment.supplier
        );

        let endDate: dayjs.Dayjs | null = null;
        let isCancelled = false;
        if (segment.cancellationDate) {
          isCancelled = true;
          const expiryDate = calculateCancelledExpiryDate(segment);
          if (expiryDate) {
            endDate = expiryDate;
          }
        }
        if (!endDate) {
          endDate = now;
        }

        let currentMonth = purchaseDate.startOf('month');
        const endMonth = endDate.startOf('month');

        while (currentMonth.isBefore(endMonth) || currentMonth.isSame(endMonth)) {
          const monthKey = currentMonth.format('YYYY-MM');
          const kind = classifyChargeKindByMonthKey(segment, monthKey);

          if (Object.prototype.hasOwnProperty.call(monthlyData, monthKey)) {
            const year = currentMonth.year();
            const month = currentMonth.month() + 1;
            const daysInMonth = getDaysInMonth(year, month);

            let startDay = 1;
            let endDay = daysInMonth;

            if (currentMonth.isSame(purchaseDate, 'month')) {
              startDay = purchaseDate.date();
            }

            if (currentMonth.isSame(endDate, 'month')) {
              endDay = endDate.date();
            } else if (!isCancelled && currentMonth.isSame(now.startOf('month'))) {
              endDay = now.date();
            }

            const actualDays = endDay - startDay + 1;

            if (actualDays > 0) {
              let monthlyCost = (monthlyPrice / daysInMonth) * actualDays;
              if (baseCostFilters.projectGroup) {
                const pgs = getEffectiveProjectGroups(segment).map((g) =>
                  labelResolvers.projectGroup(g)
                );
                monthlyCost = feeAmountForProjectGroupFilter(
                  monthlyCost,
                  pgs,
                  baseCostFilters.projectGroup
                );
              }
              addTrendFee(monthKey, monthlyCost, kind);
            }
          }

          currentMonth = currentMonth.add(1, 'month');
        }
      });
    };

    if (monthlyFeeMode === 'billingAnchors') {
      fillTrendBillingAnchors();
    } else {
      fillTrendDailyProrata();
    }

    stats.monthlyTrend = Object.keys(monthlyData)
      .sort((a, b) => String(b).localeCompare(String(a)))
      .map((month) => ({
        month,
        cost: monthlyData[month].total,
        costNewPurchase: monthlyData[month].newPurchase,
        costRenewal: monthlyData[month].renewal,
      }));

    return stats;
  }, [ipSegments, labelResolvers, monthlyFeeMode, baseCostFilters]);

  // 计算指定月份的费用分布
  const getMonthlyDistribution = useMemo(() => {
    const now = dayjs();
    
    const monthlyDistributions: {
      [month: string]: {
        bySupplier: { [key: string]: { cost: number; count: number } };
        byUsageArea: { [key: string]: { cost: number; count: number } };
        byProjectGroup: { [key: string]: { cost: number; count: number } };
        totalCost: number;
        costNewPurchase: number;
        costRenewal: number;
        /** 当月计入「未归属项目组」的明细（与 byProjectGroup 中该项金额一致） */
        unassignedProjectGroupDetails: { segmentId: string; amount: number; reason: string }[];
        /** 各分类下 IP 段分摊明细（用于点击卡片查看） */
        detailsBySupplier: Record<string, { segmentId: string; amount: number }[]>;
        detailsByUsageArea: Record<string, { segmentId: string; amount: number }[]>;
        detailsByProjectGroup: Record<string, { segmentId: string; amount: number }[]>;
        detailsChargeNewPurchase: { segmentId: string; amount: number }[];
        detailsChargeRenewal: { segmentId: string; amount: number }[];
      };
    } = {};
    
    // 获取某个月的天数
    const getDaysInMonth = (year: number, month: number): number => {
      return dayjs(`${year}-${month}-01`).daysInMonth();
    };
    
    // 初始化所有月份的分布数据
    statistics.monthlyTrend.forEach(trend => {
      monthlyDistributions[trend.month] = {
        bySupplier: {},
        byUsageArea: {},
        byProjectGroup: {},
        totalCost: 0,
        costNewPurchase: 0,
        costRenewal: 0,
        unassignedProjectGroupDetails: [],
        detailsBySupplier: {},
        detailsByUsageArea: {},
        detailsByProjectGroup: {},
        detailsChargeNewPurchase: [],
        detailsChargeRenewal: [],
      };
    });

    const pushChargeKindDetail = (
      md: (typeof monthlyDistributions)[string],
      kind: CostChargeKind,
      segmentId: string,
      amount: number
    ) => {
      if (amount <= 0) return;
      if (kind === 'newPurchase') {
        md.detailsChargeNewPurchase.push({ segmentId, amount });
      } else {
        md.detailsChargeRenewal.push({ segmentId, amount });
      }
    };

    const addMonthChargeTotals = (md: (typeof monthlyDistributions)[string], amount: number, kind: CostChargeKind) => {
      md.totalCost += amount;
      if (kind === 'newPurchase') md.costNewPurchase += amount;
      else md.costRenewal += amount;
    };
    
    if (monthlyFeeMode === 'billingAnchors') {
      ipSegments.forEach((segment) => {
        if (!segment.purchaseDate) return;
        if (!segmentPassesCostSegmentFilters(segment, distributionCostFilters, labelResolvers)) return;
        const monthlyPrice = applyMonthlyUsdWithOptionalIpxoFee(
          getDisplayMonthlyPrice(segment),
          segment.supplier
        );
        let endDateCut: dayjs.Dayjs | null = null;
        if (segment.cancellationDate) {
          const expiryDate = calculateCancelledExpiryDate(segment);
          if (expiryDate) endDateCut = expiryDate;
        }
        if (!endDateCut) endDateCut = now;

        const anchors = collectBillingAnchors(segment, endDateCut);
        anchors.forEach((anchor, anchorIndex) => {
          if (!isBillingEffectiveForStats(anchor, now)) return;
          const kind = classifyChargeKindByAnchorIndex(anchorIndex);
          if (!chargeKindMatchesFilter(kind, distributionCostFilters.chargeKind)) return;
          const monthKey = anchor.format('YYYY-MM');
          if (!Object.prototype.hasOwnProperty.call(monthlyDistributions, monthKey)) return;

          const md = monthlyDistributions[monthKey];
          const pgLabels = resolveProjectGroupLabelsForBillingDay(
            segment,
            anchor,
            now,
            labelResolvers.projectGroup,
            calculateCancelledExpiryDate
          );
          const lump = feeAmountForProjectGroupFilter(
            monthlyPrice,
            pgLabels,
            distributionCostFilters.projectGroup
          );
          if (lump <= 0) return;
          addMonthChargeTotals(md, lump, kind);
          pushChargeKindDetail(md, kind, segment.id, lump);

          const pushDetailBill = (
            map: Record<string, { segmentId: string; amount: number }[]>,
            key: string,
            amount: number,
          ) => {
            if (!map[key]) map[key] = [];
            map[key].push({ segmentId: segment.id, amount });
          };

          if (segment.supplier) {
            const sk = labelResolvers.supplier(segment.supplier);
            if (!md.bySupplier[sk]) md.bySupplier[sk] = { cost: 0, count: 0 };
            md.bySupplier[sk].cost += lump;
            md.bySupplier[sk].count += 1;
            pushDetailBill(md.detailsBySupplier, sk, lump);
          }

          if (segment.usageArea) {
            const uk = labelResolvers.usageArea(segment.usageArea);
            if (!md.byUsageArea[uk]) md.byUsageArea[uk] = { cost: 0, count: 0 };
            md.byUsageArea[uk].cost += lump;
            md.byUsageArea[uk].count += 1;
            pushDetailBill(md.detailsByUsageArea, uk, lump);
          }

          if (pgLabels.length === 0) {
            const k = UNASSIGNED_PROJECT_GROUP_LABEL;
            if (!md.byProjectGroup[k]) md.byProjectGroup[k] = { cost: 0, count: 0 };
            md.byProjectGroup[k].cost += lump;
            md.byProjectGroup[k].count += 1;
            pushDetailBill(md.detailsByProjectGroup, k, lump);
            md.unassignedProjectGroupDetails.push({
              segmentId: segment.id,
              amount: lump,
              reason: '入账月无项目组或当日历程未归属',
            });
          } else {
            const share = lump / pgLabels.length;
            pgLabels.forEach((gk) => {
              if (!md.byProjectGroup[gk]) md.byProjectGroup[gk] = { cost: 0, count: 0 };
              md.byProjectGroup[gk].cost += share;
              md.byProjectGroup[gk].count += 1;
              pushDetailBill(md.detailsByProjectGroup, gk, share);
            });
          }
        });
      });
    } else {
    // 计算每个IP段在每个月的费用分布（按日历天折算）
    ipSegments.forEach(segment => {
      if (!segmentPassesCostSegmentFilters(segment, distributionCostFilters, labelResolvers)) return;
      if (segment.purchaseDate) {
        const purchaseDate = dayjs(segment.purchaseDate);
        const monthlyPrice = applyMonthlyUsdWithOptionalIpxoFee(getDisplayMonthlyPrice(segment), segment.supplier);

        // 确定结束日期
        let endDate: dayjs.Dayjs | null = null;
        let isCancelled = false;
        if (segment.cancellationDate) {
          isCancelled = true;
          const expiryDate = calculateCancelledExpiryDate(segment);
          if (expiryDate) {
            endDate = expiryDate;
          }
        }
        if (!endDate) {
          // 对于正常使用的IP段，只计算到当前月份（不包括未来月份）
          endDate = now;
        }

        // 从购买月份开始，到结束月份
        let currentMonth = purchaseDate.startOf('month');
        const endMonth = endDate.startOf('month');

        while (currentMonth.isBefore(endMonth) || currentMonth.isSame(endMonth)) {
          const monthKey = currentMonth.format('YYYY-MM');
          const kind = classifyChargeKindByMonthKey(segment, monthKey);
          if (!chargeKindMatchesFilter(kind, distributionCostFilters.chargeKind)) {
            currentMonth = currentMonth.add(1, 'month');
            continue;
          }
          
          if (monthlyDistributions.hasOwnProperty(monthKey)) {
            const year = currentMonth.year();
            const month = currentMonth.month() + 1;
            const daysInMonth = getDaysInMonth(year, month);
            
            let startDay = 1;
            let endDay = daysInMonth;
            
            if (currentMonth.isSame(purchaseDate, 'month')) {
              startDay = purchaseDate.date();
            }
            
            if (currentMonth.isSame(endDate, 'month')) {
              endDay = endDate.date();
            } else if (!isCancelled && currentMonth.isSame(now.startOf('month'))) {
              // 对于正常使用的IP段，当前月份到当前日期
              endDay = now.date();
            }
            
            const actualDays = endDay - startDay + 1;
            
            if (actualDays > 0) {
              let monthlyCost = (monthlyPrice / daysInMonth) * actualDays;
              const md = monthlyDistributions[monthKey];
              const pushDetail = (
                map: Record<string, { segmentId: string; amount: number }[]>,
                key: string,
                amount: number,
              ) => {
                if (!map[key]) map[key] = [];
                map[key].push({ segmentId: segment.id, amount });
              };

              const recordMonthFee = (amount: number) => {
                if (amount <= 0) return;
                addMonthChargeTotals(md, amount, kind);
              };

              const pushSupplierUsageForAmount = (amount: number) => {
                if (amount <= 0) return;
                if (segment.supplier) {
                  const sk = labelResolvers.supplier(segment.supplier);
                  if (!md.bySupplier[sk]) {
                    md.bySupplier[sk] = { cost: 0, count: 0 };
                  }
                  md.bySupplier[sk].cost += amount;
                  md.bySupplier[sk].count += 1;
                  pushDetail(md.detailsBySupplier, sk, amount);
                }
                if (segment.usageArea) {
                  const uk = labelResolvers.usageArea(segment.usageArea);
                  if (!md.byUsageArea[uk]) {
                    md.byUsageArea[uk] = { cost: 0, count: 0 };
                  }
                  md.byUsageArea[uk].cost += amount;
                  md.byUsageArea[uk].count += 1;
                  pushDetail(md.detailsByUsageArea, uk, amount);
                }
              };

              let monthCredited = 0;

              // 按项目组统计（支持历程记录）
              const monthStart = currentMonth.startOf('month');
              const monthEnd = currentMonth.endOf('month');
              
              if (segment.history && segment.history.length > 0) {
                // 有历程记录：根据该月的历程记录计算费用分配
                const sortedHistory = [...segment.history].sort((a, b) => 
                  dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                );
                
                // 计算该月每个项目组的使用天数
                const projectGroupDays: { [key: string]: number } = {};
                
                sortedHistory.forEach((history, idx) => {
                  const rawHistoryStart = dayjs(history.startDate);
                  let historyStart = rawHistoryStart;
                  const historyEnd = history.endDate ? dayjs(history.endDate) : (segment.cancellationDate ? calculateCancelledExpiryDate(segment) : now);
                  
                  if (!historyEnd) return;

                  // 多次购买：当前月费对应最近一期 purchaseDate，历程中早于该日的段落不计入本月项目组拆分
                  if (segment.multiPurchaseMarked && segment.purchaseDate) {
                    const billingStart = dayjs(segment.purchaseDate);
                    if (billingStart.isValid() && historyStart.isBefore(billingStart, 'day')) {
                      historyStart = billingStart;
                    }
                  }

                  // 衔接日：上一条结束日=本条开始日 → 本条从次日起计入本月（衔接日归上一条项目组）
                  historyStart = effectiveHistoryStartForFee(sortedHistory, idx, rawHistoryStart, historyStart);
                  
                  // 计算历程记录与该月的交集
                  const overlapStart = historyStart.isAfter(monthStart) ? historyStart : monthStart;
                  const overlapEnd = historyEnd.isBefore(monthEnd) ? historyEnd : monthEnd;
                  
                  if (overlapStart.isBefore(overlapEnd) || overlapStart.isSame(overlapEnd, 'day')) {
                    // 计算该历程记录在该月的天数
                    let historyDaysInMonth = 0;
                    
                    if (overlapStart.isSame(overlapEnd, 'month')) {
                      // 同一个月内
                      historyDaysInMonth = overlapEnd.diff(overlapStart, 'day') + 1;
                    } else {
                      // 跨月的情况
                      let current = overlapStart.startOf('month');
                      while (current.isBefore(overlapEnd) || current.isSame(overlapEnd, 'month')) {
                        if (current.isSame(monthStart, 'month')) {
                          if (current.isSame(overlapStart, 'month')) {
                            historyDaysInMonth += current.endOf('month').diff(overlapStart, 'day') + 1;
                          } else {
                            historyDaysInMonth += current.endOf('month').diff(current.startOf('month'), 'day') + 1;
                          }
                        }
                        current = current.add(1, 'month');
                      }
                    }
                    
                    if (historyDaysInMonth > 0) {
                      const pgKey = labelResolvers.projectGroup(history.projectGroup);
                      if (!projectGroupDays[pgKey]) {
                        projectGroupDays[pgKey] = 0;
                      }
                      projectGroupDays[pgKey] += historyDaysInMonth;
                    }
                  }
                });
                
                const totalDaysInMonth = actualDays;
                const sumPgDays = Object.values(projectGroupDays).reduce((a, b) => a + b, 0);

                const addPgPortion = (gk: string, portion: number) => {
                  if (portion <= 0) return;
                  if (!md.byProjectGroup[gk]) {
                    md.byProjectGroup[gk] = { cost: 0, count: 0 };
                  }
                  md.byProjectGroup[gk].cost += portion;
                  md.byProjectGroup[gk].count += 1;
                  pushDetail(md.detailsByProjectGroup, gk, portion);
                  if (!distributionCostFilters.projectGroup || gk === distributionCostFilters.projectGroup) {
                    monthCredited += portion;
                  }
                };

                if (sumPgDays === 0) {
                  if (segment.projectGroups && segment.projectGroups.length > 0) {
                    const n = segment.projectGroups.length;
                    const share = monthlyCost / n;
                    segment.projectGroups.forEach((group) => {
                      addPgPortion(labelResolvers.projectGroup(group), share);
                    });
                  } else if (!distributionCostFilters.projectGroup) {
                    const k = UNASSIGNED_PROJECT_GROUP_LABEL;
                    addPgPortion(k, monthlyCost);
                    md.unassignedProjectGroupDetails.push({
                      segmentId: segment.id,
                      amount: monthlyCost,
                      reason: '历程与当月无交集且无项目组',
                    });
                  }
                } else if (sumPgDays <= totalDaysInMonth) {
                  Object.keys(projectGroupDays).forEach((group) => {
                    const days = projectGroupDays[group];
                    addPgPortion(group, (monthlyCost / totalDaysInMonth) * days);
                  });
                  if (sumPgDays < totalDaysInMonth && !distributionCostFilters.projectGroup) {
                    const remainder =
                      (monthlyCost / totalDaysInMonth) * (totalDaysInMonth - sumPgDays);
                    const k = UNASSIGNED_PROJECT_GROUP_LABEL;
                    addPgPortion(k, remainder);
                    md.unassignedProjectGroupDetails.push({
                      segmentId: segment.id,
                      amount: remainder,
                      reason: '历程未覆盖当月全部计费天数',
                    });
                  }
                } else {
                  Object.keys(projectGroupDays).forEach((group) => {
                    const days = projectGroupDays[group];
                    addPgPortion(group, monthlyCost * (days / sumPgDays));
                  });
                }
              } else if (segment.projectGroups && segment.projectGroups.length > 0) {
                const n = segment.projectGroups.length;
                const share = monthlyCost / n;
                segment.projectGroups.forEach((group) => {
                  const gk = labelResolvers.projectGroup(group);
                  if (!md.byProjectGroup[gk]) {
                    md.byProjectGroup[gk] = { cost: 0, count: 0 };
                  }
                  md.byProjectGroup[gk].cost += share;
                  md.byProjectGroup[gk].count += 1;
                  pushDetail(md.detailsByProjectGroup, gk, share);
                  if (!distributionCostFilters.projectGroup || gk === distributionCostFilters.projectGroup) {
                    monthCredited += share;
                  }
                });
              } else if (!distributionCostFilters.projectGroup) {
                const k = UNASSIGNED_PROJECT_GROUP_LABEL;
                if (!md.byProjectGroup[k]) {
                  md.byProjectGroup[k] = { cost: 0, count: 0 };
                }
                md.byProjectGroup[k].cost += monthlyCost;
                md.byProjectGroup[k].count += 1;
                pushDetail(md.detailsByProjectGroup, k, monthlyCost);
                monthCredited = monthlyCost;
                md.unassignedProjectGroupDetails.push({
                  segmentId: segment.id,
                  amount: monthlyCost,
                  reason: '无历程且无项目组',
                });
              }

              if (monthCredited <= 0 && !distributionCostFilters.projectGroup) {
                monthCredited = monthlyCost;
              }
              recordMonthFee(monthCredited);
              pushChargeKindDetail(md, kind, segment.id, monthCredited);
              pushSupplierUsageForAmount(monthCredited);
            }
          }
          
          currentMonth = currentMonth.add(1, 'month');
        }
      }
    });
    }
    
    return monthlyDistributions;
  }, [ipSegments, statistics.monthlyTrend, labelResolvers, monthlyFeeMode, distributionCostFilters]);
  
  // 准备饼图数据（上个月）
  const pieData = useMemo(() => {
    const now = dayjs();
    const lastMonthKey = now.subtract(1, 'month').format('YYYY-MM');
    const lastMonthData = getMonthlyDistribution[lastMonthKey] || {
      bySupplier: {},
      byUsageArea: {},
      byProjectGroup: {},
      totalCost: 0,
      costNewPurchase: 0,
      costRenewal: 0,
      unassignedProjectGroupDetails: [],
      detailsBySupplier: {},
      detailsByUsageArea: {},
      detailsByProjectGroup: {},
      detailsChargeNewPurchase: [],
      detailsChargeRenewal: [],
    };

    const distinctSegmentCount = (rows: { segmentId: string }[]) =>
      new Set(rows.map((r) => r.segmentId)).size;
    
    let data: { type: string; rawKey: string; value: number; count: number }[] = [];
    
    if (viewType === 'supplier') {
      data = Object.entries(lastMonthData.bySupplier).map(([key, value]) => ({
        type: key || '未知',
        rawKey: key,
        value: Number(value.cost.toFixed(2)),
        count: value.count,
      }));
    } else if (viewType === 'usageArea') {
      data = Object.entries(lastMonthData.byUsageArea).map(([key, value]) => ({
        type: key || '未知',
        rawKey: key,
        value: Number(value.cost.toFixed(2)),
        count: value.count,
      }));
    } else if (viewType === 'projectGroup') {
      data = Object.entries(lastMonthData.byProjectGroup).map(([key, value]) => ({
        type: key || '未知',
        rawKey: key,
        value: value.cost,
        count: value.count,
      }));
    } else if (viewType === 'chargeKind') {
      data = [
        {
          type: '新购',
          rawKey: 'newPurchase',
          value: Number(lastMonthData.costNewPurchase.toFixed(2)),
          count: distinctSegmentCount(lastMonthData.detailsChargeNewPurchase ?? []),
        },
        {
          type: '续费',
          rawKey: 'renewal',
          value: Number(lastMonthData.costRenewal.toFixed(2)),
          count: distinctSegmentCount(lastMonthData.detailsChargeRenewal ?? []),
        },
      ];
    }
    
    return data.sort((a, b) => b.value - a.value);
  }, [getMonthlyDistribution, viewType]);

  /** segmentId → segment 快查 */
  const segmentMap = useMemo(
    () => new Map(ipSegments.map((s) => [s.id, s])),
    [ipSegments]
  );

  type ChargeKindGroupRow = { label: string; cost: number; count: number; segmentIds: string[] };

  /** 根据费用明细数组，按供应商或项目组聚合，支持筛选 */
  const buildChargeKindGroupRows = useCallback(
    (
      details: { segmentId: string; amount: number }[],
      groupBy: 'supplier' | 'projectGroup',
      filterOpts?: { supplier?: string | null; projectGroup?: string | null }
    ): ChargeKindGroupRow[] => {
      const map: Record<string, { cost: number; seen: Set<string> }> = {};
      details.forEach(({ segmentId, amount }) => {
        const seg = segmentMap.get(segmentId);
        if (!seg) return;
        // 供应商筛选
        if (filterOpts?.supplier) {
          const sl = labelResolvers.supplier(seg.supplier) || '未知';
          if (sl !== filterOpts.supplier) return;
        }
        // 项目组筛选
        if (filterOpts?.projectGroup) {
          const groups = getEffectiveProjectGroups(seg).map((g) => labelResolvers.projectGroup(g));
          if (!groups.includes(filterOpts.projectGroup)) return;
        }
        if (groupBy === 'supplier') {
          const key = labelResolvers.supplier(seg.supplier) || '未知';
          if (!map[key]) map[key] = { cost: 0, seen: new Set() };
          map[key].cost += amount;
          map[key].seen.add(segmentId);
        } else {
          // 按项目组：一个 segment 可能属于多个项目组
          const groups = getEffectiveProjectGroups(seg).map((g) => labelResolvers.projectGroup(g));
          if (groups.length === 0) {
            const key = '未分配项目组';
            if (!map[key]) map[key] = { cost: 0, seen: new Set() };
            map[key].cost += amount;
            map[key].seen.add(segmentId);
          } else {
            groups.forEach((gLabel) => {
              if (!map[gLabel]) map[gLabel] = { cost: 0, seen: new Set() };
              map[gLabel].cost += amount / groups.length; // 按组均分
              map[gLabel].seen.add(segmentId);
            });
          }
        }
      });
      return Object.entries(map)
        .map(([label, v]) => ({
          label,
          cost: Number(v.cost.toFixed(2)),
          count: v.seen.size,
          segmentIds: [...v.seen],
        }))
        .sort((a, b) => b.cost - a.cost);
    },
    [segmentMap, labelResolvers]
  );

  /** 向后兼容旧调用 */
  const buildChargeKindSupplierRows = useCallback(
    (details: { segmentId: string; amount: number }[]) =>
      buildChargeKindGroupRows(details, 'supplier').map((r) => ({
        supplier: r.label,
        cost: r.cost,
        count: r.count,
      })),
    [buildChargeKindGroupRows]
  );

  // 计算百分比
  const getPercentage = (value: number, total: number) => {
    if (total === 0) return 0;
    return ((value / total) * 100).toFixed(1);
  };
  
  // 处理月份点击事件
  const handleMonthClick = (month: string) => {
    setSelectedMonth(month);
    setIsMonthDetailVisible(true);
  };
  
  // 获取选中月份的费用分布数据
  const selectedMonthData = useMemo(() => {
    if (!selectedMonth) return null;
    return getMonthlyDistribution[selectedMonth] || null;
  }, [selectedMonth, getMonthlyDistribution]);
  
  // 准备选中月份的饼图数据
  const selectedMonthPieData = useMemo(() => {
    if (!selectedMonthData) return [];
    
    let data: { type: string; rawKey: string; value: number; count: number }[] = [];
    
    if (viewType === 'supplier') {
      data = Object.entries(selectedMonthData.bySupplier).map(([key, value]) => ({
        type: key || '未知',
        rawKey: key,
        value: Number(value.cost.toFixed(2)),
        count: value.count,
      }));
    } else if (viewType === 'usageArea') {
      data = Object.entries(selectedMonthData.byUsageArea).map(([key, value]) => ({
        type: key || '未知',
        rawKey: key,
        value: Number(value.cost.toFixed(2)),
        count: value.count,
      }));
    } else if (viewType === 'projectGroup') {
      data = Object.entries(selectedMonthData.byProjectGroup).map(([key, value]) => ({
        type: key || '未知',
        rawKey: key,
        value: value.cost,
        count: value.count,
      }));
    } else if (viewType === 'chargeKind') {
      const distinctSegmentCount = (rows: { segmentId: string }[]) =>
        new Set(rows.map((r) => r.segmentId)).size;
      data = [
        {
          type: '新购',
          rawKey: 'newPurchase',
          value: Number(selectedMonthData.costNewPurchase.toFixed(2)),
          count: distinctSegmentCount(selectedMonthData.detailsChargeNewPurchase ?? []),
        },
        {
          type: '续费',
          rawKey: 'renewal',
          value: Number(selectedMonthData.costRenewal.toFixed(2)),
          count: distinctSegmentCount(selectedMonthData.detailsChargeRenewal ?? []),
        },
      ];
    }
    
    return data.sort((a, b) => b.value - a.value);
  }, [selectedMonthData, viewType]);

  const categoryDetailRows = useMemo(() => {
    if (!categoryDetailModal) return [];
    const m = getMonthlyDistribution[categoryDetailModal.monthKey];
    if (!m) return [];
    const { viewKind, categoryKey } = categoryDetailModal;

    const mapBasic = (list: { segmentId: string; amount: number }[]) =>
      [...list]
        .map((d, i) => ({
          key: `${d.segmentId}-${i}-${d.amount}`,
          segment: ipSegments.find((s) => s.id === d.segmentId)?.segment ?? d.segmentId,
          amount: d.amount,
        }))
        .sort((a, b) => b.amount - a.amount);

    if (viewKind === 'supplier') {
      return mapBasic(m.detailsBySupplier[categoryKey] ?? []);
    }
    if (viewKind === 'usageArea') {
      return mapBasic(m.detailsByUsageArea[categoryKey] ?? []);
    }
    if (viewKind === 'projectGroup' && categoryKey === UNASSIGNED_PROJECT_GROUP_LABEL) {
      return [...(m.unassignedProjectGroupDetails ?? [])]
        .map((d, i) => ({
          key: `${d.segmentId}-${i}-${d.amount}`,
          segment: ipSegments.find((s) => s.id === d.segmentId)?.segment ?? d.segmentId,
          amount: d.amount,
          reason: d.reason,
        }))
        .sort((a, b) => b.amount - a.amount);
    }
    if (viewKind === 'projectGroup') {
      return mapBasic(m.detailsByProjectGroup[categoryKey] ?? []);
    }
    if (viewKind === 'chargeKind') {
      // 支持 "newPurchase::supplier::某供应商" 格式（二级明细）
      if (categoryKey.includes('::')) {
        const [chargeKey, , groupLabel] = categoryKey.split('::');
        const fullList =
          chargeKey === 'newPurchase'
            ? m.detailsChargeNewPurchase ?? []
            : m.detailsChargeRenewal ?? [];
        const filtered = fullList.filter(({ segmentId }) => {
          const seg = ipSegments.find((s) => s.id === segmentId);
          if (!seg) return false;
          const parts = categoryKey.split('::');
          const gBy = parts[1]; // 'supplier' | 'projectGroup'
          if (gBy === 'supplier') {
            return (labelResolvers.supplier(seg.supplier) || '未知') === groupLabel;
          }
          const groups = getEffectiveProjectGroups(seg).map((g) => labelResolvers.projectGroup(g));
          return groups.includes(groupLabel) || (groups.length === 0 && groupLabel === '未分配项目组');
        });
        return mapBasic(filtered);
      }
      const list =
        categoryKey === 'newPurchase'
          ? m.detailsChargeNewPurchase ?? []
          : m.detailsChargeRenewal ?? [];
      return mapBasic(list);
    }
    return [];
  }, [categoryDetailModal, getMonthlyDistribution, ipSegments, labelResolvers]);

  const categoryDetailTitle = useMemo(() => {
    if (!categoryDetailModal) return '';
    const { monthKey, viewKind, categoryKey } = categoryDetailModal;

    if (viewKind === 'chargeKind' && categoryKey.includes('::')) {
      const [chargeKey, gBy, groupLabel] = categoryKey.split('::');
      const chargeLabel = chargeKey === 'newPurchase' ? '新购' : '续费';
      const dimLabel = gBy === 'supplier' ? '供应商' : '项目组';
      return `${monthKey} · ${chargeLabel} · ${dimLabel}「${groupLabel}」— IP段明细`;
    }

    const dim =
      viewKind === 'supplier'
        ? '供应商'
        : viewKind === 'usageArea'
          ? '使用地区'
          : viewKind === 'chargeKind'
            ? '费用类型'
            : '项目组';
    const label =
      viewKind === 'chargeKind'
        ? categoryKey === 'newPurchase'
          ? '新购'
          : '续费'
        : categoryKey || '未知';
    return `${monthKey} · ${dim}「${label}」— IP段明细`;
  }, [categoryDetailModal]);

  const categoryDetailColumns: ColumnsType<{
    key: string;
    segment: string;
    amount: number;
    reason?: string;
  }> = useMemo(() => {
    const showReason =
      categoryDetailModal?.viewKind === 'projectGroup' &&
      categoryDetailModal.categoryKey === UNASSIGNED_PROJECT_GROUP_LABEL;
    const cols: ColumnsType<{
      key: string;
      segment: string;
      amount: number;
      reason?: string;
    }> = [
      { title: 'IP段', dataIndex: 'segment', key: 'segment', ellipsis: true },
      {
        title: '金额($)',
        dataIndex: 'amount',
        key: 'amount',
        width: 120,
        align: 'right',
        render: (v: number) => `$${v.toFixed(2)}`,
      },
    ];
    if (showReason) {
      cols.push({ title: '原因', dataIndex: 'reason', key: 'reason', ellipsis: true });
    }
    return cols;
  }, [categoryDetailModal]);

  // 详细费用表格列定义
  const detailColumns: ColumnsType<any> = [
    {
      title: 'IP段',
      dataIndex: 'segment',
      key: 'segment',
      width: 150,
    },
    {
      title: '使用地区',
      dataIndex: 'usageArea',
      key: 'usageArea',
      width: 120,
    },
    {
      title: '供应商',
      dataIndex: 'supplier',
      key: 'supplier',
      width: 120,
    },
    {
      title: '项目组',
      dataIndex: 'projectGroups',
      key: 'projectGroups',
      width: 150,
      render: (groups: string[]) => (
        <Space wrap>
          {groups && groups.length > 0 ? (
            groups.map(group => <Tag key={group}>{group}</Tag>)
          ) : (
            <Text type="secondary">-</Text>
          )}
        </Space>
      ),
    },
    {
      title: '费用($)',
      dataIndex: 'cost',
      key: 'cost',
      width: 120,
      align: 'right' as const,
      render: (cost: number) => `$${cost.toFixed(2)}`,
      sorter: (a: any, b: any) => a.cost - b.cost,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const statusMap: { [key: string]: { color: string; text: string } } = {
          active: { color: 'green', text: '正常' },
          cancelledButNotExpired: { color: 'orange', text: '已取消未到期' },
          cancelled: { color: 'red', text: '已取消' },
        };
        const statusInfo = statusMap[status] || { color: 'default', text: status };
        return <Tag color={statusInfo.color}>{statusInfo.text}</Tag>;
      },
    },
  ];

  // 准备详细费用表格数据
  const detailTableData = useMemo(() => {
    const now = dayjs();
    return ipSegments
      .filter((segment) => segmentPassesCostSegmentFilters(segment, baseCostFilters, labelResolvers))
      .map(segment => {
      const cost = applyMonthlyUsdWithOptionalIpxoFee(getDisplayMonthlyPrice(segment), segment.supplier);
      let status = 'active';
      
      if (segment.renewalStatus === 'cancelled' || segment.cancellationDate) {
        const expiryDate = calculateCancelledExpiryDate(segment);
        if (expiryDate && expiryDate.isAfter(now)) {
          status = 'cancelledButNotExpired';
        } else {
          status = 'cancelled';
        }
      }
      
      return {
        key: segment.id,
        segment: segment.segment,
        usageArea: labelResolvers.usageArea(segment.usageArea),
        supplier: labelResolvers.supplier(segment.supplier),
        projectGroups: getEffectiveProjectGroups(segment).map((g) => labelResolvers.projectGroup(g)),
        cost,
        status,
      };
    });
  }, [ipSegments, labelResolvers, baseCostFilters]);

  useEffect(() => {
    if (detailTableData.length === 0) return;
    const totalPages = Math.max(1, Math.ceil(detailTableData.length / detailTablePageSize));
    if (detailTablePage > totalPages) setDetailTablePage(totalPages);
  }, [detailTableData.length, detailTablePageSize, detailTablePage]);

  // 导出数据
  const handleExport = () => {
    try {
      const headers = ['IP段', '使用地区', '供应商', '项目组', '费用($)', '状态'];
      const rows = detailTableData.map(item => [
        item.segment,
        item.usageArea || '',
        item.supplier || '',
        (item.projectGroups || []).join(';'),
        item.cost.toFixed(2),
        item.status === 'active' ? '正常' : item.status === 'cancelledButNotExpired' ? '已取消未到期' : '已取消',
      ]);

      const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `IP段费用统计-${dayjs().format('YYYY-MM-DD')}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('导出失败:', error);
    }
  };

  return (
    <div style={{ padding: '24px', background: '#f0f2f5', minHeight: '100vh' }}>
      {/* 页面标题和操作栏 */}
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <Title level={2} style={{ margin: 0 }}>费用统计与分析</Title>
          <Text type="secondary">实时监控IP段费用支出趋势与详细构成</Text>
        </div>
        <Space>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>
            导出数据
          </Button>
        </Space>
      </div>

      {/* 总支出统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={24}>
          <Card>
            <Row gutter={16}>
              <Col span={6}>
                <Statistic
                  title="总费用（美元）"
                  value={statistics.totalCost}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#722ed1', fontSize: '28px' }}
                />
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">正常使用中 + 已取消未到期；仅 IPXO 供应商在月费基础上加收 4% 手续费</Text>
                </div>
              </Col>
              <Col span={6}>
                <Statistic
                  title="正常IP段费用"
                  value={statistics.activeCost}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#52c41a', fontSize: '24px' }}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="已取消但未到期费用"
                  value={statistics.cancelledButNotExpiredCost}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#faad14', fontSize: '24px' }}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="已取消IP段费用"
                  value={statistics.cancelledCost}
                  prefix="$"
                  precision={2}
                  valueStyle={{ color: '#ff4d4f', fontSize: '24px' }}
                />
              </Col>
            </Row>
          </Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginBottom: 24 }} styles={{ body: { paddingBottom: 12 } }}>
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Space wrap align="center">
            <Text strong>月度费用统计口径：</Text>
            <Segmented
              value={monthlyFeeMode}
              onChange={(v) => setMonthlyFeeMode(v as MonthlyFeeStatisticMode)}
              options={[
                { label: '按日历天折算', value: 'dailyProRata' },
                { label: '按入账月（购买/续费日）', value: 'billingAnchors' },
              ]}
            />
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {monthlyFeeMode === 'dailyProRata'
              ? '各自然月费用 = 该月覆盖到的实际日历天数 ×（月费 ÷ 当月总天数）。购买日所在自然月计为「新购」，之后各自然月计为「续费」。'
              : '购买日/首个账单日计为「新购」；之后每期账单日（购买日按月顺延）计为「续费」。仅当今天 ≥ 账单日才计入；取消续费后不再产生晚于取消日的续费账单。项目组按账单日当天历程判断。'}
          </Text>
        </Space>
      </Card>

      {/* 费用分布和趋势 */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={12}>
          <Card
            title={
              <Space>
                <PieChartOutlined />
                <span>费用分布</span>
              </Space>
            }
            extra={
              <Space wrap>
                {viewType !== 'chargeKind' && (
                  <Segmented
                    size="small"
                    value={distributionChargeKind}
                    onChange={(v) =>
                      setDistributionChargeKind(v as CostAnalysisFilters['chargeKind'])
                    }
                    options={[
                      { label: '全部', value: 'all' },
                      { label: '新购', value: 'newPurchase' },
                      { label: '续费', value: 'renewal' },
                    ]}
                  />
                )}
                <Select
                  value={viewType}
                  onChange={(v) => setViewType(v as typeof viewType)}
                  style={{ width: 128 }}
                  options={[
                    { label: '按供应商', value: 'supplier' },
                    { label: '按使用地区', value: 'usageArea' },
                    { label: '按项目组', value: 'projectGroup' },
                    { label: '按费用类型', value: 'chargeKind' },
                  ]}
                />
              </Space>
            }
          >
            {pieData.length > 0 ? (
              <div>
                <div style={{ marginBottom: 16, padding: '8px 12px', background: '#e6f7ff', borderRadius: '4px' }}>
                  {(() => {
                    const lm = getMonthlyDistribution[dayjs().subtract(1, 'month').format('YYYY-MM')];
                    return (
                      <>
                        <Text strong>上个月（{dayjs().subtract(1, 'month').format('YYYY-MM')}）总费用：</Text>
                        <Text style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff', marginLeft: 8 }}>
                          ${lm?.totalCost.toFixed(2) || '0.00'}
                        </Text>
                        <Text type="secondary" style={{ marginLeft: 16, fontSize: 12 }}>
                          新购 ${lm?.costNewPurchase.toFixed(2) ?? '0.00'} · 续费 $
                          {lm?.costRenewal.toFixed(2) ?? '0.00'}
                        </Text>
                      </>
                    );
                  })()}
                </div>
                {viewType === 'chargeKind' ? (
                  /* ── 按费用类型：展示新购/续费各自的供应商/项目组明细，支持筛选和点击查看 ── */
                  (() => {
                    const lastMonthKeyStr = dayjs().subtract(1, 'month').format('YYYY-MM');
                    const lmDist = getMonthlyDistribution[lastMonthKeyStr];
                    const filterOpts = {
                      supplier: chargeKindSubSupplier,
                      projectGroup: chargeKindSubProjectGroup,
                    };
                    const groupCols = [
                      {
                        title: chargeKindSubView === 'supplier' ? '供应商' : '项目组',
                        dataIndex: 'label',
                        key: 'label',
                        ellipsis: true,
                        render: (text: string, record: ChargeKindGroupRow & { chargeKey: string }) => (
                          <a
                            onClick={() =>
                              setCategoryDetailModal({
                                monthKey: lastMonthKeyStr,
                                viewKind: 'chargeKind',
                                categoryKey: `${record.chargeKey}::${chargeKindSubView}::${text}`,
                              })
                            }
                          >
                            {text}
                          </a>
                        ),
                      },
                      { title: 'IP段数', dataIndex: 'count', key: 'count', width: 76, align: 'right' as const },
                      {
                        title: '费用($)', dataIndex: 'cost', key: 'cost', width: 110, align: 'right' as const,
                        render: (v: number) => `$${v.toFixed(2)}`,
                      },
                    ];
                    const kinds = [
                      {
                        label: '新购', key: 'newPurchase',
                        total: lmDist?.costNewPurchase ?? 0,
                        details: lmDist?.detailsChargeNewPurchase ?? [],
                      },
                      {
                        label: '续费', key: 'renewal',
                        total: lmDist?.costRenewal ?? 0,
                        details: lmDist?.detailsChargeRenewal ?? [],
                      },
                    ];
                    return (
                      <div>
                        <Space wrap size="middle" style={{ marginBottom: 12 }}>
                          <Segmented
                            size="small"
                            value={chargeKindSubView}
                            onChange={(v) => setChargeKindSubView(v as 'supplier' | 'projectGroup')}
                            options={[
                              { label: '按供应商', value: 'supplier' },
                              { label: '按项目组', value: 'projectGroup' },
                            ]}
                          />
                          <Select
                            allowClear
                            placeholder="筛选供应商"
                            size="small"
                            style={{ minWidth: 130 }}
                            value={chargeKindSubSupplier}
                            onChange={setChargeKindSubSupplier}
                            options={filterSupplierOptions}
                          />
                          <Select
                            allowClear
                            placeholder="筛选项目组"
                            size="small"
                            style={{ minWidth: 130 }}
                            value={chargeKindSubProjectGroup}
                            onChange={setChargeKindSubProjectGroup}
                            options={filterProjectGroupOptions}
                          />
                          {(chargeKindSubSupplier || chargeKindSubProjectGroup) && (
                            <Button
                              type="link"
                              size="small"
                              onClick={() => { setChargeKindSubSupplier(null); setChargeKindSubProjectGroup(null); }}
                            >
                              清空
                            </Button>
                          )}
                        </Space>
                        <Row gutter={[16, 16]}>
                          {kinds.map(({ label, key, total, details }) => {
                            const rows = buildChargeKindGroupRows(details, chargeKindSubView, filterOpts);
                            const filteredTotal = rows.reduce((s, r) => s + r.cost, 0);
                            const filteredCount = rows.reduce((s, r) => s + r.count, 0);
                            return (
                              <Col span={24} key={key}>
                                <Card
                                  size="small"
                                  title={
                                    <Space>
                                      <Text strong style={{ fontSize: 15 }}>{label}</Text>
                                      <Text style={{ color: '#1890ff', fontWeight: 'bold' }}>
                                        ${filteredTotal.toFixed(2)}
                                      </Text>
                                      <Text type="secondary" style={{ fontSize: 12 }}>
                                        {filteredCount} 个IP段
                                      </Text>
                                      {(chargeKindSubSupplier || chargeKindSubProjectGroup) && (
                                        <Text type="secondary" style={{ fontSize: 11 }}>
                                          (总 ${total.toFixed(2)})
                                        </Text>
                                      )}
                                    </Space>
                                  }
                                >
                                  <Table
                                    size="small"
                                    pagination={false}
                                    dataSource={rows.map((r, i) => ({ ...r, key: i, chargeKey: key }))}
                                    columns={groupCols as any}
                                    locale={{ emptyText: '暂无数据' }}
                                  />
                                </Card>
                              </Col>
                            );
                          })}
                        </Row>
                      </div>
                    );
                  })()
                ) : (
                  <Row gutter={[16, 16]}>
                    {pieData.map((item, index) => {
                      const lastMonthKeyStr = dayjs().subtract(1, 'month').format('YYYY-MM');
                      const lastMonthTotal = getMonthlyDistribution[lastMonthKeyStr]?.totalCost || 0;
                      const percentage = getPercentage(item.value, lastMonthTotal);
                      const openCategoryDetail =
                        item.value > 0
                          ? () =>
                              setCategoryDetailModal({
                                monthKey: lastMonthKeyStr,
                                viewKind: viewType,
                                categoryKey: item.rawKey,
                              })
                          : undefined;
                      const cardInner = (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div>
                            <Text strong>{item.type}</Text>
                            <div style={{ marginTop: 4 }}>
                              <Text type="secondary">{item.count} 个IP段</Text>
                              <Text type="secondary" style={{ marginLeft: 8 }}>{percentage}%</Text>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <Text style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
                              ${item.value.toFixed(2)}
                            </Text>
                          </div>
                        </div>
                      );
                      return (
                        <Col span={12} key={index}>
                          {openCategoryDetail ? (
                            <Tooltip title="点击查看该分类下的 IP 段明细">
                              <Card
                                size="small"
                                style={{ cursor: 'pointer' }}
                                onClick={openCategoryDetail}
                              >
                                {cardInner}
                              </Card>
                            </Tooltip>
                          ) : (
                            <Card size="small">{cardInner}</Card>
                          )}
                        </Col>
                      );
                    })}
                  </Row>
                )}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                <Text type="secondary">暂无数据</Text>
              </div>
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card
            title={
              <Space>
                <BarChartOutlined />
                <span>月度费用趋势</span>
              </Space>
            }
          >
            {statistics.monthlyTrend.length > 0 ? (
              <div>
                <Table
                  dataSource={statistics.monthlyTrend.map((item, index) => {
                    // 计算涨跌百分比
                    let changePercent: number | null = null;
                    if (index < statistics.monthlyTrend.length - 1) {
                      // 有上个月的数据
                      const prevCost = statistics.monthlyTrend[index + 1].cost;
                      if (prevCost > 0) {
                        changePercent = ((item.cost - prevCost) / prevCost) * 100;
                      }
                    }
                    return { ...item, key: index, changePercent };
                  })}
                  columns={[
                    {
                      title: '月份',
                      dataIndex: 'month',
                      key: 'month',
                      render: (month: string) => (
                        <span
                          onClick={() => handleMonthClick(month)}
                          style={{
                            cursor: 'pointer',
                            color: '#1890ff',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.textDecoration = 'underline';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.textDecoration = 'none';
                          }}
                        >
                          {month}
                        </span>
                      ),
                    },
                    {
                      title: '费用($)',
                      dataIndex: 'cost',
                      key: 'cost',
                      align: 'right' as const,
                      render: (cost: number) => `$${cost.toFixed(2)}`,
                      sorter: (a: any, b: any) => a.cost - b.cost,
                    },
                    {
                      title: '新购($)',
                      dataIndex: 'costNewPurchase',
                      key: 'costNewPurchase',
                      align: 'right' as const,
                      render: (v: number) => `$${(v ?? 0).toFixed(2)}`,
                    },
                    {
                      title: '续费($)',
                      dataIndex: 'costRenewal',
                      key: 'costRenewal',
                      align: 'right' as const,
                      render: (v: number) => `$${(v ?? 0).toFixed(2)}`,
                    },
                    {
                      title: '涨跌',
                      dataIndex: 'changePercent',
                      key: 'changePercent',
                      align: 'right' as const,
                      render: (changePercent: number | null) => {
                        if (changePercent === null) {
                          return <Text type="secondary" style={{ fontSize: 13 }}>-</Text>;
                        }
                        const isIncrease = changePercent > 0;
                        const isDecrease = changePercent < 0;
                        const absPercent = Math.abs(changePercent);
                        const color = isIncrease ? '#ff4d4f' : isDecrease ? '#52c41a' : '#8c8c8c';
                        const bgColor = isIncrease ? '#fff1f0' : isDecrease ? '#f6ffed' : '#fafafa';
                        
                        return (
                          <div style={{ 
                            display: 'inline-flex', 
                            alignItems: 'center',
                            padding: '2px 6px',
                            borderRadius: 4,
                            backgroundColor: bgColor,
                            fontSize: 12,
                          }}>
                            {isIncrease && (
                              <ArrowUpOutlined 
                                style={{ 
                                  color, 
                                  fontSize: 11,
                                  marginRight: 3,
                                }} 
                              />
                            )}
                            {isDecrease && (
                              <ArrowDownOutlined 
                                style={{ 
                                  color, 
                                  fontSize: 11,
                                  marginRight: 3,
                                }} 
                              />
                            )}
                            <Text style={{ color, fontSize: 12 }}>
                              {absPercent.toFixed(2)}%
                            </Text>
                          </div>
                        );
                      },
                    },
                  ]}
                  pagination={false}
                  size="small"
                />
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                <Text type="secondary">暂无数据</Text>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* 详细费用表格 */}
      <Card title="全部详细费用">
        <Table
          columns={detailColumns}
          dataSource={detailTableData}
          scroll={{ x: 1200 }}
          pagination={{
            current: detailTablePage,
            pageSize: detailTablePageSize,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total) => `共 ${total} 条记录`,
            onChange: (page, size) => {
              setDetailTablePage(page);
              if (size) setDetailTablePageSize(size);
            },
            onShowSizeChange: (_current, size) => {
              setDetailTablePage(1);
              setDetailTablePageSize(size);
            },
          }}
        />
      </Card>

      {/* 月份费用分布详情模态框 */}
      <Modal
        title={`${selectedMonth} 费用分布详情`}
        open={isMonthDetailVisible}
        onCancel={() => setIsMonthDetailVisible(false)}
        footer={null}
        width={800}
      >
        {selectedMonthData ? (
          <div>
            <div style={{ marginBottom: 16, padding: '12px', background: '#e6f7ff', borderRadius: '4px' }}>
              <Text strong>该月总费用：</Text>
              <Text style={{ fontSize: '20px', fontWeight: 'bold', color: '#1890ff', marginLeft: 8 }}>
                ${selectedMonthData.totalCost.toFixed(2)}
              </Text>
              <Text type="secondary" style={{ marginLeft: 16 }}>
                新购 ${selectedMonthData.costNewPurchase.toFixed(2)} · 续费 $
                {selectedMonthData.costRenewal.toFixed(2)}
              </Text>
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <Space wrap>
                <Text strong>查看方式：</Text>
                {viewType !== 'chargeKind' && (
                  <Segmented
                    size="small"
                    value={distributionChargeKind}
                    onChange={(v) =>
                      setDistributionChargeKind(v as CostAnalysisFilters['chargeKind'])
                    }
                    options={[
                      { label: '全部', value: 'all' },
                      { label: '新购', value: 'newPurchase' },
                      { label: '续费', value: 'renewal' },
                    ]}
                  />
                )}
                <Select
                  value={viewType}
                  onChange={(v) => setViewType(v as typeof viewType)}
                  style={{ width: 128 }}
                  options={[
                    { label: '按供应商', value: 'supplier' },
                    { label: '按使用地区', value: 'usageArea' },
                    { label: '按项目组', value: 'projectGroup' },
                    { label: '按费用类型', value: 'chargeKind' },
                  ]}
                />
              </Space>
            </div>
            
            {selectedMonthPieData.length > 0 || viewType === 'chargeKind' ? (
              viewType === 'chargeKind' ? (
                /* ── 按费用类型：展示新购/续费各自的供应商/项目组明细（月份弹窗） ── */
                (() => {
                  const monthKeyStr = selectedMonth!;
                  const filterOpts = {
                    supplier: chargeKindSubSupplier,
                    projectGroup: chargeKindSubProjectGroup,
                  };
                  const groupCols = [
                    {
                      title: chargeKindSubView === 'supplier' ? '供应商' : '项目组',
                      dataIndex: 'label',
                      key: 'label',
                      ellipsis: true,
                      render: (text: string, record: ChargeKindGroupRow & { chargeKey: string }) => (
                        <a
                          onClick={() =>
                            setCategoryDetailModal({
                              monthKey: monthKeyStr,
                              viewKind: 'chargeKind',
                              categoryKey: `${record.chargeKey}::${chargeKindSubView}::${text}`,
                            })
                          }
                        >
                          {text}
                        </a>
                      ),
                    },
                    { title: 'IP段数', dataIndex: 'count', key: 'count', width: 76, align: 'right' as const },
                    {
                      title: '费用($)', dataIndex: 'cost', key: 'cost', width: 110, align: 'right' as const,
                      render: (v: number) => `$${v.toFixed(2)}`,
                    },
                  ];
                  const kinds = [
                    {
                      label: '新购', key: 'newPurchase',
                      total: selectedMonthData.costNewPurchase,
                      details: selectedMonthData.detailsChargeNewPurchase ?? [],
                    },
                    {
                      label: '续费', key: 'renewal',
                      total: selectedMonthData.costRenewal,
                      details: selectedMonthData.detailsChargeRenewal ?? [],
                    },
                  ];
                  return (
                    <div>
                      <Space wrap size="middle" style={{ marginBottom: 12 }}>
                        <Segmented
                          size="small"
                          value={chargeKindSubView}
                          onChange={(v) => setChargeKindSubView(v as 'supplier' | 'projectGroup')}
                          options={[
                            { label: '按供应商', value: 'supplier' },
                            { label: '按项目组', value: 'projectGroup' },
                          ]}
                        />
                        <Select
                          allowClear
                          placeholder="筛选供应商"
                          size="small"
                          style={{ minWidth: 130 }}
                          value={chargeKindSubSupplier}
                          onChange={setChargeKindSubSupplier}
                          options={filterSupplierOptions}
                        />
                        <Select
                          allowClear
                          placeholder="筛选项目组"
                          size="small"
                          style={{ minWidth: 130 }}
                          value={chargeKindSubProjectGroup}
                          onChange={setChargeKindSubProjectGroup}
                          options={filterProjectGroupOptions}
                        />
                        {(chargeKindSubSupplier || chargeKindSubProjectGroup) && (
                          <Button
                            type="link"
                            size="small"
                            onClick={() => { setChargeKindSubSupplier(null); setChargeKindSubProjectGroup(null); }}
                          >
                            清空
                          </Button>
                        )}
                      </Space>
                      <Row gutter={[16, 16]}>
                        {kinds.map(({ label, key, total, details }) => {
                          const rows = buildChargeKindGroupRows(details, chargeKindSubView, filterOpts);
                          const filteredTotal = rows.reduce((s, r) => s + r.cost, 0);
                          const filteredCount = rows.reduce((s, r) => s + r.count, 0);
                          return (
                            <Col span={24} key={key}>
                              <Card
                                size="small"
                                title={
                                  <Space>
                                    <Text strong style={{ fontSize: 15 }}>{label}</Text>
                                    <Text style={{ color: '#1890ff', fontWeight: 'bold' }}>
                                      ${filteredTotal.toFixed(2)}
                                    </Text>
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                      {filteredCount} 个IP段
                                    </Text>
                                    {(chargeKindSubSupplier || chargeKindSubProjectGroup) && (
                                      <Text type="secondary" style={{ fontSize: 11 }}>
                                        (总 ${total.toFixed(2)})
                                      </Text>
                                    )}
                                  </Space>
                                }
                              >
                                <Table
                                  size="small"
                                  pagination={false}
                                  dataSource={rows.map((r, i) => ({ ...r, key: i, chargeKey: key }))}
                                  columns={groupCols as any}
                                  locale={{ emptyText: '暂无数据' }}
                                />
                              </Card>
                            </Col>
                          );
                        })}
                      </Row>
                    </div>
                  );
                })()
              ) : (
              <Row gutter={[16, 16]}>
                {selectedMonthPieData.map((item, index) => {
                  const percentage = getPercentage(item.value, selectedMonthData.totalCost);
                  const openCategoryDetail =
                    item.value > 0 && selectedMonth
                      ? () =>
                          setCategoryDetailModal({
                            monthKey: selectedMonth,
                            viewKind: viewType,
                            categoryKey: item.rawKey,
                          })
                      : undefined;
                  const cardInner = (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <Text strong>{item.type}</Text>
                        <div style={{ marginTop: 4 }}>
                          <Text type="secondary">{item.count} 个IP段</Text>
                          <Text type="secondary" style={{ marginLeft: 8 }}>{percentage}%</Text>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <Text style={{ fontSize: '18px', fontWeight: 'bold', color: '#1890ff' }}>
                          ${item.value.toFixed(2)}
                        </Text>
                      </div>
                    </div>
                  );
                  return (
                    <Col span={12} key={index}>
                      {openCategoryDetail ? (
                        <Tooltip title="点击查看该分类下的 IP 段明细">
                          <Card
                            size="small"
                            style={{ cursor: 'pointer' }}
                            onClick={openCategoryDetail}
                          >
                            {cardInner}
                          </Card>
                        </Tooltip>
                      ) : (
                        <Card size="small">{cardInner}</Card>
                      )}
                    </Col>
                  );
                })}
              </Row>
              )
            ) : (
              <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                <Text type="secondary">该月暂无数据</Text>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
            <Text type="secondary">加载中...</Text>
          </div>
        )}
      </Modal>

      <Modal
        title={categoryDetailTitle || 'IP段明细'}
        open={categoryDetailModal !== null}
        onCancel={() => setCategoryDetailModal(null)}
        footer={null}
        width={760}
        destroyOnClose
      >
        <Table
          size="small"
          columns={categoryDetailColumns}
          dataSource={categoryDetailRows}
          pagination={false}
          scroll={{ y: 480 }}
          locale={{ emptyText: '暂无明细' }}
        />
        {categoryDetailRows.length > 0 && (
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Text type="secondary">
              合计：$
              {categoryDetailRows.reduce((s, r) => s + r.amount, 0).toFixed(2)}
            </Text>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default CostAnalysis;

