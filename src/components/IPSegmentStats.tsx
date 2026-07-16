import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Row, Col, Spin, Typography, Tag, Modal, Table, Space,
  Statistic, Empty, Badge, Select, Tooltip, Button, message,
} from 'antd';
import { SyncOutlined } from '@ant-design/icons';
import { PieChartOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text } = Typography;

// ─── 关键字分类配置 ───────────────────────────────────────────────────────────

interface CategoryConfig {
  key: string;
  label: string;
  color: string;
  keywords: string[];
}

const USAGE_CATEGORIES: CategoryConfig[] = [
  { key: 'main_ip',    label: '主IP使用',  color: '#1677ff', keywords: ['主ip', '主IP', '主ip使用'] },
  { key: 'russia',     label: '俄罗斯',    color: '#722ed1', keywords: ['俄罗斯', '俄罗', 'russia'] },
  { key: 'iran',       label: '伊朗',      color: '#eb2f96', keywords: ['伊朗', 'iran'] },
  { key: 'myanmar',    label: '缅甸',      color: '#fa8c16', keywords: ['缅甸', 'myanmar'] },
  { key: 'other',      label: '其他用途',  color: '#52c41a', keywords: [] }, // 兜底：有备注但不匹配以上
  { key: 'no_remark',  label: '待取消',    color: '#ff4d4f', keywords: [] }, // 无备注
];

const PIE_COLORS = [
  '#1677ff', '#722ed1', '#eb2f96', '#fa8c16', '#52c41a',
  '#ff4d4f', '#13c2c2', '#faad14', '#2f54eb', '#f5222d',
];

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface SliceData {
  key: string;
  label: string;
  color: string;
  count: number;
  segments: any[];
  percentage: number;
}

// ─── 辅助：判断备注属于哪个分类 ──────────────────────────────────────────────

