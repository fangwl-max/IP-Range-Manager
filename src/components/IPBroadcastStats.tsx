import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Card, Tabs, Table, Tag, Typography, Spin, Alert, Tooltip,
  message, Button, Modal, List, Checkbox, InputNumber,
} from 'antd';
import {
  SortAscendingOutlined, ArrowUpOutlined, ArrowDownOutlined,
  VerticalAlignTopOutlined, VerticalAlignBottomOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { ColumnsType, ColumnType } from 'antd/es/table';
import type { IPSegment, BlockedCountry, RenewalStatus } from '../types/index';

const { Text } = Typography;

const LS_TAB_ORDER_KEY = 'ip-broadcast-stats-tab-order';

// ─── 封锁状态 ───────────────────────────────────────────────────────────────

type BlockLabel = '被墙' | '停用后被墙' | '未检测' | '可用';

function blockLabel(seg: IPSegment, country: BlockedCountry): BlockLabel {
  if (seg.blockedCountries?.includes(country)) return '被墙';
  if (seg.postUseBlockedCountries?.includes(country)) return '停用后被墙';
  if (!seg.detectedCountries?.includes(country)) return '未检测';
  return '可用';
}

const BLOCK_COLOR: Record<BlockLabel, string> = {
  '被墙': 'red',
  '停用后被墙': 'orange',
  '未检测': 'default',
  '可用': 'green',
};

const BLOCK_FILTERS = (['被墙', '停用后被墙', '未检测', '可用'] as BlockLabel[]).map(v => ({
  text: v, value: v,
}));

function BlockTag({ seg, country }: { seg: IPSegment; country: BlockedCountry }) {
  const label = blockLabel(seg, country);
  return <Tag color={BLOCK_COLOR[label]} style={{ margin: 0 }}>{label}</Tag>;
}

function blockCol(title: string, country: BlockedCountry): ColumnType<IPSegment> {
  return {
    title,
    key: country,
    width: 108,
    filters: BLOCK_FILTERS,
    filterMultiple: true,
    onFilter: (v, seg) => blockLabel(seg, country) === v,
    render: (_: unknown, seg: IPSegment) => <BlockTag seg={seg} country={country} />,
  };
}

// ─── 续费/下架状态 ──────────────────────────────────────────────────────────

const RENEWAL_TAG: Record<RenewalStatus, { text: string; color: string }> = {
  renewed: { text: '未下架', color: 'green' },
  not_renewed: { text: '未下架', color: 'green' },
  cancelled: { text: '已下架', color: 'red' },
  refunded: { text: '已退款', color: 'blue' },
};

// ─── 使用情况 ───────────────────────────────────────────────────────────────

function usageText(seg: IPSegment): string {
  if (seg.projectGroups?.length) return seg.projectGroups.join(', ');
  const active = [...(seg.history || [])].reverse().find(h => !h.endDate);
  return active?.projectGroup || '—';
}

// ─── 日期格式化 ─────────────────────────────────────────────────────────────

function formatDate(v: string | undefined): string {
  if (!v) return '—';
  const d = dayjs(v);
  return d.isValid() ? d.format('YYYY-MM-DD') : v;
}

// ─── /24 等效地址计算 ────────────────────────────────────────────────────────

function cidrToSlash24Equiv(cidr: string): number {
  const prefix = parseInt(cidr.split('/')[1] ?? '32', 10);
  if (isNaN(prefix) || prefix > 24) return 0;
  return Math.pow(2, 24 - prefix);
}

// ─── Tab 排序 Modal ──────────────────────────────────────────────────────────

interface TabSortItem { key: string; label: string; }
interface TabSortModalProps {
  open: boolean;
  items: TabSortItem[];
  onConfirm: (order: string[]) => void;
  onCancel: () => void;
}

const TabSortModal: React.FC<TabSortModalProps> = ({ open, items, onConfirm, onCancel }) => {
  const [draft, setDraft] = useState<TabSortItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<number>(1);

  useEffect(() => {
    if (open) { setDraft([...items]); setSelected(new Set()); setStep(1); }
  }, [open, items]);

  const toggleItem = useCallback((key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => prev.size === draft.length ? new Set() : new Set(draft.map(x => x.key)));
  }, [draft]);

  // 将选中项作为一组整体移动 delta 步（在未选中项中的插入位置偏移 delta）
  const moveSelected = useCallback((delta: number) => {
    setDraft(prev => {
      if (selected.size === 0) return prev;
      const sel = prev.filter(x => selected.has(x.key));
      const unsel = prev.filter(x => !selected.has(x.key));
      const firstIdx = prev.findIndex(x => selected.has(x.key));
      let ip = prev.slice(0, firstIdx).filter(x => !selected.has(x.key)).length;
      ip = Math.max(0, Math.min(unsel.length, ip + delta));
      const result = [...unsel];
      result.splice(ip, 0, ...sel);
      return result;
    });
  }, [selected]);

  // 单行 ↑/↓（不影响选中状态，仅移动该行）
  const moveOne = useCallback((idx: number, dir: -1 | 1) => {
    setDraft(prev => {
      const next = [...prev];
      const t = idx + dir;
      if (t < 0 || t >= next.length) return prev;
      [next[idx], next[t]] = [next[t], next[idx]];
      return next;
    });
  }, []);

  const selCount = selected.size;
  const allChecked = draft.length > 0 && selCount === draft.length;
  const indeterminate = selCount > 0 && selCount < draft.length;

  const actionBarStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 10px', marginBottom: 8,
    background: '#f0f5ff', borderRadius: 6,
    flexWrap: 'wrap',
  };

  return (
    <Modal
      title="调整 Tab 排序"
      open={open}
      onOk={() => onConfirm(draft.map(x => x.key))}
      onCancel={onCancel}
      okText="应用"
      cancelText="取消"
      width={500}
    >
      {/* 批量操作栏：选中后出现 */}
      {selCount > 0 ? (
        <div style={actionBarStyle}>
          <span style={{ fontSize: 13, color: '#1677ff', marginRight: 4 }}>已选 {selCount} 项</span>
          <Button size="small" icon={<VerticalAlignTopOutlined />} onClick={() => moveSelected(-Infinity)}>置顶</Button>
          <Button size="small" icon={<ArrowUpOutlined />} onClick={() => moveSelected(-step)}>上移</Button>
          <InputNumber
            size="small"
            min={1}
            max={draft.length - 1}
            value={step}
            onChange={v => setStep(Math.max(1, v ?? 1))}
            style={{ width: 52 }}
          />
          <span style={{ fontSize: 12, color: '#666' }}>步</span>
          <Button size="small" icon={<ArrowDownOutlined />} onClick={() => moveSelected(step)}>下移</Button>
          <Button size="small" icon={<VerticalAlignBottomOutlined />} onClick={() => moveSelected(Infinity)}>置底</Button>
        </div>
      ) : (
        <div style={{ marginBottom: 8, fontSize: 13, color: '#888' }}>
          勾选一个或多个地区后，可批量上移/下移指定步数，或一键置顶/置底。
        </div>
      )}

      <List
        size="small"
        bordered
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px' }}>
            <Checkbox indeterminate={indeterminate} checked={allChecked} onChange={toggleAll} />
            <span style={{ fontSize: 13, color: '#555' }}>全选（共 {draft.length} 个 Tab）</span>
          </div>
        }
        dataSource={draft}
        renderItem={(item, idx) => (
          <List.Item
            style={{
              padding: '5px 12px',
              background: selected.has(item.key) ? '#f0f5ff' : undefined,
              cursor: 'pointer',
            }}
            onClick={() => toggleItem(item.key)}
            actions={[
              <Button
                size="small"
                icon={<ArrowUpOutlined />}
                disabled={idx === 0}
                onClick={e => { e.stopPropagation(); moveOne(idx, -1); }}
              />,
              <Button
                size="small"
                icon={<ArrowDownOutlined />}
                disabled={idx === draft.length - 1}
                onClick={e => { e.stopPropagation(); moveOne(idx, 1); }}
              />,
            ]}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
              <Checkbox checked={selected.has(item.key)} onChange={() => toggleItem(item.key)} />
              <span style={{ fontWeight: 500 }}>{idx + 1}. {item.label}</span>
            </div>
          </List.Item>
        )}
      />
    </Modal>
  );
};

