import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Row, Col, Spin, Typography, Tag, Modal, Table, Space,
  Empty, Badge, Select, Tooltip, Button, message, Radio, DatePicker, Tabs,
} from 'antd';
import { SyncOutlined, PieChartOutlined, ReloadOutlined, CalendarOutlined } from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

// ─── 计费地区分类配置 ──────────────────────────────────────────────────────────

interface RegionCategory {
  key: string;
  label: string;
  color: string;
}

const REGION_CATEGORIES: RegionCategory[] = [
  { key: 'iran',         label: '伊朗',          color: '#eb2f96' },
  { key: 'myanmar',      label: '缅甸',          color: '#fa8c16' },
  { key: 'turkmenistan', label: '土库曼',        color: '#722ed1' },
  { key: 'russia',       label: '俄罗斯',        color: '#1677ff' },
  { key: 'pakistan',     label: '巴基斯坦',      color: '#52c41a' },
  { key: 'other_region', label: '其他计费地区',  color: '#13c2c2' },
  { key: 'no_region',    label: '未标记计费地区', color: '#faad14' },
];

const REGION_KEY_MAP: Record<string, string> = {
  '伊朗': 'iran',
  '缅甸': 'myanmar',
  '土库曼': 'turkmenistan',
  '俄罗斯': 'russia',
  '巴基斯坦': 'pakistan',
};

const PIE_COLORS = [
  '#1677ff', '#52c41a', '#eb2f96', '#fa8c16', '#722ed1',
  '#13c2c2', '#faad14', '#2f54eb', '#f5222d', '#a0d911',
];

function classifyByRegion(serverLocations: { supplier: string; region: string }[]): string {
  if (!serverLocations || serverLocations.length === 0) return 'no_region';
  const regions = serverLocations.map(l => l.region).filter(Boolean);
  if (regions.length === 0) return 'no_region';
  for (const region of regions) {
    const key = REGION_KEY_MAP[region];
    if (key) return key;
  }
  return 'other_region';
}

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface SliceData {
  key: string;
  label: string;
  color: string;
  count: number;
  segments: any[];
  percentage: number;
}

// 来自 /api/ipxo/services-list 的每条记录类型
interface IpxoServiceItem {
  segment: string;
  address: string;
  cidr: number;
  status: string;
  nextDueDate: number | null;
  recurringAmount: number | null;
  renewalStatus: string | null;
  renewalDate: string | null;
  purchaseDate: string | null;
  remark: string;
  projectGroups: string[];
  monthlyPrice: number | null;
  supplier: string;
  serverLocations: { supplier: string; region: string }[];
  [key: string]: any;
}

type TimeFilter = 'all' | 'day' | 'week' | 'month' | 'custom';

function getLastWeekRange(): [Dayjs, Dayjs] {
  const today = dayjs();
  // dayjs().day(): 0=周日, 1=周一, …, 6=周六
  const daysFromMon = today.day() === 0 ? 6 : today.day() - 1;
  const thisMonday = today.subtract(daysFromMon, 'day').startOf('day');
  return [thisMonday.subtract(7, 'day'), thisMonday.subtract(1, 'day').endOf('day')];
}

function isInTimeRange(purchaseDate: string | null, filter: TimeFilter, range: [Dayjs, Dayjs] | null): boolean {
  if (filter === 'all') return true;
  // 无购买日期的段不参与时间过滤（始终显示）
  if (!purchaseDate) return true;
  const date = dayjs(purchaseDate);
  if (filter === 'day') {
    const yesterday = dayjs().subtract(1, 'day');
    return !date.isBefore(yesterday.startOf('day')) && !date.isAfter(yesterday.endOf('day'));
  }
  if (filter === 'week') {
    const [mon, sun] = getLastWeekRange();
    return !date.isBefore(mon) && !date.isAfter(sun);
  }
  if (filter === 'month') {
    const start = dayjs().subtract(1, 'month').startOf('month');
    const end = dayjs().subtract(1, 'month').endOf('month');
    return !date.isBefore(start) && !date.isAfter(end);
  }
  if (filter === 'custom' && range) {
    return !date.isBefore(range[0].startOf('day')) && !date.isAfter(range[1].endOf('day'));
  }
  return true;
}

// ─── 简易饼图（SVG） ──────────────────────────────────────────────────────────

interface PieChartProps {
  data: SliceData[];
  size?: number;
  onSliceClick: (slice: SliceData) => void;
}

