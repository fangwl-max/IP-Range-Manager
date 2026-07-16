import React, { useState, useEffect, useMemo, type CSSProperties } from 'react';
import {
  Card,
  Form,
  Input,
  InputNumber,
  Button,
  Space,
  Tag,
  Row,
  Col,
  Select,
  Typography,
  Divider,
  Empty,
  Modal,
  message,
  Popconfirm,
  DatePicker,
  Table,
  Tooltip,
  Checkbox,
  ConfigProvider,
  Statistic,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  CheckCircleOutlined,
  EditOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  AppstoreOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { normalizeAsnDigitsOnly } from '../../utils/asn-normalize';
import {
  ASN,
  AsnGroup,
  AsnStatus,
  ASN_STATUS_OPTIONS,
  UsageAreaOption,
  BLOCKED_COUNTRY_OPTIONS,
  type BlockedCountry,
  type AsnUsageHistoryEntry,
} from '../../types';
import { asnStorage, asnGroupStorage, usageAreaStorage, ipSegmentStorage, projectGroupStorage } from '../../utils/storage';
import { useAuth } from '../../contexts/AuthContext';
import { saveConfigDataToFile } from './saveConfigData';
import { checkASNInUse, getAsnCountInGroup } from './configInUse';
import { ConfigPageShell } from './ConfigPageShell';

const { Text } = Typography;
const { TextArea } = Input;

function parseUsageAreaHexColor(hex: string): { r: number; g: number; b: number } | null {
  const s = (hex || '').trim();
  if (!s) return null;
  let h = s.startsWith('#') ? s.slice(1) : s;
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 根据背景色选择对比度更好的字色，避免浅底 + 白字 */
function textColorOnUsageAreaBg(hex: string): string {
  const rgb = parseUsageAreaHexColor(hex);
  if (!rgb) return 'rgba(0,0,0,0.88)';
  const toLinear = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return L > 0.6 ? 'rgba(0,0,0,0.9)' : '#fff';
}

function usageAreaTagStyle(bgHex: string): CSSProperties {
  return {
    margin: 0,
    background: bgHex,
    color: textColorOnUsageAreaBg(bgHex),
    border: '1px solid rgba(0,0,0,0.1)',
    fontWeight: 500,
    fontSize: 'inherit',
    lineHeight: 1.35,
  };
}

const asnListTableTag: CSSProperties = { margin: 0, fontSize: 'inherit', lineHeight: 1.35 };

/** 旧数据仅单选 usageAreaId 时合并为列表 */
function resolveUsageAreaIds(asn: ASN): string[] {
  if (asn.usageAreaIds && asn.usageAreaIds.length > 0) {
    return [...new Set(asn.usageAreaIds)];
  }
  if (asn.usageAreaId) {
    return [asn.usageAreaId];
  }
  return [];
}

function resolveAsnStatus(asn: ASN): AsnStatus {
  return asn.status ?? 'unused';
}

/** 按「ASN 分组」在配置中的顺序排列；同组内按名称；未分组置末；引用了已删分组者排在未分组之前 */
function sortAsnsByGroupOrder(list: ASN[], asnGroups: AsnGroup[]): ASN[] {
  const out = [...list];
  const groupRank = (asnGroupId: string | undefined) => {
    if (!asnGroupId) return 1_000_000;
    const i = asnGroups.findIndex((g) => g.id === asnGroupId);
    return i < 0 ? 999_000 : i;
  };
  out.sort((a, b) => {
    const d = groupRank(a.asnGroupId) - groupRank(b.asnGroupId);
    if (d !== 0) return d;
    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });
  return out;
}

type AsnFormValues = {
  name: string;
  status: AsnStatus;
  /** 月度费用（美元 USD） */
  feeUsd?: number | null;
  /** 到期日；当日仍计入「月度费用」统计 */
  expiryDate?: Dayjs | null;
  /** 购买日（可选），用于过往自然月费用汇总 */
  purchaseDate?: Dayjs | null;
  /** 使用历程（备案） */
  usageHistory?: {
    id?: string;
    startDate?: Dayjs | null;
    endDate?: Dayjs | null;
    remark?: string;
  }[];
  /** 选中的 ASN 分组 id，未选表示不归属任何组 */
  asnGroupId?: string;
  usageAreaIds?: string[];
  projectGroupNames?: string[];
  datacenter?: string[];
  countryUsage?: Partial<
    Record<
      BlockedCountry,
      {
        enabledAt?: Dayjs | null;
        blockedAt?: Dayjs | null;
      }
    >
  >;
};

function emptyCountryUsageForm(): AsnFormValues['countryUsage'] {
  const out: NonNullable<AsnFormValues['countryUsage']> = {};
  for (const { value } of BLOCKED_COUNTRY_OPTIONS) {
    out[value as BlockedCountry] = { enabledAt: undefined, blockedAt: undefined };
  }
  return out;
}

function asnToFormValues(asn: ASN): AsnFormValues {
  const countryUsage: NonNullable<AsnFormValues['countryUsage']> = { ...emptyCountryUsageForm() };
  for (const { value } of BLOCKED_COUNTRY_OPTIONS) {
    const k = value as BlockedCountry;
    const u = asn.countryUsage?.[k];
    countryUsage[k] = {
      enabledAt: u?.enabledAt ? dayjs(u.enabledAt, 'YYYY-MM-DD') : undefined,
      blockedAt: u?.blockedAt ? dayjs(u.blockedAt, 'YYYY-MM-DD') : undefined,
    };
  }
  return {
    name: asn.name,
    status: resolveAsnStatus(asn),
    feeUsd: asn.feeUsd,
    expiryDate: asn.expiryDate ? dayjs(asn.expiryDate, 'YYYY-MM-DD') : undefined,
    purchaseDate: asn.purchaseDate ? dayjs(asn.purchaseDate, 'YYYY-MM-DD') : undefined,
    usageHistory:
      asn.usageHistory && asn.usageHistory.length > 0
        ? asn.usageHistory.map((h) => ({
            id: h.id,
            startDate: h.startDate ? dayjs(h.startDate, 'YYYY-MM-DD') : undefined,
            endDate: h.endDate ? dayjs(h.endDate, 'YYYY-MM-DD') : undefined,
            remark: h.remark,
          }))
        : [],
    asnGroupId: asn.asnGroupId,
    usageAreaIds: resolveUsageAreaIds(asn),
    projectGroupNames: asn.projectGroupNames?.length ? [...asn.projectGroupNames] : [],
    countryUsage,
    datacenter: asn.datacenter?.length ? [...asn.datacenter] : [],
  };
}

function formValuesToCountryUsage(
  countryUsage: AsnFormValues['countryUsage']
): ASN['countryUsage'] | undefined {
  if (!countryUsage) return undefined;
  const out: NonNullable<ASN['countryUsage']> = {};
  for (const { value } of BLOCKED_COUNTRY_OPTIONS) {
    const k = value as BlockedCountry;
    const cell = countryUsage[k];
    if (!cell) continue;
    const enabledAt = cell.enabledAt ? dayjs(cell.enabledAt).format('YYYY-MM-DD') : undefined;
    const blockedAt = cell.blockedAt ? dayjs(cell.blockedAt).format('YYYY-MM-DD') : undefined;
    if (enabledAt || blockedAt) {
      out[k] = { enabledAt, blockedAt };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function parseFeeUsd(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

function newUsageHistoryRowId(): string {
  return `uh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** ZEN 分组名称：按月持续计费（与原先自然月交集逻辑一致） */
const ZEN_MONTHLY_GROUP_NAMES = new Set(['ZEN-1月租用', 'ZEN-2月租用']);

function asnZenMonthlyBilling(asn: ASN, asnGroups: AsnGroup[]): boolean {
  const gid = asn.asnGroupId?.trim();
  if (!gid) return false;
  const g = asnGroups.find((x) => x.id === gid);
  const name = g?.name?.trim();
  if (!name) return false;
  return ZEN_MONTHLY_GROUP_NAMES.has(name);
}

/** 是否已超过到期日（不含当日）：仅在「翌日」起不再计入月度费用合计 */
function isPastExpiry(expiry?: string): boolean {
  const s = expiry?.trim();
  if (!s) return false;
  const exp = dayjs(s, 'YYYY-MM-DD').startOf('day');
  if (!exp.isValid()) return false;
  return dayjs().startOf('day').isAfter(exp);
}

/**
 * 本条 ASN 当前是否计入「月度费用合计」：
 * — ZEN-1月租用 / ZEN-2月租用：月费大于 0、未取消、未过期（按今日）。
 * — 其余分组或未分组：同上，且 **仅购买日所在自然月** 计入；须填写购买日。
 */
function asnIncludedInMonthlyTotalFee(asn: ASN, asnGroups: AsnGroup[]): boolean {
  const fee = asn.feeUsd;
  if (fee == null || !Number.isFinite(fee) || fee <= 0) return false;
  if ((asn.status ?? 'unused') === 'cancelled') return false;
  if (isPastExpiry(asn.expiryDate)) return false;

  if (asnZenMonthlyBilling(asn, asnGroups)) return true;

  const purchaseRaw = asn.purchaseDate?.trim();
  if (!purchaseRaw) return false;
  const purchase = dayjs(purchaseRaw, 'YYYY-MM-DD');
  if (!purchase.isValid()) return false;
  return dayjs().format('YYYY-MM') === purchase.format('YYYY-MM');
}

function formValuesToUsageHistory(rows: AsnFormValues['usageHistory']): AsnUsageHistoryEntry[] | undefined {
  if (!rows?.length) return undefined;
  const out: AsnUsageHistoryEntry[] = [];
  for (const r of rows) {
    const sd = r.startDate ? dayjs(r.startDate) : null;
    if (!sd || !sd.isValid()) continue;
    out.push({
      id: r.id && String(r.id).trim() ? String(r.id) : newUsageHistoryRowId(),
      startDate: sd.format('YYYY-MM-DD'),
      endDate: r.endDate && dayjs(r.endDate).isValid() ? dayjs(r.endDate).format('YYYY-MM-DD') : undefined,
      remark: r.remark?.trim() || undefined,
    });
  }
  out.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return out.length ? out : undefined;
}

const REMOTE_FUTURE = '2099-12-31';
const ANCIENT_PAST = '1970-01-01';

/** 自然月 YYYY-MM 的起止（按日） */
function calendarMonthDayRange(ym: string): { mStart: Dayjs; mEnd: Dayjs } | null {
  const mStart = dayjs(`${ym}-01`, 'YYYY-MM-DD').startOf('day');
  if (!mStart.isValid()) return null;
  const mEnd = mStart.endOf('month').startOf('day');
  return { mStart, mEnd };
}

/**
 * 某自然月 ym 是否计入该 ASN 月费（过往月份表 & 内部汇总）。
 * — 分组为 ZEN-1月租用 / ZEN-2月租用：与 [购买日, 到期日] 有交集的自然月均计整月月费；未填购买日自 1970-01-01 起算，未填到期至远未来。
 * — 其余：仅 **购买日所在自然月** 计 1 次（须填购买日）；与到期日仍须有日历交集。
 */
function asnBillableInCalendarMonth(asn: ASN, ym: string, asnGroups: AsnGroup[]): boolean {
  const fee = asn.feeUsd;
  if (fee == null || !Number.isFinite(fee) || fee <= 0) return false;
  if ((asn.status ?? 'unused') === 'cancelled') return false;
  const range = calendarMonthDayRange(ym);
  if (!range) return false;
  const { mStart, mEnd } = range;

  const expRaw = asn.expiryDate?.trim();
  const expEnd = expRaw ? dayjs(expRaw, 'YYYY-MM-DD').startOf('day') : dayjs(REMOTE_FUTURE, 'YYYY-MM-DD');
  if (!expEnd.isValid()) return false;

  if (asnZenMonthlyBilling(asn, asnGroups)) {
    const purchaseRaw = asn.purchaseDate?.trim();
    const purchase = purchaseRaw
      ? dayjs(purchaseRaw, 'YYYY-MM-DD').startOf('day')
      : dayjs(ANCIENT_PAST, 'YYYY-MM-DD');
    if (!purchase.isValid()) return false;
    if (mEnd.isBefore(purchase, 'day')) return false;
    if (mStart.isAfter(expEnd, 'day')) return false;
    return true;
  }

  const purchaseRaw = asn.purchaseDate?.trim();
  if (!purchaseRaw) return false;
  const purchase = dayjs(purchaseRaw, 'YYYY-MM-DD').startOf('day');
  if (!purchase.isValid()) return false;
  if (ym !== purchase.format('YYYY-MM')) return false;
  if (mEnd.isBefore(purchase, 'day')) return false;
  if (mStart.isAfter(expEnd, 'day')) return false;
  return true;
}

type PastMonthFeeRow = { ym: string; labelZh: string; total: number; count: number };

/** 生成早于当前月的自然月费用行（仅含合计>0 的月份）；月份倒序（新→旧） */
function computePastMonthlyFeeRows(asns: ASN[], asnGroups: AsnGroup[]): PastMonthFeeRow[] {
  const curYm = dayjs().format('YYYY-MM');
  let oldestCursor = dayjs().subtract(35, 'month').startOf('month'); // 与数据取最早购买日交集
  for (const a of asns) {
    const raw = a.purchaseDate?.trim();
    if (!raw) continue;
    const p = dayjs(raw, 'YYYY-MM-DD').startOf('month');
    if (!p.isValid()) continue;
    if (p.isBefore(oldestCursor)) oldestCursor = p;
  }
  const rows: PastMonthFeeRow[] = [];
  let cursor = oldestCursor.startOf('month');
  const curStamp = dayjs(`${curYm}-01`, 'YYYY-MM-DD').startOf('month');
  while (cursor.isBefore(curStamp)) {
    const ym = cursor.format('YYYY-MM');
    let total = 0;
    let count = 0;
    for (const a of asns) {
      if (!asnBillableInCalendarMonth(a, ym, asnGroups)) continue;
      total += Number(a.feeUsd);
      count++;
    }
    total = Math.round(total * 100) / 100;
    if (total > 0) {
      rows.push({
        ym,
        labelZh: `${cursor.year()}年${cursor.month() + 1}月`,
        total,
        count,
      });
    }
    cursor = cursor.add(1, 'month');
  }
  rows.reverse();
  return rows;
}

const pastMonthFeeColumns: ColumnsType<PastMonthFeeRow> = [
  { title: '自然月', dataIndex: 'labelZh', key: 'labelZh', width: 140 },
  {
    title: '月度合计（USD）',
    dataIndex: 'total',
    key: 'total',
    align: 'right' as const,
    render: (v: number) => <Text>${Number(v).toFixed(2)}</Text>,
  },
  { title: '计入 ASN 数', dataIndex: 'count', key: 'count', align: 'right' as const, width: 120 },
];

/** 批量编辑：通过文本解析 ASN 得到 id 集合，或退回使用表格勾选；返回未找到的 `AS 数字` 展示名 */
function resolveBatchEditTargetIds(
  asnListText: string | undefined,
  selectedRowKeys: React.Key[],
  allAsns: ASN[]
): { byList: boolean; idSet: Set<string>; notFound: string[] } {
  const raw = String(asnListText ?? '').trim();
  if (raw) {
    const parts = raw
      .split(/[\n,;，；\r\t]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const wantDigits: string[] = [];
    const seenD = new Set<string>();
    for (const p of parts) {
      const d = normalizeAsnDigitsOnly(p);
      if (!d || seenD.has(d)) continue;
      seenD.add(d);
      wantDigits.push(d);
    }
    if (wantDigits.length === 0) {
      return { byList: true, idSet: new Set(), notFound: [] };
    }
    const byDigit = new Map<string, string>();
    for (const a of allAsns) {
      const d = normalizeAsnDigitsOnly(a.name);
      if (d) {
        if (!byDigit.has(d)) byDigit.set(d, a.id);
      }
    }
    const idSet = new Set<string>();
    const notFound: string[] = [];
    for (const d of wantDigits) {
      const id = byDigit.get(d);
      if (id) idSet.add(id);
      else notFound.push(`AS${d}`);
    }
    return { byList: true, idSet, notFound };
  }
  return { byList: false, idSet: new Set(selectedRowKeys.map((k) => String(k))), notFound: [] };
}

const AsnConfigPage: React.FC = () => {
  const { hasPermission } = useAuth();
  const canManageConfig = hasPermission('manage_config');
  const [asns, setAsns] = useState<ASN[]>([]);
  const [asnGroups, setAsnGroups] = useState<AsnGroup[]>([]);
  const [usageAreas, setUsageAreas] = useState<UsageAreaOption[]>([]);
  const [projectGroupOptions, setProjectGroupOptions] = useState<string[]>([]);
  const [form] = Form.useForm<AsnFormValues>();
  const [groupForm] = Form.useForm<{ name: string }>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [batchAddOpen, setBatchAddOpen] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [asnListPage, setAsnListPage] = useState(1);
  const [asnListPageSize, setAsnListPageSize] = useState(50);
  const [monthlyFeeDetailOpen, setMonthlyFeeDetailOpen] = useState(false);
  const [batchAddForm] = Form.useForm<{
    rawText: string;
    defaultStatus?: AsnStatus;
    defaultFeeUsd?: number | null;
    defaultPurchaseDate?: Dayjs | null;
    defaultExpiryDate?: Dayjs | null;
    asnGroupId?: string;
    usageAreaIds?: string[];
    projectGroupNames?: string[];
  }>();
  const [batchEditForm] = Form.useForm<{
    asnListText?: string;
    applyGroup: boolean;
    applyUsage: boolean;
    applyPgs: boolean;
    applyStatus: boolean;
    applyFee: boolean;
    applyPurchaseDate: boolean;
    applyExpiryDate: boolean;
    batchAsnGroupId?: string;
    batchUsageAreaIds?: string[];
    batchProjectGroupNames?: string[];
    batchStatus?: AsnStatus;
    batchFeeUsd?: number | null;
    batchPurchaseDate?: Dayjs | null;
    batchExpiryDate?: Dayjs | null;
  }>();
  const batchApplyGroup = Form.useWatch('applyGroup', batchEditForm);
  const batchApplyUsage = Form.useWatch('applyUsage', batchEditForm);
  const batchApplyPgs = Form.useWatch('applyPgs', batchEditForm);
  const batchApplyStatus = Form.useWatch('applyStatus', batchEditForm);
  const batchApplyFee = Form.useWatch('applyFee', batchEditForm);
  const batchApplyPurchaseDate = Form.useWatch('applyPurchaseDate', batchEditForm);
  const batchApplyExpiryDate = Form.useWatch('applyExpiryDate', batchEditForm);

  const asnsSortedByGroup = useMemo(
    () => sortAsnsByGroupOrder(asns, asnGroups),
    [asns, asnGroups]
  );

  // ASN 搜索：支持多值批量搜索（空格/逗号/换行分隔）
  const [asnSearchText, setAsnSearchText] = useState('');
  const asnSearchKeywords = useMemo(() => {
    if (!asnSearchText.trim()) return [];
    return asnSearchText
      .split(/[\s,，\n]+/)
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
  }, [asnSearchText]);

  const asnDisplayList = useMemo(() => {
    if (asnSearchKeywords.length === 0) return asnsSortedByGroup;
    return asnsSortedByGroup.filter((a) => {
      const nameL = (a.name || '').toLowerCase();
      // 有 / 的关键词精确匹配，否则模糊匹配
      return asnSearchKeywords.some((kw) =>
        kw.includes('/') ? nameL === kw : nameL.includes(kw)
      );
    });
  }, [asnsSortedByGroup, asnSearchKeywords]);

  const monthlyFeeSummary = useMemo(() => {
    let total = 0;
    let count = 0;
    for (const a of asns) {
      if (!asnIncludedInMonthlyTotalFee(a, asnGroups)) continue;
      total += Number(a.feeUsd);
      count++;
    }
    total = Math.round(total * 100) / 100;
    return { total, count };
  }, [asns, asnGroups]);

  const pastMonthlyRows = useMemo(() => computePastMonthlyFeeRows(asns, asnGroups), [asns, asnGroups]);

  const currentMonthLabelZh = `${dayjs().year()}年${dayjs().month() + 1}月`;

  const copyAsnToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制: ${text}`);
    } catch {
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
      } catch {
        message.error('复制失败，请手动复制');
      }
      document.body.removeChild(textArea);
    }
  };

  const load = () => {
    setAsns(asnStorage.getAll());
    setAsnGroups(asnGroupStorage.getAll());
    setUsageAreas(usageAreaStorage.getAll());
    setProjectGroupOptions(projectGroupStorage.getAll().map((g) => g.name));
  };

  useEffect(() => {
    load();
  }, []);

  // 受控分页：数据变少时避免当前页越界
  useEffect(() => {
    if (asns.length === 0) return;
    const totalPages = Math.max(1, Math.ceil(asns.length / asnListPageSize));
    if (asnListPage > totalPages) {
      setAsnListPage(totalPages);
    }
  }, [asns.length, asnListPageSize, asnListPage]);

  const openAdd = () => {
    setEditingId(null);
    form.resetFields();
    form.setFieldsValue({
      name: '',
      status: 'unused',
      feeUsd: undefined,
      expiryDate: undefined,
      purchaseDate: undefined,
      usageHistory: [],
      asnGroupId: undefined,
      usageAreaIds: [],
      projectGroupNames: [],
      countryUsage: emptyCountryUsageForm(),
    });
    setModalOpen(true);
  };

  const openEdit = (asn: ASN) => {
    setEditingId(asn.id);
    form.setFieldsValue(asnToFormValues(asn));
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditingId(null);
    form.resetFields();
  };

  const openBatchAdd = () => {
    batchAddForm.resetFields();
    setBatchAddOpen(true);
  };

  const openBatchEdit = () => {
    if (asns.length === 0) {
      message.warning('暂无 ASN 可编辑');
      return;
    }
    batchEditForm.resetFields();
    batchEditForm.setFieldsValue({
      asnListText: '',
      applyGroup: false,
      applyUsage: false,
      applyPgs: false,
      applyStatus: false,
      applyFee: false,
      applyPurchaseDate: false,
      applyExpiryDate: false,
      batchStatus: 'unused',
      batchFeeUsd: undefined,
      batchPurchaseDate: undefined,
      batchExpiryDate: undefined,
    });
    setBatchEditOpen(true);
  };

  const isFormValidateError = (e: unknown): e is { errorFields: unknown } =>
    typeof e === 'object' && e !== null && 'errorFields' in e;

  const handleBatchAdd = async () => {
    try {
      const v = await batchAddForm.validateFields();
      const raw = String(v.rawText || '');
      const parts = raw
        .split(/[\n,;，；\r\t]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const seen = new Set<string>();
      const queue: { digits: string; name: string }[] = [];
      for (const p of parts) {
        const d = normalizeAsnDigitsOnly(p);
        if (!d) continue;
        if (seen.has(d)) continue;
        seen.add(d);
        queue.push({ digits: d, name: `AS${d}` });
      }
      if (queue.length === 0) {
        message.error('没有可识别的 ASN，请输入数字或 AS+数字（可换行/逗号/分号分隔）');
        return Promise.reject(new Error('no valid asn'));
      }
      const existing = asnStorage.getAll();
      const used = new Set(
        existing.map((a) => normalizeAsnDigitsOnly(a.name)).filter((x): x is string => !!x)
      );
      const rawG = v.asnGroupId;
      const asnGroupId =
        rawG != null && String(rawG).trim() !== '' ? String(rawG).trim() : undefined;
      const uids = (v.usageAreaIds || []).filter(Boolean) as string[];
      const usageAreaIds = uids.length > 0 ? [...new Set(uids)] : undefined;
      const pgs = (v.projectGroupNames || []).filter(Boolean) as string[];
      const projectGroupNames = pgs.length > 0 ? [...new Set(pgs)] : undefined;
      const batchStatus: AsnStatus = v.defaultStatus ?? 'unused';
      const batchFeeUsd = parseFeeUsd(v.defaultFeeUsd);
      const defaultPurchase =
        v.defaultPurchaseDate != null && dayjs(v.defaultPurchaseDate).isValid()
          ? dayjs(v.defaultPurchaseDate).format('YYYY-MM-DD')
          : undefined;
      const defaultExpiry =
        v.defaultExpiryDate != null && dayjs(v.defaultExpiryDate).isValid()
          ? dayjs(v.defaultExpiryDate).format('YYYY-MM-DD')
          : undefined;
      const toAdd: ASN[] = [];
      let skipDup = 0;
      for (const { digits, name } of queue) {
        if (used.has(digits)) {
          skipDup++;
          continue;
        }
        used.add(digits);
        toAdd.push({
          id: `asn-${Date.now()}-${digits}-${Math.random().toString(36).slice(2, 9)}`,
          name,
          status: batchStatus,
          ...(batchFeeUsd !== undefined ? { feeUsd: batchFeeUsd } : {}),
          ...(defaultPurchase ? { purchaseDate: defaultPurchase } : {}),
          ...(defaultExpiry ? { expiryDate: defaultExpiry } : {}),
          asnGroupId,
          usageAreaIds: usageAreaIds ? [...usageAreaIds] : undefined,
          projectGroupNames: projectGroupNames ? [...projectGroupNames] : undefined,
        });
      }
      if (toAdd.length === 0) {
        message.warning('输入的 ASN 均已存在，未添加新记录');
        return Promise.reject(new Error('all duplicate'));
      }
      asnStorage.save([...existing, ...toAdd]);
      setAsns(asnStorage.getAll());
      await saveConfigDataToFile();
      setSelectedRowKeys([]);
      setBatchAddOpen(false);
      batchAddForm.resetFields();
      const partsMsg: string[] = [`成功添加 ${toAdd.length} 条`];
      if (skipDup) partsMsg.push(`已存在未添加 ${skipDup} 条`);
      message.success(partsMsg.join('，'));
    } catch (e) {
      if (isFormValidateError(e)) {
        return Promise.reject(e);
      }
      console.error(e);
    }
  };

  const handleBatchEdit = async () => {
    try {
      const v = await batchEditForm.validateFields();
      if (
        !v.applyGroup &&
        !v.applyUsage &&
        !v.applyPgs &&
        !v.applyStatus &&
        !v.applyFee &&
        !v.applyPurchaseDate &&
        !v.applyExpiryDate
      ) {
        message.error('请至少勾选一项要修改的内容');
        return Promise.reject(new Error('no batch field'));
      }
      const all = asnStorage.getAll();
      const { byList, idSet, notFound } = resolveBatchEditTargetIds(
        v.asnListText,
        selectedRowKeys,
        all
      );
      if (byList) {
        if (idSet.size === 0) {
          if (notFound.length) {
            message.error(`以下 ASN 在库中未找到：${notFound.join('、')}`);
          } else {
            message.error('请填写可识别的 ASN（数字或 AS+数字）');
          }
          return Promise.reject(new Error('no target'));
        }
        if (notFound.length) {
          message.warning(`以下未找到，已跳过：${notFound.join('、')}`);
        }
      } else if (idSet.size === 0) {
        message.warning('请勾选表格中的 ASN，或在上方填写要修改的 ASN 列表');
        return Promise.reject(new Error('no target'));
      }
      const next: ASN[] = all.map((a) => {
        if (!idSet.has(a.id)) return a;
        const merged: ASN = { ...a };
        if (v.applyGroup) {
          const g = v.batchAsnGroupId;
          if (g != null && String(g).trim() !== '') {
            merged.asnGroupId = String(g).trim();
          } else {
            delete merged.asnGroupId;
          }
        }
        if (v.applyUsage) {
          const u = (v.batchUsageAreaIds || []).filter(Boolean) as string[];
          merged.usageAreaIds = u.length > 0 ? [...new Set(u)] : undefined;
        }
        if (v.applyPgs) {
          const p = (v.batchProjectGroupNames || []).filter(Boolean) as string[];
          merged.projectGroupNames = p.length > 0 ? [...new Set(p)] : undefined;
        }
        if (v.applyStatus) {
          merged.status = (v.batchStatus as AsnStatus) ?? 'unused';
        }
        if (v.applyFee) {
          const f = parseFeeUsd(v.batchFeeUsd);
          if (f === undefined) {
            delete merged.feeUsd;
          } else {
            merged.feeUsd = f;
          }
        }
        if (v.applyPurchaseDate) {
          const pd =
            v.batchPurchaseDate != null && dayjs(v.batchPurchaseDate).isValid()
              ? dayjs(v.batchPurchaseDate).format('YYYY-MM-DD')
              : undefined;
          if (pd) {
            merged.purchaseDate = pd;
          } else {
            delete merged.purchaseDate;
          }
        }
        if (v.applyExpiryDate) {
          const ed =
            v.batchExpiryDate != null && dayjs(v.batchExpiryDate).isValid()
              ? dayjs(v.batchExpiryDate).format('YYYY-MM-DD')
              : undefined;
          if (ed) {
            merged.expiryDate = ed;
          } else {
            delete merged.expiryDate;
          }
        }
        return merged;
      });
      asnStorage.save(next);
      setAsns(asnStorage.getAll());
      await saveConfigDataToFile();
      setSelectedRowKeys([]);
      setBatchEditOpen(false);
      batchEditForm.resetFields();
      const via = byList ? '（按 ASN 列表）' : '（按表格勾选）';
      message.success(`已批量更新 ${idSet.size} 条 ASN${via}`);
    } catch (e) {
      if (isFormValidateError(e)) {
        return Promise.reject(e);
      }
      console.error(e);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const trimmedName = values.name.trim();
      const rawIds = (values.usageAreaIds || []).filter(Boolean) as string[];
      const usageAreaIds = rawIds.length > 0 ? [...new Set(rawIds)] : undefined;
      const countryUsage = formValuesToCountryUsage(values.countryUsage);
      const usageHistoryParsed = formValuesToUsageHistory(values.usageHistory) ?? [];
      const projectGroupNames =
        values.projectGroupNames && values.projectGroupNames.length > 0 ? [...values.projectGroupNames] : undefined;
      const rawG = values.asnGroupId;
      const asnGroupId =
        rawG != null && String(rawG).trim() !== '' ? String(rawG).trim() : undefined;
      const status: AsnStatus = values.status ?? 'unused';
      const feeUsd = parseFeeUsd(values.feeUsd);
      const expiryDate =
        values.expiryDate != null && dayjs(values.expiryDate).isValid()
          ? dayjs(values.expiryDate).format('YYYY-MM-DD')
          : undefined;
      const purchaseDate =
        values.purchaseDate != null && dayjs(values.purchaseDate).isValid()
          ? dayjs(values.purchaseDate).format('YYYY-MM-DD')
          : undefined;
      const datacenter =
        values.datacenter && values.datacenter.length > 0 ? [...values.datacenter] : undefined;

      if (!editingId) {
        const existing = asnStorage.getAll();
        if (existing.find((a) => a.name === trimmedName)) {
          message.warning(`ASN "${trimmedName}" 已存在`);
          return;
        }
        const newASN: ASN = {
          id: `asn-${Date.now()}`,
          name: trimmedName,
          status,
          ...(feeUsd !== undefined ? { feeUsd } : {}),
          ...(expiryDate ? { expiryDate } : {}),
          ...(purchaseDate ? { purchaseDate } : {}),
          ...(usageHistoryParsed.length > 0 ? { usageHistory: usageHistoryParsed } : {}),
          asnGroupId,
          usageAreaIds,
          countryUsage,
          projectGroupNames,
          ...(datacenter ? { datacenter } : {}),
        };
        asnStorage.add(newASN);
        message.success('ASN 添加成功');
      } else {
        const existingASNs = asnStorage.getAll();
        const prev = existingASNs.find((a) => a.id === editingId);
        if (!prev) return;
        if (trimmedName !== prev.name && existingASNs.find((a) => a.name === trimmedName && a.id !== editingId)) {
          message.error(`ASN "${trimmedName}" 已存在`);
          return;
        }
        const next: ASN = {
          id: prev.id,
          name: trimmedName,
          status,
          feeUsd,
          expiryDate,
          purchaseDate,
          usageHistory: usageHistoryParsed,
          asnGroupId,
          usageAreaIds,
          countryUsage,
          projectGroupNames,
          datacenter,
        };
        asnStorage.update(editingId, next);
        if (trimmedName !== prev.name) {
          const segments = ipSegmentStorage.getAll();
          const updatedSegments = segments.map((seg) =>
            seg.asn === prev.name ? { ...seg, asn: trimmedName } : seg
          );
          ipSegmentStorage.save(updatedSegments);
        }
        message.success('ASN 已保存');
      }

      setAsns(asnStorage.getAll());
      await saveConfigDataToFile();
      closeModal();
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddAsnGroup = async (item: { name: string }) => {
    const trimmed = item.name.trim();
    if (!trimmed) {
      message.error('分组名称不能为空');
      return;
    }
    if (asnGroupStorage.getAll().some((g) => g.name === trimmed)) {
      message.warning(`分组「${trimmed}」已存在`);
      return;
    }
    asnGroupStorage.add({ id: `asng-${Date.now()}`, name: trimmed });
    setAsnGroups(asnGroupStorage.getAll());
    groupForm.resetFields();
    await saveConfigDataToFile();
    message.success('分组已添加');
  };

  const handleEditAsnGroup = (groupId: string, oldName: string) => {
    let inputValue = oldName;
    Modal.confirm({
      title: '编辑 ASN 分组',
      icon: <EditOutlined />,
      width: 400,
      content: (
        <Input
          placeholder="新分组名称"
          defaultValue={oldName}
          autoFocus
          onChange={(e) => {
            inputValue = e.target.value.trim();
          }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: () => {
        if (!inputValue) {
          message.error('名称不能为空');
          return Promise.reject();
        }
        if (inputValue === oldName) {
          return Promise.resolve();
        }
        if (asnGroupStorage.getAll().find((g) => g.name === inputValue && g.id !== groupId)) {
          message.error(`分组「${inputValue}」已存在`);
          return Promise.reject();
        }
        const group = asnGroupStorage.getAll().find((g) => g.id === groupId);
        if (!group) {
          return Promise.resolve();
        }
        asnGroupStorage.update(groupId, { ...group, name: inputValue });
        setAsnGroups(asnGroupStorage.getAll());
        void saveConfigDataToFile();
        message.success('已保存');
        return Promise.resolve();
      },
    });
  };

  const handleMoveAsnGroup = (index: number, delta: -1 | 1) => {
    const list = [...asnGroupStorage.getAll()];
    const j = index + delta;
    if (j < 0 || j >= list.length) return;
    const tmp = list[index];
    list[index] = list[j];
    list[j] = tmp;
    asnGroupStorage.save(list);
    setAsnGroups(list);
    void saveConfigDataToFile();
  };

  const handleDeleteAsnGroup = (groupId: string, groupName: string) => {
    const n = getAsnCountInGroup(groupId);
    const doDelete = () => {
      if (n > 0) {
        const list = asnStorage.getAll().map((a) =>
          a.asnGroupId === groupId ? { ...a, asnGroupId: undefined } : a
        );
        asnStorage.save(list);
      }
      asnGroupStorage.delete(groupId);
      load();
      void saveConfigDataToFile();
      message.success('已删除分组');
    };
    if (n > 0) {
      Modal.confirm({
        title: '确认删除分组',
        icon: <ExclamationCircleOutlined />,
        content: `分组「${groupName}」下还有 ${n} 个 ASN，删除后这些 ASN 将变为未分组。`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        onOk: doDelete,
      });
    } else {
      Modal.confirm({
        title: '确认删除分组',
        content: `确定删除分组「${groupName}」？`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        onOk: doDelete,
      });
    }
  };

  const handleDeleteASN = (asnId: string, asnName: string) => {
    if (checkASNInUse(asnName)) {
      Modal.warning({
        title: '无法删除',
        icon: <ExclamationCircleOutlined />,
        content: `ASN "${asnName}" 正在被 IP 段引用，无法删除。请先修改相关 IP 段的 ASN。`,
        okText: '知道了',
      });
      return;
    }
    Modal.confirm({
      title: '确认删除 ASN',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除 "${asnName}" 吗？此操作不可恢复。`,
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => {
        asnStorage.delete(asnId);
        setAsns(asnStorage.getAll());
        void saveConfigDataToFile();
        message.success('已删除');
      },
    });
  };

  const countryCellLine: CSSProperties = {
    fontSize: 12,
    lineHeight: 1.25,
    whiteSpace: 'nowrap',
  };

  const renderCountryUsageCell = (u?: { enabledAt?: string; blockedAt?: string } | null) => {
    if (!u?.enabledAt && !u?.blockedAt) {
      return <Text type="secondary">—</Text>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {u.enabledAt && (
          <div style={countryCellLine}>
            <Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>
              启用
            </Text>
            {u.enabledAt}
          </div>
        )}
        {u.blockedAt && (
          <div style={countryCellLine}>
            <Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>
              被墙
            </Text>
            {u.blockedAt}
          </div>
        )}
      </div>
    );
  };

  const countryTableColumns: ColumnsType<ASN> = BLOCKED_COUNTRY_OPTIONS.map(({ label, value }) => ({
    title: label,
    key: `country-${value}`,
    width: 134,
    render: (_: unknown, r: ASN) => renderCountryUsageCell(r.countryUsage?.[value as BlockedCountry]),
  }));

  const columns: ColumnsType<ASN> = [
    {
      title: 'ASN',
      dataIndex: 'name',
      key: 'name',
      width: 124,
      fixed: 'left',
      render: (name: string) => (
        <Tooltip title="点击复制到剪贴板">
          <Tag
            color={checkASNInUse(name) ? 'blue' : 'default'}
            style={{ fontWeight: 600, cursor: 'pointer', ...asnListTableTag }}
            onClick={() => void copyAsnToClipboard(name)}
          >
            {name}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 104,
      filterMultiple: false,
      filters: ASN_STATUS_OPTIONS.map((o) => ({ text: o.label, value: o.value })),
      onFilter: (value, record) => resolveAsnStatus(record) === value,
      render: (_: unknown, r: ASN) => {
        const s = resolveAsnStatus(r);
        const o = ASN_STATUS_OPTIONS.find((x) => x.value === s);
        return (
          <Tag color={o?.color} style={asnListTableTag}>
            {o?.label ?? s}
          </Tag>
        );
      },
    },
    {
      title: '月度费用（USD）',
      key: 'feeUsd',
      width: 124,
      align: 'right',
      render: (_: unknown, r: ASN) =>
        r.feeUsd != null && Number.isFinite(r.feeUsd) ? (
          <Text>${Number(r.feeUsd).toFixed(2)}</Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '购买日',
      key: 'purchaseDate',
      width: 120,
      render: (_: unknown, r: ASN) =>
        r.purchaseDate?.trim() ? (
          <Text style={{ whiteSpace: 'nowrap' }}>{r.purchaseDate}</Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '到期日',
      key: 'expiryDate',
      width: 126,
      render: (_: unknown, r: ASN) => {
        if (!r.expiryDate?.trim()) return <Text type="secondary">—</Text>;
        const past = isPastExpiry(r.expiryDate);
        return (
          <Tooltip title={past ? '已过到期日，不再计入月度费用合计' : '到期当日仍计入合计，翌日起不再计入'}>
            <Text type={past ? 'secondary' : undefined} style={{ whiteSpace: 'nowrap' }}>
              {r.expiryDate}
              {past ? <span style={{ marginLeft: 4, fontSize: 12 }}>（已过）</span> : null}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: '使用历程',
      key: 'usageHistory',
      width: 100,
      align: 'center',
      render: (_: unknown, r: ASN) => {
        const list = r.usageHistory;
        if (!list?.length) return <Text type="secondary">—</Text>;
        const lines = list
          .slice()
          .sort((a, b) => a.startDate.localeCompare(b.startDate))
          .map((h) => {
            const tail = h.endDate ? ` ~ ${h.endDate}` : ' ~ 至今';
            const rm = h.remark ? ` · ${h.remark}` : '';
            return `${h.startDate}${tail}${rm}`;
          });
        return (
          <Tooltip title={<div>{lines.map((ln, i) => <div key={i}>{ln}</div>)}</div>}>
            <Tag style={{ cursor: 'help', ...asnListTableTag }}>{list.length} 段</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '分组',
      dataIndex: 'asnGroupId',
      key: 'asnGroupId',
      width: 128,
      filterMultiple: false,
      filters: [
        { text: '未分组', value: '__none' },
        ...asnGroups.map((g) => ({ text: g.name, value: g.id })),
      ],
      onFilter: (value, record) => {
        if (value === '__none') return !record.asnGroupId;
        return record.asnGroupId === value;
      },
      render: (_: unknown, r: ASN) => {
        if (!r.asnGroupId) return <Text type="secondary">—</Text>;
        const g = asnGroups.find((x) => x.id === r.asnGroupId);
        if (g) {
          return (
            <Tag color="cyan" style={asnListTableTag}>
              {g.name}
            </Tag>
          );
        }
        return <Text type="secondary">引用的分组已删除</Text>;
      },
    },
    {
      title: '使用地区（可多）',
      key: 'usage',
      width: 228,
      render: (_, r) => {
        const ids = resolveUsageAreaIds(r);
        if (ids.length === 0) return <Text type="secondary">—</Text>;
        return (
          <Space wrap size={[8, 6]}>
            {ids.map((id) => {
              const a = usageAreas.find((x) => x.id === id);
              return a ? (
                <Tag key={id} style={usageAreaTagStyle(a.color)}>
                  {a.name}
                </Tag>
              ) : (
                <Tag key={id} style={asnListTableTag}>
                  {id}
                </Tag>
              );
            })}
          </Space>
        );
      },
    },
    {
      title: '配置地区',
      key: 'datacenter',
      width: 180,
      render: (_, r) =>
        r.datacenter && r.datacenter.length > 0 ? (
          <Space wrap size={[4, 4]}>
            {r.datacenter.map((dc) => (
              <Tag key={dc} color="cyan" style={asnListTableTag}>{dc}</Tag>
            ))}
          </Space>
        ) : <Text type="secondary">—</Text>,
    },
    {
      title: '项目组（可多）',
      key: 'pgs',
      width: 178,
      render: (_, r) =>
        r.projectGroupNames && r.projectGroupNames.length > 0 ? (
          <Space wrap size={[8, 6]}>
            {r.projectGroupNames.map((n) => (
              <Tag key={n} color="processing" style={asnListTableTag}>
                {n}
              </Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    ...countryTableColumns,
    {
      title: '操作',
      key: 'actions',
      width: 132,
      fixed: 'right',
      render: (_, r) =>
        canManageConfig ? (
          <Space size={14} wrap>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(r)}>
              编辑
            </Button>
            <Popconfirm
              title="确认删除"
              description={`删除「${r.name}」？`}
              onConfirm={() => handleDeleteASN(r.id, r.name)}
              okText="删除"
              okType="danger"
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <ConfigPageShell
      title="ASN"
      subtitle="列表默认按「ASN 分组」中的顺序排列（同组内按名称排序；未分组的行在最后）。费用统计规则：分组名为「ZEN-1月租用」「ZEN-2月租用」的 ASN 按自然月持续统计；其余分组或未分组的 ASN 仅在购买日所属自然月计 1 次月费（须填购买日），之后月份不再计入。顶部「月度费用合计」为本月口径下的应计之和；点击查看弹窗可查过往自然月汇总。可在分组弹窗中调整分组顺序。删除前请确保无 IP 段仍引用该 ASN。"
    >
      <Row justify="center">
        <Col xs={24} xl={24}>
          <Card
            title={
              <Space>
                <CheckCircleOutlined style={{ color: '#fa8c16', fontSize: 16 }} />
                <span style={{ fontSize: 16, fontWeight: 600 }}>ASN 列表</span>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  ({asns.length})
                </Text>
              </Space>
            }
            extra={
              <Space wrap align="center">
                <Button type="default" icon={<AppstoreOutlined />} onClick={() => setGroupModalOpen(true)}>
                  ASN 分组{asnGroups.length > 0 ? ` (${asnGroups.length})` : ''}
                </Button>
                {canManageConfig ? (
                  <>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      已选 {selectedRowKeys.length} 条
                    </Text>
                    <Button onClick={openBatchAdd}>批量增加</Button>
                    <Button onClick={openBatchEdit}>批量编辑</Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
                      添加 ASN
                    </Button>
                  </>
                ) : null}
              </Space>
            }
            style={{ width: '100%' }}
          >
            {/* ASN 搜索框：支持多值批量搜索（空格/逗号/换行分隔） */}
            <div style={{ marginBottom: 12 }}>
              <Input.TextArea
                value={asnSearchText}
                onChange={(e) => { setAsnSearchText(e.target.value); setAsnListPage(1); }}
                placeholder={'搜索 ASN，支持批量输入（空格/逗号/换行分隔），如：AS12345 AS67890'}
                autoSize={{ minRows: 1, maxRows: 4 }}
                allowClear
                style={{ fontFamily: 'monospace', fontSize: 13 }}
              />
              {asnSearchKeywords.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>
                  搜索 {asnSearchKeywords.length} 个关键词，命中 {asnDisplayList.length} / {asns.length} 条
                </div>
              )}
            </div>
            <Row gutter={[16, 12]} align="top" style={{ marginBottom: 8 }}>
              <Col xs={24} lg={9}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setMonthlyFeeDetailOpen(true)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      setMonthlyFeeDetailOpen(true);
                    }
                  }}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 8,
                    padding: '10px 12px',
                    border: '1px solid #f0f0f0',
                    background: '#fff',
                    outline: 'none',
                  }}
                >
                  <Statistic
                    title={<span>{currentMonthLabelZh} 月度费用合计（USD）</span>}
                    value={monthlyFeeSummary.total}
                    precision={2}
                    prefix={<span style={{ opacity: 0.85 }}>$</span>}
                  />
                  <Text type="secondary" style={{ fontSize: 12, marginTop: 6, display: 'block', lineHeight: 1.5 }}>
                    点击查看按月汇总的明细（ZEN 两分组按月；其它分组仅购买月计一次）
                  </Text>
                </div>
              </Col>
              <Col xs={24} sm={8} lg={5}>
                <Statistic title="本月计入 ASN 条数" value={monthlyFeeSummary.count} suffix="条" />
              </Col>
              <Col xs={24} lg={10}>
                <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.65, display: 'block' }}>
                  本月计入：月度费用大于 0、状态非「已取消」、且未到到期翌日。「ZEN-1月租用」「ZEN-2月租用」按月纳入；其余及未分组仅当本月为购买日所在自然月时才计入（须填购买日）。过往月份列表仅统计早于本月且月度合计大于 0 的自然月。
                </Text>
              </Col>
            </Row>
            <ConfigProvider
              theme={{
                components: {
                  Table: {
                    cellPaddingBlockSM: 10,
                    cellPaddingInlineSM: 14,
                    cellFontSizeSM: 15,
                  },
                },
              }}
            >
              <Table<ASN>
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={asnDisplayList}
                pagination={
                  asns.length > 0
                    ? {
                        current: asnListPage,
                        pageSize: asnListPageSize,
                        showSizeChanger: true,
                        pageSizeOptions: ['10', '20', '50', '100', '200'],
                        showTotal: (total) => `共 ${total} 条`,
                        onChange: (page, size) => {
                          setAsnListPage(page);
                          if (size && size !== asnListPageSize) {
                            setAsnListPageSize(size);
                          }
                        },
                        onShowSizeChange: (_current, size) => {
                          setAsnListPage(1);
                          setAsnListPageSize(size);
                        },
                      }
                    : false
                }
                scroll={{ x: 1980 }}
                locale={{ emptyText: <Empty description="暂无 ASN" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                rowSelection={
                  canManageConfig
                    ? {
                        selectedRowKeys,
                        onChange: (keys) => setSelectedRowKeys(keys),
                        preserveSelectedRowKeys: true,
                      }
                    : undefined
                }
              />
            </ConfigProvider>
          </Card>
        </Col>
      </Row>

      <Modal
        title={
          <Space>
            <CheckCircleOutlined style={{ color: '#fa8c16' }} />
            <span>{currentMonthLabelZh} · ASN 月度费用汇总</span>
          </Space>
        }
        open={monthlyFeeDetailOpen}
        onCancel={() => setMonthlyFeeDetailOpen(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setMonthlyFeeDetailOpen(false)}>
            关闭
          </Button>,
        ]}
        width={760}
        styles={{ body: { maxHeight: 'calc(100vh - 200px)', overflow: 'auto' } }}
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={24} sm={12}>
            <Statistic
              title={`${currentMonthLabelZh} 月度费用合计（USD）`}
              value={monthlyFeeSummary.total}
              precision={2}
              prefix={<span style={{ opacity: 0.85 }}>$</span>}
            />
          </Col>
          <Col xs={24} sm={12}>
            <Statistic title="本月计入 ASN 条数" value={monthlyFeeSummary.count} suffix="条" />
          </Col>
        </Row>
        <Divider orientation="left" plain style={{ margin: '12px 0 16px' }}>
          过往自然月（早于本月）
        </Divider>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 13, lineHeight: 1.65 }}>
          按当前 ASN 分组与日期回溯：分组为「ZEN-1月租用」「ZEN-2月租用」时，与购买～到期区间有交集的每个自然月各计一整月月费（未填购买日自最早回溯起算）。其余分组或未分组每条 ASN 仅在「购买日」所在自然月计 1 次，须提供购买日。
        </Text>
        {pastMonthlyRows.length > 0 ? (
          <Table<PastMonthFeeRow>
            size="small"
            rowKey="ym"
            columns={pastMonthFeeColumns}
            dataSource={pastMonthlyRows}
            pagination={{ pageSize: 12, showSizeChanger: true, hideOnSinglePage: true }}
            locale={{
              emptyText: <Empty description="暂无过往月份" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
            }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            styles={{ root: { margin: '24px 0' } }}
            description="暂无早于本月的计费月份（月度合计大于 0 时才列出；非 ZEN 分组须填购买日，且只在购买当月产生费用）"
          />
        )}
      </Modal>

      <Modal
        title={
          <Space>
            <AppstoreOutlined style={{ color: '#13c2c2' }} />
            <span>ASN 分组</span>
            <Text type="secondary" style={{ fontSize: 13 }}>
              ({asnGroups.length})
            </Text>
          </Space>
        }
        open={groupModalOpen}
        onCancel={() => setGroupModalOpen(false)}
        footer={[
          <Button key="close" type="primary" onClick={() => setGroupModalOpen(false)}>
            关闭
          </Button>,
        ]}
        width={640}
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflow: 'auto' } }}
        destroyOnClose={false}
      >
        {canManageConfig ? (
          <Form form={groupForm} layout="inline" onFinish={handleAddAsnGroup} style={{ marginBottom: 12 }}>
            <Form.Item
              name="name"
              rules={[{ required: true, message: '请输入分组名称' }]}
              style={{ marginBottom: 8 }}
            >
              <Input placeholder="新分组名称" style={{ minWidth: 200 }} allowClear maxLength={64} />
            </Form.Item>
            <Form.Item style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
                添加分组
              </Button>
            </Form.Item>
          </Form>
        ) : null}
        {canManageConfig && asnGroups.length > 1 ? (
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            排序将用于本页「分组」筛选项及添加/编辑 ASN 中的分组下拉顺序，使用「上移 / 下移」调整。
          </Text>
        ) : null}
        {asnGroups.length === 0 ? (
          <Empty
            description="暂无分组。可在此添加，再在「添加/编辑 ASN」中把多个 ASN 归到同组，列表中可按分组筛选。"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={6}>
            {asnGroups.map((g, index) => {
              const inGroup = getAsnCountInGroup(g.id);
              const last = index === asnGroups.length - 1;
              return (
                <div
                  key={g.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    background: '#fafafa',
                    borderRadius: 6,
                    border: '1px solid #f0f0f0',
                  }}
                >
                  <Space wrap>
                    <Tag
                      color={inGroup > 0 ? 'blue' : 'default'}
                      style={{ margin: 0, fontSize: 14, fontWeight: 600, padding: '4px 12px' }}
                    >
                      {g.name}
                    </Tag>
                    {inGroup > 0 && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {inGroup} 个 ASN
                      </Text>
                    )}
                  </Space>
                  {canManageConfig ? (
                    <Space size={0} wrap>
                      <Tooltip title="上移">
                        <Button
                          type="text"
                          size="small"
                          disabled={index === 0}
                          icon={<ArrowUpOutlined />}
                          aria-label="上移"
                          onClick={() => handleMoveAsnGroup(index, -1)}
                        />
                      </Tooltip>
                      <Tooltip title="下移">
                        <Button
                          type="text"
                          size="small"
                          disabled={last}
                          icon={<ArrowDownOutlined />}
                          aria-label="下移"
                          onClick={() => handleMoveAsnGroup(index, 1)}
                        />
                      </Tooltip>
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => handleEditAsnGroup(g.id, g.name)}
                        style={{ color: '#1890ff' }}
                      >
                        编辑
                      </Button>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => handleDeleteAsnGroup(g.id, g.name)}
                      >
                        删除
                      </Button>
                    </Space>
                  ) : null}
                </div>
              );
            })}
          </Space>
        )}
      </Modal>

      <Modal
        title={editingId ? '编辑 ASN' : '添加 ASN'}
        open={modalOpen}
        onCancel={closeModal}
        onOk={handleSubmit}
        width={720}
        destroyOnClose
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="name"
            label="ASN 号码"
            rules={[
              { required: true, message: '请输入 ASN' },
              {
                validator: (_, v) => {
                  const t = String(v || '').trim();
                  if (!t) return Promise.resolve();
                  const others = asnStorage.getAll().filter((a) => a.id !== editingId);
                  if (others.some((a) => a.name === t)) {
                    return Promise.reject(new Error(`ASN「${t}」已存在`));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="例如 AS12345" allowClear />
          </Form.Item>
          <Form.Item
            name="status"
            label="状态"
            rules={[{ required: true, message: '请选择状态' }]}
            initialValue="unused"
          >
            <Select
              options={ASN_STATUS_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="feeUsd" label="月度费用（美元）" extra="单位：USD，可选；仅大于 0 且本条未取消、未到到期翌日时计入本月度合计">
            <InputNumber
              min={0}
              step={0.01}
              precision={2}
              style={{ width: '100%' }}
              placeholder="0.00"
            />
          </Form.Item>
          <Form.Item
            name="purchaseDate"
            label="购买日"
            extra="ZEN-1月租用 / ZEN-2月租用 分组：用于按月回溯。其它分组或不分组：仅「购买日」所在月份会计入费用统计（须填写）"
          >
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="选择日期或留空" allowClear />
          </Form.Item>
          <Form.Item
            name="expiryDate"
            label="到期日"
            extra="可选。到期日当天仍计入月度合计；自到期日翌日起不再计入。留空表示不设到期。"
          >
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="选择日期或留空" allowClear />
          </Form.Item>
          <Form.Item name="asnGroupId" label="所属分组（可选）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="不选则不分组，需先点击列表右上角「ASN 分组」维护"
              options={asnGroups.map((g) => ({ label: g.name, value: g.id }))}
            />
          </Form.Item>
          <Form.Item name="usageAreaIds" label="使用地区（可多选）">
            <Select
              mode="multiple"
              placeholder="选择使用地区，需先在「配置管理 → 使用地区」中维护"
              allowClear
              showSearch
              optionFilterProp="label"
            >
              {usageAreas.map((area) => (
                <Select.Option key={area.id} value={area.id} label={area.name}>
                  <Tag style={usageAreaTagStyle(area.color)}>{area.name}</Tag>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            name="datacenter"
            label="配置地区"
            extra="机房所在运营商/地区，可多选，也可直接输入新值"
          >
            <Select
              mode="tags"
              allowClear
              placeholder="选择或输入配置地区，如：ZEN、首都在线、自建机房、Liasail"
              options={[
                { label: 'ZEN', value: 'ZEN' },
                { label: '首都在线', value: '首都在线' },
                { label: '自建机房', value: '自建机房' },
                { label: 'Liasail', value: 'Liasail' },
                { label: 'Timeweb', value: 'Timeweb' },
                { label: 'FDC', value: 'FDC' },
                { label: 'OWS', value: 'OWS' },
              ]}
            />
          </Form.Item>
          <Form.Item name="projectGroupNames" label="在哪些项目组使用（可多选）">
            <Select
              mode="multiple"
              placeholder="选择项目组，需先在「配置管理 → 项目组」中维护"
              allowClear
              showSearch
              optionFilterProp="label"
              options={projectGroupOptions.map((n) => ({ label: n, value: n }))}
            />
          </Form.Item>

          <Divider orientation="left" plain>
            使用历程（备案）
          </Divider>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
            按需记录使用该 ASN 的时间段，便于核对；不参与月度费用合计计算。
          </Text>
          <Form.List name="usageHistory">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                {fields.map(({ key, name, ...restField }) => (
                  <Card
                    key={key}
                    size="small"
                    bodyStyle={{ padding: 12 }}
                    extra={
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<MinusCircleOutlined />}
                        onClick={() => remove(name)}
                      >
                        删除
                      </Button>
                    }
                  >
                    <Form.Item {...restField} name={[name, 'id']} hidden>
                      <Input />
                    </Form.Item>
                    <Row gutter={[12, 0]}>
                      <Col xs={24} sm={8}>
                        <Form.Item
                          {...restField}
                          name={[name, 'startDate']}
                          label="开始日"
                          rules={[{ required: true, message: '请选择或使用删除移除此段' }]}
                        >
                          <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="必填" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} sm={8}>
                        <Form.Item {...restField} name={[name, 'endDate']} label="结束日（可选）">
                          <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="不填表示至今" />
                        </Form.Item>
                      </Col>
                      <Col xs={24} sm={8}>
                        <Form.Item {...restField} name={[name, 'remark']} label="备注（可选）">
                          <Input allowClear placeholder="简述" maxLength={200} />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Card>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ id: newUsageHistoryRowId() })}>
                  添加一段历程
                </Button>
              </Space>
            )}
          </Form.List>

          <Divider orientation="left" plain>
            伊朗、缅甸、土库曼、俄罗斯
          </Divider>
          <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 12 }}>
            分别填写该 ASN 在对应国家/地区的启用时间与被墙时间（可选，按日）
          </Text>
          <Row gutter={[12, 12]}>
            {BLOCKED_COUNTRY_OPTIONS.map(({ label, value }) => (
              <Col span={24} key={value}>
                <Card size="small" title={label} bodyStyle={{ padding: 12 }}>
                  <Row gutter={12}>
                    <Col xs={24} sm={12}>
                      <Form.Item name={['countryUsage', value, 'enabledAt']} label="启用时间">
                        <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="启用日期" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={12}>
                      <Form.Item name={['countryUsage', value, 'blockedAt']} label="被墙时间">
                        <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="被墙日期" />
                      </Form.Item>
                    </Col>
                  </Row>
                </Card>
              </Col>
            ))}
          </Row>
        </Form>
      </Modal>

      <Modal
        title="批量增加 ASN"
        open={batchAddOpen}
        onCancel={() => {
          setBatchAddOpen(false);
          batchAddForm.resetFields();
        }}
        onOk={handleBatchAdd}
        width={700}
        destroyOnClose
        okText="开始添加"
        cancelText="取消"
      >
        <Form form={batchAddForm} layout="vertical" style={{ marginTop: 4 }}>
          <Form.Item
            name="rawText"
            label="ASN 列表"
            rules={[{ required: true, message: '请至少输入一行 ASN' }]}
            extra="每行一个，或用逗号/分号/中文分号分隔；可写 AS123 或 123，统一记为 AS+数字。重复行或已存在则跳过"
          >
            <TextArea
              rows={9}
              placeholder={'例如：\nAS12345\n67890, AS11111 \n; 与上述格式相同'}
              showCount
              maxLength={20000}
            />
          </Form.Item>
          <Divider plain orientation="left" style={{ margin: '8px 0' }}>
            共同默认值（会应用到本批新 ASN；可选）
          </Divider>
          <Form.Item name="defaultStatus" label="默认状态" initialValue="unused">
            <Select
              options={ASN_STATUS_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="defaultFeeUsd" label="默认月度费用（美元）" extra="可选，留空则本批不设月度费用">
            <InputNumber min={0} step={0.01} precision={2} style={{ width: '100%' }} placeholder="0.00" />
          </Form.Item>
          <Form.Item
            name="defaultPurchaseDate"
            label="默认购买日"
            extra="可选，留空则本批不写入购买日"
          >
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="不选则留空" allowClear />
          </Form.Item>
          <Form.Item
            name="defaultExpiryDate"
            label="默认到期日"
            extra="可选，留空则本批不设到期日"
          >
            <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="不选则留空" allowClear />
          </Form.Item>
          <Form.Item name="asnGroupId" label="默认所属分组">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="不选则不分组"
              options={asnGroups.map((g) => ({ label: g.name, value: g.id }))}
            />
          </Form.Item>
          <Form.Item name="usageAreaIds" label="默认使用地区（可多选）">
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="不选则留空"
            >
              {usageAreas.map((area) => (
                <Select.Option key={area.id} value={area.id} label={area.name}>
                  <Tag style={usageAreaTagStyle(area.color)}>{area.name}</Tag>
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="projectGroupNames" label="默认项目组（可多选）">
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="不选则留空"
              options={projectGroupOptions.map((n) => ({ label: n, value: n }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="批量编辑 ASN"
        open={batchEditOpen}
        onCancel={() => {
          setBatchEditOpen(false);
          batchEditForm.resetFields();
        }}
        onOk={handleBatchEdit}
        width={640}
        destroyOnClose
        okText="应用"
        cancelText="取消"
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          目标范围二选一：① 在下方填写 ASN 列表（有内容时以列表为准，与表格是否勾选无关）；② 不填列表时在表格中勾选。再勾选要改哪些字段，未勾选的项不变；使用地区/项目组为整项替换，留空即清空；月度费用留空则清空已填月度费用；购买日/到期日勾选后留空则清空对应字段。
        </Text>
        <Form
          form={batchEditForm}
          layout="vertical"
          initialValues={{
            applyGroup: false,
            applyUsage: false,
            applyPgs: false,
            applyStatus: false,
            applyFee: false,
            applyPurchaseDate: false,
            applyExpiryDate: false,
            batchStatus: 'unused',
          }}
        >
          <Form.Item
            name="asnListText"
            label="通过 ASN 指定（可选）"
            extra="与批量增加相同的分隔方式。填写后只更新在库中匹配到的 ASN，未命中的会在保存时提示"
          >
            <TextArea
              rows={5}
              placeholder={'每行一个，或用逗号/分号分隔，例如：\nAS12345\nAS678'}
              showCount
              maxLength={20000}
            />
          </Form.Item>
          <Divider style={{ margin: '8px 0 12px' }} />
          <Form.Item name="applyGroup" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改所属分组</Checkbox>
          </Form.Item>
          {batchApplyGroup ? (
            <Form.Item
              name="batchAsnGroupId"
              label="新分组"
              extra="不选择表示取消分组"
              style={{ marginLeft: 24, marginBottom: 16 }}
            >
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="选择分组或清空以取消"
                options={asnGroups.map((g) => ({ label: g.name, value: g.id }))}
              />
            </Form.Item>
          ) : null}
          <Form.Item name="applyUsage" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改使用地区</Checkbox>
          </Form.Item>
          {batchApplyUsage ? (
            <Form.Item
              name="batchUsageAreaIds"
              label="使用地区"
              style={{ marginLeft: 24, marginBottom: 16 }}
            >
              <Select
                mode="multiple"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="留空则清空"
              >
                {usageAreas.map((area) => (
                  <Select.Option key={area.id} value={area.id} label={area.name}>
                    <Tag style={usageAreaTagStyle(area.color)}>{area.name}</Tag>
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          ) : null}
          <Form.Item name="applyPgs" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改项目组</Checkbox>
          </Form.Item>
          {batchApplyPgs ? (
            <Form.Item
              name="batchProjectGroupNames"
              label="项目组"
              style={{ marginLeft: 24, marginBottom: 16 }}
            >
              <Select
                mode="multiple"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="留空则清空"
                options={projectGroupOptions.map((n) => ({ label: n, value: n }))}
              />
            </Form.Item>
          ) : null}
          <Form.Item name="applyStatus" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改状态</Checkbox>
          </Form.Item>
          {batchApplyStatus ? (
            <Form.Item
              name="batchStatus"
              label="新状态"
              style={{ marginLeft: 24, marginBottom: 16 }}
            >
              <Select
                options={ASN_STATUS_OPTIONS.map((o) => ({ label: o.label, value: o.value }))}
                optionFilterProp="label"
              />
            </Form.Item>
          ) : null}
          <Form.Item name="applyFee" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改月度费用（美元）</Checkbox>
          </Form.Item>
          {batchApplyFee ? (
            <Form.Item
              name="batchFeeUsd"
              label="新月度费用"
              extra="留空将清空已填月度费用，单位：USD"
              style={{ marginLeft: 24, marginBottom: 16 }}
            >
              <InputNumber min={0} step={0.01} precision={2} style={{ width: '100%' }} placeholder="0.00" />
            </Form.Item>
          ) : null}
          <Form.Item name="applyPurchaseDate" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改购买日</Checkbox>
          </Form.Item>
          {batchApplyPurchaseDate ? (
            <Form.Item
              name="batchPurchaseDate"
              label="新购买日"
              extra="留空将清空已填购买日"
              style={{ marginLeft: 24, marginBottom: 16 }}
            >
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="留空则清空" allowClear />
            </Form.Item>
          ) : null}
          <Form.Item name="applyExpiryDate" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>修改到期日</Checkbox>
          </Form.Item>
          {batchApplyExpiryDate ? (
            <Form.Item
              name="batchExpiryDate"
              label="新到期日"
              extra="留空将清空已填到期日"
              style={{ marginLeft: 24, marginBottom: 0 }}
            >
              <DatePicker style={{ width: '100%' }} format="YYYY-MM-DD" placeholder="留空则清空" allowClear />
            </Form.Item>
          ) : null}
        </Form>
      </Modal>
    </ConfigPageShell>
  );
};

export default AsnConfigPage;