function classifyRemark(remark: string | undefined): string {
  if (!remark || !remark.trim()) return 'no_remark';
  const lower = remark.toLowerCase();
  for (const cat of USAGE_CATEGORIES) {
    if (cat.keywords.length === 0) continue;
    if (cat.keywords.some(kw => lower.includes(kw.toLowerCase()))) return cat.key;
  }
  return 'other';
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
      {/* 中心圆 */}
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
    const ratio = item.count / total;
    if (cw >= ch) {
      const mw = remaining.reduce((s, d) => s + d.count, 0);
      const bw = (item.count / (item.count + mw)) * cw;
      const bh = ch;
      rects.push({ key: item.key, x: cx, y: cy, w: bw, h: bh, slice: item });
      cx += bw;
      cw -= bw;
    } else {
      const mh = remaining.reduce((s, d) => s + d.count, 0);
      const bh = (item.count / (item.count + mh)) * ch;
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

// ─── 主组件 ───────────────────────────────────────────────────────────────────

// 来自 /api/ipxo/services-list 的每条记录类型
interface IpxoServiceItem {
  segment: string;
  address: string;
  cidr: number;
  status: string;           // active / cancelled / ...
  nextDueDate: number | null;
  recurringAmount: number | null;
  renewalStatus: string | null;  // ip-data.json 中的续费状态
  renewalDate: string | null;
  purchaseDate: string | null;
  remark: string;
  projectGroups: string[];
  monthlyPrice: number | null;
  supplier: string;
  [key: string]: any;
}

const IPSegmentStats: React.FC = () => {
  const [loading, setLoading] = useState(false);
  // 官网 IP 段列表（来自 ipxo-cache.json services.data + 本地补充信息）
  const [servicesList, setServicesList] = useState<IpxoServiceItem[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // 弹窗
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalSegments, setModalSegments] = useState<IpxoServiceItem[]>([]);

  // 图表类型
  const [chartType, setChartType] = useState<'pie' | 'treemap'>('pie');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ipxo/services-list');
      const json = res.ok ? await res.json() : {};
      setServicesList(json?.data || []);
      setCachedAt(json?.cachedAt || null);
    } catch (e: any) {
      console.error('加载数据失败:', e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // 同步 IPXO 官网最新数据（调用 cache/refresh 接口）
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

  // ── 数据处理 ────────────────────────────────────────────────────────────────

  // 数据源：IPXO 官网 IP 段列表（来自 ipxo-cache.json services.data）
  // renewalStatus 来自 ip-data.json（本地标记），remark 来自 ipxo-upcoming-status.json 优先
  const todayStr = new Date().toISOString().slice(0, 10);
  const cancelledSegs = servicesList.filter(s => s.renewalStatus === 'cancelled');
  // 已取消中进一步区分：已到期（不再统计）vs 待生效（还在租期内，需统计）
  const cancelledExpiredSegs = cancelledSegs.filter(s => !s.renewalDate || s.renewalDate <= todayStr);
  const cancelledPendingSegs = cancelledSegs.filter(s => s.renewalDate && s.renewalDate > todayStr);
  // 在用 = 未标记取消的段
  const activeSegs = servicesList.filter(s => s.renewalStatus !== 'cancelled');
  // 当前租用中 = 在用 + 已取消但未到期（两者都还在租用中）
  const rentedSegs = [...activeSegs, ...cancelledPendingSegs];
  const ipxoTotal = rentedSegs.length; // 统计基数：当前仍在租用中的段

  // 在用 IP 段按备注分类（remark 已由后端从 ipxo-upcoming-status.json + ip-data.json 合并）
  const categoryMap: Record<string, IpxoServiceItem[]> = {};
  USAGE_CATEGORIES.forEach(c => { categoryMap[c.key] = []; });

  activeSegs.forEach(seg => {
    const remark = (seg.remark || '').trim();
    const catKey = classifyRemark(remark);
    categoryMap[catKey].push({ ...seg, _remark: remark } as any);
  });

  const noRemarkSegs = categoryMap['no_remark'];   // 无备注（待取消）
  const withRemarkSegs = activeSegs.filter(s => !!(s.remark || '').trim());

  const activeTotal = activeSegs.length;

  // ── 已租用IP段分布：当前仍在租用中的IP段（在用 + 已取消待生效），按用途分类 ──
  // 已取消已到期的段不再统计（已不在租用列表中）
  const overviewSlices: SliceData[] = [
    {
      key: 'no_remark', label: '待取消（无备注）', color: '#faad14',
      count: noRemarkSegs.length, segments: noRemarkSegs,
      percentage: ipxoTotal > 0 ? (noRemarkSegs.length / ipxoTotal) * 100 : 0,
    },
    ...USAGE_CATEGORIES.filter(c => c.key !== 'no_remark' && c.key !== 'other').map(cat => ({
      key: cat.key, label: cat.label,
      color: cat.color,
      count: categoryMap[cat.key].length,
      segments: categoryMap[cat.key],
      percentage: ipxoTotal > 0 ? (categoryMap[cat.key].length / ipxoTotal) * 100 : 0,
    })),
    {
      key: 'other', label: '其他用途', color: '#52c41a',
      count: categoryMap['other'].length, segments: categoryMap['other'],
      percentage: ipxoTotal > 0 ? (categoryMap['other'].length / ipxoTotal) * 100 : 0,
    },
    {
      key: 'cancelled_pending', label: '已取消（待生效）', color: '#ff7875',
      count: cancelledPendingSegs.length, segments: cancelledPendingSegs,
      percentage: ipxoTotal > 0 ? (cancelledPendingSegs.length / ipxoTotal) * 100 : 0,
    },
  ].filter(s => s.count > 0);

  // ── 在用IP用途分布（仅有备注的，方便查看分类细节）────────────────────────
  const usageSlices: SliceData[] = USAGE_CATEGORIES
    .filter(c => c.key !== 'no_remark')
    .map(cat => ({
      key: cat.key,
      label: cat.label,
      color: cat.color,
      count: categoryMap[cat.key].length,
      segments: categoryMap[cat.key],
      percentage: withRemarkSegs.length > 0 ? (categoryMap[cat.key].length / withRemarkSegs.length) * 100 : 0,
    }))
    .filter(s => s.count > 0);

  // 打开弹窗
  const openModal = (slice: SliceData) => {
    setModalTitle(`${slice.label}（${slice.count} 个 IP 段）`);
    setModalSegments(slice.segments);
    setModalVisible(true);
  };

  // ── 弹窗表格列 ──────────────────────────────────────────────────────────────

  const modalColumns = [
    {
      title: 'IP 段', dataIndex: 'segment', key: 'segment', width: 160,
      render: (v: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</span>,
    },
    {
      title: '备注', key: 'remark', width: 220,
      render: (_: any, r: any) => {
        const remark = (r as any)._remark || r.remark || '';
        return remark ? <span style={{ color: '#555' }}>{remark}</span> : <span style={{ color: '#ccc' }}>-</span>;
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
                IPXO 供应商 IP 段使用情况分析
              </Text>
            </Space>
            {cachedAt && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                数据来自缓存：<strong>{dayjs(cachedAt).format('YYYY-MM-DD HH:mm')}</strong>
                {servicesList.length > 0 && (
                  <span style={{ marginLeft: 6 }}>
                    当前租用 <strong>{ipxoTotal}</strong> 个 IP 段
                  </span>
                )}
                <span style={{ marginLeft: 8, color: '#8c8c8c' }}>
                  如与官网数量不符，请点击右上角「同步官网数据」
                </span>
              </Text>
            )}
          </Space>
          <Space>
            <Select
              value={chartType}
              onChange={setChartType}
              style={{ width: 120 }}
              options={[
                { label: '饼图', value: 'pie' },
                { label: '树状图', value: 'treemap' },
              ]}
            />
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
        {/* 总览统计卡片 */}
        <Row gutter={16} style={{ marginBottom: 16 }}>
          {[
            { title: '当前租用 IP 段', value: ipxoTotal, color: undefined },
            { title: '在用 IP 段', value: activeSegs.length, color: '#52c41a' },
            { title: '  其中有用途标注', value: withRemarkSegs.length, color: '#1677ff' },
            { title: '  其中待取消', value: noRemarkSegs.length, color: '#faad14' },
            { title: '已取消（待生效）', value: cancelledPendingSegs.length, color: '#ff7875' },
            { title: '已取消（已到期）', value: cancelledExpiredSegs.length, color: '#ff4d4f' },
            { title: '月费合计（在用）', value: `$${activeSegs.reduce((s, seg) => s + (seg.monthlyPrice || 0), 0).toFixed(2)}`, color: undefined },
          ].map((item, i) => (
            <Col span={3} key={i}>
              <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>{item.title}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: item.color || '#333' }}>{item.value}</div>
              </Card>
            </Col>
          ))}
        </Row>

        <Row gutter={16}>
          {/* 左：已租用IP段分布（全部IPXO官网列表，按用途+续费状态分类） */}
          <Col xs={24} lg={12}>
            <Card
              title="IPXO 已租用IP段分布"
              size="small"
              style={{ marginBottom: 16 }}
            >
              {chartType === 'pie' ? (
                <SimplePieChart data={overviewSlices} size={280} onSliceClick={openModal} />
              ) : (
                <SimpleTreemap data={overviewSlices} width={500} height={260} onSliceClick={openModal} />
              )}
              {renderLegend(overviewSlices)}
            </Card>
          </Col>

          {/* 右：有用途标注的在用 IP 段分布 */}
          <Col xs={24} lg={12}>
            <Card
              title={
                <Space>
                  有用途标注的在用 IP 段分布
                  <Tag color="blue">{withRemarkSegs.length} 个</Tag>
                  <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                    （共 {activeSegs.length} 个在用，{noRemarkSegs.length} 个待取消未计入）
                  </Text>
                </Space>
              }
              size="small"
              style={{ marginBottom: 16 }}
            >
              {usageSlices.length === 0 ? (
                <Empty description="暂无有备注的在用 IP 段" style={{ padding: '40px 0' }} />
              ) : chartType === 'pie' ? (
                <SimplePieChart data={usageSlices} size={280} onSliceClick={openModal} />
              ) : (
                <SimpleTreemap data={usageSlices} width={500} height={260} onSliceClick={openModal} />
              )}
              {usageSlices.length > 0 && renderLegend(usageSlices)}
            </Card>
          </Col>
        </Row>

        {/* 分类详情卡片 */}
        <Row gutter={16}>
          {/* 先展示有备注的分类 */}
          {USAGE_CATEGORIES.filter(c => c.key !== 'no_remark').map(cat => {
            const segs = categoryMap[cat.key];
            if (segs.length === 0) return null;
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
                  <div style={{ maxHeight: 110, overflowY: 'auto' }}>
                    {segs.slice(0, 6).map((seg, idx) => (
                      <div key={seg.segment || idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600 }}>{seg.segment}</span>
                        <Text type="secondary" style={{ fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {(seg as any)._remark || '-'}
                        </Text>
                      </div>
                    ))}
                    {segs.length > 6 && (
                      <Text type="secondary" style={{ fontSize: 11 }}>...还有 {segs.length - 6} 个</Text>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}

          {/* 待取消（无备注）单独展示 */}
          {noRemarkSegs.length > 0 && (
            <Col xs={24} sm={12} xl={8} style={{ marginBottom: 16 }}>
              <Card
                size="small"
                title={
                  <Space>
                    <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#faad14' }} />
                    待取消（无备注）
                    <Badge count={noRemarkSegs.length} style={{ backgroundColor: '#faad14' }} />
                  </Space>
                }
                extra={
                  <span style={{ fontSize: 12, color: '#1677ff', cursor: 'pointer' }}
                    onClick={() => openModal({ key: 'no_remark', label: '待取消（无备注）', color: '#faad14', count: noRemarkSegs.length, segments: noRemarkSegs, percentage: 0 })}>
                    查看全部 →
                  </span>
                }
                style={{ minHeight: 180 }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {noRemarkSegs.length} 个在用 IP 段没有备注，可能是待取消的段。
                </Text>
                <div style={{ maxHeight: 80, overflowY: 'auto', marginTop: 8 }}>
                  {noRemarkSegs.slice(0, 4).map((seg, idx) => (
                    <div key={seg.segment || idx} style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                      {seg.segment}
                    </div>
                  ))}
                  {noRemarkSegs.length > 4 && (
                    <Text type="secondary" style={{ fontSize: 11 }}>...还有 {noRemarkSegs.length - 4} 个</Text>
                  )}
                </div>
              </Card>
            </Col>
          )}

          {/* 已取消·待生效（renewalDate > 今天，仍在用期内） */}
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
      </Spin>

      {/* 详情弹窗 */}
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
          rowKey="id"
          size="small"
          scroll={{ x: 900 }}
          pagination={{ pageSize: 20, showTotal: t => `共 ${t} 条`, showSizeChanger: true }}
        />
      </Modal>
    </div>
  );
};

export default IPSegmentStats;