const SimplePieChart: React.FC<PieChartProps> = ({ data, size = 260, onSliceClick }) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 20;
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <Empty description="暂无数据" />;

  let startAngle = -Math.PI / 2;
  const slices = data.filter(d => d.count > 0).map(d => {
    const angle = (d.count / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const midAngle = startAngle + angle / 2;
    const lx = cx + (r * 0.65) * Math.cos(midAngle);
    const ly = cy + (r * 0.65) * Math.sin(midAngle);
    const slice = { ...d, x1, y1, x2, y2, largeArc, lx, ly, startAngle, endAngle };
    startAngle = endAngle;
    return slice;
  });

  return (
    <svg width={size} height={size} style={{ display: 'block', margin: '0 auto', cursor: 'pointer' }}>
      {slices.map(s => {
        const isHovered = hoveredKey === s.key;
        const scale = isHovered ? 1.05 : 1;
        return (
          <g key={s.key}
            style={{ transform: `scale(${scale})`, transformOrigin: `${cx}px ${cy}px`, transition: 'transform 0.15s' }}
            onClick={() => onSliceClick(s)}
            onMouseEnter={() => setHoveredKey(s.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <path
              d={`M ${cx} ${cy} L ${s.x1} ${s.y1} A ${r} ${r} 0 ${s.largeArc} 1 ${s.x2} ${s.y2} Z`}
              fill={s.color}
              opacity={isHovered ? 1 : 0.88}
              stroke="#fff"
              strokeWidth={2}
            />
            {s.count / total > 0.06 && (
              <text x={s.lx} y={s.ly} textAnchor="middle" dominantBaseline="middle"
                fill="#fff" fontSize={11} fontWeight={600} pointerEvents="none">
                {s.count}
              </text>
            )}
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={r * 0.38} fill="#fff" />
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize={18} fontWeight={700} fill="#333">{total}</text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize={11} fill="#999">个IP段</text>
    </svg>
  );
};

// ─── 树状图（矩形树图 Treemap） ───────────────────────────────────────────────

interface TreemapProps {
  data: SliceData[];
  width?: number;
  height?: number;
  onSliceClick: (slice: SliceData) => void;
}

function squarify(items: SliceData[], x: number, y: number, w: number, h: number) {
  interface Rect { key: string; x: number; y: number; w: number; h: number; slice: SliceData }
  const total = items.reduce((s, d) => s + d.count, 0);
  if (total === 0 || items.length === 0) return [] as Rect[];
  const rects: Rect[] = [];
  let cx = x, cy = y, cw = w, ch = h;
  let remaining = [...items];
  while (remaining.length > 0) {
    const item = remaining.shift()!;
    const mw = remaining.reduce((s, d) => s + d.count, 0);
    if (cw >= ch) {
      const bw = (item.count / (item.count + mw)) * cw;
      const bh = ch;
      rects.push({ key: item.key, x: cx, y: cy, w: bw, h: bh, slice: item });
      cx += bw;
      cw -= bw;
    } else {
      const bh = (item.count / (item.count + mw)) * ch;
      const bw = cw;
      rects.push({ key: item.key, x: cx, y: cy, w: bw, h: bh, slice: item });
      cy += bh;
      ch -= bh;
    }
  }
  return rects;
}

const SimpleTreemap: React.FC<TreemapProps> = ({ data, width = 480, height = 300, onSliceClick }) => {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const filtered = data.filter(d => d.count > 0).sort((a, b) => b.count - a.count);
  const rects = squarify(filtered, 0, 0, width, height);
  if (filtered.length === 0) return <Empty description="暂无数据" />;

  return (
    <svg width={width} height={height} style={{ display: 'block', cursor: 'pointer' }}>
      {rects.map(rect => {
        const isHovered = hoveredKey === rect.key;
        return (
          <g key={rect.key}
            onClick={() => onSliceClick(rect.slice)}
            onMouseEnter={() => setHoveredKey(rect.key)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <rect
              x={rect.x + 1} y={rect.y + 1}
              width={Math.max(rect.w - 2, 0)} height={Math.max(rect.h - 2, 0)}
              fill={rect.slice.color}
              opacity={isHovered ? 1 : 0.82}
              rx={4}
            />
            {rect.w > 50 && rect.h > 28 && (
              <>
                <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 - 8}
                  textAnchor="middle" fill="#fff" fontSize={Math.min(13, rect.w / 7)}
                  fontWeight={600} pointerEvents="none">
                  {rect.slice.label}
                </text>
                <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2 + 10}
                  textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize={11} pointerEvents="none">
                  {rect.slice.count} 个 · {rect.slice.percentage.toFixed(1)}%
                </text>
              </>
            )}
            {(rect.w <= 50 || rect.h <= 28) && rect.w > 20 && rect.h > 14 && (
              <text x={rect.x + rect.w / 2} y={rect.y + rect.h / 2}
                textAnchor="middle" dominantBaseline="middle"
                fill="#fff" fontSize={10} pointerEvents="none">
                {rect.slice.count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

// ─── 饼图卡片（含局部多选筛选） ──────────────────────────────────────────────────

interface ChartCardProps {
  title: React.ReactNode;
  allSlices: SliceData[];          // 未经局部筛选的全量切片
  chartType: 'pie' | 'treemap';
  onSliceClick: (s: SliceData) => void;
  renderLegend: (slices: SliceData[]) => React.ReactNode;
  // 可筛选的维度
  filterDims: {
    key: string;
    placeholder: string;
    options: { label: string; value: string }[];
    /** 给定一个段数组和已选值列表，返回是否保留 */
    match: (seg: any, selected: string[]) => boolean;
  }[];
  extra?: React.ReactNode;
  style?: React.CSSProperties;
  emptyText?: string;
}

const ChartCard: React.FC<ChartCardProps> = ({
  title, allSlices, chartType, onSliceClick, renderLegend,
  filterDims, extra, style, emptyText,
}) => {
  // 每个维度的已选值，key → string[]
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  const hasFilter = filterDims.some(d => (selected[d.key] || []).length > 0);

  // 对每个 slice 的 segments 应用局部筛选
  const filteredSlices: SliceData[] = (() => {
    if (!hasFilter) return allSlices;
    const result: SliceData[] = [];
    let total = 0;
    // 先算 filtered segments
    const withSegs = allSlices.map(slice => {
      const segs = slice.segments.filter(seg =>
        filterDims.every(d => {
          const sel = selected[d.key] || [];
          return sel.length === 0 || d.match(seg, sel);
        })
      );
      total += segs.length;
      return { ...slice, segs };
    });
    withSegs.forEach(s => {
      if (s.segs.length === 0) return;
      result.push({
        key: s.key, label: s.label, color: s.color,
        count: s.segs.length, segments: s.segs,
        percentage: total > 0 ? (s.segs.length / total) * 100 : 0,
      });
    });
    return result;
  })();

  const filterBar = (
    <Space size={6} wrap>
      {filterDims.map(d => (
        <Select
          key={d.key}
          mode="multiple"
          allowClear
          placeholder={d.placeholder}
          size="small"
          style={{ minWidth: 130, maxWidth: 240 }}
          value={selected[d.key] || []}
          onChange={v => setSelected(prev => ({ ...prev, [d.key]: v }))}
          options={d.options}
          maxTagCount="responsive"
          getPopupContainer={() => document.body}
        />
      ))}
      <Button
        size="small"
        onClick={() => setSelected({})}
        style={{ visibility: hasFilter ? 'visible' : 'hidden' }}
      >
        清除
      </Button>
    </Space>
  );

  return (
    <Card
      title={title}
      size="small"
      style={style}
      extra={
        <Space size={8}>
          {filterBar}
          {extra}
        </Space>
      }
    >
      {filteredSlices.length === 0 ? (
        <Empty description={emptyText || '暂无数据'} style={{ padding: '40px 0' }} />
      ) : chartType === 'pie' ? (
        <SimplePieChart data={filteredSlices} size={280} onSliceClick={onSliceClick} />
      ) : (
        <SimpleTreemap data={filteredSlices} width={500} height={260} onSliceClick={onSliceClick} />
      )}
      {filteredSlices.length > 0 && renderLegend(filteredSlices)}
    </Card>
  );
};

// ─── 主组件 ───────────────────────────────────────────────────────────────────

const IPSegmentStats: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [servicesList, setServicesList] = useState<IpxoServiceItem[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [allLocalSegments, setAllLocalSegments] = useState<any[]>([]);

  // IP段详情弹窗
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalSegments, setModalSegments] = useState<IpxoServiceItem[]>([]);
  const [purchaseModalVisible, setPurchaseModalVisible] = useState(false);
  const [purchaseModalTitle, setPurchaseModalTitle] = useState('');
  const [purchaseModalSegments, setPurchaseModalSegments] = useState<any[]>([]);

  // 供应商分布弹窗（IPXO 专项）
  const [supplierModalVisible, setSupplierModalVisible] = useState(false);

  // 全量可筛选列表弹窗
  const [listModalOpen, setListModalOpen] = useState(false);
  const [listModalTitle, setListModalTitle] = useState('');
  const [listModalBase, setListModalBase] = useState<any[]>([]);
  const [listFilterSupplier, setListFilterSupplier] = useState('');
  const [listFilterStatus, setListFilterStatus] = useState('');

  // ── 全局图表筛选（多选） ──────────────────────────────────────────────────────
  const [gfSuppliers, setGfSuppliers] = useState<string[]>([]);    // 供应商多选
  const [gfRegions, setGfRegions] = useState<string[]>([]);         // 计费地区多选
  const [gfProjects, setGfProjects] = useState<string[]>([]);       // 项目组多选
  const [purchaseRegionFilter, setPurchaseRegionFilter] = useState<string[]>([]); // 购买统计地区筛选
  const [purchaseCustomRange, setPurchaseCustomRange] = useState<[Dayjs, Dayjs] | null>(null); // 自定义时间区间

  const openListModal = (title: string, segments: any[]) => {
    setListModalTitle(title);
    setListModalBase(segments);
    setListFilterSupplier('');
    setListFilterStatus('');
    setListModalOpen(true);
  };

  // 图表类型
  const [chartType, setChartType] = useState<'pie' | 'treemap'>('pie');
  const [statsTab, setStatsTab] = useState<'distribution' | 'purchase'>('distribution');

  // 时间筛选
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [ipxoRes, localRes] = await Promise.all([
        fetch('/api/ipxo/services-list'),
        fetch('/api/get-data'),
      ]);
      const ipxoJson = ipxoRes.ok ? await ipxoRes.json() : {};
      setServicesList(ipxoJson?.data || []);
      setCachedAt(ipxoJson?.cachedAt || null);
      const localJson = localRes.ok ? await localRes.json() : {};
      setAllLocalSegments(localJson?.ipSegments || []);
    } catch (e: any) {
      console.error('加载数据失败:', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/ipxo/cache/refresh', { method: 'POST' });
      const json = res.ok ? await res.json() : {};
      if (json.success) {
        message.success(`同步完成，共 ${json.servicesCount ?? '?'} 个 IP 段`);
        await loadData();
      } else {
        message.error(json.message || '同步失败');
      }
    } catch (e: any) {
      message.error('同步失败：' + e.message);
    } finally {
      setSyncing(false);
    }
  }, [loadData]);

  // ── 时间过滤 ─────────────────────────────────────────────────────────────────

  const filteredList = (timeFilter === 'all')
    ? servicesList
    : servicesList.filter(s => isInTimeRange(s.purchaseDate, timeFilter, customRange));

  // ── 数据处理 ─────────────────────────────────────────────────────────────────

  const todayStr = new Date().toISOString().slice(0, 10);

  // ── 全量供应商（本地 ip-data.json，含所有供应商）────────────────────────────
  const localFiltered = (timeFilter === 'all')
    ? allLocalSegments
    : allLocalSegments.filter(s => isInTimeRange(s.purchaseDate, timeFilter, customRange));

  // ── 全局图表筛选：从所有段中收集可选项 ────────────────────────────────────────
  // 供应商：IPXO API + 本地非IPXO
  const allSuppliersSet = new Set<string>();
  filteredList.forEach(s => allSuppliersSet.add(String(s.supplier ?? '').trim() || '未知供应商'));
  localFiltered.filter(s => String(s.supplier ?? '').trim() !== 'IPXO').forEach(s => allSuppliersSet.add(String(s.supplier ?? '').trim() || '未知供应商'));
  const gfSupplierOptions = Array.from(allSuppliersSet).sort().map(v => ({ label: v, value: v }));

  // 计费地区：只有 IPXO 有此字段
  const allRegionsSet = new Set<string>();
  filteredList.forEach(s => (s.serverLocations || []).forEach((l: any) => { if (l.region) allRegionsSet.add(l.region); }));
  const gfRegionOptions = Array.from(allRegionsSet).sort().map(v => ({ label: v, value: v }));

  // 项目组：所有段
  const allProjectsSet = new Set<string>();
  filteredList.forEach(s => (s.projectGroups || []).forEach((g: string) => allProjectsSet.add(g)));
  localFiltered.forEach(s => (s.projectGroups || []).forEach((g: string) => allProjectsSet.add(g)));
  const gfProjectOptions = Array.from(allProjectsSet).sort().map(v => ({ label: v, value: v }));

  const gfActive = gfSuppliers.length > 0 || gfRegions.length > 0 || gfProjects.length > 0;

  // 通用筛选函数：对任意段数组应用全局筛选
  const applyGf = (segs: any[]): any[] => {
    if (!gfActive) return segs;
    return segs.filter(s => {
      if (gfSuppliers.length > 0) {
        const sup = String(s.supplier ?? '').trim() || '未知供应商';
        if (!gfSuppliers.includes(sup)) return false;
      }
      if (gfRegions.length > 0) {
        const regions = (s.serverLocations || []).map((l: any) => l.region).filter(Boolean);
        if (!gfRegions.some(r => regions.includes(r))) return false;
      }
      if (gfProjects.length > 0) {
        const projs = s.projectGroups || [];
        if (!gfProjects.some(p => projs.includes(p))) return false;
      }
      return true;
    });
  };

  // 非 IPXO 供应商：仅取本地数据中 supplier !== 'IPXO' 的段
  const nonIpxoFiltered = applyGf(localFiltered.filter(s => String(s.supplier ?? '').trim() !== 'IPXO'));
  const nonIpxoActive = nonIpxoFiltered.filter(s =>
    s.renewalStatus !== 'cancelled' && !s.cancellationDate
  );
  const nonIpxoCancelledPending = nonIpxoFiltered.filter(s =>
    (s.renewalStatus === 'cancelled' || s.cancellationDate) && s.renewalDate && s.renewalDate > todayStr
  );
  const nonIpxoRented = [...nonIpxoActive, ...nonIpxoCancelledPending];

  // IPXO status 是"是否在租"的权威依据：缓存里 status=active 的段都算当前在租
  // 本地 renewalStatus 仅表示用户意图，不影响 IPXO 实际计费
  const ipxoRented = applyGf(filteredList.filter(s => !s.status || s.status === 'active'));
  const ipxoTotal = ipxoRented.length; // 与官网一致

  // 按本地用户意图细分：
  const activeSegs = ipxoRented.filter(s => s.renewalStatus !== 'cancelled');
  const localCancelledSegs = ipxoRented.filter(s => s.renewalStatus === 'cancelled');
  // 本地已取消且续费日未到 → 即将生效（正常流程）
  const cancelledPendingSegs = localCancelledSegs.filter(s => s.renewalDate && s.renewalDate > todayStr);
  // 本地已取消且续费日已过 → 可能已被 IPXO 续费、本地未同步
  const cancelledExpiredSegs = localCancelledSegs.filter(s => !s.renewalDate || s.renewalDate <= todayStr);

  // 按计费地区分类
  const categoryMap: Record<string, IpxoServiceItem[]> = {};
  REGION_CATEGORIES.forEach(c => { categoryMap[c.key] = []; });

  activeSegs.forEach(seg => {
    const catKey = classifyByRegion(seg.serverLocations || []);
    categoryMap[catKey].push(seg);
  });

  const noRegionSegs = categoryMap['no_region'];
  const withRegionSegs = activeSegs.filter(s => (s.serverLocations || []).length > 0 &&
    (s.serverLocations || []).some((l: any) => l.region));

  // 按供应商分组（在用 IP 段）
  const supplierMap = new Map<string, IpxoServiceItem[]>();
  activeSegs.forEach(seg => {
    const key = String(seg.supplier ?? '').trim() || '未知供应商';
    if (!supplierMap.has(key)) supplierMap.set(key, []);
    supplierMap.get(key)!.push(seg);
  });
  const supplierBreakdown = Array.from(supplierMap.entries())
    .map(([supplier, segs], i) => ({
      supplier,
      count: segs.length,
      segs,
      percentage: activeSegs.length > 0 ? (segs.length / activeSegs.length) * 100 : 0,
      color: PIE_COLORS[i % PIE_COLORS.length],
    }))
    .sort((a, b) => b.count - a.count);
  const supplierSlices: SliceData[] = supplierBreakdown.map(s => ({
    key: s.supplier, label: s.supplier, color: s.color,
    count: s.count, segments: s.segs, percentage: s.percentage,
  }));

  // ── 全量供应商饼图数据（当前租用 = 正常 + 已取消未到期）────────────────────────
  // IPXO 用 API 数据（权威），非 IPXO 用本地数据
  // 全量当前租用：IPXO API 在租段 + 非IPXO本地在租段
  const allRentedSegs: any[] = [...ipxoRented, ...nonIpxoRented];
  const allRentedTotal = allRentedSegs.length;
  const allRentedMap = new Map<string, any[]>();
  allRentedSegs.forEach(seg => {
    const key = (seg.supplier as string)?.trim() || '未知供应商';
    if (!allRentedMap.has(key)) allRentedMap.set(key, []);
    allRentedMap.get(key)!.push(seg);
  });
  const allRentedBreakdown = Array.from(allRentedMap.entries())
    .map(([supplier, segs], i) => ({
      supplier, count: segs.length, segs,
      percentage: allRentedTotal > 0 ? (segs.length / allRentedTotal) * 100 : 0,
      color: PIE_COLORS[i % PIE_COLORS.length],
    }))
    .sort((a, b) => b.count - a.count);
  const allRentedBySupplierSlices: SliceData[] = allRentedBreakdown.map(s => ({
    key: s.supplier, label: s.supplier, color: s.color,
    count: s.count, segments: s.segs, percentage: s.percentage,
  }));

  // 全量在用：IPXO activeSegs（未取消）+ 非IPXO local active
  const allActiveSegs: any[] = [...activeSegs, ...nonIpxoActive];
  const allActiveTotal = allActiveSegs.length;
  // 全量已标记计费地区：allActiveSegs 中有 serverLocations.region 的段，按地区分组
  const allRegionMap = new Map<string, any[]>();
  allActiveSegs.forEach(seg => {
    const regions: string[] = (seg.serverLocations || []).map((l: any) => l.region).filter(Boolean);
    const dedupedRegions = Array.from(new Set(regions));
    if (dedupedRegions.length === 0) return;
    dedupedRegions.forEach(r => {
      if (!allRegionMap.has(r)) allRegionMap.set(r, []);
      allRegionMap.get(r)!.push(seg);
    });
  });
  const allRegionBreakdown = Array.from(allRegionMap.entries())
    .map(([region, segs], i) => ({
      region, count: segs.length, segs,
      percentage: allActiveTotal > 0 ? (segs.length / allActiveTotal) * 100 : 0,
      color: PIE_COLORS[i % PIE_COLORS.length],
    }))
    .sort((a, b) => b.count - a.count);
  const allRegionSlices: SliceData[] = allRegionBreakdown.map(s => ({
    key: s.region, label: s.region, color: s.color,
    count: s.count, segments: s.segs, percentage: s.percentage,
  }));

  // ── 已租用IP段分布（全量：在用 + 已取消待生效）───────────────────────────────
  const overviewSlices: SliceData[] = [
    ...REGION_CATEGORIES.filter(c => c.key !== 'no_region').map(cat => ({
      key: cat.key, label: cat.label, color: cat.color,
      count: categoryMap[cat.key].length,
      segments: categoryMap[cat.key],
      percentage: ipxoTotal > 0 ? (categoryMap[cat.key].length / ipxoTotal) * 100 : 0,
    })),
    {
      key: 'no_region', label: '未标记计费地区', color: '#faad14',
      count: noRegionSegs.length, segments: noRegionSegs,
      percentage: ipxoTotal > 0 ? (noRegionSegs.length / ipxoTotal) * 100 : 0,
    },
    {
      key: 'cancelled_pending', label: '已取消（待生效）', color: '#ff7875',
      count: cancelledPendingSegs.length, segments: cancelledPendingSegs,
      percentage: ipxoTotal > 0 ? (cancelledPendingSegs.length / ipxoTotal) * 100 : 0,
    },
    {
      key: 'cancelled_overdue', label: '本地取消但IPXO续费', color: '#cf1322',
      count: cancelledExpiredSegs.length, segments: cancelledExpiredSegs,
      percentage: ipxoTotal > 0 ? (cancelledExpiredSegs.length / ipxoTotal) * 100 : 0,
    },
  ].filter(s => s.count > 0);

  // ── 已标记计费地区的在用 IP 段分布 ──────────────────────────────────────────
  const usageSlices: SliceData[] = REGION_CATEGORIES
    .filter(c => c.key !== 'no_region')
    .map(cat => ({
      key: cat.key, label: cat.label, color: cat.color,
      count: categoryMap[cat.key].length,
      segments: categoryMap[cat.key],
      percentage: withRegionSegs.length > 0 ? (categoryMap[cat.key].length / withRegionSegs.length) * 100 : 0,
    }))
    .filter(s => s.count > 0);

  // ── 按项目组 × 时间段购买统计 ───────────────────────────────────────────────

  const COUNTRY_LABEL: Record<string, string> = {
    iran: '伊朗', myanmar: '缅甸', turkmenistan: '土库曼', russia: '俄罗斯', pakistan: '巴基斯坦',
  };

  function getPurchasePeriod(label: 'day' | 'week' | 'month'): [string, string] {
    const d = dayjs();
    if (label === 'day') {
      const yd = d.subtract(1, 'day');
      return [yd.format('YYYY-MM-DD'), yd.format('YYYY-MM-DD')];
    }
    if (label === 'week') {
      const [mon, sun] = getLastWeekRange();
      return [mon.format('YYYY-MM-DD'), sun.format('YYYY-MM-DD')];
    }
    // month
    const start = d.subtract(1, 'month').startOf('month');
    const end = d.subtract(1, 'month').endOf('month');
    return [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
  }

  interface PeriodStat {
    label: string;
    range: [string, string];
    segs: any[];
  }

  const PERIOD_DEFS: { key: 'day' | 'week' | 'month'; label: string }[] = [
    { key: 'day',   label: '昨天' },
    { key: 'week',  label: '上周' },
    { key: 'month', label: '上个月' },
  ];

  // 全量（IPXO API + 非IPXO本地），用于购买统计
  // 注意：这里不套 gfActive 过滤，购买统计用原始全量数据
  const allSegsForPurchase: any[] = [
    ...servicesList.filter(s => !s.status || s.status === 'active'),
    ...allLocalSegments.filter(s => String(s.supplier ?? '').trim() !== 'IPXO'),
  ];

  const periodStats: (PeriodStat & { byProject: Map<string, any[]> })[] = PERIOD_DEFS.map(({ key, label }) => {
    const [from, to] = getPurchasePeriod(key);
    const segs = allSegsForPurchase.filter(s => {
      if (!s.purchaseDate) return false;
      if (s.purchaseDate < from || s.purchaseDate > to) return false;
      if (purchaseRegionFilter.length > 0) {
        const regions = (s.serverLocations || []).map((l: any) => l.region).filter(Boolean);
        if (!purchaseRegionFilter.some(r => regions.includes(r))) return false;
      }
      return true;
    });
    const byProject = new Map<string, any[]>();
    segs.forEach(seg => {
      const projs: string[] = seg.projectGroups?.length ? seg.projectGroups : ['未分配项目组'];
      projs.forEach(p => {
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p)!.push(seg);
      });
    });
    return { label, range: [from, to], segs, byProject };
  });

  const customPeriodStat: (PeriodStat & { byProject: Map<string, any[]> }) | null = (() => {
    if (!purchaseCustomRange) return null;
    const from = purchaseCustomRange[0].format('YYYY-MM-DD');
    const to   = purchaseCustomRange[1].format('YYYY-MM-DD');
    const label = `${purchaseCustomRange[0].format('MM/DD')} ~ ${purchaseCustomRange[1].format('MM/DD')}`;
    const segs = allSegsForPurchase.filter(s => {
      if (!s.purchaseDate) return false;
      if (s.purchaseDate < from || s.purchaseDate > to) return false;
      if (purchaseRegionFilter.length > 0) {
        const regions = (s.serverLocations || []).map((l: any) => l.region).filter(Boolean);
        if (!purchaseRegionFilter.some(r => regions.includes(r))) return false;
      }
      return true;
    });
    const byProject = new Map<string, any[]>();
    segs.forEach(seg => {
      const projs: string[] = seg.projectGroups?.length ? seg.projectGroups : ['未分配项目组'];
      projs.forEach(p => {
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p)!.push(seg);
      });
    });
    return { label, range: [from, to], segs, byProject };
  })();

  const allPeriodStats = customPeriodStat
    ? [...periodStats, customPeriodStat]
    : periodStats;

  const purchaseRegionOpts = Array.from(new Set(
    allSegsForPurchase.flatMap(s => (s.serverLocations || []).map((l: any) => l.region).filter(Boolean))
  )).sort().map(v => ({ label: v, value: v }));

  // ── ChartCard 局部筛选维度定义 ────────────────────────────────────────────────

  const supplierOpts = Array.from(new Set(allRentedSegs.map(s => String(s.supplier ?? '').trim() || '未知供应商'))).sort().map(v => ({ label: v, value: v }));
  const regionOpts = Array.from(new Set(
    [...allRentedSegs, ...activeSegs].flatMap(s => (s.serverLocations || []).map((l: any) => l.region).filter(Boolean))
  )).sort().map(v => ({ label: v, value: v }));
  const projectOpts = Array.from(new Set(
    [...allRentedSegs, ...activeSegs].flatMap(s => s.projectGroups || [])
  )).sort().map(v => ({ label: v, value: v }));

  const matchSupplier = (seg: any, sel: string[]) => sel.includes(String(seg.supplier ?? '').trim() || '未知供应商');
  const matchRegion   = (seg: any, sel: string[]) => (seg.serverLocations || []).some((l: any) => sel.includes(l.region));
  const matchProject  = (seg: any, sel: string[]) => (seg.projectGroups || []).some((p: string) => sel.includes(p));

  const openModal = (slice: SliceData) => {
    setModalTitle(`${slice.label}（${slice.count} 个 IP 段）`);
    setModalSegments(slice.segments);
    setModalVisible(true);
  };

  const openPurchaseModal = (title: string, segs: any[]) => {
    setPurchaseModalTitle(title);
    setPurchaseModalSegments(segs);
    setPurchaseModalVisible(true);
  };

  // ── 购买统计弹窗表格列（含被墙信息）──────────────────────────────────────────
  const purchaseModalColumns = [
    {
      title: 'IP 段', dataIndex: 'segment', key: 'segment', width: 160,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '供应商', dataIndex: 'supplier', key: 'supplier', width: 110,
      render: (v: string) => v || <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: '项目组', dataIndex: 'projectGroups', key: 'projectGroups', width: 160,
      render: (v: string[]) => (
        <Space size={2} wrap>
          {(v || []).map((g: string) => <Tag key={g} style={{ fontSize: 11 }}>{g}</Tag>)}
        </Space>
      ),
    },
    {
      title: '月费', dataIndex: 'monthlyPrice', key: 'monthlyPrice', width: 88, align: 'right' as const,
      render: (v: number) => v != null ? <span style={{ fontWeight: 600 }}>${Number(v).toFixed(2)}</span> : '-',
    },
    {
      title: '计费地区', key: 'serverLocations', width: 180,
      render: (_: any, r: any) => {
        const locs = (r.serverLocations || []).filter((l: any) => l.region);
        if (locs.length === 0) return <span style={{ color: '#ccc' }}>-</span>;
        return (
          <Space size={4} wrap>
            {locs.map((l: any, i: number) => <Tag key={i} color="green" style={{ fontSize: 11 }}>{l.region}</Tag>)}
          </Space>
        );
      },
    },
    {
      title: '被墙信息', key: 'blocked', width: 220,
      render: (_: any, r: any) => {
        const blocked: string[] = r.blockedCountries || [];
        const detected: string[] = r.detectedCountries || [];
        if (blocked.length === 0 && detected.length === 0) {
          return <span style={{ color: '#bbb', fontSize: 12 }}>未检测</span>;
        }
        const clean = detected.filter(c => !blocked.includes(c));
        return (
          <Space size={2} wrap>
            {blocked.map(c => (
              <Tag key={c} color="red" style={{ fontSize: 11 }}>{COUNTRY_LABEL[c] || c} · 被墙</Tag>
            ))}
            {clean.map(c => (
              <Tag key={c} color="success" style={{ fontSize: 11 }}>{COUNTRY_LABEL[c] || c} · 可用</Tag>
            ))}
          </Space>
        );
      },
    },
  ];

  // ── 弹窗表格列 ──────────────────────────────────────────────────────────────

  const modalColumns = [
    {
      title: 'IP 段', dataIndex: 'segment', key: 'segment', width: 160,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '供应商', dataIndex: 'supplier', key: 'supplier', width: 120,
      render: (v: string) => v || <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: '计费地区', key: 'serverLocations', width: 200,
      render: (_: any, r: IpxoServiceItem) => {
        const locs = (r.serverLocations || []).filter(l => l.region);
        if (locs.length === 0) return <span style={{ color: '#ccc' }}>-</span>;
        return (
          <Space size={4} wrap>
            {locs.map((l, i) => <Tag key={i} color="green" style={{ fontSize: 11 }}>{l.region}</Tag>)}
          </Space>
        );
      },
    },
    {
      title: '项目组', dataIndex: 'projectGroups', key: 'projectGroups',
      render: (v: string[]) => (
        <Space size={2} wrap>
          {(v || []).map(g => <Tag key={g} style={{ fontSize: 11 }}>{g}</Tag>)}
        </Space>
      ),
    },
    {
      title: '月费', dataIndex: 'monthlyPrice', key: 'monthlyPrice', width: 90, align: 'right' as const,
      render: (v: number) => v != null ? <span style={{ fontWeight: 600 }}>${Number(v).toFixed(2)}</span> : '-',
    },
    {
      title: '购买日', dataIndex: 'purchaseDate', key: 'purchaseDate', width: 110,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-',
    },
    {
      title: '续费日', dataIndex: 'renewalDate', key: 'renewalDate', width: 110,
      render: (v: string) => v ? (
        <Tooltip title={`${dayjs(v).diff(dayjs(), 'day')} 天后`}>
          <Tag color={dayjs(v).diff(dayjs(), 'day') <= 7 ? 'red' : dayjs(v).diff(dayjs(), 'day') <= 14 ? 'orange' : 'default'}>
            {v}
          </Tag>
        </Tooltip>
      ) : '-',
    },
    {
      title: '续费状态', dataIndex: 'renewalStatus', key: 'renewalStatus', width: 100,
      render: (v: string) => {
        const map: Record<string, { label: string; color: string }> = {
          not_renewed: { label: '待续费', color: 'default' },
          renewed: { label: '已续费', color: 'green' },
          cancelled: { label: '已取消', color: 'orange' },
          refunded: { label: '已退款', color: 'blue' },
        };
        const info = map[v] || { label: v || '-', color: 'default' };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
  ];

  // ── 渲染辅助：图例 ───────────────────────────────────────────────────────────

  const renderLegend = (slices: SliceData[]) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 12 }}>
      {slices.map(s => (
        <Space key={s.key} size={4} style={{ cursor: 'pointer' }} onClick={() => openModal(s)}>
          <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: s.color }} />
          <Text style={{ fontSize: 12 }}>{s.label}</Text>
          <Badge count={s.count} style={{ backgroundColor: s.color }} showZero />
          <Text type="secondary" style={{ fontSize: 11 }}>{s.percentage.toFixed(1)}%</Text>
        </Space>
      ))}
    </div>
  );

  // ── 时间筛选标签文本 ─────────────────────────────────────────────────────────

  const timeFilterLabel = (() => {
    if (timeFilter === 'all') return '全部时间';
    if (timeFilter === 'day') return `昨天（${dayjs().subtract(1, 'day').format('YYYY-MM-DD')}）`;
    if (timeFilter === 'week') {
      const [mon, sun] = getLastWeekRange();
      return `上周（${mon.format('MM/DD')} ~ ${sun.format('MM/DD')}）`;
    }
    if (timeFilter === 'month') return `上个月（${dayjs().subtract(1, 'month').format('YYYY年M月')}）`;
    return customRange ? `${customRange[0].format('YYYY-MM-DD')} ~ ${customRange[1].format('YYYY-MM-DD')}` : '自定义';
  })();

  // ── 渲染 ────────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* 页头 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Space direction="vertical" size={4}>
            <Space>
              <PieChartOutlined style={{ fontSize: 18, color: '#1677ff' }} />
              <Title level={4} style={{ margin: 0 }}>IP 段分布统计</Title>
              <Text type="secondary" style={{ fontSize: 13 }}>
                全量 IP 段统计（含所有供应商）/ IPXO 计费地区分布
              </Text>
            </Space>
            {cachedAt && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                IPXO 数据来自缓存：<strong>{dayjs(cachedAt).format('YYYY-MM-DD HH:mm')}</strong>
                <span style={{ marginLeft: 8, color: '#8c8c8c' }}>
                  如与官网数量不符，请点击右上角「同步官网数据」
                </span>
              </Text>
            )}

            {/* 图表筛选条 */}
            <Space wrap style={{ marginTop: 4 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>图表筛选：</Text>
              <Select
                mode="multiple"
                allowClear
                placeholder="按供应商筛选"
                size="small"
                style={{ minWidth: 160, maxWidth: 320 }}
                value={gfSuppliers}
                onChange={setGfSuppliers}
                options={gfSupplierOptions}
                maxTagCount="responsive"
              />
              {gfRegionOptions.length > 0 && (
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="按计费地区筛选"
                  size="small"
                  style={{ minWidth: 160, maxWidth: 280 }}
                  value={gfRegions}
                  onChange={setGfRegions}
                  options={gfRegionOptions}
                  maxTagCount="responsive"
                />
              )}
              {gfProjectOptions.length > 0 && (
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="按项目组筛选"
                  size="small"
                  style={{ minWidth: 160, maxWidth: 280 }}
                  value={gfProjects}
                  onChange={setGfProjects}
                  options={gfProjectOptions}
                  maxTagCount="responsive"
                />
              )}
              {gfActive && (
                <Button
                  size="small"
                  onClick={() => { setGfSuppliers([]); setGfRegions([]); setGfProjects([]); }}
                >
                  清除筛选
                </Button>
              )}
              {gfActive && (
                <Text type="secondary" style={{ fontSize: 11, color: '#1677ff' }}>
                  · 图表已按筛选项过滤
                </Text>
              )}
            </Space>
          </Space>

          <Space>
            <Button
              icon={<SyncOutlined spin={syncing} />}
              loading={syncing}
              onClick={handleSync}
              type="primary"
              ghost
            >
              同步官网数据
            </Button>
            <span
              onClick={loadData}
              style={{ cursor: 'pointer', color: '#1677ff', display: 'flex', alignItems: 'center', gap: 4, fontSize: 14 }}
            >
              <ReloadOutlined spin={loading} /> 刷新
            </span>
          </Space>
        </div>
      </Card>

      <Spin spinning={loading}>
        <Tabs
          activeKey={statsTab}
          onChange={k => setStatsTab(k as 'distribution' | 'purchase')}
          size="small"
          style={{ marginBottom: 8 }}
          items={[
            { key: 'distribution', label: 'IP段分布' },
            { key: 'purchase',     label: '购买统计' },
          ]}
        />

        {statsTab === 'distribution' && (<>
        {/* 购买时间 + 图表类型 控制栏 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <Space wrap>
            <CalendarOutlined style={{ color: '#8c8c8c' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>购买时间：</Text>
            <Radio.Group
              value={timeFilter}
              onChange={e => { setTimeFilter(e.target.value); if (e.target.value !== 'custom') setCustomRange(null); }}
              size="small"
            >
              <Radio.Button value="all">全部</Radio.Button>
              <Radio.Button value="day">昨天</Radio.Button>
              <Radio.Button value="week">上周</Radio.Button>
              <Radio.Button value="month">上个月</Radio.Button>
              <Radio.Button value="custom">自定义</Radio.Button>
            </Radio.Group>
            {timeFilter === 'custom' && (
              <RangePicker
                size="small"
                value={customRange}
                onChange={val => setCustomRange(val ? [val[0]!, val[1]!] : null)}
              />
            )}
            {timeFilter !== 'all' && (
              <Text type="secondary" style={{ fontSize: 11, color: '#1677ff' }}>
                · 已按 <strong>{timeFilterLabel}</strong> 购买日筛选，共 {filteredList.length} 条
              </Text>
            )}
          </Space>
          <Select
            value={chartType}
            onChange={setChartType}
            style={{ width: 110 }}
            size="small"
            options={[
              { label: '饼图', value: 'pie' },
              { label: '树状图', value: 'treemap' },
            ]}
          />
        </div>
        {/* 总览统计卡片 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          {([
            { title: '当前租用 IP 段', value: allRentedTotal, color: undefined, onClickFn: () => openListModal(`当前租用 IP 段（${allRentedTotal} 个）`, allRentedSegs), hint: '查看明细 →' },
            { title: '  在用', value: allActiveTotal, color: '#52c41a', onClickFn: () => openListModal(`在用 IP 段（${allActiveTotal} 个）`, allActiveSegs), hint: '查看明细 →' },
            { title: '  待取消生效', value: nonIpxoCancelledPending.length + cancelledPendingSegs.length, color: '#ff7875', onClickFn: () => openListModal(`待取消生效（${nonIpxoCancelledPending.length + cancelledPendingSegs.length} 个）`, [...nonIpxoCancelledPending, ...cancelledPendingSegs]), hint: '查看明细 →' },
            { title: '月费合计（在用）', value: `$${allActiveSegs.reduce((s: number, seg: any) => s + (seg.monthlyPrice || 0), 0).toFixed(2)}`, color: undefined },
            { title: 'IPXO 在租', value: ipxoTotal, color: '#1677ff', onClickFn: () => setSupplierModalVisible(true), hint: '按供应商 →' },
            { title: '  已标记计费地区', value: withRegionSegs.length, color: '#1677ff', onClickFn: () => openListModal(`已标记计费地区（${withRegionSegs.length} 个）`, withRegionSegs), hint: '查看明细 →' },
            { title: '  未标记计费地区', value: noRegionSegs.length, color: '#faad14', onClickFn: () => openListModal(`未标记计费地区（${noRegionSegs.length} 个）`, noRegionSegs), hint: '查看明细 →' },
            { title: '⚠ 本地取消但IPXO续费', value: cancelledExpiredSegs.length, color: '#ff4d4f', onClickFn: () => openListModal(`本地取消但IPXO续费（${cancelledExpiredSegs.length} 个）`, cancelledExpiredSegs), hint: '查看明细 →' },
          ] as { title: string; value: number | string; color?: string; onClickFn?: () => void; hint?: string }[]).map((item, i) => (
            <Col span={3} key={i}>
              <Card
                size="small"
                hoverable={!!item.onClickFn}
                onClick={item.onClickFn}
                styles={{ body: { padding: '12px 16px' } }}
                style={item.onClickFn ? { cursor: 'pointer' } : undefined}
              >
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                  {item.title}
                  {item.hint && <span style={{ marginLeft: 4, fontSize: 11, color: '#1677ff' }}>{item.hint}</span>}
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: item.color || '#333' }}>{item.value}</div>
              </Card>
            </Col>
          ))}
        </Row>

        <Row gutter={16} style={{ marginBottom: 16 }}>
          {/* 全量：当前租用 IP 段分布（按供应商） */}
          <Col xs={24} lg={12}>
            <ChartCard
              title={<Space>全量IP段分布（按供应商）<Tag color="default">{allRentedTotal} 个</Tag></Space>}
              allSlices={allRentedBySupplierSlices}
              chartType={chartType}
              onSliceClick={openModal}
              renderLegend={renderLegend}
              filterDims={[
                { key: 'supplier', placeholder: '按供应商', options: supplierOpts, match: matchSupplier },
                { key: 'region',   placeholder: '按计费地区', options: regionOpts,   match: matchRegion   },
                { key: 'project',  placeholder: '按项目组',   options: projectOpts,  match: matchProject  },
              ]}
            />
          </Col>

          {/* 全量：已标记计费地区 IP 段分布 */}
          <Col xs={24} lg={12}>
            <ChartCard
              title={<Space>全量IP段分布（按计费地区）<Tag color="green">{allRegionSlices.reduce((s, r) => s + r.count, 0)} 个</Tag></Space>}
              allSlices={allRegionSlices}
              chartType={chartType}
              onSliceClick={openModal}
              renderLegend={renderLegend}
              filterDims={[
                { key: 'supplier', placeholder: '按供应商', options: supplierOpts, match: matchSupplier },
                { key: 'region',   placeholder: '按计费地区', options: regionOpts,   match: matchRegion   },
                { key: 'project',  placeholder: '按项目组',   options: projectOpts,  match: matchProject  },
              ]}
              emptyText="暂无已标记计费地区的在用 IP 段"
            />
          </Col>
        </Row>

        {/* 分类详情卡片 */}
        <Row gutter={16}>
          {REGION_CATEGORIES.filter(c => c.key !== 'no_region').map(cat => {
            const segs = categoryMap[cat.key];
            if (segs.length === 0) return null;
            const total = segs.length;
            const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
            const isKnownCountry = ['iran', 'myanmar', 'turkmenistan', 'russia', 'pakistan'].includes(cat.key);
            const blockedCount   = isKnownCountry ? segs.filter(s => (s.blockedCountries  || []).includes(cat.key)).length : 0;
            const availableCount = isKnownCountry ? segs.filter(s =>
              (s.detectedCountries || []).includes(cat.key) && !(s.blockedCountries || []).includes(cat.key)
            ).length : 0;
            const untestedCount  = isKnownCountry ? segs.filter(s =>
              !(s.detectedCountries || []).includes(cat.key) && !(s.blockedCountries || []).includes(cat.key)
            ).length : 0;
            return (
              <Col xs={24} sm={12} xl={8} key={cat.key} style={{ marginBottom: 16 }}>
                <Card
                  size="small"
                  title={
                    <Space>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: cat.color }} />
                      {cat.label}
                      <Badge count={segs.length} style={{ backgroundColor: cat.color }} />
                    </Space>
                  }
                  extra={
                    <span style={{ fontSize: 12, color: '#1677ff', cursor: 'pointer' }}
                      onClick={() => openModal({ key: cat.key, label: cat.label, color: cat.color, count: segs.length, segments: segs, percentage: 0 })}>
                      查看全部 →
                    </span>
                  }
                  style={{ minHeight: 180 }}
                >
                  {/* 被墙统计 */}
                  {isKnownCountry && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      <Tag color="success" style={{ fontSize: 11 }}>可用 {availableCount} 个 · {pct(availableCount)}</Tag>
                      {blockedCount > 0 && <Tag color="red" style={{ fontSize: 11 }}>被墙 {blockedCount} 个 · {pct(blockedCount)}</Tag>}
                      {untestedCount > 0 && <Tag color="orange" style={{ fontSize: 11 }}>未检测 {untestedCount} 个 · {pct(untestedCount)}</Tag>}
                    </div>
                  )}
                  <div style={{ maxHeight: 110, overflowY: 'auto' }}>
                    {segs.slice(0, 6).map((seg, idx) => {
                      const regions = (seg.serverLocations || []).map((l: any) => l.region).filter(Boolean);
                      return (
                        <div key={seg.segment || idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                          <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{seg.segment}</span>
                          <Space size={2}>
                            {regions.map((r: string, i: number) => (
                              <Tag key={i} color="green" style={{ fontSize: 10, margin: 0 }}>{r}</Tag>
                            ))}
                          </Space>
                        </div>
                      );
                    })}
                    {segs.length > 6 && (
                      <Text type="secondary" style={{ fontSize: 11 }}>...还有 {segs.length - 6} 个</Text>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}

          {/* 未标记计费地区 */}
          {noRegionSegs.length > 0 && (
            <Col xs={24} sm={12} xl={8} style={{ marginBottom: 16 }}>
              <Card
                size="small"
                title={
                  <Space>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#faad14' }} />
                    未标记计费地区
                    <Badge count={noRegionSegs.length} style={{ backgroundColor: '#faad14' }} />
                  </Space>
                }
                extra={
                  <span style={{ fontSize: 12, color: '#1677ff', cursor: 'pointer' }}
                    onClick={() => openModal({ key: 'no_region', label: '未标记计费地区', color: '#faad14', count: noRegionSegs.length, segments: noRegionSegs, percentage: 0 })}>
                    查看全部 →
                  </span>
                }
                style={{ minHeight: 180 }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {noRegionSegs.length} 个在用 IP 段未设置计费地区。
                </Text>
                <div style={{ maxHeight: 80, overflowY: 'auto', marginTop: 8 }}>
                  {noRegionSegs.slice(0, 4).map((seg, idx) => (
                    <div key={seg.segment || idx} style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                      {seg.segment}
                    </div>
                  ))}
                  {noRegionSegs.length > 4 && (
                    <Text type="secondary" style={{ fontSize: 11 }}>...还有 {noRegionSegs.length - 4} 个</Text>
                  )}
                </div>
              </Card>
            </Col>
          )}

          {/* 已取消·待生效 */}
          {cancelledPendingSegs.length > 0 && (
            <Col xs={24} sm={12} xl={8} style={{ marginBottom: 16 }}>
              <Card
                size="small"
                title={
                  <Space>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#ff7875' }} />
                    已取消·待生效
                    <Badge count={cancelledPendingSegs.length} style={{ backgroundColor: '#ff7875' }} />
                  </Space>
                }
                extra={
                  <span style={{ fontSize: 12, color: '#1677ff', cursor: 'pointer' }}
                    onClick={() => openModal({ key: 'cancelled_pending', label: '已取消·待生效', color: '#ff7875', count: cancelledPendingSegs.length, segments: cancelledPendingSegs, percentage: 0 })}>
                    查看全部 →
                  </span>
                }
                style={{ minHeight: 180 }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {cancelledPendingSegs.length} 个 IP 段已标记取消续费，但续费日尚未到期，仍处于使用中。
                </Text>
                <div style={{ maxHeight: 80, overflowY: 'auto', marginTop: 8 }}>
                  {cancelledPendingSegs.slice(0, 4).map((seg, idx) => (
                    <div key={seg.segment || idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{seg.segment}</span>
                      <Tag color="orange" style={{ fontSize: 11 }}>{seg.renewalDate}</Tag>
                    </div>
                  ))}
                  {cancelledPendingSegs.length > 4 && (
                    <Text type="secondary" style={{ fontSize: 11 }}>...还有 {cancelledPendingSegs.length - 4} 个</Text>
                  )}
                </div>
              </Card>
            </Col>
          )}
        </Row>
        </>)}

        {statsTab === 'purchase' && (<>
        {/* ── 按项目组购买统计（昨天 / 上周 / 上月） ── */}
        <Card
          title={<Space><span>按项目组购买统计</span><Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>昨天 / 上周 / 上月新购IP段数量、费用与地区情况</Text></Space>}
          size="small"
          style={{ marginTop: 16 }}
          extra={
            <Space size={8} wrap>
              <RangePicker
                size="small"
                value={purchaseCustomRange}
                onChange={v => setPurchaseCustomRange(v as [Dayjs, Dayjs] | null)}
                allowClear
                placeholder={['自定义开始', '自定义结束']}
                style={{ width: 220 }}
              />
              <Select
                mode="multiple"
                allowClear
                placeholder="按计费地区筛选"
                value={purchaseRegionFilter}
                onChange={setPurchaseRegionFilter}
                options={purchaseRegionOpts}
                style={{ minWidth: 180 }}
                size="small"
                maxTagCount="responsive"
                getPopupContainer={() => document.body}
              />
            </Space>
          }
        >
          <Row gutter={16}>
            {allPeriodStats.map(period => {
              const allProjects = Array.from(period.byProject.keys()).sort();
              return (
                <Col xs={24} lg={customPeriodStat ? 12 : 8} xl={customPeriodStat ? 6 : 8} key={period.label} style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#1677ff' }}>
                      {period.label}
                      <Text type="secondary" style={{ fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
                        {period.range[0] === period.range[1] ? period.range[0] : `${period.range[0]} ~ ${period.range[1]}`}
                      </Text>
                      <Tag style={{ marginLeft: 8 }}>{period.segs.length} 个</Tag>
                      <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
                        ${period.segs.reduce((s, seg) => s + (seg.monthlyPrice || 0), 0).toFixed(2)}/月
                      </Text>
                    </div>
                    {period.segs.length > 0 && (
                      <Text
                        style={{ fontSize: 12, color: '#1677ff', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        onClick={() => openPurchaseModal(
                          `${period.label} · 全部新购（${period.segs.length} 个）`,
                          period.segs,
                        )}
                      >
                        查看全部 →
                      </Text>
                    )}
                  </div>

                  {period.segs.length === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>该时间段内无新购IP段</Text>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {allProjects.map(proj => {
                        const pSegs = period.byProject.get(proj)!;
                        const total = pSegs.length;
                        const fee = pSegs.reduce((s, seg) => s + (seg.monthlyPrice || 0), 0);
                        const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';

                        // 计费地区：去重统计每个段在哪些 region
                        const regionStats: Record<string, { count: number; fee: number; segs: any[] }> = {};
                        // 被墙：blockedCountries 包含该 countryKey
                        const blockedStats: Record<string, { count: number; fee: number; segs: any[] }> = {};
                        // 未检测：有 region 对应的 countryKey，但既不在 blockedCountries 也不在 detectedCountries
                        const untestedStats: Record<string, { count: number; fee: number; segs: any[] }> = {};

                        pSegs.forEach(seg => {
                          const blocked: string[] = seg.blockedCountries || [];
                          const detected: string[] = seg.detectedCountries || [];
                          const price = seg.monthlyPrice || 0;
                          const seenRegions = new Set<string>();
                          (seg.serverLocations || []).forEach((l: any) => {
                            if (!l.region || seenRegions.has(l.region)) return;
                            seenRegions.add(l.region);
                            if (!regionStats[l.region]) regionStats[l.region] = { count: 0, fee: 0, segs: [] };
                            regionStats[l.region].count++;
                            regionStats[l.region].fee += price;
                            regionStats[l.region].segs.push(seg);
                            const ck = REGION_KEY_MAP[l.region];
                            if (ck && !blocked.includes(ck) && !detected.includes(ck)) {
                              if (!untestedStats[l.region]) untestedStats[l.region] = { count: 0, fee: 0, segs: [] };
                              untestedStats[l.region].count++;
                              untestedStats[l.region].fee += price;
                              untestedStats[l.region].segs.push(seg);
                            }
                          });
                          const seenBlocked = new Set<string>();
                          blocked.forEach(c => {
                            if (seenBlocked.has(c)) return;
                            seenBlocked.add(c);
                            if (!blockedStats[c]) blockedStats[c] = { count: 0, fee: 0, segs: [] };
                            blockedStats[c].count++;
                            blockedStats[c].fee += price;
                            blockedStats[c].segs.push(seg);
                          });
                        });

                        const regionEntries = Object.entries(regionStats).sort((a, b) => b[1].count - a[1].count);
                        const blockedEntries = Object.entries(blockedStats).sort((a, b) => b[1].count - a[1].count);
                        const untestedEntries = Object.entries(untestedStats).sort((a, b) => b[1].count - a[1].count);

                        const renderStatRow = (
                          label: string,
                          entries: [string, { count: number; fee: number; segs: any[] }][],
                          color: string,
                          labelFn: (k: string) => string,
                          titleFn: (k: string) => string,
                          emptyText?: string,
                        ) => {
                          const LABEL_W = 72;
                          if (entries.length === 0) return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
                              <span style={{ width: LABEL_W, flexShrink: 0, fontSize: 12, color: '#888', textAlign: 'right' }}>{label}</span>
                              <span style={{ fontSize: 12, color: '#bbb' }}>{emptyText ?? '无'}</span>
                            </div>
                          );
                          return (
                            <div style={{ marginTop: 5 }}>
                              {entries.map(([k, { count, fee: eFee, segs: kSegs }], idx) => (
                                <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                  <span style={{ width: LABEL_W, flexShrink: 0, fontSize: 12, color: '#888', textAlign: 'right' }}>
                                    {idx === 0 ? label : ''}
                                  </span>
                                  <Tag
                                    color={color}
                                    style={{ fontSize: 12, margin: 0, cursor: 'pointer', minWidth: 90 }}
                                    onClick={() => openPurchaseModal(
                                      `${proj} · ${period.label} · ${titleFn(k)}（${count} 个）`,
                                      kSegs,
                                    )}
                                  >
                                    {labelFn(k)} ×{count}
                                  </Tag>
                                  <span style={{ fontSize: 12, color: '#1677ff', fontWeight: 600, whiteSpace: 'nowrap' }}>${eFee.toFixed(2)}</span>
                                  <span style={{ fontSize: 12, color: '#595959', whiteSpace: 'nowrap' }}>{pct(count)}</span>
                                </div>
                              ))}
                            </div>
                          );
                        };

                        return (
                          <div key={proj} style={{
                            background: '#fafafa', borderRadius: 6,
                            padding: '10px 14px', border: '1px solid #e8e8e8',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <Text
                                strong
                                style={{ fontSize: 14, cursor: 'pointer', color: '#1677ff' }}
                                onClick={() => openPurchaseModal(`${proj} · ${period.label}（${total} 个）`, pSegs)}
                              >
                                {proj}
                              </Text>
                              <Space size={8}>
                                <Tag color="blue" style={{ fontSize: 12 }}>{total} 个</Tag>
                                <Text style={{ fontSize: 13, color: '#1677ff', fontWeight: 600 }}>${fee.toFixed(2)}/月</Text>
                              </Space>
                            </div>

                            {renderStatRow('计费地区：', regionEntries, 'green', k => k, k => `计费地区 ${k}`, '暂无标记')}
                            {renderStatRow('被墙情况：', blockedEntries, 'red', k => COUNTRY_LABEL[k] || k, k => `被墙 ${COUNTRY_LABEL[k] || k}`, '无')}
                            {renderStatRow('未检测：', untestedEntries, 'orange', k => k, k => `未检测 ${k}`, '无')}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Col>
              );
            })}
          </Row>
        </Card>
        </>)}
      </Spin>

      {/* IP段详情弹窗 */}
      <Modal
        title={modalTitle}
        open={modalVisible}
        onCancel={() => setModalVisible(false)}
        footer={null}
        width={1100}
      >
        <div style={{ marginBottom: 12, display: 'flex', gap: 24, alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            月费合计：<Text strong style={{ color: '#1677ff' }}>
              ${modalSegments.reduce((s, seg) => s + (seg.monthlyPrice || 0), 0).toFixed(2)}
            </Text>
          </Text>
          <Text type="secondary" style={{ fontSize: 13 }}>
            共 {modalSegments.length} 个 IP 段
          </Text>
        </div>
        <Table
          dataSource={modalSegments}
          columns={modalColumns}
          rowKey="segment"
          size="small"
          scroll={{ x: 1000, y: 480 }}
          pagination={false}
        />
      </Modal>

      {/* 购买统计弹窗 */}
      <Modal
        title={purchaseModalTitle}
        open={purchaseModalVisible}
        onCancel={() => setPurchaseModalVisible(false)}
        footer={null}
        width={1000}
      >
        <div style={{ marginBottom: 12, display: 'flex', gap: 24, alignItems: 'center' }}>
          <Text type="secondary" style={{ fontSize: 13 }}>
            月费合计：<Text strong style={{ color: '#1677ff' }}>
              ${purchaseModalSegments.reduce((s, seg) => s + (seg.monthlyPrice || 0), 0).toFixed(2)}
            </Text>
          </Text>
          <Text type="secondary" style={{ fontSize: 13 }}>
            共 {purchaseModalSegments.length} 个 IP 段
          </Text>
        </div>
        <Table
          dataSource={purchaseModalSegments}
          columns={purchaseModalColumns}
          rowKey="segment"
          size="small"
          scroll={{ x: 920, y: 480 }}
          pagination={false}
        />
      </Modal>

      {/* 供应商分布弹窗 */}
      <Modal
        title={`在用 IP 段 · 按供应商分布（共 ${activeSegs.length} 个）`}
        open={supplierModalVisible}
        onCancel={() => setSupplierModalVisible(false)}
        footer={null}
        width={820}
      >
        <Row gutter={24} align="middle">
          <Col xs={24} sm={10} style={{ textAlign: 'center' }}>
            <SimplePieChart
              data={supplierSlices}
              size={240}
              onSliceClick={s => {
                setSupplierModalVisible(false);
                openModal(s);
              }}
            />
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
              点击扇形查看该供应商的 IP 段列表
            </Text>
          </Col>
          <Col xs={24} sm={14}>
            <Table
              dataSource={supplierBreakdown}
              rowKey="supplier"
              size="small"
              pagination={false}
              onRow={row => ({
                style: { cursor: 'pointer' },
                onClick: () => {
                  setSupplierModalVisible(false);
                  openModal({ key: row.supplier, label: row.supplier, color: row.color, count: row.count, segments: row.segs, percentage: row.percentage });
                },
              })}
              columns={[
                {
                  title: '供应商', dataIndex: 'supplier', key: 'supplier',
                  render: (v: string, row: typeof supplierBreakdown[0]) => (
                    <Space>
                      <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: row.color }} />
                      <span>{v}</span>
                    </Space>
                  ),
                },
                {
                  title: 'IP段数量', dataIndex: 'count', key: 'count', width: 90, align: 'right' as const,
                  render: (v: number, row: typeof supplierBreakdown[0]) => (
                    <Space>
                      <span style={{ fontWeight: 700, color: row.color }}>{v}</span>
                      <span style={{ fontSize: 11, color: '#999' }}>个</span>
                    </Space>
                  ),
                },
                {
                  title: '占比', key: 'pct', width: 100,
                  render: (_: any, row: typeof supplierBreakdown[0]) => (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        height: 8, width: `${Math.max(row.percentage, 4)}%`,
                        background: row.color, borderRadius: 4, maxWidth: 80, minWidth: 4,
                      }} />
                      <span style={{ fontSize: 12 }}>{row.percentage.toFixed(1)}%</span>
                    </div>
                  ),
                },
                {
                  title: '月费小计', key: 'fee', width: 100, align: 'right' as const,
                  render: (_: any, row: typeof supplierBreakdown[0]) => {
                    const total = row.segs.reduce((s, seg) => s + (seg.monthlyPrice || 0), 0);
                    return <span style={{ fontWeight: 600 }}>${total.toFixed(2)}</span>;
                  },
                },
              ]}
            />
          </Col>
        </Row>
      </Modal>

      {/* 全量可筛选 IP 段列表弹窗 */}
      {(() => {
        const suppliers = Array.from(new Set(listModalBase.map((s: any) => String(s.supplier ?? '').trim() || '未知供应商'))).sort() as string[];
        const statuses = Array.from(new Set(listModalBase.map((s: any) => s.renewalStatus || '').filter(Boolean))) as string[];
        const listFiltered = listModalBase.filter((s: any) => {
          if (listFilterSupplier && (String(s.supplier ?? '').trim() || '未知供应商') !== listFilterSupplier) return false;
          if (listFilterStatus && s.renewalStatus !== listFilterStatus) return false;
          return true;
        });
        const totalFee = listFiltered.reduce((sum: number, s: any) => sum + (s.monthlyPrice || 0), 0);
        const statusLabelMap: Record<string, { label: string; color: string }> = {
          not_renewed: { label: '待续费', color: 'default' },
          renewed:     { label: '已续费', color: 'green'   },
          cancelled:   { label: '已取消', color: 'orange'  },
          refunded:    { label: '已退款', color: 'blue'    },
        };
        return (
          <Modal
            title={listModalTitle}
            open={listModalOpen}
            onCancel={() => setListModalOpen(false)}
            footer={null}
            width={1100}
            destroyOnClose
          >
            <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <Space>
                <Text type="secondary" style={{ fontSize: 13 }}>供应商：</Text>
                <Select
                  style={{ width: 180 }}
                  size="small"
                  value={listFilterSupplier || ''}
                  onChange={setListFilterSupplier}
                  options={[
                    { value: '', label: '全部供应商' },
                    ...suppliers.map(s => ({ value: s, label: s })),
                  ]}
                />
              </Space>
              <Space>
                <Text type="secondary" style={{ fontSize: 13 }}>续费状态：</Text>
                <Select
                  style={{ width: 150 }}
                  size="small"
                  value={listFilterStatus || ''}
                  onChange={setListFilterStatus}
                  options={[
                    { value: '', label: '全部状态' },
                    ...statuses.map(s => ({ value: s, label: statusLabelMap[s]?.label || s })),
                  ]}
                />
              </Space>
              {(listFilterSupplier || listFilterStatus) && (
                <Button size="small" onClick={() => { setListFilterSupplier(''); setListFilterStatus(''); }}>
                  清除筛选
                </Button>
              )}
              <Text type="secondary" style={{ fontSize: 13, marginLeft: 'auto' }}>
                共 <strong>{listFiltered.length}</strong> 个 · 月费合计 <Text strong style={{ color: '#1677ff' }}>${totalFee.toFixed(2)}</Text>
              </Text>
            </div>
            <Table
              dataSource={listFiltered}
              rowKey={(r: any) => r.id || r.segment}
              size="small"
              scroll={{ x: 900, y: 480 }}
              pagination={false}
              columns={[
                {
                  title: 'IP 段', dataIndex: 'segment', key: 'segment', width: 160, fixed: 'left' as const,
                  render: (v: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>,
                },
                {
                  title: '供应商', dataIndex: 'supplier', key: 'supplier', width: 130,
                  render: (v: string) => v || <span style={{ color: '#ccc' }}>-</span>,
                },
                {
                  title: '续费状态', dataIndex: 'renewalStatus', key: 'renewalStatus', width: 100,
                  render: (v: string) => {
                    const info = statusLabelMap[v] || { label: v || '-', color: 'default' };
                    return <Tag color={info.color}>{info.label}</Tag>;
                  },
                },
                {
                  title: '月费', dataIndex: 'monthlyPrice', key: 'monthlyPrice', width: 90, align: 'right' as const,
                  sorter: (a: any, b: any) => (a.monthlyPrice || 0) - (b.monthlyPrice || 0),
                  render: (v: number) => v != null ? <span style={{ fontWeight: 600 }}>${Number(v).toFixed(2)}</span> : '-',
                },
                {
                  title: '购买日', dataIndex: 'purchaseDate', key: 'purchaseDate', width: 110,
                  render: (v: string) => v ? <Tag>{v}</Tag> : '-',
                },
                {
                  title: '续费日', dataIndex: 'renewalDate', key: 'renewalDate', width: 110,
                  render: (v: string) => {
                    if (!v) return '-';
                    const days = dayjs(v).diff(dayjs(), 'day');
                    return (
                      <Tooltip title={`${days} 天后`}>
                        <Tag color={days <= 7 ? 'red' : days <= 14 ? 'orange' : 'default'}>{v}</Tag>
                      </Tooltip>
                    );
                  },
                },
                {
                  title: '项目组', dataIndex: 'projectGroups', key: 'projectGroups',
                  render: (v: string[]) => (
                    <Space size={2} wrap>
                      {(v || []).map(g => <Tag key={g} style={{ fontSize: 11 }}>{g}</Tag>)}
                    </Space>
                  ),
                },
              ]}
            />
          </Modal>
        );
      })()}
    </div>
  );
};

export default IPSegmentStats;
