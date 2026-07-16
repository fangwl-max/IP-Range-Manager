import React, { useState, useEffect, useMemo } from 'react';
import {
  Table,
  Button,
  Space,
  Modal,
  Form,
  Input,
  InputNumber,
  DatePicker,
  Select,
  Tag,
  Popconfirm,
  message,
  Card,
  Row,
  Col,
  Divider,
  Tabs,
  Typography,
  Collapse,
  Tooltip,
  Popover,
  Segmented,
  Switch,
  Checkbox,
} from 'antd';
import {
  PlusOutlined,
  MinusCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  UploadOutlined,
  DownloadOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { IPSegment, IPSegmentHistory, ServerLocation, ProjectGroup, Supplier, BlockedCountry, BLOCKED_COUNTRY_OPTIONS, RenewalStatus, RENEWAL_STATUS_OPTIONS, RENEWAL_STATUS_DISPLAY, UsageAreaOption, DEFAULT_USAGE_AREA_OPTIONS, PRESET_COLORS } from '../types';
import { ipSegmentStorage, projectGroupStorage, supplierStorage, usageAreaStorage, asnStorage, asnGroupStorage } from '../utils/storage';
import { buildUsageAreaMasters, resolveMasterLabel, usageAreaMatchKey } from '../utils/displayNames';
import { normalizeBatchImportFields } from '../utils/batchImportNormalize';
import { normalizeAsnDigitsOnly } from '../utils/asn-normalize';
import {
  getEffectiveProjectGroups,
  getProjectGroupsFromHistorySync,
  segmentHasOverlappingHistory,
} from '../utils/history-overlap';
import { applyMonthlyUsdWithOptionalIpxoFee, isIpxoSupplier } from '../utils/supplier-fee';
import { useAuth } from '../contexts/AuthContext';

// Interlir 供应商使用欧元，换算为美元的汇率（1 EUR ≈ X USD）
const EUR_TO_USD_RATE = 1.08;
const INTERLIR_SUPPLIER = 'Interlir';

/** 各子 Tab 大表共用：virtual 必须配 scroll.y，减少「全表几千行 DOM」导致的切换卡顿 */
/** 与各列 width 之和匹配，大屏下列可完整展示且不挤换行（续费时间等日期列单行） */
const IP_SEGMENT_TABLE_VIRTUAL_SCROLL = { x: 2280, y: 560 } as const;

/** 列表勾选列宽度（Ant Design Table rowSelection.columnWidth） */
const TABLE_SELECTION_COLUMN_WIDTH = 46;

// 获取显示用月费用（美元）：Interlir 为欧元需转换
function getDisplayMonthlyPrice(segment: { monthlyPrice?: number; supplier?: unknown }): number {
  const price = segment.monthlyPrice || 0;
  if (String(segment.supplier ?? '').toLowerCase() === INTERLIR_SUPPLIER.toLowerCase()) {
    return price * EUR_TO_USD_RATE;
  }
  return price;
}

/** 近期续费/展示用：美元月费，仅 IPXO 供应商再 ×1.04 */
function getBillableMonthlyUsdForSegment(segment: IPSegment): number {
  return applyMonthlyUsdWithOptionalIpxoFee(getDisplayMonthlyPrice(segment), segment.supplier);
}

function upcomingRenewalPriceTooltipTitle(record: IPSegment): string {
  const displayPrice = getDisplayMonthlyPrice(record);
  const billed = getBillableMonthlyUsdForSegment(record);
  const isInterlir = String(record.supplier ?? '').toLowerCase() === INTERLIR_SUPPLIER.toLowerCase();
  if (isInterlir) {
    const feeLine = isIpxoSupplier(record.supplier)
      ? `IPXO 加收4%后: $${billed.toFixed(2)}`
      : `应付（美元）: $${billed.toFixed(2)}`;
    return `原价: €${(record.monthlyPrice || 0).toFixed(2)} (EUR) ≈ $${displayPrice.toFixed(2)} (USD)\n汇率: 1 EUR = ${EUR_TO_USD_RATE} USD\n${feeLine}`;
  }
  return isIpxoSupplier(record.supplier)
    ? `含4%手续费（仅IPXO）: $${billed.toFixed(2)}`
    : `月费（美元）: $${billed.toFixed(2)}`;
}

// 根据文本为未记录的使用地区生成稳定背景色（相同文本始终得到相同颜色）
function getColorForUnknownUsageArea(areaName: string): string {
  let hash = 0;
  const str = String(areaName || '');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  const idx = Math.abs(hash) % PRESET_COLORS.length;
  return PRESET_COLORS[idx];
}

/** 购买时间列：悬浮展示历史购买日（多次购买） */
function purchaseDateTooltipTitle(segment: IPSegment, displayDate: string): React.ReactNode {
  const prev = [...(segment.previousPurchaseDates || [])]
    .filter(Boolean)
    .sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());
  if (prev.length > 0) {
    return (
      <div style={{ maxWidth: 300 }}>
        <div>当前（最近）购买：{displayDate}</div>
        <div style={{ marginTop: 8 }}>此前购买：</div>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {prev.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (segment.multiPurchaseMarked) {
    return (
      <div>
        已标记多次购买；当前购买日：{displayDate}
        <br />
        可在编辑中填写「历史购买日期」以便在此查看。
      </div>
    );
  }
  return null;
}

/**
 * 修复：取消续费后又再次购买时，仍保留 cancellationDate / 取消状态会导致一直归在「已取消」，
 * 且 loadData 会把「最后一条历程」的结束日强行写成旧周期到期日，出现结束日早于开始日（负使用时长）。
 * 若最后一段历程的开始日晚于上一段结束日或晚于取消周期到期日，则视为重新启用并清空取消信息，并修正非法结束日。
 */
function normalizeSegmentHistoryAndRepurchaseSegment(
  segment: IPSegment,
  calcCancelledExpiry: (s: IPSegment) => dayjs.Dayjs | null
): { segment: IPSegment; changed: boolean } {
  if (!segment.history || segment.history.length === 0) {
    return { segment, changed: false };
  }

  const sorted = [...segment.history].sort(
    (a, b) => dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
  );
  const last = sorted[sorted.length - 1];
  let changed = false;
  let history = segment.history;

  if (last.endDate && dayjs(last.endDate).isBefore(dayjs(last.startDate), 'day')) {
    history = history.map((h) =>
      h.id === last.id
        ? { ...h, endDate: undefined, updatedAt: new Date().toISOString() }
        : h
    );
    changed = true;
  }

  const prevMaxEnd = sorted.slice(0, -1).reduce<dayjs.Dayjs | null>((acc, h) => {
    if (!h.endDate) return acc;
    const d = dayjs(h.endDate);
    if (!d.isValid()) return acc;
    return !acc || d.isAfter(acc) ? d : acc;
  }, null);

  const expiryDate = calcCancelledExpiry(segment);
  const lastStart = dayjs(last.startDate);
  const isCancelled =
    segment.renewalStatus === 'cancelled' || !!(segment.cancellationDate && segment.cancellationDate.trim());

  let repurchase = false;
  if (isCancelled) {
    if (prevMaxEnd && lastStart.isAfter(prevMaxEnd, 'day')) repurchase = true;
    if (expiryDate && lastStart.isAfter(expiryDate, 'day')) repurchase = true;
  }

  if (!repurchase) {
    return changed
      ? { segment: { ...segment, history, updatedAt: new Date().toISOString() }, changed: true }
      : { segment, changed: false };
  }

  let cancellationDate = '';
  const renewalStatus: RenewalStatus =
    segment.renewalStatus === 'cancelled' ? 'not_renewed' : segment.renewalStatus;

  return {
    segment: {
      ...segment,
      cancellationDate,
      renewalStatus,
      history,
      updatedAt: new Date().toISOString(),
    },
    changed: true,
  };
}

const IPManagement: React.FC = () => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('edit_ip');
  const canDelete = hasPermission('delete_ip');
  const canImportExport = hasPermission('import_export');
  const [ipSegments, setIpSegments] = useState<IPSegment[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [usageAreas, setUsageAreas] = useState<UsageAreaOption[]>([]);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isBatchImportVisible, setIsBatchImportVisible] = useState(false);
  const [isBatchEditVisible, setIsBatchEditVisible] = useState(false);
  const [isTextBatchEditVisible, setIsTextBatchEditVisible] = useState(false);
  const [textBatchEditValue, setTextBatchEditValue] = useState('');
  const [textBatchEditForm] = Form.useForm();
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [cancelledButNotExpiredSelectedKeys, setCancelledButNotExpiredSelectedKeys] = useState<React.Key[]>([]);
  const [cancelledSelectedKeys, setCancelledSelectedKeys] = useState<React.Key[]>([]);
  const [allSegmentsSelectedKeys, setAllSegmentsSelectedKeys] = useState<React.Key[]>([]);
  const [previewSelectedRowKeys, setPreviewSelectedRowKeys] = useState<React.Key[]>([]);
  const [isPreviewBatchEditVisible, setIsPreviewBatchEditVisible] = useState(false);
  const [activeTabKey, setActiveTabKey] = useState<string>('active');
  const [editingSegment, setEditingSegment] = useState<IPSegment | null>(null);
  const [batchTableData, setBatchTableData] = useState<Partial<IPSegment>[]>([]);
  const [textImportValue, setTextImportValue] = useState('');
  const [blockedInfoImportValue, setBlockedInfoImportValue] = useState('');
  const [filteredSupplier, setFilteredSupplier] = useState<string | undefined>(undefined);
  const [filteredSegment, setFilteredSegment] = useState<string>('');
  const [sortBySearchOrder, setSortBySearchOrder] = useState(false);
  const [filteredUpcomingProjectGroup, setFilteredUpcomingProjectGroup] = useState<string | undefined>(undefined);
  /** 仅显示至少两条历程在时间上重叠的 IP 段（与费用统计「历程天数重复累加」风险一致） */
  const [filterOverlappingHistoryOnly, setFilterOverlappingHistoryOnly] = useState(false);
  const [upcomingRenewalViewMode, setUpcomingRenewalViewMode] = useState<'grouped' | 'list'>('grouped');
  const [segmentHistory, setSegmentHistory] = useState<IPSegmentHistory[]>([]);
  const [isHistoryModalVisible, setIsHistoryModalVisible] = useState(false);
  const [isHistoryViewModalVisible, setIsHistoryViewModalVisible] = useState(false);
  const [isBatchHistoryEditVisible, setIsBatchHistoryEditVisible] = useState(false);
  const [viewingSegment, setViewingSegment] = useState<IPSegment | null>(null);
  const [editingHistoryIndex, setEditingHistoryIndex] = useState<number | null>(null);
  const [historyForm] = Form.useForm();
  const [batchHistoryForm] = Form.useForm();
  const [form] = Form.useForm();
  const [batchEditForm] = Form.useForm();
  const [previewBatchEditForm] = Form.useForm();
  const { TextArea } = Input;
  const { Text } = Typography;

  useEffect(() => {
    // 初始化使用地区选项（如果存储中没有数据，则使用预设选项）
    let existingAreas = usageAreaStorage.getAll();
    // 移除已废弃的选项：准备取消、已取消
    existingAreas = existingAreas.filter(a => a.name !== '准备取消' && a.name !== '已取消');
    if (existingAreas.length > 0) {
      usageAreaStorage.save(existingAreas);
    } else {
      usageAreaStorage.save(DEFAULT_USAGE_AREA_OPTIONS);
    }

    // 先即时用 localStorage 刷新界面，避免切换到本页时必须等完 /api/get-data 才出现表格（体感卡顿）。
    loadData();

    const loadDataFromFile = async () => {
      try {
        const response = await fetch('/api/get-data');
        if (response.ok) {
          const data = await response.json();
          if (data) {
            // 如果文件中有数据，覆盖 localStorage
            if (data.ipSegments) ipSegmentStorage.save(data.ipSegments);
            if (data.projectGroups) projectGroupStorage.save(data.projectGroups);
            if (data.suppliers) supplierStorage.save(data.suppliers);
            if (data.usageAreas) {
              const filtered = (data.usageAreas as UsageAreaOption[]).filter(
                a => a.name !== '准备取消' && a.name !== '已取消'
              );
              usageAreaStorage.save(filtered);
            }
            if (data.asnGroups) asnGroupStorage.save(data.asnGroups);
            if (data.asns) asnStorage.save(data.asns);

            console.log('已自动加载本地保存的数据');
          }
        }
      } catch (error) {
        console.error('Failed to load local data:', error);
      } finally {
        loadData();
      }
    };

    void loadDataFromFile();
    
    // 设置定时器，每分钟检查一次是否有IP段到期，自动刷新数据
    // 由于数据过滤逻辑基于当前时间，每次loadData()会触发重新渲染，从而自动更新分类
    const interval = setInterval(() => {
      loadData();
    }, 60000); // 每分钟检查一次
    
    return () => clearInterval(interval);
  }, []);

  const loadData = () => {
    const allSegments = ipSegmentStorage.getAll();
    const now = dayjs();
    let hasUpdates = false;
    
    // 根据购买时间和取消时间重新计算续费时间，并自动初始化历程记录
    const updatedSegments = allSegments.map(segment => {
      const healed = normalizeSegmentHistoryAndRepurchaseSegment(segment, calculateCancelledExpiryDate);
      if (healed.changed) {
        hasUpdates = true;
        segment = healed.segment;
      }

      const asnNorm = normalizeAsnDigitsOnly(segment.asn);
      const extrasNorm: string[] = [];
      const extrasSeen = new Set<string>();
      for (const e of segment.additionalAsns || []) {
        const n = normalizeAsnDigitsOnly(e);
        if (!n || n === asnNorm || extrasSeen.has(n)) continue;
        extrasSeen.add(n);
        extrasNorm.push(n);
      }
      const rawExtras = segment.additionalAsns || [];
      const asnNeedsNorm =
        (segment.asn || '') !== (asnNorm || '') ||
        rawExtras.length !== extrasNorm.length ||
        rawExtras.some((e, i) => normalizeAsnDigitsOnly(e) !== (extrasNorm[i] ?? ''));
      if (asnNeedsNorm) {
        hasUpdates = true;
        segment = {
          ...segment,
          asn: asnNorm,
          additionalAsns: extrasNorm,
          updatedAt: new Date().toISOString(),
        };
      }

      if (!segment.purchaseDate) {
        return segment; // 没有购买时间，跳过
      }
      
      const purchaseDateObj = dayjs(segment.purchaseDate);
      if (!purchaseDateObj.isValid()) {
        return segment; // 购买时间无效，跳过
      }
      
      let newRenewalDate: string;
      
      if (segment.cancellationDate && segment.cancellationDate.trim()) {
        // 如果有取消时间，根据购买时间的"日"和取消时间的"日"来判断续费时间的月份
        const cancellationDateObj = dayjs(segment.cancellationDate);
        if (cancellationDateObj.isValid()) {
          const purchaseDay = purchaseDateObj.date(); // 购买时间的"日"（1-31）
          
          // 续费时间 = 取消时间所在月份的购买时间的"日"
          // 例如：购买时间2025-10-28，取消时间2026-02-26，续费时间应该是2026-02-28
          // 例如：购买时间2025-10-28，取消时间2026-02-28，续费时间应该是2026-02-28
          newRenewalDate = cancellationDateObj.date(purchaseDay).format('YYYY-MM-DD');
        } else {
          return segment; // 取消时间无效，跳过
        }
      } else {
        // 如果没有取消时间，续费时间 = 下一个购买时间的"日"
        const purchaseDay = purchaseDateObj.date(); // 购买时间的"日"（1-31）
        const currentDay = now.date(); // 当前时间的"日"（1-31）
        
        // 计算下一个续费日期
        let nextRenewalDate = now.date(purchaseDay);
        
        // 如果当前日期已经过了购买时间的"日"，续费时间应该是下个月的购买时间的"日"
        if (currentDay > purchaseDay) {
          nextRenewalDate = nextRenewalDate.add(1, 'month');
        }
        // 如果当前日期还没到购买时间的"日"，续费时间就是本月的购买时间的"日"
        // 如果当前日期就是购买时间的"日"，续费时间就是本月的购买时间的"日"（今天需要续费）
        
        newRenewalDate = nextRenewalDate.format('YYYY-MM-DD');
      }
      
      // 如果续费时间发生了变化，更新数据
      if (segment.renewalDate !== newRenewalDate) {
        hasUpdates = true;
        segment = {
          ...segment,
          renewalDate: newRenewalDate,
          updatedAt: new Date().toISOString(),
        };
      }
      
      // 自动初始化历程记录（如果IP段有项目组和购买日期但没有历程记录）
      if (!segment.history || segment.history.length === 0) {
        if (segment.purchaseDate && segment.projectGroups && segment.projectGroups.length > 0) {
          hasUpdates = true;
          segment = {
            ...segment,
            history: [{
              id: `history-${segment.id}-auto-${Date.now()}`,
              projectGroup: segment.projectGroups[0],
              startDate: segment.purchaseDate,
              endDate: undefined, // 当前仍在使用
              createdAt: segment.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }],
            updatedAt: new Date().toISOString(),
          };
        }
      }
      
      // 对于已到期的IP段，自动设置最后一条历程记录的结束日期为到期时间（仅限仍属于取消周期内的最后一段，避免覆盖再次购买后的新历程）
      if (segment.history && segment.history.length > 0) {
        const expiryDate = calculateCancelledExpiryDate(segment);
        if (expiryDate && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
          // IP段已到期，检查最后一条历程记录
          const sortedHistory = [...segment.history].sort((a, b) => 
            dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
          );
          const lastHistory = sortedHistory[sortedHistory.length - 1];
          // 最后一段若开始日晚于取消周期到期日，说明是取消到期后的新购买周期，不得写入旧到期日
          const lastStartsAfterCancelledExpiry = dayjs(lastHistory.startDate).isAfter(expiryDate, 'day');
          if (
            !lastStartsAfterCancelledExpiry &&
            (!lastHistory.endDate || dayjs(lastHistory.endDate).isAfter(expiryDate, 'day'))
          ) {
            const expiryDateStr = expiryDate.format('YYYY-MM-DD');
            if (lastHistory.endDate !== expiryDateStr) {
              hasUpdates = true;
              const updatedHistory = segment.history.map(h => 
                h.id === lastHistory.id 
                  ? { ...h, endDate: expiryDateStr, updatedAt: new Date().toISOString() }
                  : h
              );
              segment = {
                ...segment,
                history: updatedHistory,
                updatedAt: new Date().toISOString(),
              };
            }
          }
        }
      }
      
      // 有历程时：根据「当前」历程条目的项目组修正 projectGroups（含仅一条「至今」记录的情况）
      const expectedPg = getProjectGroupsFromHistorySync(segment);
      if (expectedPg && expectedPg.length > 0) {
        const cur = segment.projectGroups?.[0];
        if (cur !== expectedPg[0]) {
          hasUpdates = true;
          segment = {
            ...segment,
            projectGroups: expectedPg,
            updatedAt: new Date().toISOString(),
          };
        }
      }
      
      return segment;
    });
    
    // 如果有更新，保存数据
    if (hasUpdates) {
      ipSegmentStorage.save(updatedSegments);
    }

    setIpSegments(updatedSegments);
    setProjectGroups(projectGroupStorage.getAll());
    setSuppliers(supplierStorage.getAll());
    setUsageAreas(usageAreaStorage.getAll());
  };

  // 保存数据到本地文件（实际执行保存），silent 为 true 时不显示成功提示
  const saveDataToFile = async (silent = false) => {
    try {
      const allData = {
        ipSegments: ipSegmentStorage.getAll(),
        projectGroups: projectGroupStorage.getAll(),
        suppliers: supplierStorage.getAll(),
        usageAreas: usageAreaStorage.getAll(),
        asns: asnStorage.getAll(),
        asnGroups: asnGroupStorage.getAll(),
        exportTime: new Date().toISOString(),
        version: '1.0.0',
      };
      
      const response = await fetch('/api/save-data', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(allData, null, 2),
      });

      if (response.ok) {
        if (!silent) message.success('数据已成功保存到本地文件 (ip-data.json)');
      } else {
        throw new Error('Server responded with error');
      }
    } catch (error) {
      console.error('保存失败:', error);
      message.error('数据保存失败');
    }
  };

  // 提示用户保存数据
  const promptToSaveData = () => {
    Modal.confirm({
      title: '数据已更新',
      content: '是否将最新的数据保存到本地文件 (ip-data.json)？',
      okText: '保存',
      cancelText: '暂不保存',
      onOk: saveDataToFile,
    });
  };

  // 获取 IP 段到期时间（用于展示和导出，含取消续费无取消时间时的续费时间回退）
  const getExpiryDateForDisplay = (seg: IPSegment): dayjs.Dayjs | null => {
    if (seg.renewalStatus === 'cancelled' || seg.cancellationDate) {
      const d = calculateCancelledExpiryDate(seg);
      if (d) return d;
      // 仅设置取消续费但无取消时间时，到期时间 = 续费时间（当前周期结束）
      if (seg.renewalDate) return dayjs(seg.renewalDate);
      return null;
    }
    if (!seg.renewalDate) return null;
    const renewalDate = dayjs(seg.renewalDate);
    return seg.renewalStatus === 'renewed' ? renewalDate.add(1, 'month') : renewalDate;
  };

  const getExpiryDateForExport = (seg: IPSegment): string => {
    const d = getExpiryDateForDisplay(seg);
    return d ? d.format('YYYY-MM-DD') : '';
  };

  /** 使用地区：与配置及数据中的规范名对齐，修复乱码展示（与费用统计一致） */
  const resolveUsageAreaName = useMemo(() => {
    const masters = buildUsageAreaMasters(usageAreas, ipSegments);
    return (raw: unknown) => {
      const t = String(raw ?? '').trim();
      if (!t || t === '未使用') return '未使用';
      return resolveMasterLabel(t, masters, usageAreaMatchKey) || t;
    };
  }, [usageAreas, ipSegments]);

  // 导出数据为表格 (CSV) - 导出所有IP段
  const handleExportCSV = () => {
    try {
      const segments = ipSegmentStorage.getAll();
      if (segments.length === 0) {
        message.warning('没有可导出的数据');
        return;
      }

      // CSV表头（与表格列一致，含购买时间、续费时间、到期时间等）
      const headers = ['IP段', '使用地区', '费用($)', '购买时间', '取消时间', '项目组', '供应商', 'ASN', '续费时间', '到期时间', '是否续费', '服务器位置', '被墙信息'];
      
      // 转换数据为CSV行
      const rows = segments.map(seg => {
        // 处理数组和特殊字段
        const projectGroups = getEffectiveProjectGroups(seg).join(';');
        const serverLocations = seg.serverLocations.map(loc => `${loc.supplier}-${loc.region}`).join(';');
        const blockedCountries = seg.blockedCountries.map(c => {
          const countryMap: Record<string, string> = {
            'iran': '伊朗', 'myanmar': '缅甸', 'turkmenistan': '土库曼', 'russia': '俄罗斯'
          };
          return countryMap[c] || c;
        }).join(';');
        
        // 续费状态中文转换
        const renewalStatusMap: Record<string, string> = {
          'not_renewed': '',
          'renewed': '已续费',
          'cancelled': '取消续费',
          'refunded': '已退款'
        };
        const effectiveStatus = getEffectiveRenewalStatusForDisplay(seg);
        const renewalStatus = renewalStatusMap[effectiveStatus] ?? effectiveStatus ?? '';

        // 处理包含逗号的字段，用引号包裹
        const escape = (val: string | number) => {
          const str = String(val || '');
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        };

        return [
          escape(seg.segment),
          escape(resolveUsageAreaName(seg.usageArea)),
          escape(seg.monthlyPrice),
          escape(seg.purchaseDate),
          escape(seg.cancellationDate),
          escape(projectGroups),
          escape(seg.supplier),
          escape(seg.asn),
          escape(seg.renewalDate),
          escape(getExpiryDateForExport(seg)),
          escape(renewalStatus),
          escape(serverLocations),
          escape(blockedCountries)
        ].join(',');
      });

      // 组合CSV内容，添加BOM防止乱码
      const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
      
      // 创建下载链接
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ip-segments-${dayjs().format('YYYY-MM-DD')}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      message.success('数据导出成功');
    } catch (error) {
      console.error('导出失败:', error);
      message.error('数据导出失败');
    }
  };

  // 通用导出函数 - 根据当前标签页导出对应的IP段数据
  const handleExportCurrentTab = () => {
    try {
      let segmentsToExport: IPSegment[] = [];
      let tabName = '';
      let tabLabel = '';

      // 根据当前激活的标签页确定要导出的数据
      switch (activeTabKey) {
        case 'all':
          segmentsToExport = displayAllIpSegments;
          tabName = '所有IP段';
          tabLabel = '所有IP段';
          break;
        case 'active':
          segmentsToExport = displayFilteredIpSegments;
          tabName = '正常IP段';
          tabLabel = '正常IP段';
          break;
        case 'cancelledButNotExpired':
          segmentsToExport = displayCancelledButNotExpiredSegments;
          tabName = '已取消但未到期';
          tabLabel = '已取消但未到期IP段';
          break;
        case 'cancelled':
          segmentsToExport = displayCancelledIpSegments;
          tabName = '已取消IP段';
          tabLabel = '已取消IP段';
          break;
        case 'upcomingRenewal':
          // 近期续费IP段需要特殊处理，导出所有近10天需要续费的IP段
          const upcomingSegments: IPSegment[] = [];
          const today = dayjs().startOf('day');
          const tenDaysLater = today.add(10, 'day');
          displayFilteredIpSegments.forEach(segment => {
            if (segment.renewalDate) {
              const renewalDate = dayjs(segment.renewalDate).startOf('day');
              if ((renewalDate.isAfter(today) || renewalDate.isSame(today)) && 
                  (renewalDate.isBefore(tenDaysLater) || renewalDate.isSame(tenDaysLater))) {
                upcomingSegments.push(segment);
              }
            }
          });
          segmentsToExport = upcomingSegments;
          tabName = '近期续费IP段';
          tabLabel = '近期续费IP段';
          break;
        default:
          segmentsToExport = [];
          break;
      }

      if (segmentsToExport.length === 0) {
        message.warning(`没有可导出的${tabLabel}数据`);
        return;
      }

      // CSV表头（与表格列一致，含购买时间、续费时间、到期时间等）
      const headers = ['IP段', '使用地区', '费用($)', '购买时间', '取消时间', '项目组', '供应商', 'ASN', '续费时间', '到期时间', '是否续费', '服务器位置', '被墙信息'];
      
      // 转换数据为CSV行
      const rows = segmentsToExport.map(seg => {
        // 处理数组和特殊字段
        const projectGroups = getEffectiveProjectGroups(seg).join(';');
        const serverLocations = (seg.serverLocations || []).map(loc => `${loc.supplier}-${loc.region}`).join(';');
        const blockedCountries = (seg.blockedCountries || []).map(c => {
          const countryMap: Record<string, string> = {
            'iran': '伊朗', 'myanmar': '缅甸', 'turkmenistan': '土库曼', 'russia': '俄罗斯'
          };
          return countryMap[c] || c;
        }).join(';');
        
        // 续费状态中文转换
        const renewalStatusMap: Record<string, string> = {
          'not_renewed': '',
          'renewed': '已续费',
          'cancelled': '取消续费',
          'refunded': '已退款'
        };
        const effectiveStatus = getEffectiveRenewalStatusForDisplay(seg);
        const renewalStatus = renewalStatusMap[effectiveStatus] ?? effectiveStatus ?? '';

        // 处理包含逗号的字段，用引号包裹
        const escape = (val: string | number | undefined) => {
          const str = String(val || '');
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        };

        return [
          escape(seg.segment),
          escape(resolveUsageAreaName(seg.usageArea)),
          escape(seg.monthlyPrice),
          escape(seg.purchaseDate),
          escape(seg.cancellationDate),
          escape(projectGroups),
          escape(seg.supplier),
          escape(seg.asn),
          escape(seg.renewalDate),
          escape(getExpiryDateForExport(seg)),
          escape(renewalStatus),
          escape(serverLocations),
          escape(blockedCountries)
        ].join(',');
      });

      // 组合CSV内容，添加BOM防止乱码
      const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
      
      // 创建下载链接
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      
      // 生成文件名，包含标签页名称和筛选条件信息
      let fileName = `${tabName}-${dayjs().format('YYYY-MM-DD')}`;
      if (filteredSupplier || filteredSegment || filterOverlappingHistoryOnly) {
        const filters = [];
        if (filteredSegment) filters.push(`IP段-${filteredSegment.substring(0, 20)}`);
        if (filteredSupplier) filters.push(`供应商-${filteredSupplier}`);
        if (filterOverlappingHistoryOnly) filters.push('历程重叠');
        if (filters.length > 0) {
          fileName += `-${filters.join('-')}`;
        }
      }
      fileName += `.csv`;
      
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      message.success(`成功导出 ${segmentsToExport.length} 条${tabLabel}数据`);
    } catch (error) {
      console.error('导出失败:', error);
      message.error('数据导出失败');
    }
  };

  // 导出选中的 IP 段（当前 Tab 中被勾选的行）
  const handleExportSelected = () => {
    try {
      // 获取当前 Tab 的选中 key 列表
      const currentSelectedKeys = activeTabKey === 'all'
        ? allSegmentsSelectedKeys
        : activeTabKey === 'active'
        ? selectedRowKeys
        : activeTabKey === 'cancelledButNotExpired'
        ? cancelledButNotExpiredSelectedKeys
        : cancelledSelectedKeys;

      if (currentSelectedKeys.length === 0) {
        message.warning('请先勾选要导出的 IP 段');
        return;
      }

      // 从当前 Tab 的展示数据中找到选中的行
      const currentDisplayData = activeTabKey === 'all'
        ? displayAllIpSegments
        : activeTabKey === 'active'
        ? displayFilteredIpSegments
        : activeTabKey === 'cancelledButNotExpired'
        ? displayCancelledButNotExpiredSegments
        : displayCancelledIpSegments;

      const keySet = new Set(currentSelectedKeys);
      const segmentsToExport = currentDisplayData.filter(seg => keySet.has(seg.id));

      if (segmentsToExport.length === 0) {
        message.warning('未找到选中的 IP 段数据');
        return;
      }

      // CSV 表头（与 handleExportCurrentTab 保持一致）
      const headers = ['IP段', '使用地区', '费用($)', '购买时间', '取消时间', '项目组', '供应商', 'ASN', '续费时间', '到期时间', '是否续费', '服务器位置', '被墙信息'];

      const escape = (val: string | number | undefined) => {
        const str = String(val || '');
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };

      const renewalStatusMap: Record<string, string> = {
        'not_renewed': '',
        'renewed': '已续费',
        'cancelled': '取消续费',
        'refunded': '已退款'
      };

      const rows = segmentsToExport.map(seg => {
        const projectGroups = getEffectiveProjectGroups(seg).join(';');
        const serverLocations = (seg.serverLocations || []).map(loc => `${loc.supplier}-${loc.region}`).join(';');
        const blockedCountries = (seg.blockedCountries || []).map(c => {
          const countryMap: Record<string, string> = {
            'iran': '伊朗', 'myanmar': '缅甸', 'turkmenistan': '土库曼', 'russia': '俄罗斯'
          };
          return countryMap[c] || c;
        }).join(';');
        const effectiveStatus = getEffectiveRenewalStatusForDisplay(seg);
        const renewalStatus = renewalStatusMap[effectiveStatus] ?? effectiveStatus ?? '';
        return [
          escape(seg.segment),
          escape(resolveUsageAreaName(seg.usageArea)),
          escape(seg.monthlyPrice),
          escape(seg.purchaseDate),
          escape(seg.cancellationDate),
          escape(projectGroups),
          escape(seg.supplier),
          escape(seg.asn),
          escape(seg.renewalDate),
          escape(getExpiryDateForExport(seg)),
          escape(renewalStatus),
          escape(serverLocations),
          escape(blockedCountries),
        ].join(',');
      });

      const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;

      // 文件名包含筛选条件
      let fileName = `选中IP段-${dayjs().format('YYYY-MM-DD')}`;
      const filters: string[] = [];
      if (filteredSegment) filters.push(`IP段-${filteredSegment.substring(0, 20)}`);
      if (filteredSupplier) filters.push(`供应商-${filteredSupplier}`);
      if (filters.length > 0) fileName += `-${filters.join('-')}`;
      fileName += '.csv';

      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      message.success(`成功导出 ${segmentsToExport.length} 条选中 IP 段数据`);
    } catch (error) {
      console.error('导出失败:', error);
      message.error('导出失败');
    }
  };

  // 获取所有供应商列表：配置中的供应商优先作为规范写法，再合并 IP 段中的值；按 trim + 不区分大小写去重，避免出现两条「IPXO」
  const getAllSuppliers = useMemo((): string[] => {
    const byNorm = new Map<string, string>();
    const add = (raw: string | null | undefined) => {
      const t = String(raw ?? '').trim();
      if (!t) return;
      const k = t.toLowerCase();
      if (!byNorm.has(k)) byNorm.set(k, t);
    };
    suppliers.forEach((s) => add(s.name));
    ipSegments.forEach((segment) => {
      // supplier 字段可能是数组（历史数据问题），统一取第一个元素
      const sup = Array.isArray(segment.supplier) ? segment.supplier[0] : segment.supplier;
      add(sup);
    });
    return Array.from(byNorm.values()).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [ipSegments, suppliers]);

  /** 批量导入预览：下拉选项 = 配置 + 当前预览行中已出现的值，避免乱码仅展示为不可编辑文本 */
  const previewUsageAreaOptions = useMemo(() => {
    const names = new Set<string>();
    usageAreas.forEach((a) => names.add(a.name));
    batchTableData.forEach((r) => {
      if (r.usageArea != null && r.usageArea !== '') names.add(String(r.usageArea));
    });
    return Array.from(names)
      .sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))
      .map((name) => {
        const area = usageAreas.find((x) => x.name === name);
        return {
          label: area ? (
            <span>
              <Tag color={area.color} style={{ marginRight: 4, color: '#000' }}>
                {name}
              </Tag>
            </span>
          ) : (
            name
          ),
          value: name,
        };
      });
  }, [usageAreas, batchTableData]);

  const previewSupplierOptions = useMemo(() => {
    const byNorm = new Map<string, string>();
    const add = (raw: string | null | undefined) => {
      const t = String(raw ?? '').trim();
      if (!t) return;
      const k = t.toLowerCase();
      if (!byNorm.has(k)) byNorm.set(k, t);
    };
    getAllSuppliers.forEach((s) => add(s));
    batchTableData.forEach((r) => add(r.supplier));
    return Array.from(byNorm.values())
      .sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'))
      .map((name) => ({ label: name, value: name }));
  }, [getAllSuppliers, batchTableData]);

  // 获取当前时间（用于判断是否到期）
  const now = dayjs();

  // 计算近10天需要续费的IP段（按日期分组，支持项目组筛选）
  const getUpcomingRenewalSegments = (projectGroupFilter?: string) => {
    const upcomingSegments: IPSegment[] = [];
    const today = dayjs().startOf('day');
    const tenDaysLater = today.add(10, 'day');

    // 筛选出近10天需要续费的正常IP段（支持项目组筛选）
    filteredIpSegments.forEach(segment => {
      // 项目组筛选：若选择了项目组，只显示该项目组下的IP段
      if (projectGroupFilter && !getEffectiveProjectGroups(segment).includes(projectGroupFilter)) {
        return;
      }
      if (segment.renewalDate) {
        const renewalDate = dayjs(segment.renewalDate).startOf('day');
        // 续费时间在今天到10天后之间（包含今天和10天后）
        if ((renewalDate.isAfter(today) || renewalDate.isSame(today)) && 
            (renewalDate.isBefore(tenDaysLater) || renewalDate.isSame(tenDaysLater))) {
          upcomingSegments.push(segment);
        }
      }
    });

    // 按续费日期分组（仅 IPXO 加收 4%，Interlir 先欧元→美元）
    const groupedByDate: { [key: string]: { segments: IPSegment[], totalCost: number } } = {};
    upcomingSegments.forEach(segment => {
      if (segment.renewalDate) {
        const renewalDateStr = dayjs(segment.renewalDate).format('YYYY-MM-DD');
        if (!groupedByDate[renewalDateStr]) {
          groupedByDate[renewalDateStr] = { segments: [], totalCost: 0 };
        }
        groupedByDate[renewalDateStr].segments.push(segment);
        groupedByDate[renewalDateStr].totalCost += getBillableMonthlyUsdForSegment(segment);
      }
    });

    // 按续费日期降序排列（越早需续费的排在前面）
    const sortedDates = Object.keys(groupedByDate).sort((a, b) => {
      return dayjs(a).valueOf() - dayjs(b).valueOf();
    });

    // 每组内的IP段按续费时间向下排列（已按日期分组，组内保持原有顺序）
    sortedDates.forEach(dateStr => {
      groupedByDate[dateStr].segments.sort((a, b) => {
        const ra = a.renewalDate ? dayjs(a.renewalDate).valueOf() : 0;
        const rb = b.renewalDate ? dayjs(b.renewalDate).valueOf() : 0;
        return ra - rb;
      });
    });

    const totalCost = upcomingSegments.reduce((sum, seg) => sum + getBillableMonthlyUsdForSegment(seg), 0);
    return { groupedByDate, sortedDates, totalSegments: upcomingSegments.length, totalCost };
  };

  // 解析多个IP段搜索关键词（支持空格、逗号、换行分隔）
  const parseSegmentSearchKeywords = (searchText: string): string[] => {
    if (!searchText.trim()) return [];
    // 支持空格、逗号、换行作为分隔符
    return searchText
      .split(/[\s,\n]+/)
      .map(keyword => keyword.trim())
      .filter(keyword => keyword.length > 0);
  };

  // 判断某个关键词是否应精确匹配（包含 / 说明是完整 IP 段格式，如 1.2.3.0/24）
  const isExactKeyword = (keyword: string): boolean => keyword.includes('/');

  // 检查某个 IP 段是否匹配关键词列表（精确/模糊自动切换）
  const matchesKeywords = (segmentStr: string, keywords: string[]): boolean => {
    if (keywords.length === 0) return true;
    const segLower = segmentStr.toLowerCase();
    return keywords.some(keyword => {
      const kwLower = keyword.toLowerCase();
      // 包含 / 的关键词（完整 IP 段）用精确匹配，否则模糊匹配
      return isExactKeyword(keyword) ? segLower === kwLower : segLower.includes(kwLower);
    });
  };

  // 按搜索关键词顺序对 IP 段列表排序（首个匹配关键词的索引优先）
  const sortSegmentsBySearchOrder = (segments: IPSegment[], keywords: string[]): IPSegment[] => {
    if (keywords.length === 0) return segments;
    const getOrder = (seg: IPSegment): number => {
      const segStr = String(seg.segment ?? '');
      for (let i = 0; i < keywords.length; i++) {
        const kwLower = keywords[i].toLowerCase();
        const segLower = segStr.toLowerCase();
        const matched = isExactKeyword(keywords[i]) ? segLower === kwLower : segLower.includes(kwLower);
        if (matched) return i;
      }
      return keywords.length;
    };
    return [...segments].sort((a, b) => {
      const orderA = getOrder(a);
      const orderB = getOrder(b);
      if (orderA !== orderB) return orderA - orderB;
      return String(a.segment ?? '').localeCompare(String(b.segment ?? ''), 'zh-CN');
    });
  };

  const overlappingHistorySegmentCount = useMemo(
    () => ipSegments.filter((s) => segmentHasOverlappingHistory(s)).length,
    [ipSegments],
  );

  // 过滤后的IP段数据（正常状态）；useMemo 避免无关 state 变动时整块重筛
  const filteredIpSegments = useMemo(() => {
    return ipSegments.filter((segment) => {
      // 过滤已取消的
      if (segment.renewalStatus === 'cancelled' || segment.cancellationDate) {
        return false;
      }
      // 供应商筛选
      if (filteredSupplier && segment.supplier !== filteredSupplier) {
        return false;
      }
      // IP段筛选（支持多个IP段）
      if (filteredSegment) {
        const keywords = parseSegmentSearchKeywords(filteredSegment);
        if (keywords.length > 0) {
          const segmentStr = String(segment.segment ?? '');
          const matches = matchesKeywords(segmentStr, keywords);
          if (!matches) {
            return false;
          }
        }
      }
      if (filterOverlappingHistoryOnly && !segmentHasOverlappingHistory(segment)) {
        return false;
      }
      return true;
    });
  }, [
    ipSegments,
    filteredSupplier,
    filteredSegment,
    filterOverlappingHistoryOnly,
  ]);

  // 计算近10天需要续费的IP段数据（必须在filteredIpSegments定义之后调用）
  const upcomingRenewalData = getUpcomingRenewalSegments(filteredUpcomingProjectGroup);

  // 近期续费列表视图的扁平化数据（按续费日期排序）
  const upcomingRenewalListData = useMemo(() => {
    const list: IPSegment[] = [];
    upcomingRenewalData.sortedDates.forEach(dateStr => {
      list.push(...upcomingRenewalData.groupedByDate[dateStr].segments);
    });
    return list;
  }, [upcomingRenewalData]);

  // 所有IP段（应用筛选条件）；useMemo 同上
  const allIpSegments = useMemo(() => {
    return ipSegments.filter((segment) => {
      if (filteredSupplier && segment.supplier !== filteredSupplier) {
        return false;
      }
      if (filteredSegment) {
        const keywords = parseSegmentSearchKeywords(filteredSegment);
        if (keywords.length > 0) {
          const segmentStr = String(segment.segment ?? '');
          const matches = matchesKeywords(segmentStr, keywords);
          if (!matches) {
            return false;
          }
        }
      }
      if (filterOverlappingHistoryOnly && !segmentHasOverlappingHistory(segment)) {
        return false;
      }
      return true;
    });
  }, [
    ipSegments,
    filteredSupplier,
    filteredSegment,
    filterOverlappingHistoryOnly,
  ]);

  // 计算已取消IP段的实际到期时间（取消时间所在续费周期的结束时间）
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

  // 获取用于显示的续费状态：已取消并到期的IP段强制显示「取消续费」
  const getEffectiveRenewalStatusForDisplay = (segment: IPSegment): RenewalStatus => {
    const isCancelled = segment.renewalStatus === 'cancelled' || !!segment.cancellationDate;
    if (!isCancelled) return segment.renewalStatus || 'not_renewed';
    const expiryDate = calculateCancelledExpiryDate(segment);
    if (!expiryDate) return segment.renewalStatus || 'not_renewed';
    const nowRef = dayjs();
    if (nowRef.isAfter(expiryDate) || nowRef.isSame(expiryDate, 'day')) {
      return 'cancelled'; // 已取消并到期，显示取消续费
    }
    return segment.renewalStatus || 'not_renewed';
  };

  // 已取消但还未到期的IP段数据（到期日与列表「到期时间」列一致：含仅取消续费、无取消时间时用续费时间）
  const cancelledButNotExpiredSegments = ipSegments.filter(segment => {
    // 必须是已取消的
    if (segment.renewalStatus !== 'cancelled' && !segment.cancellationDate) {
      return false;
    }

    const expiryDate = getExpiryDateForDisplay(segment);
    if (!expiryDate) {
      return false;
    }

    // 必须还未到期（当前时间 < 到期时间）
    if (now.isAfter(expiryDate) || now.isSame(expiryDate, 'day')) {
      return false; // 已到期，显示在"已取消IP段"
    }
    // 供应商筛选
    if (filteredSupplier && segment.supplier !== filteredSupplier) {
      return false;
    }
    // IP段筛选（支持多个IP段）
    if (filteredSegment) {
      const keywords = parseSegmentSearchKeywords(filteredSegment);
      if (keywords.length > 0) {
        const segmentStr = String(segment.segment ?? '');
        // 只要匹配任意一个关键词就显示
        const matches = matchesKeywords(segmentStr, keywords);
        if (!matches) {
          return false;
        }
      }
    }
    if (filterOverlappingHistoryOnly && !segmentHasOverlappingHistory(segment)) {
      return false;
    }
    return true;
  });

  // 已取消且已到期的IP段数据（到期判断与 getExpiryDateForDisplay 一致）
  const cancelledIpSegments = ipSegments.filter(segment => {
    // 必须是已取消的
    if (segment.renewalStatus !== 'cancelled' && !segment.cancellationDate) {
      return false;
    }

    const expiryDate = getExpiryDateForDisplay(segment);
    if (expiryDate) {
      if (now.isBefore(expiryDate)) {
        return false; // 还未到期，显示在"已取消但未到期"
      }
    }
    // 无可用到期日（极少见）时归入已取消，与历史逻辑一致
    // 供应商筛选
    if (filteredSupplier && segment.supplier !== filteredSupplier) {
      return false;
    }
    // IP段筛选（支持多个IP段）
    if (filteredSegment) {
      const keywords = parseSegmentSearchKeywords(filteredSegment);
      if (keywords.length > 0) {
        const segmentStr = String(segment.segment ?? '');
        // 只要匹配任意一个关键词就显示
        const matches = matchesKeywords(segmentStr, keywords);
        if (!matches) {
          return false;
        }
      }
    }
    if (filterOverlappingHistoryOnly && !segmentHasOverlappingHistory(segment)) {
      return false;
    }
    return true;
  });

  // 按搜索顺序展示时，对当前 tab 的数据进行排序（仅当开启功能且有 IP 段筛选时生效）
  const searchKeywords = useMemo(() => parseSegmentSearchKeywords(filteredSegment), [filteredSegment]);
  const shouldSortBySearch = sortBySearchOrder && searchKeywords.length > 0;

  const displayFilteredIpSegments = useMemo(() => {
    if (!shouldSortBySearch) return filteredIpSegments;
    return sortSegmentsBySearchOrder(filteredIpSegments, searchKeywords);
  }, [filteredIpSegments, shouldSortBySearch, searchKeywords]);

  const displayAllIpSegments = useMemo(() => {
    if (!shouldSortBySearch) return allIpSegments;
    return sortSegmentsBySearchOrder(allIpSegments, searchKeywords);
  }, [allIpSegments, shouldSortBySearch, searchKeywords]);

  const displayCancelledButNotExpiredSegments = useMemo(() => {
    if (!shouldSortBySearch) return cancelledButNotExpiredSegments;
    return sortSegmentsBySearchOrder(cancelledButNotExpiredSegments, searchKeywords);
  }, [cancelledButNotExpiredSegments, shouldSortBySearch, searchKeywords]);

  const displayCancelledIpSegments = useMemo(() => {
    if (!shouldSortBySearch) return cancelledIpSegments;
    return sortSegmentsBySearchOrder(cancelledIpSegments, searchKeywords);
  }, [cancelledIpSegments, shouldSortBySearch, searchKeywords]);

  const handleAdd = () => {
    setEditingSegment(null);
    setSegmentHistory([]);
    form.resetFields();
    setIsModalVisible(true);
  };

  // 自动初始化历程记录（如果IP段有项目组但没有历程记录）
  const initializeHistoryIfNeeded = (segment: IPSegment): IPSegmentHistory[] => {
    // 如果已有历程记录，直接返回
    if (segment.history && segment.history.length > 0) {
      return segment.history;
    }
    
    // 如果没有购买日期或项目组，返回空数组
    if (!segment.purchaseDate || !segment.projectGroups || segment.projectGroups.length === 0) {
      return [];
    }
    
    // 自动创建初始历程记录：从购买日期开始，使用当前项目组
    const purchaseDate = segment.purchaseDate;
    const firstProjectGroup = segment.projectGroups[0]; // 使用第一个项目组
    
    return [{
      id: `history-${segment.id}-initial`,
      projectGroup: firstProjectGroup,
      startDate: purchaseDate,
      endDate: undefined, // 当前仍在使用
      createdAt: segment.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }];
  };

  const handleEdit = (record: IPSegment) => {
    setEditingSegment(record);
    // 加载历程记录，如果没有则自动初始化
    const history = initializeHistoryIfNeeded(record);
    setSegmentHistory(history);
    form.setFieldsValue({
      ...record,
      asn: normalizeAsnDigitsOnly(record.asn),
      purchaseDate: record.purchaseDate ? dayjs(record.purchaseDate) : null,
      renewalDate: dayjs(record.renewalDate),
      cancellationDate: record.cancellationDate ? dayjs(record.cancellationDate) : null,
      multiPurchaseMarked: !!record.multiPurchaseMarked,
      previousPurchaseDates: (record.previousPurchaseDates || [])
        .filter(Boolean)
        .map((d) => dayjs(d))
        .filter((d) => d.isValid()),
    });
    setIsModalVisible(true);
  };

  // 计算续费时间（当前时间下个月的同一日）
  const calculateRenewalDate = (purchaseDate: dayjs.Dayjs | null): dayjs.Dayjs => {
    // 续费时间基于当前时间和购买时间计算，为下个月的购买日
    const now = dayjs();
    if (purchaseDate && purchaseDate.isValid()) {
      const purchaseDay = purchaseDate.date(); // 购买时间的"日"（1-31）
      return now.date(purchaseDay).add(1, 'month');
    }
    return now.add(1, 'month');
  };

  // 处理购买时间变化
  const handlePurchaseDateChange = (date: dayjs.Dayjs | null) => {
    if (date && date.isValid()) {
      const renewalDate = calculateRenewalDate(date);
      form.setFieldsValue({
        purchaseDate: date,
        renewalDate: renewalDate,
      });
    }
  };

  const handleDelete = (id: string) => {
    ipSegmentStorage.delete(id);
    loadData();
    saveDataToFile();
    message.success('删除成功');
  };

  // 批量删除
  const handleBatchDelete = () => {
    if (selectedRowKeys.length === 0) {
      message.warning('请先选择要删除的IP段');
      return;
    }
    const count = selectedRowKeys.length;
    selectedRowKeys.forEach(key => {
      ipSegmentStorage.delete(key as string);
    });
    setSelectedRowKeys([]);
    loadData();
    saveDataToFile();
    message.success(`成功删除 ${count} 条记录`);
  };

  // 通用批量删除函数（用于其他标签页）
  const handleBatchDeleteForTab = (keys: React.Key[], setKeys: (keys: React.Key[]) => void) => {
    if (keys.length === 0) {
      message.warning('请先选择要删除的IP段');
      return;
    }
    const count = keys.length;
    keys.forEach(key => {
      ipSegmentStorage.delete(key as string);
    });
    setKeys([]);
    loadData();
    saveDataToFile();
    message.success(`成功删除 ${count} 条记录`);
  };

  // 预览数据批量编辑提交
  const handlePreviewBatchEditSubmit = async () => {
    if (previewSelectedRowKeys.length === 0) {
      message.warning('请先选择要编辑的数据');
      return;
    }

    try {
      const values = await previewBatchEditForm.validateFields();
      const updateData: Partial<IPSegment> = {};
      
      // 只更新有值的字段（排除空字符串和undefined）
      if (values.usageArea !== undefined && values.usageArea !== null && values.usageArea !== '') {
        updateData.usageArea = values.usageArea;
      }
      if (values.supplier !== undefined && values.supplier !== null && values.supplier !== '') {
        updateData.supplier = values.supplier;
      }
      if (values.asn !== undefined && values.asn !== null && values.asn !== '') {
        updateData.asn = normalizeAsnDigitsOnly(values.asn);
      }
      if (values.monthlyPrice !== undefined && values.monthlyPrice !== null) {
        updateData.monthlyPrice = values.monthlyPrice;
      }
      if (values.renewalStatus !== undefined && values.renewalStatus !== null) {
        updateData.renewalStatus = values.renewalStatus;
      }
      if (values.purchaseDate && values.purchaseDate.isValid()) {
        updateData.purchaseDate = values.purchaseDate.format('YYYY-MM-DD');
        updateData.renewalDate = calculateRenewalDate(values.purchaseDate).format('YYYY-MM-DD');
      }
      if (values.cancellationDate && values.cancellationDate.isValid()) {
        updateData.cancellationDate = values.cancellationDate.format('YYYY-MM-DD');
      }
      if (values.projectGroups !== undefined && values.projectGroups !== null) {
        updateData.projectGroups = values.projectGroups;
      }

      // 检查是否有任何字段需要更新
      if (Object.keys(updateData).length === 0) {
        message.warning('请至少填写一个要修改的字段');
        return;
      }

      // 更新预览数据
      const updatedData = batchTableData.map((item, index) => {
        if (previewSelectedRowKeys.includes(index)) {
          return { ...item, ...updateData };
        }
        return item;
      });

      setBatchTableData(updatedData);
      message.success(`成功更新 ${previewSelectedRowKeys.length} 条预览数据`);
      setIsPreviewBatchEditVisible(false);
      setPreviewSelectedRowKeys([]);
      previewBatchEditForm.resetFields();
    } catch (error) {
      console.error('预览数据批量编辑失败:', error);
    }
  };

  // 解析文本中的IP段
  const parseTextIPSegments = (text: string): string[] => {
    const lines = text.split('\n').filter(line => line.trim());
    const segments: string[] = [];
    
    lines.forEach((line) => {
      // 支持Tab键、英文逗号和中文逗号作为分隔符
      let normalizedLine = line.replace(/，/g, ',');
      
      let parts: string[];
      if (normalizedLine.includes('\t')) {
        parts = normalizedLine.split('\t').map(p => p.trim());
      } else {
        parts = normalizedLine.split(',').map(p => p.trim());
      }
      
      // 提取第一个字段作为IP段
      if (parts.length > 0 && parts[0]) {
        const segment = parts[0].trim();
        if (segment) {
          segments.push(segment);
        }
      }
    });
    
    return segments;
  };

  // 文本批量编辑提交
  const handleTextBatchEditSubmit = async () => {
    if (!textBatchEditValue.trim()) {
      message.warning('请输入要修改的IP段');
      return;
    }

    try {
      // 解析文本中的IP段
      const segments = parseTextIPSegments(textBatchEditValue);
      if (segments.length === 0) {
        message.warning('未能解析出有效的IP段，请检查格式');
        return;
      }

      // 根据IP段找到对应的记录ID
      const allSegments = ipSegmentStorage.getAll();
      const segmentMap = new Map<string, string>(); // IP段 -> ID
      allSegments.forEach(seg => {
        segmentMap.set(seg.segment.toLowerCase().trim(), seg.id);
      });

      const foundIds: string[] = [];
      const notFoundSegments: string[] = [];

      segments.forEach(segment => {
        const segmentKey = segment.toLowerCase().trim();
        const id = segmentMap.get(segmentKey);
        if (id) {
          foundIds.push(id);
        } else {
          notFoundSegments.push(segment);
        }
      });

      if (foundIds.length === 0) {
        message.error('未找到任何匹配的IP段记录');
        return;
      }

      if (notFoundSegments.length > 0) {
        const notFoundText = notFoundSegments.length <= 5 
          ? notFoundSegments.join('、') 
          : `${notFoundSegments.slice(0, 5).join('、')} 等共 ${notFoundSegments.length} 个`;
        message.warning(`以下IP段未找到：${notFoundText}。将只更新找到的 ${foundIds.length} 条记录。`);
      }

      // 获取表单值并更新
      const values = await textBatchEditForm.validateFields();
      const updateData: Partial<IPSegment> = {};
      
      // 只更新有值的字段（排除空字符串和undefined）
      if (values.usageArea !== undefined && values.usageArea !== null && values.usageArea !== '') {
        updateData.usageArea = values.usageArea;
      }
      if (values.supplier !== undefined && values.supplier !== null && values.supplier !== '') {
        updateData.supplier = values.supplier;
      }
      if (values.asn !== undefined && values.asn !== null && values.asn !== '') {
        updateData.asn = normalizeAsnDigitsOnly(values.asn);
      }
      if (values.monthlyPrice !== undefined && values.monthlyPrice !== null) {
        updateData.monthlyPrice = values.monthlyPrice;
      }
      if (values.renewalStatus !== undefined && values.renewalStatus !== null) {
        updateData.renewalStatus = values.renewalStatus;
      }
      if (values.purchaseDate && values.purchaseDate.isValid()) {
        updateData.purchaseDate = values.purchaseDate.format('YYYY-MM-DD');
        updateData.renewalDate = calculateRenewalDate(values.purchaseDate).format('YYYY-MM-DD');
      }
      if (values.cancellationDate && values.cancellationDate.isValid()) {
        updateData.cancellationDate = values.cancellationDate.format('YYYY-MM-DD');
      }
      if (values.projectGroups !== undefined && values.projectGroups !== null) {
        updateData.projectGroups = values.projectGroups;
      }
      if (values.blockedCountries !== undefined && values.blockedCountries !== null) {
        updateData.blockedCountries = values.blockedCountries;
      }

      // 检查是否有任何字段需要更新
      if (Object.keys(updateData).length === 0) {
        message.warning('请至少填写一个要修改的字段');
        return;
      }

      // 批量更新
      let successCount = 0;
      foundIds.forEach(id => {
        try {
          ipSegmentStorage.update(id, updateData);
          successCount++;
        } catch (error) {
          console.error(`更新失败:`, id, error);
        }
      });

      if (successCount > 0) {
        message.success(`成功更新 ${successCount} 条记录`);
        setIsTextBatchEditVisible(false);
        setTextBatchEditValue('');
        textBatchEditForm.resetFields();
        loadData();
        saveDataToFile();
      } else {
        message.error('更新失败');
      }
    } catch (error) {
      console.error('文本批量编辑失败:', error);
    }
  };

  // 批量编辑提交
  const handleBatchEditSubmit = async () => {
    // 根据当前标签页获取选中的keys
    const currentSelectedKeys = activeTabKey === 'all'
      ? allSegmentsSelectedKeys
      : activeTabKey === 'active' 
      ? selectedRowKeys 
      : activeTabKey === 'cancelledButNotExpired'
      ? cancelledButNotExpiredSelectedKeys
      : cancelledSelectedKeys;
    
    if (currentSelectedKeys.length === 0) {
      message.warning('请先选择要编辑的IP段');
      return;
    }

    try {
      const values = await batchEditForm.validateFields();
      const updateData: Partial<IPSegment> = {};
      
      // 只更新有值的字段（排除空字符串和undefined）
      if (values.usageArea !== undefined && values.usageArea !== null && values.usageArea !== '') {
        updateData.usageArea = values.usageArea;
      }
      if (values.supplier !== undefined && values.supplier !== null && values.supplier !== '') {
        updateData.supplier = values.supplier;
      }
      if (values.asn !== undefined && values.asn !== null && values.asn !== '') {
        updateData.asn = normalizeAsnDigitsOnly(values.asn);
      }
      if (values.monthlyPrice !== undefined && values.monthlyPrice !== null) {
        updateData.monthlyPrice = values.monthlyPrice;
      }
      if (values.renewalStatus !== undefined && values.renewalStatus !== null) {
        updateData.renewalStatus = values.renewalStatus;
      }
      if (values.purchaseDate && values.purchaseDate.isValid()) {
        updateData.purchaseDate = values.purchaseDate.format('YYYY-MM-DD');
        updateData.renewalDate = calculateRenewalDate(values.purchaseDate).format('YYYY-MM-DD');
      }
      if (values.cancellationDate && values.cancellationDate.isValid()) {
        updateData.cancellationDate = values.cancellationDate.format('YYYY-MM-DD');
      }
      if (values.projectGroups !== undefined && values.projectGroups !== null) {
        updateData.projectGroups = values.projectGroups;
      }
      if (values.blockedCountries !== undefined && values.blockedCountries !== null) {
        updateData.blockedCountries = values.blockedCountries;
      }
      // 备注：有值才更新
      const remarkVal = (values.remark || '').trim();
      const remarkOverwrite = !!values.remarkOverwrite; // true=覆盖，false=追加（默认）
      if (remarkVal !== '') {
        // 追加模式在 forEach 里单独处理，覆盖模式统一写入 updateData
        if (remarkOverwrite) {
          updateData.remark = remarkVal;
        }
      }

      // 检查是否有任何字段需要更新
      if (Object.keys(updateData).length === 0) {
        message.warning('请至少填写一个要修改的字段');
        return;
      }

      let successCount = 0;
      currentSelectedKeys.forEach(key => {
        try {
          // 追加模式：先读取现有备注再拼接
          if (remarkVal !== '' && !remarkOverwrite) {
            const existing = ipSegmentStorage.getAll().find(s => s.id === key);
            const existingRemark = (existing?.remark || '').trim();
            const newRemark = existingRemark ? `${existingRemark} ${remarkVal}` : remarkVal;
            ipSegmentStorage.update(key as string, { ...updateData, remark: newRemark });
          } else {
            ipSegmentStorage.update(key as string, updateData);
          }
          successCount++;
        } catch (error) {
          console.error(`更新失败:`, key, error);
        }
      });

      if (successCount > 0) {
        message.success(`成功更新 ${successCount} 条记录`);
        setIsBatchEditVisible(false);
        // 清空当前标签页的选中项
        if (activeTabKey === 'all') {
          setAllSegmentsSelectedKeys([]);
        } else if (activeTabKey === 'active') {
          setSelectedRowKeys([]);
        } else if (activeTabKey === 'cancelledButNotExpired') {
          setCancelledButNotExpiredSelectedKeys([]);
        } else {
          setCancelledSelectedKeys([]);
        }
        batchEditForm.resetFields();
        loadData();
        // 如果更新了备注，同步到 IPXO 账单的备注（ipxo-upcoming-status.json）
        if (remarkVal !== '') {
          const updatedSegs = ipSegmentStorage.getAll().filter(s => currentSelectedKeys.includes(s.id));
          Promise.all(updatedSegs.map(s =>
            fetch('/api/ipxo/upcoming/set-remark', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // 追加模式时用 ip-data.json 中已拼接好的最终备注值
              body: JSON.stringify({ segment: s.segment, remark: s.remark || remarkVal }),
            })
          )).catch(e => console.error('备注同步失败:', e));
        }
        saveDataToFile();
      } else {
        message.error('更新失败');
      }
    } catch (error) {
      console.error('批量编辑失败:', error);
    }
  };

  // 批量编辑历程记录提交
  const handleBatchHistoryEditSubmit = async () => {
    // 根据当前标签页获取选中的keys
    const currentSelectedKeys = activeTabKey === 'all'
      ? allSegmentsSelectedKeys
      : activeTabKey === 'active' 
      ? selectedRowKeys 
      : activeTabKey === 'cancelledButNotExpired'
      ? cancelledButNotExpiredSelectedKeys
      : cancelledSelectedKeys;
    
    if (currentSelectedKeys.length === 0) {
      message.warning('请先选择要编辑的IP段');
      return;
    }

    try {
      const values = await batchHistoryForm.validateFields();
      const { projectGroup, startDate, endDate, operation } = values;
      
      if (!projectGroup) {
        message.warning('请选择项目组');
        return;
      }

      if (!startDate || !startDate.isValid()) {
        message.warning('请选择开始日期');
        return;
      }

      const startDateStr = startDate.format('YYYY-MM-DD');
      const endDateStr = endDate && endDate.isValid() ? endDate.format('YYYY-MM-DD') : undefined;
      const projectGroupStr = String(projectGroup);

      let successCount = 0;
      let failCount = 0;
      const allSegments = ipSegmentStorage.getAll();

      currentSelectedKeys.forEach(key => {
        const segment = allSegments.find(s => s.id === key);
        if (!segment) {
          failCount++;
          return;
        }

        try {
          let updatedHistory: IPSegmentHistory[] = segment.history ? [...segment.history] : [];
          
          if (operation === 'add') {
            // 添加新的历程记录
            const newHistory: IPSegmentHistory = {
              id: `history-${segment.id}-${Date.now()}-${Math.random()}`,
              projectGroup: projectGroupStr,
              startDate: startDateStr,
              endDate: endDateStr,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            updatedHistory.push(newHistory);
          } else if (operation === 'update_current') {
            // 更新当前正在使用的历程记录（没有结束日期的记录）
            const currentHistoryIndex = updatedHistory.findIndex(h => !h.endDate);
            if (currentHistoryIndex >= 0) {
              // 更新现有记录
              updatedHistory[currentHistoryIndex] = {
                ...updatedHistory[currentHistoryIndex],
                projectGroup: projectGroupStr,
                startDate: startDateStr,
                endDate: endDateStr,
                updatedAt: new Date().toISOString(),
              };
            } else {
              // 如果没有当前记录，添加新记录
              const newHistory: IPSegmentHistory = {
                id: `history-${segment.id}-${Date.now()}-${Math.random()}`,
                projectGroup: projectGroupStr,
                startDate: startDateStr,
                endDate: endDateStr,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              updatedHistory.push(newHistory);
            }
          } else if (operation === 'end_current') {
            // 结束当前正在使用的历程记录
            const currentHistoryIndex = updatedHistory.findIndex(h => !h.endDate);
            if (currentHistoryIndex >= 0) {
              updatedHistory[currentHistoryIndex] = {
                ...updatedHistory[currentHistoryIndex],
                endDate: endDateStr || startDateStr,
                updatedAt: new Date().toISOString(),
              };
            }
          }

          // 按开始日期排序
          updatedHistory.sort((a, b) => dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf());

          // 对于已到期的IP段，自动设置最后一条历程记录的结束日期为到期时间
          const expiryDate = calculateCancelledExpiryDate(segment);
          const now = dayjs();
          if (expiryDate && updatedHistory.length > 0 && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
            const lastHistory = updatedHistory[updatedHistory.length - 1];
            if (!lastHistory.endDate || dayjs(lastHistory.endDate).isAfter(expiryDate, 'day')) {
              updatedHistory[updatedHistory.length - 1] = {
                ...lastHistory,
                endDate: expiryDate.format('YYYY-MM-DD'),
                updatedAt: new Date().toISOString(),
              };
            }
          }

          const mergedForSync = {
            ...segment,
            history: updatedHistory.length > 0 ? updatedHistory : undefined,
          } as IPSegment;
          const pgSync = getProjectGroupsFromHistorySync(mergedForSync);
          ipSegmentStorage.update(segment.id, {
            history: updatedHistory.length > 0 ? updatedHistory : undefined,
            ...(pgSync && pgSync.length ? { projectGroups: pgSync } : {}),
            updatedAt: new Date().toISOString(),
          });
          successCount++;
        } catch (error) {
          console.error(`更新IP段 ${segment.segment} 的历程记录失败:`, error);
          failCount++;
        }
      });

      if (successCount > 0) {
        message.success(`成功更新 ${successCount} 条IP段的历程记录${failCount > 0 ? `，失败 ${failCount} 条` : ''}`);
        setIsBatchHistoryEditVisible(false);
        batchHistoryForm.resetFields();
        loadData();
        saveDataToFile();
        
        // 清空选中项
        if (activeTabKey === 'all') {
          setAllSegmentsSelectedKeys([]);
        } else if (activeTabKey === 'active') {
          setSelectedRowKeys([]);
        } else if (activeTabKey === 'cancelledButNotExpired') {
          setCancelledButNotExpiredSelectedKeys([]);
        } else {
          setCancelledSelectedKeys([]);
        }
      } else {
        message.error('更新失败');
      }
    } catch (error) {
      console.error('批量编辑历程记录失败:', error);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      
      // 检查IP段是否已存在（编辑时排除当前记录）
      const existingSegments = ipSegmentStorage.getAll();
      const duplicateSegment = existingSegments.find(
        seg => seg.segment.toLowerCase().trim() === values.segment.toLowerCase().trim() 
        && (!editingSegment || seg.id !== editingSegment.id)
      );
      
      if (duplicateSegment) {
        message.error(`IP段 "${values.segment}" 已存在，请勿重复添加！`);
        return;
      }
      
      // 如果有购买时间，自动计算续费时间
      let renewalDate = values.renewalDate;
      if (values.purchaseDate && values.purchaseDate.isValid()) {
        renewalDate = calculateRenewalDate(values.purchaseDate);
      }
      
      // 处理历程记录：如果没有历程记录但有项目组和购买日期，自动创建初始记录
      let finalHistory = segmentHistory;
      if (finalHistory.length === 0 && values.projectGroups && values.projectGroups.length > 0 && values.purchaseDate) {
        const purchaseDateStr = values.purchaseDate.format('YYYY-MM-DD');
        finalHistory = [{
          id: `history-${editingSegment?.id || `ip-${Date.now()}`}-initial`,
          projectGroup: Array.isArray(values.projectGroups) ? values.projectGroups[0] : values.projectGroups,
          startDate: purchaseDateStr,
          endDate: undefined, // 当前仍在使用
          createdAt: editingSegment?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }];
      }
      
      const blockedCountries = values.blockedCountries || [];
      const rateLimitedCountries = values.rateLimitedCountries || [];
      const detectedCountries = [...new Set([...blockedCountries, ...rateLimitedCountries, ...(editingSegment?.detectedCountries || [])])];

      const purchaseStr = values.purchaseDate?.isValid() ? values.purchaseDate.format('YYYY-MM-DD') : '';
      const rawPrevList = (values.previousPurchaseDates || []) as unknown[];
      const previousPurchaseDatesSorted = Array.from(
        new Set(
          rawPrevList
            .map((d) => (d && dayjs.isDayjs(d) && d.isValid() ? d.format('YYYY-MM-DD') : ''))
            .filter((s) => {
              if (!s) return false;
              if (s === purchaseStr) return false;
              if (purchaseStr && !dayjs(s).isBefore(dayjs(purchaseStr), 'day')) return false;
              return true;
            })
        )
      ).sort((a, b) => dayjs(a).valueOf() - dayjs(b).valueOf());
      
      let segmentData: IPSegment = {
        id: editingSegment?.id || `ip-${Date.now()}`,
        segment: values.segment.trim(),
        supplier: values.supplier || '',
        asn: normalizeAsnDigitsOnly(values.asn ?? ''),
        usageArea: (values.usageArea || '').trim(),
        purchaseDate: values.purchaseDate ? values.purchaseDate.format('YYYY-MM-DD') : '',
        renewalDate: renewalDate.format('YYYY-MM-DD'),
        cancellationDate: values.cancellationDate ? values.cancellationDate.format('YYYY-MM-DD') : '',
        monthlyPrice: values.monthlyPrice,
        renewalStatus: values.renewalStatus || 'not_renewed',
        projectGroups: values.projectGroups || [],
        serverLocations: values.serverLocations || [],
        blockedCountries,
        rateLimitedCountries,
        detectedCountries,
        history: finalHistory.length > 0 ? finalHistory : undefined,
        multiPurchaseMarked: !!values.multiPurchaseMarked,
        previousPurchaseDates: previousPurchaseDatesSorted.length > 0 ? previousPurchaseDatesSorted : undefined,
        additionalAsns: editingSegment?.additionalAsns,
        createdAt: editingSegment?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const repurchaseHeal = normalizeSegmentHistoryAndRepurchaseSegment(segmentData, calculateCancelledExpiryDate);
      if (repurchaseHeal.changed) {
        segmentData = repurchaseHeal.segment;
        finalHistory = segmentData.history ? [...segmentData.history] : [];
      }
      
      // 对于已到期的IP段，自动设置最后一条历程记录的结束日期为到期时间（不得覆盖再次购买后的新历程）
      if (finalHistory.length > 0) {
        const expiryDate = calculateCancelledExpiryDate(segmentData);
        const now = dayjs();
        if (expiryDate && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
          const sortedHistory = [...finalHistory].sort((a, b) => 
            dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
          );
          const lastHistory = sortedHistory[sortedHistory.length - 1];
          if (dayjs(lastHistory.startDate).isAfter(expiryDate, 'day')) {
            // 新购买周期，不自动写旧到期结束日
          } else if (!lastHistory.endDate || dayjs(lastHistory.endDate).isAfter(expiryDate, 'day')) {
            finalHistory = finalHistory.map(h => 
              h.id === lastHistory.id 
                ? { ...h, endDate: expiryDate.format('YYYY-MM-DD'), updatedAt: new Date().toISOString() }
                : h
            );
            segmentData.history = finalHistory;
          }
        }
      }

      // 用户在表单中手动修改了 projectGroups 时，将最新未结束的历程条目同步更新，
      // 而不是让历程反过来覆盖用户的修改。
      // 历程同步仅用于"展示"层（getEffectiveProjectGroups），不应覆盖用户的保存意图。
      const formProjectGroups = values.projectGroups || [];
      if (formProjectGroups.length > 0 && segmentData.history && segmentData.history.length > 0) {
        const openEntries = segmentData.history.filter((h: any) => !h.endDate);
        if (openEntries.length > 0) {
          // 找最新的未结束历程，将其 projectGroup 同步为用户填写的第一个项目组
          const latestOpen = openEntries.reduce((a: any, b: any) =>
            dayjs(a.startDate).isAfter(dayjs(b.startDate), 'day') ? a : b
          );
          segmentData = {
            ...segmentData,
            history: segmentData.history.map((h: any) =>
              h.id === latestOpen.id ? { ...h, projectGroup: formProjectGroups[0] } : h
            ),
          };
        }
      }

      if (editingSegment) {
        ipSegmentStorage.update(editingSegment.id, segmentData);
        message.success('更新成功');
      } else {
        ipSegmentStorage.add(segmentData);
        message.success('添加成功');
      }

      setIsModalVisible(false);
      loadData();
      // 自动保存到文件
      saveDataToFile();
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };


  // 复制文本到剪贴板
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制: ${text}`);
    } catch (err) {
      // 降级方案：使用传统方法
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        message.success(`已复制: ${text}`);
      } catch (e) {
        message.error('复制失败，请手动复制');
      }
      document.body.removeChild(textArea);
    }
  };


  // 解析被墙信息导入
  const parseBlockedInfoImport = (text: string): { segments: Partial<IPSegment>[]; skippedSegments: string[] } => {
    const lines = text.split('\n').filter(line => line.trim());
    const segments: Partial<IPSegment>[] = [];
    const skippedSegments: string[] = [];

    lines.forEach((line, index) => {
      try {
        // 支持 Tab、逗号、空格作为分隔符（优先级：Tab > 逗号 > 空格）
        let parts: string[];
        if (line.includes('\t')) {
          parts = line.split('\t').map(p => p.trim()).filter(Boolean);
        } else if (line.includes(',') || line.includes('，')) {
          const normalizedLine = line.replace(/，/g, ',');
          parts = normalizedLine.split(',').map(p => p.trim()).filter(Boolean);
        } else {
          // 支持空格分隔：IP段 伊朗被墙 土库曼被墙 俄罗斯被墙
          parts = line.split(/\s+/).map(p => p.trim()).filter(Boolean);
        }
        
        // IP段为必填项，被墙信息为选填项
        // 格式：IP段[ 地区状态1][ 地区状态2]... 或 IP段,地区状态1,地区状态2
        if (parts.length >= 1) {
          const segment = parts[0] || '';
          
          if (!segment.trim()) {
            skippedSegments.push(`第${index + 1}行（缺少IP段）`);
            return;
          }
          
          // 判断被墙状态的辅助函数
          const isBlocked = (status: string) => {
            const s = status.trim();
            if (s.includes('被墙')) return true;
            const lowerS = s.toLowerCase();
            return ['是', 'true', '1', 'yes', 'y', 'blocked'].includes(lowerS);
          };
          // 判断限速状态的辅助函数
          const isRateLimited = (status: string) => {
            const s = status.trim();
            if (s.includes('限速')) return true;
            const lowerS = s.toLowerCase();
            return ['限速', 'throttle', 'throttled', 'ratelimit'].some(k => lowerS.includes(k));
          };
          
          // 记录哪些地区有数据（用于区分"未检测"和"可用"）
          const detectedCountries = {
            iran: false,
            myanmar: false,
            turkmenistan: false,
            russia: false,
          };
          
          // 根据文本内容智能匹配地区
          const blockedCountries: BlockedCountry[] = [];
          const rateLimitedCountries: BlockedCountry[] = [];
          
          // 遍历所有部分，查找地区关键词
          for (let i = 1; i < parts.length; i++) {
            const part = parts[i];
            
            // 伊朗
            if (part.includes('伊朗')) {
              detectedCountries.iran = true;
              if (isBlocked(part)) {
                blockedCountries.push('iran');
              } else if (isRateLimited(part)) {
                rateLimitedCountries.push('iran');
              }
            }
            // 缅甸
            if (part.includes('缅甸')) {
              detectedCountries.myanmar = true;
              if (isBlocked(part)) {
                blockedCountries.push('myanmar');
              } else if (isRateLimited(part)) {
                rateLimitedCountries.push('myanmar');
              }
            }
            // 土库曼
            if (part.includes('土库曼')) {
              detectedCountries.turkmenistan = true;
              if (isBlocked(part)) {
                blockedCountries.push('turkmenistan');
              } else if (isRateLimited(part)) {
                rateLimitedCountries.push('turkmenistan');
              }
            }
            // 俄罗斯
            if (part.includes('俄罗斯')) {
              detectedCountries.russia = true;
              if (isBlocked(part)) {
                blockedCountries.push('russia');
              } else if (isRateLimited(part)) {
                rateLimitedCountries.push('russia');
              }
            }
          }
          
          // 使用默认值填充其他必填字段
          const today = dayjs();
          const purchaseDate = today.format('YYYY-MM-DD');
          const renewalDate = calculateRenewalDate(today).format('YYYY-MM-DD');
          
          segments.push({
            segment: segment.trim(),
            usageArea: '未使用',
            supplier: '',
            asn: '',
            purchaseDate: purchaseDate,
            renewalDate: renewalDate,
            cancellationDate: '',
            monthlyPrice: 0,
            renewalStatus: 'not_renewed',
            projectGroups: [],
            serverLocations: [],
            blockedCountries: blockedCountries,
            rateLimitedCountries: rateLimitedCountries,
            // 添加自定义字段记录检测状态
            _detectedCountries: detectedCountries,
          } as any);
        } else {
          skippedSegments.push(`第${index + 1}行（格式错误）`);
        }
      } catch (error) {
        console.error(`解析第 ${index + 1} 行时出错:`, error);
        // 尝试提取IP段信息
        const simpleParts = line.split(/[\t,，]/).map(p => p.trim());
        if (simpleParts.length > 0 && simpleParts[0]) {
          skippedSegments.push(`${simpleParts[0]} (解析错误)`);
        } else {
          skippedSegments.push(`第${index + 1}行（解析失败）`);
        }
      }
    });

    return { segments, skippedSegments };
  };

  // 从文本解析续费状态（取消续费、已续费、已退款）
  const parseRenewalStatusFromText = (text: string): RenewalStatus | null => {
    const t = (text || '').trim();
    if (t === '取消续费') return 'cancelled';
    if (t === '已退款') return 'refunded';
    return null;
  };

  // 解析文本格式导入
  const parseTextImport = (text: string): { segments: Partial<IPSegment>[]; skippedSegments: string[] } => {
    const lines = text.split('\n').filter(line => line.trim());
    const segments: Partial<IPSegment>[] = [];
    const skippedSegments: string[] = [];

    lines.forEach((line, index) => {
      try {
        // 支持Tab键、英文逗号和中文逗号作为分隔符
        // 先统一将中文逗号替换为英文逗号
        let normalizedLine = line.replace(/，/g, ',');
        
        // 检测分隔符：Tab > 逗号 > 空格
        let parts: string[];
        if (normalizedLine.includes('\t')) {
          parts = normalizedLine.split('\t').map(p => p.trim());
        } else if (normalizedLine.includes(',')) {
          parts = normalizedLine.split(',').map(p => p.trim());
        } else {
          // 空格分隔（如：78.31.249.0/24 ZET 92 2025-12-17 2026-03-05 取消续费）
          parts = normalizedLine.split(/\s+/).map(p => p.trim()).filter(Boolean);
        }
        
        // 支持多种格式：
        // 3个字段：IP段,费用,购买时间
        // 4个字段：IP段,使用地区,费用,购买时间 或 IP段,费用,购买时间,取消时间
        // 5个字段：IP段,使用地区,费用,购买时间,供应商 或 IP段,使用地区,费用,购买时间,取消时间
        // 6个字段：IP段,使用地区,费用,购买时间,取消时间,供应商
        if (parts.length >= 3) {
          let segment = '';
          let usageArea = '';
          let monthlyPrice = '';
          let purchaseDate = '';
          let cancellationDate = '';
          let supplier = '';
          let renewalStatusFromField: RenewalStatus | null = null;
          
          // 检测哪些字段是日期格式
          const dateIndices: number[] = [];
          parts.forEach((part, idx) => {
            if (dayjs(part).isValid() && (part.includes('-') || part.includes('/'))) {
              dateIndices.push(idx);
            }
          });
          
          if (parts.length === 3) {
            // 格式：IP段,费用,购买时间
            segment = parts[0] || '';
            monthlyPrice = parts[1] || '0';
            purchaseDate = parts[2] || '';
          } else if (parts.length === 4) {
            if (dateIndices.length >= 2 && dateIndices[0] === 2 && dateIndices[1] === 3) {
              // 格式：IP段,费用,购买时间,取消时间
              segment = parts[0] || '';
              monthlyPrice = parts[1] || '0';
              purchaseDate = parts[2] || '';
              cancellationDate = parts[3] || '';
            } else {
              // 格式：IP段,使用地区,费用,购买时间
              segment = parts[0] || '';
              usageArea = parts[1] || '';
              monthlyPrice = parts[2] || '0';
              purchaseDate = parts[3] || '';
            }
          } else if (parts.length === 5) {
            if (dateIndices.length >= 2 && dateIndices[0] === 3 && dateIndices[1] === 4) {
              // 格式：IP段,使用地区,费用,购买时间,取消时间
              segment = parts[0] || '';
              usageArea = parts[1] || '';
              monthlyPrice = parts[2] || '0';
              purchaseDate = parts[3] || '';
              cancellationDate = parts[4] || '';
            } else {
              // 格式：IP段,使用地区,费用,购买时间,供应商
              segment = parts[0] || '';
              usageArea = parts[1] || '';
              monthlyPrice = parts[2] || '0';
              purchaseDate = parts[3] || '';
              supplier = parts[4] || '';
            }
          } else if (parts.length >= 6) {
            const sixthField = parts[5] || '';
            const parsedRenewalStatus = parseRenewalStatusFromText(sixthField);
            if (parsedRenewalStatus !== null) {
              // 格式：IP段,使用地区,费用,购买时间,取消时间,续费状态（取消续费/已退款）
              segment = parts[0] || '';
              usageArea = parts[1] || '';
              monthlyPrice = parts[2] || '0';
              purchaseDate = parts[3] || '';
              cancellationDate = parts[4] || '';
              supplier = '';
              // 使用第6字段的续费状态，在下方 segments.push 时应用
              renewalStatusFromField = parsedRenewalStatus;
            } else {
              // 格式：IP段,使用地区,费用,购买时间,取消时间,供应商
              segment = parts[0] || '';
              usageArea = parts[1] || '';
              monthlyPrice = parts[2] || '0';
              purchaseDate = parts[3] || '';
              cancellationDate = parts[4] || '';
              supplier = sixthField;
            }
          }
          
          // 验证购买日期格式（购买时间为必填项）
          if (!purchaseDate || purchaseDate.trim() === '') {
            // 购买时间为空，跳过这条记录
            if (segment && segment.trim()) {
              skippedSegments.push(segment.trim());
            }
            return; // 跳过这条记录
          }
          
          let validPurchaseDate = purchaseDate;
          if (!dayjs(purchaseDate).isValid()) {
            // 如果日期格式无效，跳过这条记录
            if (segment && segment.trim()) {
              skippedSegments.push(segment.trim());
            }
            return; // 跳过这条记录
          }
          
          // 验证取消日期格式（如果提供了）
          let validCancellationDate = cancellationDate;
          if (cancellationDate && cancellationDate.trim()) {
            if (!dayjs(cancellationDate).isValid()) {
              // 取消日期格式无效，跳过这条记录
              if (segment && segment.trim()) {
                skippedSegments.push(`${segment.trim()}（取消时间格式无效）`);
              }
              return; // 跳过这条记录
            }
            
            // 验证取消时间必须大于购买时间
            const purchaseDateObj = dayjs(validPurchaseDate);
            const cancellationDateObj = dayjs(validCancellationDate);
            if (cancellationDateObj.isBefore(purchaseDateObj) || cancellationDateObj.isSame(purchaseDateObj)) {
              // 取消时间必须大于购买时间
              if (segment && segment.trim()) {
                skippedSegments.push(`${segment.trim()}（取消时间必须大于购买时间）`);
              }
              return; // 跳过这条记录
            }
          }
          
          // 清理价格字段：移除所有非数字字符（保留小数点和负号）
          const cleanPrice = monthlyPrice.replace(/[^\d.-]/g, '');
          const price = parseFloat(cleanPrice) || 0;
          
          // 计算续费时间
          const purchaseDateObj = dayjs(validPurchaseDate);
          let renewalDate: string;
          let renewalStatus: RenewalStatus = 'not_renewed';
          
          if (validCancellationDate && validCancellationDate.trim()) {
            // 如果提供了取消时间，根据购买时间的"日"和取消时间的"日"来判断续费时间的月份
            const cancellationDateObj = dayjs(validCancellationDate);
            const purchaseDay = purchaseDateObj.date(); // 购买时间的"日"（1-31）
            const cancellationDay = cancellationDateObj.date(); // 取消时间的"日"（1-31）
            
            // 当购买时间的"日" <= 取消时间的"日"时，续费时间的月份与取消时间相同
            // 当购买时间的"日" > 取消时间的"日"时，续费时间的月份是取消时间的下一个月
            if (purchaseDay <= cancellationDay) {
              // 续费时间 = 取消时间的月份 + 购买时间的"日"
              renewalDate = cancellationDateObj.date(purchaseDay).format('YYYY-MM-DD');
            } else {
              // 续费时间 = 取消时间的下一个月 + 购买时间的"日"
              const nextMonthAfterCancellation = cancellationDateObj.add(1, 'month');
              renewalDate = nextMonthAfterCancellation.date(purchaseDay).format('YYYY-MM-DD');
            }
            
            // 仅当第6字段显式提供取消续费/已续费/已退款时才设置；未提供时保持为空
            renewalStatus = renewalStatusFromField ?? 'not_renewed';
          } else {
            // 如果没有取消时间，使用当前时间+1个月
            renewalDate = calculateRenewalDate(purchaseDateObj).format('YYYY-MM-DD');
            renewalStatus = renewalStatusFromField ?? 'not_renewed';
          }
          
          segments.push({
            segment: segment.trim(),
            usageArea: usageArea.trim() || '未使用',
            supplier: supplier.trim() || '',
            asn: '',
            purchaseDate: validPurchaseDate,
            renewalDate: renewalDate,
            cancellationDate: validCancellationDate || '',
            monthlyPrice: price,
            renewalStatus: renewalStatus,
            projectGroups: [],
            serverLocations: [],
            blockedCountries: [],
          });
        } else {
          // 字段数量不足，尝试提取IP段
          if (parts.length > 0 && parts[0] && parts[0].trim()) {
            skippedSegments.push(parts[0].trim());
          }
        }
      } catch (error) {
        console.error(`解析第 ${index + 1} 行时出错:`, error);
        // 尝试提取IP段
        try {
          const normalizedLine = line.replace(/，/g, ',');
          const parts = normalizedLine.includes('\t') 
            ? normalizedLine.split('\t').map(p => p.trim())
            : normalizedLine.split(',').map(p => p.trim());
          if (parts.length > 0 && parts[0] && parts[0].trim()) {
            skippedSegments.push(parts[0].trim());
          }
        } catch (e) {
          // 无法提取IP段，跳过
        }
      }
    });

    return { segments, skippedSegments };
  };

  // 处理被墙信息导入
  const handleBlockedInfoImport = () => {
    if (!blockedInfoImportValue.trim()) {
      message.warning('请输入要导入的被墙信息');
      return;
    }

    try {
      const { segments, skippedSegments } = parseBlockedInfoImport(blockedInfoImportValue);
      
      // 如果有跳过的IP段，提示用户
      if (skippedSegments.length > 0) {
        const skippedText = skippedSegments.length <= 5 
          ? skippedSegments.join('、') 
          : `${skippedSegments.slice(0, 5).join('、')} 等共 ${skippedSegments.length} 个`;
        message.warning(`以下IP段因格式无效已跳过：${skippedText}`);
      }
      
      if (segments.length === 0) {
        message.error('未能解析出有效数据，请检查格式。格式：IP段,伊朗,缅甸,土库曼,俄罗斯（分隔符支持逗号或Tab键）');
        return;
      }

      // 验证解析出的数据
      const validSegments = segments.filter(seg => seg.segment);
      if (validSegments.length === 0) {
        message.warning('解析出的数据缺少必填字段（IP段）');
        return;
      }

      // 检查重复的IP段
      const segmentSet = new Set<string>();
      const duplicateSegments: string[] = [];
      const uniqueSegments: Partial<IPSegment>[] = [];

      validSegments.forEach(seg => {
        const segmentKey = seg.segment!.toLowerCase().trim();
        if (segmentSet.has(segmentKey)) {
          duplicateSegments.push(seg.segment!);
        } else {
          segmentSet.add(segmentKey);
          uniqueSegments.push(seg);
        }
      });

      if (duplicateSegments.length > 0) {
        message.warning(
          `解析完成，发现 ${duplicateSegments.length} 个重复的IP段：${duplicateSegments.slice(0, 5).join('、')}${duplicateSegments.length > 5 ? '...' : ''}。已自动去除重复项，保留 ${uniqueSegments.length} 条数据。`
        );
      } else if (validSegments.length < segments.length) {
        message.warning(`成功解析 ${validSegments.length} 条有效数据，${segments.length - validSegments.length} 条数据因格式问题被跳过`);
      } else {
        message.success(`成功解析 ${validSegments.length} 条数据，请检查后点击"批量添加"`);
      }

      setBatchTableData(
        uniqueSegments.map((row) =>
          normalizeBatchImportFields(row, usageAreas, suppliers, projectGroups, ipSegments),
        ),
      );
    } catch (error) {
      message.error('解析失败，请检查数据格式');
      console.error(error);
    }
  };

  // 处理文本格式导入
  const handleTextImport = () => {
    if (!textImportValue.trim()) {
      message.warning('请输入要导入的数据');
      return;
    }

    try {
      const { segments, skippedSegments } = parseTextImport(textImportValue);
      
      // 如果有跳过的IP段，提示用户
      if (skippedSegments.length > 0) {
        const skippedText = skippedSegments.length <= 5 
          ? skippedSegments.join('、') 
          : `${skippedSegments.slice(0, 5).join('、')} 等共 ${skippedSegments.length} 个`;
        message.warning(`以下IP段因购买时间为空或格式无效已跳过：${skippedText}。请补充购买时间后重试。`);
      }
      
      if (segments.length === 0) {
        message.error('未能解析出有效数据，请检查格式。支持格式：3个字段(IP段,费用,购买时间)、4个字段(IP段,使用地区,费用,购买时间)或5个字段(IP段,使用地区,费用,购买时间,供应商)（分隔符支持逗号或Tab键）。注意：购买时间为必填项！');
        return;
      }

      // 验证解析出的数据（供应商为非必填）
      const validSegments = segments.filter(seg => seg.segment);
      if (validSegments.length === 0) {
        message.warning('解析出的数据缺少必填字段（IP段）');
        return;
      }

      // 检查重复的IP段
      const segmentSet = new Set<string>();
      const duplicateSegments: string[] = [];
      const uniqueSegments: Partial<IPSegment>[] = [];

      validSegments.forEach(seg => {
        const segmentKey = seg.segment!.toLowerCase().trim();
        if (segmentSet.has(segmentKey)) {
          duplicateSegments.push(seg.segment!);
        } else {
          segmentSet.add(segmentKey);
          uniqueSegments.push(seg);
        }
      });

      if (duplicateSegments.length > 0) {
        message.warning(
          `解析完成，发现 ${duplicateSegments.length} 个重复的IP段：${duplicateSegments.slice(0, 5).join('、')}${duplicateSegments.length > 5 ? '...' : ''}。已自动去除重复项，保留 ${uniqueSegments.length} 条数据。`
        );
      } else if (validSegments.length < segments.length) {
        message.warning(`成功解析 ${validSegments.length} 条有效数据，${segments.length - validSegments.length} 条数据因格式问题被跳过`);
      } else {
        message.success(`成功解析 ${validSegments.length} 条数据，请检查后点击"批量添加"`);
      }

      setBatchTableData(
        uniqueSegments.map((row) =>
          normalizeBatchImportFields(row, usageAreas, suppliers, projectGroups, ipSegments),
        ),
      );
    } catch (error) {
      message.error('解析失败，请检查数据格式');
      console.error(error);
    }
  };

  // 批量添加IP段
  const handleBatchAdd = () => {
    if (batchTableData.length === 0) {
      message.warning('没有可添加的数据');
      return;
    }

    // 获取现有数据
    const existingSegments = ipSegmentStorage.getAll();
    const existingSegmentMap = new Map<string, IPSegment>();
    existingSegments.forEach(seg => {
      existingSegmentMap.set(seg.segment.toLowerCase().trim(), seg);
    });

    // 检查批量数据内部的重复
    const segmentSet = new Set<string>();
    const duplicateInBatch: string[] = [];
    const duplicateWithExisting: Array<{ segment: string; existingData: IPSegment }> = [];
    const uniqueItems: Partial<IPSegment>[] = [];

    const prepared = batchTableData.map((row) =>
      normalizeBatchImportFields(row, usageAreas, suppliers, projectGroups, ipSegments),
    );

    prepared.forEach((item) => {
      if (item.segment) {
        const segmentKey = item.segment.toLowerCase().trim();
        if (segmentSet.has(segmentKey)) {
          // 批量数据内部重复，只保留第一个
          duplicateInBatch.push(item.segment);
        } else {
          segmentSet.add(segmentKey);
          if (existingSegmentMap.has(segmentKey)) {
            // 与现有数据重复
            duplicateWithExisting.push({
              segment: item.segment,
              existingData: existingSegmentMap.get(segmentKey)!
            });
          } else {
            // 不重复，可以正常添加
            uniqueItems.push(item);
          }
        }
      }
    });

    // 如果有批量数据内部重复，提示
    if (duplicateInBatch.length > 0) {
      message.warning(
        `批量数据内部发现 ${duplicateInBatch.length} 个重复的IP段：${duplicateInBatch.slice(0, 5).join('、')}${duplicateInBatch.length > 5 ? '...' : ''}。已自动去除重复项。`
      );
    }

    // 检查是否为被墙信息导入
    const isBlockedInfoImport = batchTableData.length > 0 && (batchTableData[0] as any)._detectedCountries !== undefined;
    
    // 如果有与现有数据重复的，弹出确认对话框
    if (duplicateWithExisting.length > 0) {
      const duplicateList = duplicateWithExisting.map(d => d.segment).slice(0, 10);
      const duplicateText = duplicateList.join('、') + (duplicateWithExisting.length > 10 ? ` 等共${duplicateWithExisting.length}个` : '');
      
      Modal.confirm({
        title: '发现重复的IP段',
        width: 500,
        content: (
          <div>
            <p>以下IP段已存在：</p>
            <p style={{ margin: '8px 0', color: '#666', fontSize: '12px', maxHeight: '150px', overflow: 'auto' }}>
              {duplicateText}
            </p>
            <p style={{ marginTop: '12px' }}>请选择操作：</p>
            <ul style={{ margin: '8px 0', paddingLeft: '20px', color: '#666', fontSize: '12px' }}>
              {isBlockedInfoImport ? (
                <>
                  <li><strong>覆盖添加</strong>：更新被墙信息（只更新检测到的地区，其他信息保持不变）</li>
                  <li><strong>跳过重复</strong>：跳过所有重复的IP段，只添加未重复的</li>
                </>
              ) : (
                <>
                  <li><strong>覆盖添加</strong>：更新重复的IP段（只更新导入数据中提供的字段，未涉及的字段保留原值），未重复的正常添加</li>
                  <li><strong>跳过重复</strong>：跳过所有重复的IP段，只添加未重复的</li>
                </>
              )}
            </ul>
          </div>
        ),
        okText: isBlockedInfoImport ? '覆盖添加' : '覆盖添加',
        cancelText: '跳过重复',
        onOk: () => {
          // 用户选择覆盖，执行批量添加（包括覆盖重复的）
          executeBatchAdd(prepared, existingSegmentMap, true);
        },
        onCancel: () => {
          // 用户选择跳过重复，只添加不重复的
          executeBatchAdd(uniqueItems, existingSegmentMap, false);
        },
      });
    } else {
      // 没有重复，直接添加
      executeBatchAdd(uniqueItems, existingSegmentMap, false);
    }
  };

  // 执行批量添加
  const executeBatchAdd = (
    itemsToAdd: Partial<IPSegment>[],
    existingSegmentMap: Map<string, IPSegment>,
    overwrite: boolean
  ) => {
    let successCount = 0;
    let failCount = 0;
    let overwriteCount = 0;
    let updateCount = 0; // 被墙信息更新计数
    const failedSegments: string[] = [];

    itemsToAdd.forEach((item, index) => {
      if (!item.segment) {
        failCount++;
        failedSegments.push(`第${index + 1}条（缺少IP段）`);
        console.error(`第 ${index + 1} 条数据缺少必填字段：`, item);
        return;
      }

      try {
        const segmentKey = String(item.segment).trim().toLowerCase();
        const existingData = existingSegmentMap.get(segmentKey);

        // 验证购买日期格式（购买时间为必填项）
        if (!item.purchaseDate || !item.purchaseDate.trim()) {
          failCount++;
          failedSegments.push(`${item.segment}（缺少购买时间）`);
          console.error(`第 ${index + 1} 条数据缺少必填字段（购买时间）：`, item);
          return;
        }
        
        let validPurchaseDate = item.purchaseDate;
        if (!dayjs(validPurchaseDate).isValid()) {
          failCount++;
          failedSegments.push(`${item.segment}（购买时间格式无效：${validPurchaseDate}）`);
          console.error(`第 ${index + 1} 条数据购买时间格式无效：`, item);
          return;
        }

        // 自动计算续费时间（购买时间+1个月）
        const purchaseDateObj = dayjs(validPurchaseDate);
        const renewalDate = calculateRenewalDate(purchaseDateObj).format('YYYY-MM-DD');

        // 确保价格为数字
        const price = typeof item.monthlyPrice === 'number' ? item.monthlyPrice : (parseFloat(String(item.monthlyPrice)) || 0);

        // 检查是否为被墙信息导入（有 _detectedCountries 标记）
        const isBlockedInfoImport = (item as any)._detectedCountries !== undefined;

        let segmentData: IPSegment;
        
        if (existingData && overwrite && isBlockedInfoImport) {
          // 被墙信息导入且存在旧数据：只更新检测到的地区信息（含被墙、限速）
          const detectedCountries = (item as any)._detectedCountries;
          const newBlockedCountries = [...(existingData.blockedCountries || [])];
          const newRateLimitedCountries = [...(existingData.rateLimitedCountries || [])];
          const newDetectedCountries = [...(existingData.detectedCountries || [])];

          const updateCountryStatus = (country: BlockedCountry) => {
            const idxB = newBlockedCountries.indexOf(country);
            if (idxB > -1) newBlockedCountries.splice(idxB, 1);
            const idxR = newRateLimitedCountries.indexOf(country);
            if (idxR > -1) newRateLimitedCountries.splice(idxR, 1);
            if (item.blockedCountries?.includes(country)) {
              newBlockedCountries.push(country);
            } else if (item.rateLimitedCountries?.includes(country)) {
              newRateLimitedCountries.push(country);
            }
            if (!newDetectedCountries.includes(country)) {
              newDetectedCountries.push(country);
            }
          };

          if (detectedCountries?.iran) updateCountryStatus('iran');
          if (detectedCountries?.myanmar) updateCountryStatus('myanmar');
          if (detectedCountries?.turkmenistan) updateCountryStatus('turkmenistan');
          if (detectedCountries?.russia) updateCountryStatus('russia');

          segmentData = {
            ...existingData,
            blockedCountries: newBlockedCountries,
            rateLimitedCountries: newRateLimitedCountries,
            detectedCountries: newDetectedCountries,
            updatedAt: new Date().toISOString(),
          };
          ipSegmentStorage.update(existingData.id, {
            blockedCountries: newBlockedCountries,
            rateLimitedCountries: newRateLimitedCountries,
            detectedCountries: newDetectedCountries,
            updatedAt: new Date().toISOString(),
          });
          updateCount++;
          successCount++;
        } else {
          // 普通导入或新增数据
          // 如果是被墙信息导入，设置 detectedCountries
          let detectedCountriesList: BlockedCountry[] | undefined = existingData?.detectedCountries || [];
          if (isBlockedInfoImport) {
            const detected = (item as any)._detectedCountries;
            const newDetected = [...(existingData?.detectedCountries || [])];
            if (detected?.iran && !newDetected.includes('iran')) newDetected.push('iran');
            if (detected?.myanmar && !newDetected.includes('myanmar')) newDetected.push('myanmar');
            if (detected?.turkmenistan && !newDetected.includes('turkmenistan')) newDetected.push('turkmenistan');
            if (detected?.russia && !newDetected.includes('russia')) newDetected.push('russia');
            detectedCountriesList = newDetected;
          }
          
          // 判断字段是否有值（非空、非undefined）
          const hasValue = (value: any): boolean => {
            if (value === undefined || value === null) return false;
            if (typeof value === 'string' && value.trim() === '') return false;
            if (typeof value === 'number' && isNaN(value)) return false;
            return true;
          };
          
          if (existingData && overwrite) {
            // IP段已存在且需要更新：只更新导入数据中提供的字段，未涉及的字段保留原值
            const updateData: Partial<IPSegment> = {
              updatedAt: new Date().toISOString(),
            };
            
            // 只更新导入数据中有值的字段
            if (hasValue(item.supplier)) {
              updateData.supplier = String(item.supplier).trim();
            }
            if (hasValue(item.asn)) {
              updateData.asn = normalizeAsnDigitsOnly(String(item.asn).trim());
            }
            if (hasValue(item.usageArea)) {
              updateData.usageArea = String(item.usageArea).trim();
            }
            // 购买时间总是更新（因为它是必填项）
            updateData.purchaseDate = validPurchaseDate;
            updateData.renewalDate = renewalDate;
            if (hasValue(item.cancellationDate)) {
              updateData.cancellationDate = String(item.cancellationDate).trim();
            }
            // 价格：如果导入数据中有值（包括0），则更新；如果未提供，保留原值
            if (item.monthlyPrice !== undefined && item.monthlyPrice !== null) {
              updateData.monthlyPrice = price;
            }
            if (hasValue(item.renewalStatus)) {
              updateData.renewalStatus = item.renewalStatus as RenewalStatus;
            }
            // 数组字段：如果导入数据中有值（非空数组），则更新；否则保留原值
            if (Array.isArray(item.projectGroups) && item.projectGroups.length > 0) {
              updateData.projectGroups = item.projectGroups;
            }
            if (Array.isArray(item.serverLocations) && item.serverLocations.length > 0) {
              updateData.serverLocations = item.serverLocations;
            }
            if (Array.isArray(item.blockedCountries) && item.blockedCountries.length > 0) {
              updateData.blockedCountries = item.blockedCountries;
            }
            if (Array.isArray(item.rateLimitedCountries)) {
              updateData.rateLimitedCountries = item.rateLimitedCountries;
            }
            if (detectedCountriesList && detectedCountriesList.length > 0) {
              updateData.detectedCountries = detectedCountriesList;
            }
            
            // 使用update方法进行部分更新
            ipSegmentStorage.update(existingData.id, updateData);
            if (isBlockedInfoImport) {
              updateCount++; // 被墙信息导入的更新
            } else {
              overwriteCount++; // 普通导入的更新
            }
            successCount++;
          } else if (!existingData) {
            // 新增数据：使用完整数据（只有当existingData不存在时才添加）
            segmentData = {
              id: `ip-${Date.now()}-${Math.random()}-${index}`,
              segment: String(item.segment).trim(),
              supplier: item.supplier ? String(item.supplier).trim() : '',
              asn: normalizeAsnDigitsOnly(item.asn ?? ''),
              usageArea: (item.usageArea || '').trim() || '未使用',
              purchaseDate: validPurchaseDate,
              renewalDate: renewalDate,
              cancellationDate: item.cancellationDate || '',
              monthlyPrice: price,
              renewalStatus: item.renewalStatus || 'not_renewed',
              projectGroups: Array.isArray(item.projectGroups) ? item.projectGroups : [],
              serverLocations: Array.isArray(item.serverLocations) ? item.serverLocations : [],
              blockedCountries: Array.isArray(item.blockedCountries) ? item.blockedCountries : [],
              rateLimitedCountries: Array.isArray(item.rateLimitedCountries) ? item.rateLimitedCountries : [],
              detectedCountries: detectedCountriesList,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            
            // 添加新数据
            ipSegmentStorage.add(segmentData);
            successCount++;
          }
          // 如果existingData存在但overwrite为false，跳过这条数据（不执行任何操作）
        }
      } catch (error) {
        failCount++;
        failedSegments.push(item.segment || `第${index + 1}条`);
        console.error(`第 ${index + 1} 条数据添加失败:`, error, item);
      }
    });

    if (successCount > 0) {
      let successMsg = '';
      const addCount = successCount - overwriteCount - updateCount;
      
      // 构建成功消息
      if (addCount > 0 && updateCount > 0) {
        successMsg = `成功添加 ${addCount} 条记录，更新 ${updateCount} 条记录`;
      } else if (addCount > 0 && overwriteCount > 0) {
        successMsg = `成功添加 ${addCount} 条记录（其中覆盖 ${overwriteCount} 条）`;
      } else if (updateCount > 0) {
        successMsg = `成功更新 ${updateCount} 条记录`;
      } else if (overwriteCount > 0) {
        successMsg = `成功覆盖 ${overwriteCount} 条记录`;
      } else {
        successMsg = `成功添加 ${successCount} 条记录`;
      }
      
      if (failCount > 0) {
        successMsg += `，失败 ${failCount} 条`;
        if (failedSegments.length > 0 && failedSegments.length <= 5) {
          successMsg += `（${failedSegments.join('、')}）`;
        }
      }
      message.success(successMsg);
      setIsBatchImportVisible(false);
      setBatchTableData([]);
      setTextImportValue('');
      setBlockedInfoImportValue('');
      setPreviewSelectedRowKeys([]);
      loadData();
      // 自动保存到文件
      saveDataToFile();
    } else {
      message.error(`添加失败，共 ${failCount} 条记录无法添加${failedSegments.length > 0 && failedSegments.length <= 5 ? `（${failedSegments.join('、')}）` : ''}`);
    }
  };

  // 添加表格行
  const handleAddTableRow = () => {
    const purchaseDate = dayjs().format('YYYY-MM-DD');
    const renewalDate = calculateRenewalDate(dayjs()).format('YYYY-MM-DD');
    setBatchTableData([...batchTableData, {
      segment: '',
      supplier: '',
      asn: '',
      usageArea: '未使用',
      purchaseDate: purchaseDate,
      renewalDate: renewalDate,
      cancellationDate: '',
      monthlyPrice: 0,
      renewalStatus: 'not_renewed',
      projectGroups: [],
      serverLocations: [],
      blockedCountries: [],
    }]);
  };

  // 删除表格行
  const handleDeleteTableRow = (index: number) => {
    const newData = [...batchTableData];
    newData.splice(index, 1);
    setBatchTableData(newData);
  };

  // 更新表格数据
  const handleTableDataChange = (index: number, field: string, value: any) => {
    const newData = [...batchTableData];
    const nextVal = field === 'asn' ? normalizeAsnDigitsOnly(value) : value;
    newData[index] = { ...newData[index], [field]: nextVal };
    setBatchTableData(newData);
  };

  const columns: ColumnsType<IPSegment> = [
    {
      title: 'IP段',
      dataIndex: 'segment',
      key: 'segment',
      width: 152,
      fixed: 'left',
      sorter: (a, b) => String(a.segment ?? '').localeCompare(String(b.segment ?? ''), 'zh-CN'),
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="搜索IP段"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            onPressEnter={() => confirm()}
            style={{ marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button type="primary" onClick={() => confirm()} size="small" style={{ width: 90 }}>
              搜索
            </Button>
            <Button onClick={() => clearFilters && clearFilters()} size="small" style={{ width: 90 }}>
              重置
            </Button>
          </Space>
        </div>
      ),
      onFilter: (value, record) =>
        String(record.segment ?? '').toLowerCase().includes(String(value).toLowerCase()),
      render: (text: string, record: IPSegment) => {
        // 判断IP段状态，参考到期时间字段的颜色逻辑
        let tagColor: 'red' | 'orange' | 'green' = 'green';
        
        if (record.renewalStatus === 'cancelled' || record.cancellationDate) {
          // 已取消的IP段
          const expiryDate = calculateCancelledExpiryDate(record);
          if (expiryDate) {
            if (expiryDate.isBefore(now, 'day')) {
              // 已取消并到期 - 红色
              tagColor = 'red';
            } else {
              // 已取消但未到期 - 橙色
              tagColor = 'orange';
            }
          } else {
            // 无法计算到期时间，默认为红色（已到期）
            tagColor = 'red';
          }
        } else {
          // 正常使用中 - 绿色
          tagColor = 'green';
        }
        
        return (
          <Space size={4}>
            <Tag
              color={tagColor}
              onClick={() => copyToClipboard(text)}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '0.8';
                e.currentTarget.style.transform = 'scale(1.05)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '1';
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {text}
            </Tag>
            {record.syncSource === 'ipxo_api' && (
              <Tooltip title={`IPXO API 同步${record.ipxoLastSyncAt ? `\n${record.ipxoLastSyncAt.slice(0, 10)}` : ''}`}>
                <Tag
                  color="blue"
                  style={{ fontSize: 10, padding: '0 4px', lineHeight: '16px', cursor: 'default', borderRadius: 4 }}
                >
                  API
                </Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: '使用地区',
      dataIndex: 'usageArea',
      key: 'usageArea',
      width: 124,
      sorter: (a, b) =>
        String(resolveUsageAreaName(a.usageArea)).localeCompare(
          String(resolveUsageAreaName(b.usageArea)),
          'zh-CN',
        ),
      filters: (() => {
        const known = usageAreas.map(area => ({ text: area.name, value: area.name }));
        const resolvedSet = Array.from(new Set(ipSegments.map((s) => resolveUsageAreaName(s.usageArea))));
        const unknownNames = resolvedSet.filter(
          (name) => name && name !== '未使用' && !usageAreas.some((a) => a.name === name),
        );
        return [...known, ...unknownNames.map((name) => ({ text: name, value: name }))];
      })(),
      onFilter: (value, record) => resolveUsageAreaName(record.usageArea) === value,
      render: (area: string) => {
        const displayArea = resolveUsageAreaName(area);
        const areaOption = usageAreas.find(a => a.name === displayArea);
        const color = areaOption ? areaOption.color : getColorForUnknownUsageArea(displayArea);
        return <Tag color={color} style={{ color: '#000' }}>{displayArea}</Tag>;
      },
    },
    {
      title: '费用($)',
      dataIndex: 'monthlyPrice',
      key: 'monthlyPrice',
      width: 100,
      sorter: (a, b) => getDisplayMonthlyPrice(a) - getDisplayMonthlyPrice(b),
      render: (price: number, record: IPSegment) => {
        const displayPrice = getDisplayMonthlyPrice(record);
        const isInterlir = String(record.supplier ?? '').toLowerCase() === INTERLIR_SUPPLIER.toLowerCase();
        const content = price != null && price !== 0 ? `$${displayPrice.toFixed(2)}` : '-';
        if (isInterlir && price != null && price !== 0) {
          const usdAmount = (price * EUR_TO_USD_RATE).toFixed(2);
          return (
            <Tooltip title={`原价: €${price.toFixed(2)} (EUR) ≈ $${usdAmount} (USD)\n汇率: 1 EUR = ${EUR_TO_USD_RATE} USD`}>
              <span style={{ cursor: 'help', borderBottom: '1px dashed #999' }}>{content}</span>
            </Tooltip>
          );
        }
        return <span>{content}</span>;
      },
    },
    {
      title: '购买时间',
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 132,
      sorter: (a, b) => {
        if (!a.purchaseDate) return 1;
        if (!b.purchaseDate) return -1;
        return dayjs(a.purchaseDate).valueOf() - dayjs(b.purchaseDate).valueOf();
      },
      render: (date: string, record: IPSegment) => {
        const display = date ? dayjs(date).format('YYYY-MM-DD') : '-';
        const tip = purchaseDateTooltipTitle(record, display);
        const inner = (
          <span style={{ cursor: tip ? 'help' : undefined, whiteSpace: 'nowrap' }}>
            {display}
            {record.multiPurchaseMarked ? (
              <Tag color="purple" style={{ marginLeft: 6, fontSize: 11, lineHeight: '18px' }}>
                多次
              </Tag>
            ) : null}
          </span>
        );
        return tip ? <Tooltip title={tip}>{inner}</Tooltip> : inner;
      },
    },
    {
      title: '取消时间',
      dataIndex: 'cancellationDate',
      key: 'cancellationDate',
      width: 128,
      sorter: (a, b) => {
        if (!a.cancellationDate) return 1;
        if (!b.cancellationDate) return -1;
        return dayjs(a.cancellationDate).valueOf() - dayjs(b.cancellationDate).valueOf();
      },
      filters: [
        { text: '有取消时间', value: 'has' },
        { text: '无取消时间', value: 'none' },
      ],
      onFilter: (value, record) => {
        if (value === 'has') return !!record.cancellationDate;
        if (value === 'none') return !record.cancellationDate;
        return true;
      },
      render: (date: string) =>
        date ? (
          <span style={{ whiteSpace: 'nowrap' }}>{dayjs(date).format('YYYY-MM-DD')}</span>
        ) : (
          '-'
        ),
    },
    {
      title: '项目组',
      dataIndex: 'projectGroups',
      key: 'projectGroups',
      width: 160,
      filters: [
        {
          text: '无项目组',
          value: '__NO_PROJECT_GROUP__',
        },
        ...Array.from(new Set(ipSegments.flatMap((s) => getEffectiveProjectGroups(s)))).map((group) => ({
          text: group,
          value: group,
        })),
      ],
      onFilter: (value, record) => {
        const eff = getEffectiveProjectGroups(record);
        if (value === '__NO_PROJECT_GROUP__') {
          return eff.length === 0;
        }
        return eff.includes(String(value));
      },
      render: (_groups: string[], record: IPSegment) => {
        const groups = getEffectiveProjectGroups(record);
        return (
        <Space wrap size={[8, 6]}>
          {groups && groups.length > 0 ? (
            groups.map((group) => (
              <Tag key={group} color="blue">{group}</Tag>
            ))
          ) : (
            <Tag color="default">无</Tag>
          )}
        </Space>
        );
      },
    },
    {
      title: '供应商',
      dataIndex: 'supplier',
      key: 'supplier',
      width: 116,
      sorter: (a, b) => String(a.supplier ?? '').localeCompare(String(b.supplier ?? ''), 'zh-CN'),
      filters: Array.from(new Set(ipSegments.map(s => (Array.isArray(s.supplier) ? s.supplier[0] : s.supplier)).filter(Boolean))).map(supplier => ({
        text: supplier,
        value: supplier,
      })),
      onFilter: (value, record) => (Array.isArray(record.supplier) ? record.supplier[0] : record.supplier) === value,
    },
    {
      title: 'ASN',
      dataIndex: 'asn',
      key: 'asn',
      width: 112,
      sorter: (a, b) => String(a.asn ?? '').localeCompare(String(b.asn ?? ''), 'zh-CN'),
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="搜索ASN"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            onPressEnter={() => confirm()}
            style={{ marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button type="primary" onClick={() => confirm()} size="small" style={{ width: 90 }}>
              搜索
            </Button>
            <Button onClick={() => clearFilters && clearFilters()} size="small" style={{ width: 90 }}>
              重置
            </Button>
          </Space>
        </div>
      ),
      onFilter: (value, record) =>
        normalizeAsnDigitsOnly(record.asn || '')
          .toLowerCase()
          .includes(String(value).toLowerCase()),
      render: (asn: string, record: IPSegment) => {
        const displayMain = normalizeAsnDigitsOnly(asn);
        const mainAsnInBgpAnnounced = record.primaryAsnInBgp !== false;
        const extras = (record.additionalAsns || []).filter(Boolean);
        const hasExtras = extras.length > 0;
        const asnTagHoverHandlers = {
          onMouseEnter: (e: React.MouseEvent<HTMLSpanElement>) => {
            e.currentTarget.style.opacity = '0.8';
            e.currentTarget.style.transform = 'scale(1.05)';
          },
          onMouseLeave: (e: React.MouseEvent<HTMLSpanElement>) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.transform = 'scale(1)';
          },
        };
        const main =
          displayMain ? (
            <Tag
              color={mainAsnInBgpAnnounced ? 'green' : 'default'}
              onClick={() => copyToClipboard(displayMain)}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                transition: 'all 0.2s',
              }}
              {...asnTagHoverHandlers}
            >
              {displayMain}
            </Tag>
          ) : (
            <span>-</span>
          );
        if (!hasExtras) {
          return main;
        }
        const popContent = (
          <div style={{ maxWidth: 260 }}>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {record.primaryAsnInBgp === false
                ? '主显为注册/检测 ASN（当前未在 BGP 宣告）；其余：'
                : '主显为 BGP 生效 ASN；其余（未在 BGP 主显）：'}
            </Text>
            {extras.map((a, i) => (
              <div
                key={`${normalizeAsnDigitsOnly(a)}-${i}`}
                style={{
                  fontSize: 13,
                  marginBottom: 6,
                  padding: '4px 8px',
                  borderRadius: 4,
                  background: '#f0f0f0',
                  color: '#595959',
                }}
              >
                {normalizeAsnDigitsOnly(a)}
              </div>
            ))}
          </div>
        );
        return (
          <Space size={6} align="center" wrap>
            {main}
            <Popover content={popContent} title="其余 ASN" trigger="click">
              <Tag
                style={{
                  margin: 0,
                  fontSize: 11,
                  cursor: 'pointer',
                  background: '#f0f0f0',
                  color: '#595959',
                  border: '1px solid #d9d9d9',
                }}
              >
                +{extras.length}
              </Tag>
            </Popover>
          </Space>
        );
      },
    },
    {
      title: '续费时间',
      dataIndex: 'renewalDate',
      key: 'renewalDate',
      width: 132,
      sorter: (a, b) => {
        if (!a.renewalDate) return 1;
        if (!b.renewalDate) return -1;
        return dayjs(a.renewalDate).valueOf() - dayjs(b.renewalDate).valueOf();
      },
      render: (date: string) =>
        date ? (
          <span style={{ whiteSpace: 'nowrap' }}>{dayjs(date).format('YYYY-MM-DD')}</span>
        ) : (
          '-'
        ),
    },
    {
      title: '到期时间',
      key: 'expiryDate',
      width: 100,
      sorter: (a, b) => {
        const expiryA = getExpiryDateForDisplay(a);
        const expiryB = getExpiryDateForDisplay(b);
        if (!expiryA) return 1;
        if (!expiryB) return -1;
        return expiryA.valueOf() - expiryB.valueOf();
      },
      render: (_: any, record: IPSegment) => {
        const expiryDate = getExpiryDateForDisplay(record);
        
        if (!expiryDate) {
          return <Text type="secondary">-</Text>;
        }
        
        const isExpired = expiryDate.isBefore(now, 'day');
        const isExpiringSoon = expiryDate.isAfter(now, 'day') && expiryDate.diff(now, 'day') <= 10;
        
        return (
          <Tag
            color={isExpired ? 'red' : isExpiringSoon ? 'orange' : 'green'}
            style={{ whiteSpace: 'nowrap', margin: 0 }}
          >
            {expiryDate.format('YYYY-MM-DD')}
          </Tag>
        );
      },
    },
    {
      title: '是否续费',
      dataIndex: 'renewalStatus',
      key: 'renewalStatus',
      width: 152,
      sorter: (a, b) =>
        String(a.renewalStatus ?? '').localeCompare(String(b.renewalStatus ?? ''), 'zh-CN'),
      filters: RENEWAL_STATUS_OPTIONS.map(opt => ({ text: opt.label, value: opt.value })),
      onFilter: (value, record) => {
        const s = record.renewalStatus || 'not_renewed';
        return s === value;
      },
      render: (status: RenewalStatus, record: IPSegment) => {
        const effectiveStatus = getEffectiveRenewalStatusForDisplay(record);
        const display = (effectiveStatus && effectiveStatus in RENEWAL_STATUS_DISPLAY)
          ? RENEWAL_STATUS_DISPLAY[effectiveStatus as RenewalStatus]
          : RENEWAL_STATUS_DISPLAY.not_renewed;
        if (!display.text) return null;
        return (
          <span
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              backgroundColor: display.bgColor,
              fontWeight: 500,
              fontSize: 13,
            }}
          >
            {display.text}
          </span>
        );
      },
    },
    {
      title: '服务器位置',
      dataIndex: 'serverLocations',
      key: 'serverLocations',
      width: 208,
      filterDropdown: ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
          <Input
            placeholder="搜索服务器位置"
            value={selectedKeys[0]}
            onChange={(e) => setSelectedKeys(e.target.value ? [e.target.value] : [])}
            onPressEnter={() => confirm()}
            style={{ marginBottom: 8, display: 'block' }}
          />
          <Space>
            <Button type="primary" onClick={() => confirm()} size="small" style={{ width: 90 }}>
              搜索
            </Button>
            <Button onClick={() => clearFilters && clearFilters()} size="small" style={{ width: 90 }}>
              重置
            </Button>
          </Space>
        </div>
      ),
      onFilter: (value, record) => {
        const searchValue = String(value).toLowerCase();
        return (record.serverLocations || []).some(loc => 
          `${loc.supplier} - ${loc.region}`.toLowerCase().includes(searchValue)
        );
      },
      render: (locations: ServerLocation[]) => (
        <Space wrap size={[8, 6]}>
          {locations.map((loc, index) => (
            <Tag key={index} color="green">
              {loc.supplier} - {loc.region}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '被墙信息',
      dataIndex: 'blockedCountries',
      key: 'blockedCountries',
      width: 300,
      filters: [
        { text: '伊朗被墙', value: 'iran_blocked' },
        { text: '伊朗限速', value: 'iran_rate_limited' },
        { text: '伊朗可用', value: 'iran_available' },
        { text: '缅甸被墙', value: 'myanmar_blocked' },
        { text: '缅甸限速', value: 'myanmar_rate_limited' },
        { text: '缅甸可用', value: 'myanmar_available' },
        { text: '土库曼被墙', value: 'turkmenistan_blocked' },
        { text: '土库曼限速', value: 'turkmenistan_rate_limited' },
        { text: '土库曼可用', value: 'turkmenistan_available' },
        { text: '俄罗斯被墙', value: 'russia_blocked' },
        { text: '俄罗斯限速', value: 'russia_rate_limited' },
        { text: '俄罗斯可用', value: 'russia_available' },
      ],
      onFilter: (value, record) => {
        const [country, status] = String(value).split('_');
        const detectedList = record.detectedCountries || [];
        const detected = Array.isArray(detectedList) ? detectedList.includes(country as BlockedCountry) : false;
        if (!detected) return false;
        const isBlocked = (record.blockedCountries || []).includes(country as BlockedCountry);
        const isRateLimited = (record.rateLimitedCountries || []).includes(country as BlockedCountry);
        if (status === 'blocked') return isBlocked;
        if (status === 'rate_limited') return isRateLimited;
        if (status === 'available') return !isBlocked && !isRateLimited;
        return false;
      },
      render: (countries: BlockedCountry[], record: IPSegment) => {
        const allCountries: { key: BlockedCountry; label: string }[] = [
          { key: 'iran', label: '伊朗' },
          { key: 'myanmar', label: '缅甸' },
          { key: 'turkmenistan', label: '土库曼' },
          { key: 'russia', label: '俄罗斯' },
        ];
        
        const detectedList = record.detectedCountries || [];
        const isDetected = (c: BlockedCountry) => Array.isArray(detectedList) && detectedList.includes(c);
        
        return (
          <Space wrap size={[8, 6]}>
            {allCountries.map(({ key, label }) => {
              // 如果该地区未在 detectedCountries 中，显示"未检测"
              if (!isDetected(key)) {
                return (
                  <Tag key={key} color="default">
                    {label}: 未检测
                  </Tag>
                );
              }
              
              // 如果已检测，根据 blockedCountries / rateLimitedCountries 显示状态
              const isBlocked = (record.blockedCountries || []).includes(key);
              const isRateLimited = (record.rateLimitedCountries || []).includes(key);
              let tagColor = 'green';
              let statusText = '可用';
              if (isBlocked) {
                tagColor = 'red';
                statusText = '被墙';
              } else if (isRateLimited) {
                tagColor = 'orange';
                statusText = '限速';
              }
              return (
                <Tag key={key} color={tagColor}>
                  {label}: {statusText}
                </Tag>
              );
            })}
          </Space>
        );
      },
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 150,
      render: (remark: string) =>
        remark ? (
          <Tooltip title={remark}>
            <span style={{ color: '#666', fontSize: 13, display: 'block', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {remark}
            </span>
          </Tooltip>
        ) : (
          <span style={{ color: '#ccc' }}>-</span>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 116,
      fixed: 'right',
      align: 'center',
      render: (_, record) => (
        <Space size={12}>
          <Tooltip title="查看历程">
            <Button
              type="text"
              icon={<HistoryOutlined />}
              onClick={() => {
                setViewingSegment(record);
                setIsHistoryViewModalVisible(true);
              }}
              style={{ padding: '4px 8px' }}
            />
          </Tooltip>
          {canEdit && (
          <Tooltip title="编辑">
            <Button
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleEdit(record)}
              style={{ padding: '4px 8px' }}
            />
          </Tooltip>
          )}
          {canDelete && (
          <Popconfirm
            title="确定要删除这个IP段吗？"
            onConfirm={() => handleDelete(record.id)}
            okText="确定"
            cancelText="取消"
          >
            <Tooltip title="删除">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                style={{ padding: '4px 8px' }}
              />
            </Tooltip>
          </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="app-header">
        <h1 className="app-title">IP段管理平台</h1>
      </div>
      <div className="app-content">
        <Card className="ip-management-card">
          <Space style={{ marginBottom: 16 }} wrap split={<Divider type="vertical" />}>
            {/* 基础操作区 */}
            <Space>
              {canEdit && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={handleAdd}
                >
                  添加IP段
                </Button>
              )}
              {canImportExport && (
              <Button
                icon={<UploadOutlined />}
                onClick={() => {
                  setIsBatchImportVisible(true);
                  const purchaseDate = dayjs().format('YYYY-MM-DD');
                  const renewalDate = calculateRenewalDate(dayjs()).format('YYYY-MM-DD');
                  setBatchTableData([{
                    segment: '',
                    supplier: '',
                    asn: '',
                    usageArea: '未使用',
                    purchaseDate: purchaseDate,
                    renewalDate: renewalDate,
                    cancellationDate: '',
                    monthlyPrice: 0,
                    renewalStatus: 'not_renewed',
                    projectGroups: [],
                    serverLocations: [],
                    blockedCountries: [],
                  }]);
                }}
              >
                批量导入
              </Button>
              )}
              {canEdit && canImportExport && (
              <Button
                icon={<EditOutlined />}
                onClick={() => {
                  setIsTextBatchEditVisible(true);
                  setTextBatchEditValue('');
                  textBatchEditForm.resetFields();
                }}
              >
                文本批量编辑
              </Button>
              )}
            </Space>

            {/* 配置与数据管理区 */}
            {canImportExport && (
            <Space>
              <Button
                icon={<DownloadOutlined />}
                onClick={handleExportCSV}
              >
                导出表格
              </Button>
            </Space>
            )}

            {/* 批量操作区 */}
            {(() => {
              const currentSelectedKeys = activeTabKey === 'all'
                ? allSegmentsSelectedKeys
                : activeTabKey === 'active' 
                ? selectedRowKeys 
                : activeTabKey === 'cancelledButNotExpired'
                ? cancelledButNotExpiredSelectedKeys
                : cancelledSelectedKeys;
              
              if (currentSelectedKeys.length > 0) {
                return (
                  <Space>
                    {canEdit && (
                    <Button
                      type="primary"
                      onClick={() => setIsBatchEditVisible(true)}
                    >
                      批量编辑 ({currentSelectedKeys.length})
                    </Button>
                    )}
                    {canEdit && (
                    <Button
                      icon={<HistoryOutlined />}
                      onClick={() => {
                        batchHistoryForm.setFieldsValue({
                          projectGroup: '',
                          startDate: dayjs(),
                          endDate: null,
                          operation: 'add',
                        });
                        setIsBatchHistoryEditVisible(true);
                      }}
                    >
                      批量编辑历程 ({currentSelectedKeys.length})
                    </Button>
                    )}
                    {canDelete && (
                    <Popconfirm
                      title={`确定要删除选中的 ${currentSelectedKeys.length} 条记录吗？`}
                      onConfirm={() => {
                        if (activeTabKey === 'all') {
                          handleBatchDeleteForTab(allSegmentsSelectedKeys, setAllSegmentsSelectedKeys);
                        } else if (activeTabKey === 'active') {
                          handleBatchDelete();
                        } else if (activeTabKey === 'cancelledButNotExpired') {
                          handleBatchDeleteForTab(cancelledButNotExpiredSelectedKeys, setCancelledButNotExpiredSelectedKeys);
                        } else {
                          handleBatchDeleteForTab(cancelledSelectedKeys, setCancelledSelectedKeys);
                        }
                      }}
                      okText="确定"
                      cancelText="取消"
                    >
                      <Button danger>
                        批量删除 ({currentSelectedKeys.length})
                      </Button>
                    </Popconfirm>
                    )}
                    <Button
                      icon={<DownloadOutlined />}
                      onClick={handleExportSelected}
                    >
                      导出选中 ({currentSelectedKeys.length})
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        if (activeTabKey === 'all') {
                          setAllSegmentsSelectedKeys([]);
                        } else if (activeTabKey === 'active') {
                          setSelectedRowKeys([]);
                        } else if (activeTabKey === 'cancelledButNotExpired') {
                          setCancelledButNotExpiredSelectedKeys([]);
                        } else {
                          setCancelledSelectedKeys([]);
                        }
                      }}
                    >
                      取消选择
                    </Button>
                  </Space>
                );
              }
              return null;
            })()}

            {/* 筛选区 */}
            <Space>
              <Input
                style={{ width: 300 }}
                placeholder="输入IP段筛选（支持多个，用空格/逗号/换行分隔）"
                allowClear
                value={filteredSegment}
                onChange={(e) => setFilteredSegment(e.target.value)}
                addonBefore="IP段"
              />
              <Tooltip title="开启后，结果按搜索框中 IP 段的顺序展示，导出时也会按此顺序">
                <Space>
                  <span style={{ fontSize: 13, color: 'rgba(0,0,0,0.65)' }}>按搜索顺序</span>
                  <Switch
                    size="small"
                    checked={sortBySearchOrder}
                    onChange={setSortBySearchOrder}
                  />
                </Space>
              </Tooltip>
              <Space direction="horizontal" size={0} style={{ display: 'flex', alignItems: 'center', border: '1px solid #d9d9d9', borderRadius: '6px', paddingLeft: '11px', backgroundColor: '#fafafa' }}>
                <span style={{ color: 'rgba(0, 0, 0, 0.85)', fontSize: '14px', marginRight: '4px' }}>供应商:</span>
                <Select
                  style={{ width: 150 }}
                  placeholder="请选择"
                  allowClear
                  value={filteredSupplier}
                  onChange={(value) => setFilteredSupplier(value)}
                  options={getAllSuppliers.map((supplier: string) => ({
                    label: supplier,
                    value: supplier,
                  }))}
                  bordered={false}
                  showSearch
                />
              </Space>
              <Tooltip
                title="至少两条历程在日历上真正重叠（无结束日则算到取消日或今天）。上一条结束日=下一条开始日仅衔接、不算重叠；衔接日当天费用归上一条项目组。用于排查异常重叠。"
              >
                <Checkbox
                  checked={filterOverlappingHistoryOnly}
                  onChange={(e) => setFilterOverlappingHistoryOnly(e.target.checked)}
                >
                  仅历程时间重叠
                </Checkbox>
              </Tooltip>
            </Space>
          </Space>

          {/* 统计信息行 */}
          <div style={{ marginBottom: 16, padding: '8px 12px', background: '#f5f5f5', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space split={<Divider type="vertical" />}>
              <Text type="secondary">IP段总数: <Text strong>{ipSegments.length}</Text></Text>
              <Text type="secondary">项目组: <Text strong>{projectGroups.length}</Text></Text>
              <Text type="secondary">供应商: <Text strong>{suppliers.length}</Text></Text>
              <Text type="secondary">使用地区: <Text strong>{usageAreas.length}</Text></Text>
              {overlappingHistorySegmentCount > 0 && (
                <Text type="secondary">
                  历程时间重叠: <Text strong style={{ color: '#d46b08' }}>{overlappingHistorySegmentCount}</Text> 条
                </Text>
              )}
            </Space>
            {(filteredSupplier || filteredSegment || filterOverlappingHistoryOnly) && (
              <Button
                size="small"
                type="link"
                onClick={() => {
                  setFilteredSupplier(undefined);
                  setFilteredSegment('');
                  setFilterOverlappingHistoryOnly(false);
                }}
              >
                清除筛选条件
              </Button>
            )}
          </div>

          <Tabs
            destroyInactiveTabPane
            activeKey={activeTabKey}
            onChange={(key) => {
              setActiveTabKey(key);
              // 切换标签页时清空所有选中项
              setSelectedRowKeys([]);
              setCancelledButNotExpiredSelectedKeys([]);
              setCancelledSelectedKeys([]);
              setAllSegmentsSelectedKeys([]);
            }}
            tabBarExtraContent={
              canImportExport && (
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  onClick={handleExportCurrentTab}
                >
                  {activeTabKey === 'active' && `导出正常IP段 (${filteredIpSegments.length}条)`}
                  {activeTabKey === 'cancelledButNotExpired' && `导出已取消但未到期IP段 (${cancelledButNotExpiredSegments.length}条)`}
                  {activeTabKey === 'cancelled' && `导出已取消IP段 (${cancelledIpSegments.length}条)`}
                  {activeTabKey === 'all' && `导出所有IP段 (${allIpSegments.length}条)`}
                  {activeTabKey === 'upcomingRenewal' && `导出近期续费IP段 (${upcomingRenewalData.totalSegments}条)`}
                  {!['active', 'cancelledButNotExpired', 'cancelled', 'all', 'upcomingRenewal'].includes(activeTabKey) && '导出'}
                </Button>
              )
            }
            items={[
              {
                key: 'active',
                label: `正常IP段 (${filteredIpSegments.length})`,
                children: (
                  <div>
                    <Table
                      virtual
                      columns={columns}
                      dataSource={displayFilteredIpSegments}
                      rowKey="id"
                      scroll={IP_SEGMENT_TABLE_VIRTUAL_SCROLL}
                      rowSelection={{
                        columnWidth: TABLE_SELECTION_COLUMN_WIDTH,
                        selectedRowKeys,
                        onChange: (selectedKeys) => {
                          setSelectedRowKeys(selectedKeys);
                        },
                      }}
                      pagination={false}
                    />
                  </div>
                ),
              },
              {
                key: 'cancelledButNotExpired',
                label: `已取消但未到期 (${cancelledButNotExpiredSegments.length})`,
                children: (
                  <div>
                    <Table
                      virtual
                      columns={columns}
                      dataSource={displayCancelledButNotExpiredSegments}
                      rowKey="id"
                      scroll={IP_SEGMENT_TABLE_VIRTUAL_SCROLL}
                      rowSelection={{
                        columnWidth: TABLE_SELECTION_COLUMN_WIDTH,
                        selectedRowKeys: cancelledButNotExpiredSelectedKeys,
                        onChange: (selectedKeys) => {
                          setCancelledButNotExpiredSelectedKeys(selectedKeys);
                        },
                      }}
                      pagination={false}
                    />
                  </div>
                ),
              },
              {
                key: 'cancelled',
                label: `已取消IP段 (${cancelledIpSegments.length})`,
                children: (
                  <div>
                    <Table
                      virtual
                      columns={columns}
                      dataSource={displayCancelledIpSegments}
                      rowKey="id"
                      scroll={IP_SEGMENT_TABLE_VIRTUAL_SCROLL}
                      rowSelection={{
                        columnWidth: TABLE_SELECTION_COLUMN_WIDTH,
                        selectedRowKeys: cancelledSelectedKeys,
                        onChange: (selectedKeys) => {
                          setCancelledSelectedKeys(selectedKeys);
                        },
                      }}
                      pagination={false}
                    />
                  </div>
                ),
              },
              {
                key: 'all',
                label: `所有IP段 (${allIpSegments.length})`,
                children: (
                  <div>
                    <Table
                      virtual
                      columns={columns}
                      dataSource={displayAllIpSegments}
                      rowKey="id"
                      scroll={IP_SEGMENT_TABLE_VIRTUAL_SCROLL}
                      rowSelection={{
                        columnWidth: TABLE_SELECTION_COLUMN_WIDTH,
                        selectedRowKeys: allSegmentsSelectedKeys,
                        onChange: (selectedKeys) => {
                          setAllSegmentsSelectedKeys(selectedKeys);
                        },
                      }}
                      pagination={false}
                    />
                  </div>
                ),
              },
              {
                key: 'upcomingRenewal',
                label: `近期续费IP段 (${upcomingRenewalData.totalSegments})`,
                children: (
                  <div>
                    {/* 筛选 */}
                    <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                      <Space wrap>
                        <Text>项目组筛选：</Text>
                        <Select
                          placeholder="全部项目组"
                          allowClear
                          style={{ minWidth: 160 }}
                          value={filteredUpcomingProjectGroup}
                          onChange={setFilteredUpcomingProjectGroup}
                          options={[
                            { value: undefined, label: '全部项目组' },
                            ...projectGroups.map(g => ({ value: g.name, label: g.name })),
                          ]}
                        />
                        {filteredUpcomingProjectGroup && (
                          <Button size="small" onClick={() => setFilteredUpcomingProjectGroup(undefined)}>
                            清除筛选
                          </Button>
                        )}
                        <Divider type="vertical" />
                        <Text>视图：</Text>
                        <Segmented
                          value={upcomingRenewalViewMode}
                          onChange={(v) => setUpcomingRenewalViewMode(v as 'grouped' | 'list')}
                          options={[
                            { label: '分组视图', value: 'grouped' },
                            { label: '列表视图', value: 'list' },
                          ]}
                        />
                      </Space>
                    </div>
                    {/* 总体统计 */}
                    <div style={{ marginBottom: 16, padding: '12px', background: '#e6f7ff', borderRadius: '4px', border: '1px solid #91d5ff' }}>
                      <Row gutter={16}>
                        <Col span={8}>
                          <Text strong>近10天需要续费的IP段总数：</Text>
                          <Text style={{ fontSize: '18px', color: '#1890ff', marginLeft: 8 }}>{upcomingRenewalData.totalSegments}</Text>
                        </Col>
                        <Col span={8}>
                          <Text strong>总费用（美元，仅 IPXO 加收 4% 手续费）：</Text>
                          <Text style={{ fontSize: '18px', color: '#f5222d', marginLeft: 8 }}>${upcomingRenewalData.totalCost.toFixed(2)}</Text>
                        </Col>
                        <Col span={8}>
                          <Text strong>涉及天数：</Text>
                          <Text style={{ fontSize: '18px', color: '#52c41a', marginLeft: 8 }}>{upcomingRenewalData.sortedDates.length}</Text>
                        </Col>
                      </Row>
                    </div>

                    {/* 分组视图 / 列表视图 */}
                    {upcomingRenewalData.sortedDates.length > 0 ? (
                      upcomingRenewalViewMode === 'grouped' ? (
                        <Collapse
                          items={upcomingRenewalData.sortedDates.map((dateStr) => {
                            const dateData = upcomingRenewalData.groupedByDate[dateStr];
                            const dateObj = dayjs(dateStr);
                            const isToday = dateObj.isSame(now, 'day');
                            const isTomorrow = dateObj.isSame(now.add(1, 'day'), 'day');
                            let dateLabel = dateObj.format('YYYY-MM-DD');
                            if (isToday) {
                              dateLabel += ' (今天)';
                            } else if (isTomorrow) {
                              dateLabel += ' (明天)';
                            } else {
                              dateLabel += ` (${dateObj.diff(now, 'day')}天后)`;
                            }

                            return {
                              key: dateStr,
                              label: (
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontSize: '16px', fontWeight: 'bold' }}>{dateLabel}</span>
                                  <span style={{ marginLeft: 'auto', marginRight: 16 }}>
                                    <Text type="secondary">共 {dateData.segments.length} 个IP段，</Text>
                                    <Text strong style={{ color: '#f5222d' }}>费用（美元，仅 IPXO 含 4%）: ${dateData.totalCost.toFixed(2)}</Text>
                                  </span>
                                </div>
                              ),
                              children: (
                                <Table
                                  virtual
                                  columns={columns.map(col => {
                                    if (col.key === 'monthlyPrice' || ('dataIndex' in col && col.dataIndex === 'monthlyPrice')) {
                                      return {
                                        ...col,
                                        render: (_value: number, record: IPSegment) => {
                                          const billed = getBillableMonthlyUsdForSegment(record);
                                          const tooltipContent = upcomingRenewalPriceTooltipTitle(record);
                                          return (
                                            <Tooltip title={tooltipContent}>
                                              <span style={{ cursor: 'default' }}>${billed.toFixed(2)}</span>
                                            </Tooltip>
                                          );
                                        },
                                      };
                                    }
                                    return col;
                                  })}
                                  dataSource={dateData.segments}
                                  rowKey="id"
                                  scroll={IP_SEGMENT_TABLE_VIRTUAL_SCROLL}
                                  pagination={false}
                                />
                              ),
                            };
                          })}
                          defaultActiveKey={upcomingRenewalData.sortedDates.slice(0, 3)}
                        />
                      ) : (
                        <Table
                          virtual
                          columns={columns.map(col => {
                            if (col.key === 'monthlyPrice' || ('dataIndex' in col && col.dataIndex === 'monthlyPrice')) {
                              return {
                                ...col,
                                render: (_value: number, record: IPSegment) => {
                                  const billed = getBillableMonthlyUsdForSegment(record);
                                  const tooltipContent = upcomingRenewalPriceTooltipTitle(record);
                                  return (
                                    <Tooltip title={tooltipContent}>
                                      <span style={{ cursor: 'default' }}>${billed.toFixed(2)}</span>
                                    </Tooltip>
                                  );
                                },
                              };
                            }
                            return col;
                          })}
                          dataSource={upcomingRenewalListData}
                          rowKey="id"
                          scroll={IP_SEGMENT_TABLE_VIRTUAL_SCROLL}
                          pagination={false}
                        />
                      )
                    ) : (
                      <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>
                        <Text type="secondary">近10天内没有需要续费的IP段</Text>
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </Card>
      </div>

      {/* IP段添加/编辑弹窗 */}
      <Modal
        title={editingSegment ? '编辑IP段' : '添加IP段'}
        open={isModalVisible}
        onOk={handleSubmit}
        onCancel={() => setIsModalVisible(false)}
        width={800}
        okText="确定"
        cancelText="取消"
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            renewalStatus: 'not_renewed',
            projectGroups: [],
            serverLocations: [],
            blockedCountries: [],
            rateLimitedCountries: [],
            multiPurchaseMarked: false,
            previousPurchaseDates: [],
          }}
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="segment"
                label="IP段"
                rules={[
                  { required: true, message: '请输入IP段' },
                  {
                    validator: (_, value) => {
                      if (!value) {
                        return Promise.resolve();
                      }
                      const existingSegments = ipSegmentStorage.getAll();
                      const duplicateSegment = existingSegments.find(
                        seg => seg.segment.toLowerCase().trim() === value.toLowerCase().trim() 
                        && (!editingSegment || seg.id !== editingSegment.id)
                      );
                      if (duplicateSegment) {
                        return Promise.reject(new Error('该IP段已存在，请勿重复添加！'));
                      }
                      return Promise.resolve();
                    },
                  },
                ]}
              >
                <Input placeholder="例如：192.168.1.0/24" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="supplier"
                label="供应商"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="选择或输入供应商名称"
                  options={getAllSuppliers.map((supplier: string) => ({
                    label: supplier,
                    value: supplier,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                  mode="tags"
                  tokenSeparators={[',']}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="usageArea"
                label="使用地区"
                tooltip="使用地区需在配置管理中添加，此处只能选择已有选项"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="选择使用地区"
                  options={usageAreas.map(area => ({
                    label: (
                      <span>
                        <Tag color={area.color} style={{ marginRight: 4, color: '#000' }}>{area.name}</Tag>
                      </span>
                    ),
                    value: area.name,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={<span style={{ color: '#999', fontSize: 12 }}>未找到匹配的使用地区，请到配置管理中添加</span>}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="asn"
                label="ASN（选填）"
              >
                <Input placeholder="例如：AS12345" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="purchaseDate"
                label="购买时间"
                tooltip="多次购买时，请填写最近一期购买日；更早的购买日请在下方「历史购买日期」中维护，列表中悬浮本字段可查看。"
                rules={[{ required: true, message: '请选择购买时间' }]}
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format="YYYY-MM-DD"
                  onChange={handlePurchaseDateChange}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="renewalDate"
                label="续费时间（自动计算：购买时间+1个月）"
                rules={[{ required: true, message: '续费时间' }]}
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format="YYYY-MM-DD"
                  disabled
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="multiPurchaseMarked"
                label="多次购买标记"
                valuePropName="checked"
                tooltip="开启后，费用分析按当前「购买时间」作为最近一期计费起点，并按使用历程拆分；历史购买日仅供展示。"
              >
                <Switch checkedChildren="是" unCheckedChildren="否" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="历史购买日期" tooltip="须早于上方「购买时间」。每条一行，保存为 YYYY-MM-DD。">
                <Form.List name="previousPurchaseDates">
                  {(fields, { add, remove }) => (
                    <div>
                      {fields.map(({ key, name, ...rest }) => (
                        <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                          <Form.Item {...rest} name={name} style={{ marginBottom: 0 }}>
                            <DatePicker format="YYYY-MM-DD" style={{ width: 200 }} placeholder="历史购买日" />
                          </Form.Item>
                          <MinusCircleOutlined onClick={() => remove(name)} />
                        </Space>
                      ))}
                      <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                        添加历史购买日期
                      </Button>
                    </div>
                  )}
                </Form.List>
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="cancellationDate"
                label="取消时间"
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format="YYYY-MM-DD"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="monthlyPrice"
                label="费用($)"
                rules={[{ required: true, message: '请输入价格' }]}
              >
                <InputNumber<number>
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  placeholder="请输入价格（美元）"
                  formatter={(value) => `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
                  parser={(value) => {
                    const s = (value ?? '').replace(/\$\s?|(,*)/g, '');
                    const n = parseFloat(s);
                    return Number.isFinite(n) ? n : 0;
                  }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="renewalStatus"
                label="是否续费"
              >
                <Select
                  options={[...RENEWAL_STATUS_OPTIONS]}
                  placeholder="选择续费状态"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="blockedCountries"
                label="被墙国家"
                tooltip="在该地区无法访问或已被封锁"
              >
                <Select
                  mode="multiple"
                  placeholder="选择被墙国家"
                  options={[...BLOCKED_COUNTRY_OPTIONS]}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="rateLimitedCountries"
                label="限速国家"
                tooltip="在该地区可访问但存在限速"
              >
                <Select
                  mode="multiple"
                  placeholder="选择限速国家"
                  options={[...BLOCKED_COUNTRY_OPTIONS]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="projectGroups"
            label="项目组（当前使用的项目组）"
            tooltip="当前使用的项目组，用于快速查看和筛选。详细的使用历程请在下方的历程记录中管理。"
          >
            <Select
              mode="tags"
              placeholder="选择或输入项目组名称"
              options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
            />
          </Form.Item>

          <Form.Item
            name="remark"
            label="备注"
            tooltip="可填写该IP段的补充说明，例如用途、特殊限制等"
          >
            <Input.TextArea
              placeholder="选填备注信息"
              rows={2}
              maxLength={500}
              showCount
            />
          </Form.Item>

          <Collapse
            items={[
              {
                key: 'history',
                label: `使用历程记录 (${segmentHistory.length}条)`,
                children: (
                  <div>
                    <div style={{ marginBottom: 16 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        历程记录用于记录IP段在不同项目组之间的转移情况，费用统计会根据历程记录和日期分别计算各项目组的费用。
                      </Text>
                    </div>
                    <Table
                      dataSource={(() => {
                        // 对于已到期的IP段，自动设置最后一条历程记录的结束日期为到期时间
                        const expiryDate = editingSegment ? calculateCancelledExpiryDate(editingSegment) : null;
                        const now = dayjs();
                        let displayHistory = segmentHistory;
                        
                        if (expiryDate && editingSegment && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
                          if (displayHistory.length > 0) {
                            const sortedHistory = [...displayHistory].sort((a, b) => 
                              dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                            );
                            const lastHistory = sortedHistory[sortedHistory.length - 1];
                            
                            if (!lastHistory.endDate || dayjs(lastHistory.endDate).isAfter(expiryDate, 'day')) {
                              displayHistory = displayHistory.map(h => 
                                h.id === lastHistory.id 
                                  ? { ...h, endDate: expiryDate.format('YYYY-MM-DD') }
                                  : h
                              );
                            }
                          }
                        }
                        return displayHistory;
                      })()}
                      rowKey="id"
                      size="small"
                      pagination={false}
                      columns={[
                        {
                          title: '项目组',
                          dataIndex: 'projectGroup',
                          width: 150,
                        },
                        {
                          title: '开始日期',
                          dataIndex: 'startDate',
                          width: 120,
                          render: (date: string) => dayjs(date).format('YYYY-MM-DD'),
                        },
                        {
                          title: '结束日期',
                          dataIndex: 'endDate',
                          width: 120,
                          render: (date: string | undefined, record, index) => {
                            // 判断是否为已取消的IP段的最后一条记录
                            const isCancelled = editingSegment && (editingSegment.renewalStatus === 'cancelled' || editingSegment.cancellationDate);
                            const expiryDate = editingSegment ? calculateCancelledExpiryDate(editingSegment) : null;
                            const now = dayjs();
                            const sortedHistory = [...segmentHistory].sort((a, b) => 
                              dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                            );
                            const isLastRecord = index === sortedHistory.length - 1;
                            
                            // 对于已取消的IP段，最后一条记录显示到期时间（红色背景）
                            if (isCancelled && isLastRecord && expiryDate) {
                              const finalEndDate = date || expiryDate.format('YYYY-MM-DD');
                              return (
                                <Tag color="red" style={{ margin: 0, fontSize: '13px', padding: '2px 8px' }}>
                                  {dayjs(finalEndDate).format('YYYY-MM-DD')}
                                </Tag>
                              );
                            }
                            
                            // 对于已到期的IP段（但可能不是已取消），最后一条记录显示到期时间
                            if (expiryDate && editingSegment && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
                              if (isLastRecord) {
                                const finalEndDate = date || expiryDate.format('YYYY-MM-DD');
                                return dayjs(finalEndDate).format('YYYY-MM-DD');
                              }
                            }
                            
                            return date ? dayjs(date).format('YYYY-MM-DD') : (
                              <Tag color="green">至今</Tag>
                            );
                          },
                        },
                        {
                          title: '操作',
                          key: 'action',
                          width: 100,
                          render: (_, record, index) => {
                            // 判断是否为已取消的IP段的最后一条记录
                            const isCancelled = editingSegment && (editingSegment.renewalStatus === 'cancelled' || editingSegment.cancellationDate);
                            const sortedHistory = [...segmentHistory].sort((a, b) => 
                              dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                            );
                            const isLastRecord = index === sortedHistory.length - 1;
                            
                            // 已取消IP段的最后一条记录：可以编辑项目组和开始日期，但结束日期不可编辑
                            if (isCancelled && isLastRecord) {
                              return (
                                <Space>
                                  <Tooltip title="可编辑项目组和开始日期，结束日期已自动设置为到期时间">
                                    <Button
                                      type="link"
                                      size="small"
                                      icon={<EditOutlined />}
                                      onClick={() => {
                                        setEditingHistoryIndex(index);
                                        const historyItem = segmentHistory[index];
                                        const expiryDate = editingSegment ? calculateCancelledExpiryDate(editingSegment) : null;
                                        historyForm.setFieldsValue({
                                          projectGroup: historyItem.projectGroup,
                                          startDate: dayjs(historyItem.startDate),
                                          endDate: expiryDate ? dayjs(expiryDate.format('YYYY-MM-DD')) : (historyItem.endDate ? dayjs(historyItem.endDate) : null),
                                        });
                                        setIsHistoryModalVisible(true);
                                      }}
                                    >
                                      编辑
                                    </Button>
                                  </Tooltip>
                                  <Popconfirm
                                    title="确定要删除这条历程记录吗？"
                                    onConfirm={() => {
                                      const newHistory = segmentHistory.filter((_, i) => i !== index);
                                      setSegmentHistory(newHistory);
                                    }}
                                  >
                                    <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                                      删除
                                    </Button>
                                  </Popconfirm>
                                </Space>
                              );
                            }
                            
                            return (
                              <Space>
                                <Button
                                  type="link"
                                  size="small"
                                  icon={<EditOutlined />}
                                  onClick={() => {
                                    setEditingHistoryIndex(index);
                                    const historyItem = segmentHistory[index];
                                    historyForm.setFieldsValue({
                                      projectGroup: historyItem.projectGroup,
                                      startDate: dayjs(historyItem.startDate),
                                      endDate: historyItem.endDate ? dayjs(historyItem.endDate) : null,
                                    });
                                    setIsHistoryModalVisible(true);
                                  }}
                                >
                                  编辑
                                </Button>
                                <Popconfirm
                                  title="确定要删除这条历程记录吗？"
                                  onConfirm={() => {
                                    const newHistory = segmentHistory.filter((_, i) => i !== index);
                                    setSegmentHistory(newHistory);
                                  }}
                                >
                                  <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                                    删除
                                  </Button>
                                </Popconfirm>
                              </Space>
                            );
                          },
                        },
                      ]}
                    />
                    <Button
                      type="dashed"
                      block
                      icon={<PlusOutlined />}
                      onClick={() => {
                        setEditingHistoryIndex(null);
                        const purchaseDate = editingSegment?.purchaseDate || form.getFieldValue('purchaseDate')?.format('YYYY-MM-DD') || dayjs().format('YYYY-MM-DD');
                        historyForm.setFieldsValue({
                          projectGroup: '',
                          startDate: dayjs(purchaseDate),
                          endDate: null,
                        });
                        setIsHistoryModalVisible(true);
                      }}
                      style={{ marginTop: 16 }}
                    >
                      添加历程记录
                    </Button>
                  </div>
                ),
              },
            ]}
          />

          <Form.Item
            name="serverLocations"
            label="服务器位置"
          >
            <Form.List name="serverLocations">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(({ key, name, ...restField }) => (
                    <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                      <Form.Item
                        {...restField}
                        name={[name, 'supplier']}
                        rules={[{ required: true, message: '请输入供应商' }]}
                      >
                        <Input placeholder="供应商" style={{ width: 150 }} />
                      </Form.Item>
                      <Form.Item
                        {...restField}
                        name={[name, 'region']}
                        rules={[{ required: true, message: '请输入地区' }]}
                      >
                        <Input placeholder="地区" style={{ width: 150 }} />
                      </Form.Item>
                      <Button onClick={() => remove(name)}>删除</Button>
                    </Space>
                  ))}
                  <Form.Item>
                    <Button type="dashed" onClick={() => add()} block icon={<PlusOutlined />}>
                      添加服务器位置
                    </Button>
                  </Form.Item>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>

      {/* 查看历程记录弹窗 */}
      <Modal
        title={`IP段历程记录 - ${viewingSegment?.segment || ''}`}
        open={isHistoryViewModalVisible}
        onCancel={() => {
          setIsHistoryViewModalVisible(false);
          setViewingSegment(null);
        }}
        width={700}
        footer={[
          <Button key="close" onClick={() => {
            setIsHistoryViewModalVisible(false);
            setViewingSegment(null);
          }}>
            关闭
          </Button>,
          ...(canEdit ? [
            <Button
              key="edit"
              type="primary"
              onClick={() => {
                setIsHistoryViewModalVisible(false);
                if (viewingSegment) {
                  handleEdit(viewingSegment);
                }
              }}
            >
              编辑IP段
            </Button>,
          ] : []),
        ]}
      >
        {viewingSegment && (() => {
          // 自动初始化历程记录（如果IP段有项目组但没有历程记录）
          let displayHistory = initializeHistoryIfNeeded(viewingSegment);
          
          // 对于已到期的IP段，自动设置最后一条历程记录的结束日期为到期时间
          const expiryDate = calculateCancelledExpiryDate(viewingSegment);
          const now = dayjs();
          if (expiryDate && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
            // IP段已到期，检查最后一条历程记录
            if (displayHistory.length > 0) {
              const sortedHistory = [...displayHistory].sort((a, b) => 
                dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
              );
              const lastHistory = sortedHistory[sortedHistory.length - 1];
              
              // 如果最后一条记录没有结束日期，或者结束日期晚于到期时间，设置为到期时间
              if (!lastHistory.endDate || dayjs(lastHistory.endDate).isAfter(expiryDate, 'day')) {
                displayHistory = displayHistory.map(h => 
                  h.id === lastHistory.id 
                    ? { ...h, endDate: expiryDate.format('YYYY-MM-DD') }
                    : h
                );
              }
            }
          }
          
          return (
            <div>
              <div style={{ marginBottom: 16 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  历程记录用于记录IP段在不同项目组之间的转移情况，费用统计会根据历程记录和日期分别计算各项目组的费用。
                </Text>
              </div>
              {displayHistory.length > 0 ? (
                <Table
                  dataSource={[...displayHistory].sort((a, b) => 
                    dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                  )}
                  rowKey="id"
                  size="small"
                  pagination={false}
                  columns={[
                    {
                      title: '序号',
                      key: 'index',
                      width: 60,
                      render: (_, __, index) => index + 1,
                    },
                    {
                      title: '项目组',
                      dataIndex: 'projectGroup',
                      width: 150,
                    },
                    {
                      title: '开始日期',
                      dataIndex: 'startDate',
                      width: 120,
                      render: (date: string) => dayjs(date).format('YYYY-MM-DD'),
                    },
                    {
                      title: '结束日期',
                      dataIndex: 'endDate',
                      width: 120,
                      render: (date: string | undefined, record, index) => {
                        // 判断是否为已取消的IP段的最后一条记录
                        const isCancelled = viewingSegment && (viewingSegment.renewalStatus === 'cancelled' || viewingSegment.cancellationDate);
                        const sortedHistory = [...displayHistory].sort((a, b) => 
                          dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                        );
                        const isLastRecord = index === sortedHistory.length - 1;
                        
                        // 对于已取消的IP段，最后一条记录显示红色背景
                        if (isCancelled && isLastRecord && expiryDate) {
                          const finalEndDate = date || expiryDate.format('YYYY-MM-DD');
                          return (
                            <Tag color="red" style={{ margin: 0, fontSize: '13px', padding: '2px 8px' }}>
                              {dayjs(finalEndDate).format('YYYY-MM-DD')}
                            </Tag>
                          );
                        }
                        
                        // 如果是最后一条记录且IP段已到期（但不是已取消），显示到期时间
                        if (isLastRecord && expiryDate && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
                          const finalEndDate = date || expiryDate.format('YYYY-MM-DD');
                          return dayjs(finalEndDate).format('YYYY-MM-DD');
                        }
                        
                        return date ? dayjs(date).format('YYYY-MM-DD') : (
                          <Tag color="green">至今</Tag>
                        );
                      },
                    },
                    {
                      title: '使用时长',
                      key: 'duration',
                      width: 120,
                      render: (_, record, index) => {
                        const startDate = dayjs(record.startDate);
                        // 如果是最后一条记录且IP段已到期，使用到期时间计算
                        const sortedHistory = [...displayHistory].sort((a, b) => 
                          dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
                        );
                        const isLastRecord = index === sortedHistory.length - 1;
                        let endDate = record.endDate ? dayjs(record.endDate) : dayjs();
                        if (isLastRecord && expiryDate && (expiryDate.isBefore(now, 'day') || expiryDate.isSame(now, 'day'))) {
                          endDate = expiryDate;
                        }
                        const days = endDate.diff(startDate, 'day') + 1;
                        const months = Math.floor(days / 30);
                        const remainingDays = days % 30;
                        if (months > 0) {
                          return `${months}个月${remainingDays > 0 ? remainingDays + '天' : ''}`;
                        }
                        return `${days}天`;
                      },
                    },
                  ]}
                />
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                  <HistoryOutlined style={{ fontSize: 48, marginBottom: 16 }} />
                  <div>暂无历程记录</div>
                  <div style={{ marginTop: 8, fontSize: 12 }}>
                    {viewingSegment.purchaseDate && viewingSegment.projectGroups && viewingSegment.projectGroups.length > 0
                      ? '系统将自动创建初始历程记录'
                      : '请先填写购买时间和项目组，系统将自动创建历程记录'}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* 历程记录编辑弹窗 */}
      <Modal
        title={editingHistoryIndex !== null ? '编辑历程记录' : '添加历程记录'}
        open={isHistoryModalVisible}
        onOk={() => {
          historyForm.validateFields().then(values => {
            // 检查是否为已取消IP段的最后一条记录
            const isCancelled = editingSegment && (editingSegment.renewalStatus === 'cancelled' || editingSegment.cancellationDate);
            const sortedHistory = [...segmentHistory].sort((a, b) => 
              dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
            );
            const isLastRecord = editingHistoryIndex !== null && editingHistoryIndex === sortedHistory.length - 1;
            const expiryDate = editingSegment ? calculateCancelledExpiryDate(editingSegment) : null;
            
            if (editingHistoryIndex !== null) {
              // 编辑现有记录
              const newHistory = [...segmentHistory];
              // 如果是已取消IP段的最后一条记录，结束日期保持为到期时间
              let finalEndDate = values.endDate ? values.endDate.format('YYYY-MM-DD') : undefined;
              if (isCancelled && isLastRecord && expiryDate) {
                finalEndDate = expiryDate.format('YYYY-MM-DD');
              }
              
              newHistory[editingHistoryIndex] = {
                ...newHistory[editingHistoryIndex],
                projectGroup: String(values.projectGroup || ''),
                startDate: values.startDate.format('YYYY-MM-DD'),
                endDate: finalEndDate,
                updatedAt: new Date().toISOString(),
              };
              setSegmentHistory(newHistory.sort((a, b) => 
                dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
              ));
            } else {
              // 添加新记录
              const newHistory: IPSegmentHistory = {
                id: `history-${Date.now()}-${Math.random()}`,
                projectGroup: String(values.projectGroup || ''),
                startDate: values.startDate.format('YYYY-MM-DD'),
                endDate: values.endDate ? values.endDate.format('YYYY-MM-DD') : undefined,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              setSegmentHistory([...segmentHistory, newHistory].sort((a, b) => 
                dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
              ));
            }
            setIsHistoryModalVisible(false);
            historyForm.resetFields();
          });
        }}
        onCancel={() => {
          setIsHistoryModalVisible(false);
          historyForm.resetFields();
        }}
        width={500}
        okText="确定"
        cancelText="取消"
      >
        {(() => {
          // 检查是否为已取消IP段的最后一条记录
          const isCancelled = editingSegment && (editingSegment.renewalStatus === 'cancelled' || editingSegment.cancellationDate);
          const sortedHistory = [...segmentHistory].sort((a, b) => 
            dayjs(a.startDate).valueOf() - dayjs(b.startDate).valueOf()
          );
          const isLastRecord = editingHistoryIndex !== null && editingHistoryIndex === sortedHistory.length - 1;
          const isEndDateDisabled = isCancelled && isLastRecord;
          const expiryDate = editingSegment ? calculateCancelledExpiryDate(editingSegment) : null;
          
          return (
            <Form
              form={historyForm}
              layout="vertical"
            >
              <Form.Item
                name="projectGroup"
                label="项目组"
                rules={[{ required: true, message: '请选择项目组' }]}
              >
                <Select
                  showSearch
                  placeholder="选择或输入项目组名称"
                  options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                  allowClear
                />
              </Form.Item>
              <Form.Item
                name="startDate"
                label="开始日期"
                rules={[{ required: true, message: '请选择开始日期' }]}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item
                name="endDate"
                label={isEndDateDisabled && expiryDate ? `结束日期（已自动设置为到期时间：${expiryDate.format('YYYY-MM-DD')}）` : '结束日期（留空表示当前仍在使用）'}
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  disabled={isEndDateDisabled || false}
                  placeholder={isEndDateDisabled && expiryDate ? `到期时间：${expiryDate.format('YYYY-MM-DD')}` : '留空表示当前仍在使用'}
                />
              </Form.Item>
            </Form>
          );
        })()}
      </Modal>

      {/* 批量导入弹窗 */}
      <Modal
        title="批量导入IP段"
        open={isBatchImportVisible}
        onOk={handleBatchAdd}
        onCancel={() => {
          setIsBatchImportVisible(false);
          setBatchTableData([]);
          setTextImportValue('');
          setBlockedInfoImportValue('');
          setPreviewSelectedRowKeys([]);
        }}
        width={1200}
        okText="批量添加"
        cancelText="取消"
      >
        <Tabs
          defaultActiveKey="text"
          items={[
            {
              key: 'text',
              label: '文本格式导入',
              children: (
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                    格式说明：每行一条记录，字段用逗号或Tab键分隔
                  </Text>
                  <div style={{ marginBottom: 16, fontSize: 12, color: 'rgba(0, 0, 0, 0.45)' }}>
                    <div>格式：IP段,使用地区(可选),费用($),购买时间(YYYY-MM-DD),取消时间(可选),供应商或续费状态(可选)</div>
                    <div style={{ marginTop: 8 }}>续费时间/到期时间计算规则：</div>
                    <div>- 续费时间：无取消时间=当前+1月；有取消时间=按购买日与取消日计算</div>
                    <div>- 到期时间：取消续费=续费时间或按取消时间计算；未续费=续费时间</div>
                    <div style={{ marginTop: 8 }}>支持格式：</div>
                    <div>- 3个字段：IP段,费用,购买时间</div>
                    <div>- 4个字段：IP段,使用地区,费用,购买时间 或 IP段,费用,购买时间,取消时间</div>
                    <div>- 5个字段：IP段,使用地区,费用,购买时间,供应商 或 IP段,使用地区,费用,购买时间,取消时间</div>
                    <div>- 6个字段：IP段,使用地区,费用,购买时间,取消时间,供应商 或 IP段,使用地区,费用,购买时间,取消时间,续费状态</div>
                    <div style={{ marginTop: 4 }}>&nbsp;&nbsp;续费状态可选值：无、取消续费、已退款（不填则保持为空）</div>
                    <div style={{ marginTop: 8 }}>分隔符支持：逗号（,）、Tab键或空格</div>
                    <div>注意：购买时间为必填项！取消时间必须大于购买时间</div>
                  </div>
                  <TextArea
                    rows={10}
                    value={textImportValue}
                    onChange={(e) => setTextImportValue(e.target.value)}
                    placeholder={`示例：
192.168.1.0/24,ZET,100,2024-12-31,供应商A
192.168.2.0/24,ZEN法兰克福,200,2024-11-30,供应商B
45.197.21.0/24,ZET,102.4,2025-10-30,LARUS`}
                    style={{ marginBottom: 16 }}
                  />
                  <Button type="primary" onClick={handleTextImport}>
                    解析并预览
                  </Button>
                  {batchTableData.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <Space style={{ marginBottom: 8 }} wrap>
                        <Text strong>预览数据（共 {batchTableData.length} 条）：</Text>
                        {previewSelectedRowKeys.length > 0 && (
                          <>
                            <Button
                              type="primary"
                              size="small"
                              onClick={() => setIsPreviewBatchEditVisible(true)}
                            >
                              批量编辑 ({previewSelectedRowKeys.length})
                            </Button>
                            <Button
                              size="small"
                              onClick={() => setPreviewSelectedRowKeys([])}
                            >
                              取消选择
                            </Button>
                          </>
                        )}
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                        解析结果已按配置与现有 IP 段对齐名称；请通过下拉选择使用地区、供应商与项目组，勿依赖粘贴文本以免编码异常。
                      </Text>
                      <Table
                        dataSource={batchTableData.map((item, index) => ({ ...item, key: index }))}
                        columns={[
                          {
                            title: 'IP段',
                            dataIndex: 'segment',
                            width: 150,
                            render: (text: string | undefined, _record, index) => (
                              <Input
                                value={text}
                                onChange={(e) => handleTableDataChange(index, 'segment', e.target.value)}
                                placeholder="192.168.1.0/24"
                              />
                            ),
                          },
                          {
                            title: '使用地区',
                            dataIndex: 'usageArea',
                            width: 150,
                            render: (text: string | undefined, _record, index) => (
                              <Select
                                showSearch
                                allowClear
                                style={{ width: '100%' }}
                                placeholder="选择地区"
                                value={text || undefined}
                                options={previewUsageAreaOptions}
                                onChange={(v) =>
                                  handleTableDataChange(index, 'usageArea', v || '未使用')
                                }
                                filterOption={(input, option) =>
                                  String(option?.value ?? '')
                                    .toLowerCase()
                                    .includes(input.toLowerCase())
                                }
                              />
                            ),
                          },
                          {
                            title: '供应商',
                            dataIndex: 'supplier',
                            width: 130,
                            render: (text: string | undefined, _record, index) => (
                              <Select
                                showSearch
                                allowClear
                                style={{ width: '100%' }}
                                placeholder="选择供应商"
                                value={text || undefined}
                                options={previewSupplierOptions}
                                onChange={(v) => handleTableDataChange(index, 'supplier', v || '')}
                                filterOption={(input, option) =>
                                  String(option?.value ?? '')
                                    .toLowerCase()
                                    .includes(input.toLowerCase())
                                }
                              />
                            ),
                          },
                          {
                            title: '项目组',
                            dataIndex: 'projectGroups',
                            width: 160,
                            render: (groups: string[] | undefined, _record, index) => (
                              <Select
                                mode="multiple"
                                style={{ width: '100%' }}
                                placeholder="选择项目组"
                                value={groups || []}
                                options={projectGroups.map((g) => ({
                                  label: g.name,
                                  value: g.name,
                                }))}
                                onChange={(v) => handleTableDataChange(index, 'projectGroups', v)}
                              />
                            ),
                          },
                          {
                            title: '费用($)',
                            dataIndex: 'monthlyPrice',
                            width: 100,
                            render: (v: number | undefined, _record, index) => (
                              <InputNumber
                                min={0}
                                style={{ width: '100%' }}
                                value={v}
                                onChange={(val) =>
                                  handleTableDataChange(index, 'monthlyPrice', Number(val) || 0)
                                }
                              />
                            ),
                          },
                          { title: '购买时间', dataIndex: 'purchaseDate', width: 120 },
                          { title: '取消时间', dataIndex: 'cancellationDate', width: 120 },
                          {
                            title: '是否续费',
                            dataIndex: 'renewalStatus',
                            width: 100,
                            render: (s: RenewalStatus) =>
                              s && RENEWAL_STATUS_DISPLAY[s] ? RENEWAL_STATUS_DISPLAY[s].text : '',
                          },
                          {
                            title: '到期时间',
                            key: 'expiryDate',
                            width: 110,
                            render: (_: unknown, record: Partial<IPSegment>) =>
                              getExpiryDateForExport(record as IPSegment) || '-',
                          },
                        ]}
                        rowSelection={{
                          columnWidth: TABLE_SELECTION_COLUMN_WIDTH,
                          selectedRowKeys: previewSelectedRowKeys,
                          onChange: (selectedKeys) => {
                            setPreviewSelectedRowKeys(selectedKeys);
                          },
                        }}
                        pagination={false}
                        size="small"
                        style={{ marginTop: 8 }}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'blockedInfo',
              label: '被墙信息导入',
              children: (
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
                    格式说明：每行一条记录，IP段为必填项，被墙信息为选填项
                  </Text>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
                    格式：IP段[,地区状态1][,地区状态2]...<br />
                    - IP段为必填项，必须在第一列<br />
                    - 被墙信息为选填项，系统会根据文本内容智能识别地区（伊朗、缅甸、土库曼、俄罗斯）<br />
                    - 被墙状态：包含"被墙"或"是"等关键词表示被墙<br />
                    - 限速状态：包含"限速"等关键词表示限速<br />
                    - 可用状态：包含"可用"或"正常"等关键词表示可用<br />
                    分隔符支持：逗号（,）或Tab键<br />
                    注意：费用默认为0，购买时间默认为今天
                  </Text>
                  <TextArea
                    rows={10}
                    value={blockedInfoImportValue}
                    onChange={(e) => setBlockedInfoImportValue(e.target.value)}
                    placeholder={`示例1（完整格式）：
205.251.131.0/24,伊朗可用,缅甸被墙,土库曼被墙,俄罗斯可用
75.127.79.0/24,伊朗被墙,缅甸被墙,土库曼被墙,俄罗斯被墙

示例2（只填写IP段）：
198.177.61.0/24
67.210.121.0/24

示例3（部分地区）：
198.177.61.0/24,伊朗被墙,俄罗斯被墙`}
                    style={{ marginBottom: 16 }}
                  />
                  <Button type="primary" onClick={handleBlockedInfoImport}>
                    解析并预览
                  </Button>
                  {batchTableData.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <Space style={{ marginBottom: 8 }} wrap>
                        <Text strong>预览数据（共 {batchTableData.length} 条）：</Text>
                        {previewSelectedRowKeys.length > 0 && (
                          <>
                            <Button
                              type="primary"
                              size="small"
                              onClick={() => setIsPreviewBatchEditVisible(true)}
                            >
                              批量编辑 ({previewSelectedRowKeys.length})
                            </Button>
                            <Button
                              size="small"
                              onClick={() => setPreviewSelectedRowKeys([])}
                            >
                              取消选择
                            </Button>
                          </>
                        )}
                      </Space>
                      <Table
                        dataSource={batchTableData.map((item, index) => ({ ...item, key: index }))}
                        columns={[
                          { 
                            title: 'IP段', 
                            dataIndex: 'segment', 
                            width: 150 
                          },
                          { 
                            title: '伊朗', 
                            dataIndex: 'blockedCountries', 
                            width: 100,
                            render: (countries: BlockedCountry[], record: any) => {
                              const detected = record._detectedCountries?.iran;
                              if (!detected) {
                                return <Tag color="default">未检测</Tag>;
                              }
                              const isBlocked = countries && countries.includes('iran');
                              const isRateLimited = record.rateLimitedCountries?.includes('iran');
                              const color = isBlocked ? 'red' : isRateLimited ? 'orange' : 'green';
                              const text = isBlocked ? '被墙' : isRateLimited ? '限速' : '可用';
                              return <Tag color={color}>{text}</Tag>;
                            }
                          },
                          { 
                            title: '缅甸', 
                            dataIndex: 'blockedCountries', 
                            width: 100,
                            render: (countries: BlockedCountry[], record: any) => {
                              const detected = record._detectedCountries?.myanmar;
                              if (!detected) {
                                return <Tag color="default">未检测</Tag>;
                              }
                              const isBlocked = countries && countries.includes('myanmar');
                              const isRateLimited = record.rateLimitedCountries?.includes('myanmar');
                              const color = isBlocked ? 'red' : isRateLimited ? 'orange' : 'green';
                              const text = isBlocked ? '被墙' : isRateLimited ? '限速' : '可用';
                              return <Tag color={color}>{text}</Tag>;
                            }
                          },
                          { 
                            title: '土库曼', 
                            dataIndex: 'blockedCountries', 
                            width: 100,
                            render: (countries: BlockedCountry[], record: any) => {
                              const detected = record._detectedCountries?.turkmenistan;
                              if (!detected) {
                                return <Tag color="default">未检测</Tag>;
                              }
                              const isBlocked = countries && countries.includes('turkmenistan');
                              const isRateLimited = record.rateLimitedCountries?.includes('turkmenistan');
                              const color = isBlocked ? 'red' : isRateLimited ? 'orange' : 'green';
                              const text = isBlocked ? '被墙' : isRateLimited ? '限速' : '可用';
                              return <Tag color={color}>{text}</Tag>;
                            }
                          },
                          { 
                            title: '俄罗斯', 
                            dataIndex: 'blockedCountries', 
                            width: 100,
                            render: (countries: BlockedCountry[], record: any) => {
                              const detected = record._detectedCountries?.russia;
                              if (!detected) {
                                return <Tag color="default">未检测</Tag>;
                              }
                              const isBlocked = countries && countries.includes('russia');
                              const isRateLimited = record.rateLimitedCountries?.includes('russia');
                              const color = isBlocked ? 'red' : isRateLimited ? 'orange' : 'green';
                              const text = isBlocked ? '被墙' : isRateLimited ? '限速' : '可用';
                              return <Tag color={color}>{text}</Tag>;
                            }
                          },
                        ]}
                        rowSelection={{
                          columnWidth: TABLE_SELECTION_COLUMN_WIDTH,
                          selectedRowKeys: previewSelectedRowKeys,
                          onChange: (selectedKeys) => {
                            setPreviewSelectedRowKeys(selectedKeys);
                          },
                        }}
                        pagination={false}
                        size="small"
                        style={{ marginTop: 8 }}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'table',
              label: '表格批量添加',
              children: (
                <div>
                  <Space style={{ marginBottom: 16 }}>
                    <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddTableRow}>
                      添加行
                    </Button>
                    <Text type="secondary">共 {batchTableData.length} 条数据</Text>
                  </Space>
                  <Table
                    dataSource={batchTableData.map((item, index) => ({ ...item, key: index }))}
                    columns={[
                      {
                        title: 'IP段',
                        dataIndex: 'segment',
                        width: 150,
                        render: (text, record, index) => (
                          <Input
                            value={text}
                            onChange={(e) => handleTableDataChange(index, 'segment', e.target.value)}
                            placeholder="192.168.1.0/24"
                          />
                        ),
                      },
                      {
                        title: '使用地区',
                        dataIndex: 'usageArea',
                        width: 150,
                        render: (text, record, index) => (
                          <Select
                            showSearch
                            value={text}
                            onChange={(value) => handleTableDataChange(index, 'usageArea', value || '未使用')}
                            style={{ width: '100%' }}
                            placeholder="选择或输入"
                            options={usageAreas.map(area => ({
                              label: (
                                <span>
                                  <Tag color={area.color} style={{ marginRight: 4, color: '#000' }}>{area.name}</Tag>
                                </span>
                              ),
                              value: area.name,
                            }))}
                            filterOption={(input, option) =>
                              (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                            }
                            notFoundContent={null}
                          />
                        ),
                      },
                      {
                        title: '供应商',
                        dataIndex: 'supplier',
                        width: 120,
                        render: (text, record, index) => (
                          <Input
                            value={text}
                            onChange={(e) => handleTableDataChange(index, 'supplier', e.target.value)}
                            placeholder="供应商名称"
                          />
                        ),
                      },
                      {
                        title: 'ASN',
                        dataIndex: 'asn',
                        width: 120,
                        render: (text, record, index) => (
                          <Input
                            value={text}
                            onChange={(e) => handleTableDataChange(index, 'asn', e.target.value)}
                            placeholder="如 13335"
                          />
                        ),
                      },
                      {
                        title: '购买时间',
                        dataIndex: 'purchaseDate',
                        width: 150,
                        render: (text, record, index) => (
                          <DatePicker
                            value={text ? dayjs(text) : null}
                            onChange={(date) => {
                              if (date && date.isValid()) {
                                const renewalDate = calculateRenewalDate(date).format('YYYY-MM-DD');
                                handleTableDataChange(index, 'purchaseDate', date.format('YYYY-MM-DD'));
                                handleTableDataChange(index, 'renewalDate', renewalDate);
                              }
                            }}
                            style={{ width: '100%' }}
                            format="YYYY-MM-DD"
                          />
                        ),
                      },
                      {
                        title: '续费时间（自动计算）',
                        dataIndex: 'renewalDate',
                        width: 150,
                        render: (text, record, index) => (
                          <DatePicker
                            value={text ? dayjs(text) : null}
                            disabled
                            style={{ width: '100%' }}
                            format="YYYY-MM-DD"
                          />
                        ),
                      },
                      {
                        title: '取消时间',
                        dataIndex: 'cancellationDate',
                        width: 150,
                        render: (text, record, index) => (
                          <DatePicker
                            value={text ? dayjs(text) : null}
                            onChange={(date) => handleTableDataChange(index, 'cancellationDate', date ? date.format('YYYY-MM-DD') : '')}
                            style={{ width: '100%' }}
                            format="YYYY-MM-DD"
                          />
                        ),
                      },
                      {
                        title: '项目组',
                        dataIndex: 'projectGroups',
                        width: 150,
                        render: (groups, record, index) => (
                          <Select
                            mode="tags"
                            value={groups}
                            onChange={(value) => handleTableDataChange(index, 'projectGroups', value)}
                            style={{ width: '100%' }}
                            placeholder="选择或输入"
                            options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
                          />
                        ),
                      },
                      {
                        title: '服务器位置',
                        dataIndex: 'serverLocations',
                        width: 200,
                        render: (locations, record, index) => {
                          const locationStr = locations && locations.length > 0
                            ? locations.map((loc: ServerLocation) => `${loc.supplier}-${loc.region}`).join(';')
                            : '';
                          return (
                            <Input
                              value={locationStr}
                              onChange={(e) => {
                                const value = e.target.value;
                                const parsedLocations: ServerLocation[] = value
                                  ? value.split(';').map(loc => {
                                      const [supplier, region] = loc.split('-').map(s => s.trim());
                                      return { supplier: supplier || '', region: region || '' };
                                    }).filter(loc => loc.supplier && loc.region)
                                  : [];
                                handleTableDataChange(index, 'serverLocations', parsedLocations);
                              }}
                              placeholder="供应商-地区;供应商-地区"
                            />
                          );
                        },
                      },
                      {
                        title: '被墙信息',
                        dataIndex: 'blockedCountries',
                        width: 150,
                        render: (countries, record, index) => (
                          <Select
                            mode="multiple"
                            value={countries}
                            onChange={(value) => handleTableDataChange(index, 'blockedCountries', value)}
                            style={{ width: '100%' }}
                            placeholder="选择国家"
                            options={[...BLOCKED_COUNTRY_OPTIONS]}
                          />
                        ),
                      },
                      {
                        title: '操作',
                        key: 'action',
                        width: 80,
                        render: (_, record, index) => (
                          <Button
                            type="link"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => handleDeleteTableRow(index)}
                          >
                            删除
                          </Button>
                        ),
                      },
                    ]}
                    pagination={false}
                    scroll={{ x: 1200, y: 400 }}
                    size="small"
                  />
                </div>
              ),
            },
          ]}
        />
      </Modal>


      {/* 批量编辑弹窗 */}
      <Modal
        title={`批量编辑 (已选择 ${(() => {
          const currentSelectedKeys = activeTabKey === 'all'
            ? allSegmentsSelectedKeys
            : activeTabKey === 'active' 
            ? selectedRowKeys 
            : activeTabKey === 'cancelledButNotExpired'
            ? cancelledButNotExpiredSelectedKeys
            : cancelledSelectedKeys;
          return currentSelectedKeys.length;
        })()} 条)`}
        open={isBatchEditVisible}
        onOk={handleBatchEditSubmit}
        onCancel={() => {
          setIsBatchEditVisible(false);
          batchEditForm.resetFields();
        }}
        width={800}
        okText="批量更新"
        cancelText="取消"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          提示：只填写需要批量修改的字段，留空的字段将保持不变
        </Text>
        <Form
          form={batchEditForm}
          layout="vertical"
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="usageArea"
                label="使用地区"
                tooltip="使用地区需在配置管理中添加，此处只能选择已有选项"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="留空则不修改"
                  options={usageAreas.map(area => ({
                    label: (
                      <span>
                        <Tag color={area.color} style={{ marginRight: 4, color: '#000' }}>{area.name}</Tag>
                      </span>
                    ),
                    value: area.name,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={<span style={{ color: '#999', fontSize: 12 }}>未找到匹配的使用地区，请到配置管理中添加</span>}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="supplier"
                label="供应商"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="留空则不修改"
                  options={getAllSuppliers.map((supplier: string) => ({
                    label: supplier,
                    value: supplier,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="asn"
                label="ASN"
              >
                <Input placeholder="留空则不修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="monthlyPrice"
                label="费用($)"
              >
                <InputNumber<number>
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  placeholder="留空则不修改"
                  formatter={(value) => value ? `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                  parser={(value) => {
                    const s = (value ?? '').replace(/\$\s?|(,*)/g, '');
                    const n = parseFloat(s);
                    return Number.isFinite(n) ? n : 0;
                  }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="purchaseDate"
                label="购买时间（修改后会自动更新续费时间）"
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format="YYYY-MM-DD"
                  placeholder="留空则不修改"
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="cancellationDate"
                label="取消时间"
              >
                <DatePicker 
                  style={{ width: '100%' }} 
                  format="YYYY-MM-DD"
                  placeholder="留空则不修改"
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="renewalStatus"
                label="续费状态"
                tooltip="可选：无、取消续费、已退款。留空则不修改"
              >
                <Select
                  placeholder="留空则不修改"
                  allowClear
                  options={[...RENEWAL_STATUS_OPTIONS]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="projectGroups"
            label="项目组"
          >
            <Select
              mode="tags"
              placeholder="留空则不修改"
              allowClear
              options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
            />
          </Form.Item>

          <Form.Item
            name="blockedCountries"
            label="被墙信息"
          >
            <Select
              mode="multiple"
              placeholder="留空则不修改"
              allowClear
              options={[...BLOCKED_COUNTRY_OPTIONS]}
            />
          </Form.Item>

          <Form.Item
            name="remark"
            label={
              <Space>
                备注
                <Form.Item name="remarkOverwrite" valuePropName="checked" initialValue={false} noStyle>
                  <Switch
                    size="small"
                    checkedChildren="覆盖"
                    unCheckedChildren="追加"
                    title="开启：用新内容覆盖原备注；关闭：将新内容追加到原备注末尾"
                  />
                </Form.Item>
              </Space>
            }
            tooltip="追加模式（默认）：在原备注末尾加上新内容；覆盖模式：完全替换原备注；留空则不修改"
          >
            <Input.TextArea
              placeholder="留空则不修改"
              autoSize={{ minRows: 2, maxRows: 4 }}
              allowClear
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 预览数据批量编辑弹窗 */}
      <Modal
        title={`批量编辑预览数据 (已选择 ${previewSelectedRowKeys.length} 条)`}
        open={isPreviewBatchEditVisible}
        onOk={handlePreviewBatchEditSubmit}
        onCancel={() => {
          setIsPreviewBatchEditVisible(false);
          previewBatchEditForm.resetFields();
        }}
        width={800}
        okText="批量更新"
        cancelText="取消"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          提示：只填写需要批量修改的字段，留空的字段将保持不变
        </Text>
        <Form
          form={previewBatchEditForm}
          layout="vertical"
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="usageArea"
                label="使用地区"
                tooltip="使用地区需在配置管理中添加，此处只能选择已有选项"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="留空则不修改"
                  options={usageAreas.map(area => ({
                    label: (
                      <span>
                        <Tag color={area.color} style={{ marginRight: 4, color: '#000' }}>{area.name}</Tag>
                      </span>
                    ),
                    value: area.name,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={<span style={{ color: '#999', fontSize: 12 }}>未找到匹配的使用地区，请到配置管理中添加</span>}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="supplier"
                label="供应商"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="留空则不修改"
                  options={previewSupplierOptions}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="asn"
                label="ASN"
              >
                <Input placeholder="留空则不修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="monthlyPrice"
                label="费用($)"
              >
                <InputNumber<number>
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  placeholder="留空则不修改"
                  formatter={(value) => value ? `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                  parser={(value) => {
                    const s = (value ?? '').replace(/\$\s?|(,*)/g, '');
                    const n = parseFloat(s);
                    return Number.isFinite(n) ? n : 0;
                  }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="purchaseDate"
                label="购买时间"
              >
                <DatePicker style={{ width: '100%' }} placeholder="留空则不修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="cancellationDate"
                label="取消时间"
              >
                <DatePicker style={{ width: '100%' }} placeholder="留空则不修改" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="renewalStatus"
                label="续费状态"
                tooltip="可选：无、取消续费、已退款。留空则不修改"
              >
                <Select
                  placeholder="留空则不修改"
                  allowClear
                  options={[...RENEWAL_STATUS_OPTIONS]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="projectGroups"
            label="项目组"
          >
            <Select
              mode="tags"
              placeholder="留空则不修改"
              allowClear
              options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量编辑历程记录弹窗 */}
      <Modal
        title={`批量编辑历程记录 (已选择 ${(() => {
          const currentSelectedKeys = activeTabKey === 'all'
            ? allSegmentsSelectedKeys
            : activeTabKey === 'active' 
            ? selectedRowKeys 
            : activeTabKey === 'cancelledButNotExpired'
            ? cancelledButNotExpiredSelectedKeys
            : cancelledSelectedKeys;
          return currentSelectedKeys.length;
        })()} 条)`}
        open={isBatchHistoryEditVisible}
        onOk={handleBatchHistoryEditSubmit}
        onCancel={() => {
          setIsBatchHistoryEditVisible(false);
          batchHistoryForm.resetFields();
        }}
        width={600}
        okText="批量更新"
        cancelText="取消"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          为选中的IP段批量添加或修改历程记录。操作将应用到所有选中的IP段。
        </Text>
        <Form
          form={batchHistoryForm}
          layout="vertical"
          initialValues={{
            operation: 'add',
          }}
        >
          <Form.Item
            name="operation"
            label="操作类型"
            rules={[{ required: true, message: '请选择操作类型' }]}
          >
            <Select>
              <Select.Option value="add">添加新的历程记录</Select.Option>
              <Select.Option value="update_current">更新当前正在使用的历程记录</Select.Option>
              <Select.Option value="end_current">结束当前正在使用的历程记录</Select.Option>
            </Select>
          </Form.Item>
          
          <Form.Item
            name="projectGroup"
            label="项目组"
            rules={[{ required: true, message: '请选择项目组' }]}
          >
            <Select
              showSearch
              placeholder="选择或输入项目组名称"
              options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
              filterOption={(input, option) =>
                (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
              }
              notFoundContent={null}
              allowClear
            />
          </Form.Item>
          
          <Form.Item
            name="startDate"
            label="开始日期"
            rules={[{ required: true, message: '请选择开始日期' }]}
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          
          <Form.Item
            name="endDate"
            label="结束日期（留空表示当前仍在使用）"
            dependencies={['operation']}
          >
            {({ getFieldValue }) => {
              const operation = getFieldValue('operation');
              if (operation === 'end_current') {
                return (
                  <DatePicker 
                    style={{ width: '100%' }} 
                    placeholder="选择结束日期"
                  />
                );
              }
              return (
                <DatePicker 
                  style={{ width: '100%' }} 
                  placeholder="留空表示当前仍在使用"
                />
              );
            }}
          </Form.Item>
        </Form>
      </Modal>

      {/* 文本批量编辑弹窗 */}
      <Modal
        title="文本批量编辑IP段"
        open={isTextBatchEditVisible}
        onOk={handleTextBatchEditSubmit}
        onCancel={() => {
          setIsTextBatchEditVisible(false);
          setTextBatchEditValue('');
          textBatchEditForm.resetFields();
        }}
        width={800}
        okText="批量更新"
        cancelText="取消"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          格式说明：每行一个IP段，支持逗号或Tab键分隔（将提取第一个字段作为IP段）
        </Text>
        <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          可批量修改的字段：使用地区、供应商、ASN、费用、购买时间、取消时间、项目组、续费状态、被墙信息。续费状态可选：无、取消续费、已退款。到期时间会根据续费时间、取消时间、续费状态自动计算。
        </Text>
        <TextArea
          rows={8}
          value={textBatchEditValue}
          onChange={(e) => setTextBatchEditValue(e.target.value)}
          placeholder={`示例：
192.168.1.0/24
192.168.2.0/24
45.197.21.0/24`}
          style={{ marginBottom: 16 }}
        />
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          提示：只填写需要批量修改的字段，留空的字段将保持不变
        </Text>
        <Form
          form={textBatchEditForm}
          layout="vertical"
        >
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="usageArea"
                label="使用地区"
                tooltip="使用地区需在配置管理中添加，此处只能选择已有选项"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="留空则不修改"
                  options={usageAreas.map(area => ({
                    label: (
                      <span>
                        <Tag color={area.color} style={{ marginRight: 4, color: '#000' }}>{area.name}</Tag>
                      </span>
                    ),
                    value: area.name,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={<span style={{ color: '#999', fontSize: 12 }}>未找到匹配的使用地区，请到配置管理中添加</span>}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="supplier"
                label="供应商"
              >
                <Select
                  showSearch
                  allowClear
                  placeholder="留空则不修改"
                  options={getAllSuppliers.map((supplier: string) => ({
                    label: supplier,
                    value: supplier,
                  }))}
                  filterOption={(input, option) =>
                    (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={null}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="asn"
                label="ASN"
              >
                <Input placeholder="留空则不修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="monthlyPrice"
                label="费用($)"
              >
                <InputNumber<number>
                  style={{ width: '100%' }}
                  min={0}
                  precision={2}
                  placeholder="留空则不修改"
                  formatter={(value) => value ? `$ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                  parser={(value) => {
                    const s = (value ?? '').replace(/\$\s?|(,*)/g, '');
                    const n = parseFloat(s);
                    return Number.isFinite(n) ? n : 0;
                  }}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="purchaseDate"
                label="购买时间"
              >
                <DatePicker style={{ width: '100%' }} placeholder="留空则不修改" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="cancellationDate"
                label="取消时间"
              >
                <DatePicker style={{ width: '100%' }} placeholder="留空则不修改" />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item
                name="renewalStatus"
                label="续费状态"
                tooltip="可选：无、取消续费、已退款。留空则不修改"
              >
                <Select
                  placeholder="留空则不修改"
                  allowClear
                  options={[...RENEWAL_STATUS_OPTIONS]}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item
            name="projectGroups"
            label="项目组"
          >
            <Select
              mode="tags"
              placeholder="留空则不修改"
              allowClear
              options={projectGroups.map(g => ({ label: g.name, value: g.name }))}
            />
          </Form.Item>

          <Form.Item
            name="blockedCountries"
            label="被墙信息"
          >
            <Select
              mode="multiple"
              placeholder="留空则不修改"
              allowClear
              options={[...BLOCKED_COUNTRY_OPTIONS]}
            />
          </Form.Item>
        </Form>
      </Modal>

    </div>
  );
};

export default IPManagement;