// ─── 主组件 ─────────────────────────────────────────────────────────────────

const IPBroadcastStats: React.FC = () => {
  const [segments, setSegments] = useState<IPSegment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [tabOrder, setTabOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(LS_TAB_ORDER_KEY) || '[]'); } catch { return []; }
  });
  const [sortModalOpen, setSortModalOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch('/api/get-data')
      .then(r => r.json())
      .then(data => { setSegments(data.ipSegments || []); setError(''); })
      .catch(e => setError(e.message || '数据加载失败'))
      .finally(() => setLoading(false));
  }, []);

  const offlineSegments = useMemo(
    () => segments.filter(s => s.renewalStatus === 'cancelled' || s.renewalStatus === 'refunded'),
    [segments],
  );

  // 所有可用的 tab keys（含固定 + 宣告地区）
  const allTabKeys = useMemo(() => {
    const areas = [...new Set(segments.map(s => s.usageArea).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return ['all', '__offline__', ...areas];
  }, [segments]);

  // 按 tabOrder 排列，未在 tabOrder 中的追加到末尾
  const orderedKeys = useMemo(() => {
    const ordered = tabOrder.filter(k => allTabKeys.includes(k));
    const rest = allTabKeys.filter(k => !tabOrder.includes(k));
    return [...ordered, ...rest];
  }, [allTabKeys, tabOrder]);

  const tabItems = useMemo(() => {
    const labelMap: Record<string, string> = {
      all: '全部',
      '__offline__': `已下架IP段 (${offlineSegments.length})`,
    };
    return orderedKeys.map(k => ({ key: k, label: labelMap[k] ?? k }));
  }, [orderedKeys, offlineSegments.length]);

  // 传给排序弹窗的 items（使用静态标签，不带计数）
  const modalSortItems = useMemo<TabSortItem[]>(() => {
    const labelMap: Record<string, string> = { all: '全部', '__offline__': '已下架IP段' };
    return orderedKeys.map(k => ({ key: k, label: labelMap[k] ?? k }));
  }, [orderedKeys]);

  const onlineSegments = useMemo(
    () => segments.filter(s => s.renewalStatus !== 'cancelled' && s.renewalStatus !== 'refunded'),
    [segments],
  );

  const tableData = useMemo(() => {
    if (activeTab === '__offline__') return offlineSegments;
    if (activeTab === 'all') return onlineSegments;
    return onlineSegments.filter(s => s.usageArea === activeTab);
  }, [onlineSegments, activeTab, offlineSegments]);

  const totalSlash24 = useMemo(
    () => tableData.reduce((s, seg) => s + cidrToSlash24Equiv(seg.segment), 0),
    [tableData],
  );

  // ── 列筛选数据（从全量 segments 计算，保持筛选项稳定）──────────────────────
  const supplierFilters = useMemo(() =>
    [...new Set(segments.map(s => s.supplier).filter(Boolean))].sort()
      .map(v => ({ text: v, value: v })),
    [segments],
  );
  const asnFilters = useMemo(() =>
    [...new Set(segments.map(s => s.asn).filter(Boolean))].sort()
      .map(v => ({ text: `AS${v.replace(/^AS/i, '')}`, value: v })),
    [segments],
  );
  const usageFilters = useMemo(() => {
    const vals = [...new Set(segments.map(usageText))].filter(u => u !== '—').sort();
    return [...vals.map(v => ({ text: v, value: v })), { text: '—', value: '—' }];
  }, [segments]);

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => message.success('已复制'));
  }

  const handleTabOrderConfirm = (order: string[]) => {
    setTabOrder(order);
    localStorage.setItem(LS_TAB_ORDER_KEY, JSON.stringify(order));
    setSortModalOpen(false);
    message.success('Tab 排序已保存');
  };

  // ── 列定义 ────────────────────────────────────────────────────────────────

  const columns: ColumnsType<IPSegment> = [
    {
      title: '购买时间',
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 110,
      sorter: (a, b) => dayjs(a.purchaseDate).valueOf() - dayjs(b.purchaseDate).valueOf(),
      render: (v: string) => formatDate(v),
    },
    {
      title: '续费时间',
      dataIndex: 'renewalDate',
      key: 'renewalDate',
      width: 110,
      render: (v: string, seg: IPSegment) =>
        seg.renewalStatus === 'not_renewed'
          ? <Text type="secondary">取消续费</Text>
          : formatDate(v),
    },
    {
      title: 'IP属地',
      key: 'ipLocation',
      width: 90,
      render: () => <Text type="secondary">—</Text>,
    },
    {
      title: '供应商',
      dataIndex: 'supplier',
      key: 'supplier',
      width: 90,
      filters: supplierFilters,
      filterMultiple: true,
      onFilter: (v, seg) => seg.supplier === v,
      render: (v: string) => v || '—',
    },
    {
      title: 'IP段',
      dataIndex: 'segment',
      key: 'segment',
      width: 160,
      render: (v: string) => (
        <Tooltip title="点击复制" mouseEnterDelay={0.5}>
          <Text
            code
            style={{ whiteSpace: 'nowrap', fontSize: 14, cursor: 'pointer' }}
            onClick={() => copyToClipboard(v)}
          >
            {v}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '宣告状态',
      key: 'announceStatus',
      width: 95,
      filters: [
        { text: '宣告中', value: 'true' },
        { text: '未宣告', value: 'false' },
      ],
      filterMultiple: false,
      onFilter: (v, seg) => String(seg.primaryAsnInBgp === true) === v,
      render: (_: unknown, seg: IPSegment) =>
        seg.primaryAsnInBgp === true
          ? <Tag color="blue" style={{ margin: 0 }}>宣告中</Tag>
          : <Tag color="default" style={{ margin: 0 }}>未宣告</Tag>,
    },
    {
      title: 'ASN',
      dataIndex: 'asn',
      key: 'asn',
      width: 110,
      filters: asnFilters,
      filterMultiple: true,
      onFilter: (v, seg) => seg.asn === v,
      render: (v: string) => v
        ? <Text code style={{ fontSize: 12 }}>AS{v.replace(/^AS/i, '')}</Text>
        : '—',
    },
    {
      title: '使用情况',
      key: 'usage',
      width: 130,
      filters: usageFilters,
      filterMultiple: true,
      onFilter: (v, seg) => usageText(seg) === v,
      render: (_: unknown, seg: IPSegment) => usageText(seg),
    },
    blockCol('伊朗封锁', 'iran'),
    blockCol('缅甸封锁', 'myanmar'),
    blockCol('土库曼封锁', 'turkmenistan'),
    blockCol('俄罗斯封锁', 'russia'),
    {
      title: '下架情况',
      key: 'renewalStatus',
      width: 95,
      filters: [
        { text: '未下架', value: 'active' },
        { text: '已下架', value: 'cancelled' },
        { text: '已退款', value: 'refunded' },
      ],
      filterMultiple: true,
      onFilter: (v, seg) => {
        if (v === 'active') return seg.renewalStatus !== 'cancelled' && seg.renewalStatus !== 'refunded';
        return seg.renewalStatus === v;
      },
      render: (_: unknown, seg: IPSegment) => {
        const cfg = RENEWAL_TAG[seg.renewalStatus] ?? { text: '未下架', color: 'green' };
        return <Tag color={cfg.color} style={{ margin: 0 }}>{cfg.text}</Tag>;
      },
    },
    {
      title: '特殊备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 180,
      render: (v: string) => v || '—',
    },
  ];

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" tip="加载数据..." />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" showIcon message="加载失败" description={error} />;
  }

  return (
    <Card
      title="广播IP段统计 A组"
      styles={{ body: { padding: '0 0 16px' } }}
    >
      {/* Tab 栏 + 排序按钮 */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            size="small"
            items={tabItems}
          />
        </div>
        <Tooltip title="调整 Tab 排序">
          <Button
            size="small"
            icon={<SortAscendingOutlined />}
            onClick={() => setSortModalOpen(true)}
            style={{ marginBottom: 8, flexShrink: 0 }}
          >
            排序管理
          </Button>
        </Tooltip>
      </div>

      {/* 摘要行 */}
      <div style={{ padding: '4px 16px 10px', fontSize: 13, color: '#666', display: 'flex', gap: 24 }}>
        <span>共 <strong>{tableData.length}</strong> 个IP段</span>
        <span>合计约 <strong>{totalSlash24}</strong> 个 /24 等效地址</span>
        {activeTab !== 'all' && activeTab !== '__offline__' && (
          <span style={{ color: '#1677ff' }}>宣告地区：{activeTab}</span>
        )}
      </div>

      <Table<IPSegment>
        rowKey="id"
        columns={columns}
        dataSource={tableData}
        size="small"
        scroll={{ x: 1700 }}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
        style={{ padding: '0 16px' }}
      />

      {/* Tab 排序 Modal */}
      <TabSortModal
        open={sortModalOpen}
        items={modalSortItems}
        onConfirm={handleTabOrderConfirm}
        onCancel={() => setSortModalOpen(false)}
      />
    </Card>
  );
};

export default IPBroadcastStats;
