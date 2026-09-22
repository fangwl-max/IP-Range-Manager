import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Table, Tabs, Button, Space, Tag, Switch, Input, Modal, message,
  Typography, Card, Popconfirm, Tooltip, Statistic, Row, Col,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useUrlTab } from '../hooks/useUrlTab';
import { useAuth } from '../contexts/AuthContext';
import { IPSegment } from '../types';
import {
  ipSegmentStorage, projectGroupStorage, supplierStorage,
  usageAreaStorage, asnStorage, asnGroupStorage,
} from '../utils/storage';

const { Text } = Typography;

const GttManagement: React.FC = () => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('gtt-management.edit');

  const [activeTab, setActiveTab] = useUrlTab(1, ['active', 'unused', 'cancelled'] as const, 'active');
  const [ipSegments, setIpSegments] = useState<IPSegment[]>([]);
  const [searchText, setSearchText] = useState('');

  // 使用方式编辑
  const [editingRecord, setEditingRecord] = useState<IPSegment | null>(null);
  const [usageMethodValue, setUsageMethodValue] = useState('');

  // 手动添加 Modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addSelectedKeys, setAddSelectedKeys] = useState<string[]>([]);

  const saveDataToFile = useCallback(async (silent = false) => {
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
      const resp = await fetch('/api/save-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allData),
      });
      if (resp.ok) {
        if (!silent) message.success('数据已保存');
      } else {
        throw new Error('Server error');
      }
    } catch {
      message.error('数据保存失败');
    }
  }, []);

  const loadData = useCallback(() => {
    const all = ipSegmentStorage.getAll();
    let changed = false;
    const updated = all.map(seg => {
      if (seg.supplier === 'GTT' && !seg.gttManaged) {
        changed = true;
        return { ...seg, gttManaged: true, updatedAt: new Date().toISOString() };
      }
      return seg;
    });
    if (changed) {
      ipSegmentStorage.save(updated);
      saveDataToFile(true);
    }
    setIpSegments(updated);
  }, [saveDataToFile]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const resp = await fetch('/api/get-data');
        if (resp.ok) {
          const data = await resp.json();
          if (data?.ipSegments) {
            ipSegmentStorage.save(data.ipSegments);
            if (data.projectGroups) projectGroupStorage.save(data.projectGroups);
            if (data.suppliers) supplierStorage.save(data.suppliers);
            if (data.usageAreas) usageAreaStorage.save(data.usageAreas);
            if (data.asns) asnStorage.save(data.asns);
            if (data.asnGroups) asnGroupStorage.save(data.asnGroups);
          }
        }
      } catch { /* use localStorage fallback */ }
      loadData();
    };
    fetchData();
  }, [loadData]);

  // GTT 管理的 IP 段
  const gttSegments = useMemo(() =>
    ipSegments.filter(seg => seg.gttManaged === true),
    [ipSegments],
  );

  const isCancelled = (seg: IPSegment) =>
    seg.renewalStatus === 'cancelled' || seg.renewalStatus === 'refunded' ||
    !!(seg.cancellationDate && seg.cancellationDate.trim());

  const activeSegments = useMemo(() =>
    gttSegments.filter(seg => !isCancelled(seg) && seg.gttInUse !== false),
    [gttSegments],
  );

  const unusedSegments = useMemo(() =>
    gttSegments.filter(seg => !isCancelled(seg) && seg.gttInUse === false),
    [gttSegments],
  );

  const cancelledSegments = useMemo(() =>
    gttSegments.filter(seg => isCancelled(seg)),
    [gttSegments],
  );

  // 搜索过滤
  const filterBySearch = useCallback((list: IPSegment[]) => {
    if (!searchText.trim()) return list;
    const kw = searchText.trim().toLowerCase();
    return list.filter(seg =>
      seg.segment.toLowerCase().includes(kw) ||
      (seg.supplier || '').toLowerCase().includes(kw) ||
      (seg.asn || '').toLowerCase().includes(kw) ||
      (seg.usageMethod || '').toLowerCase().includes(kw) ||
      (seg.remark || '').toLowerCase().includes(kw),
    );
  }, [searchText]);

  const displayActive = useMemo(() => filterBySearch(activeSegments), [filterBySearch, activeSegments]);
  const displayUnused = useMemo(() => filterBySearch(unusedSegments), [filterBySearch, unusedSegments]);
  const displayCancelled = useMemo(() => filterBySearch(cancelledSegments), [filterBySearch, cancelledSegments]);

  // 使用方式编辑
  const openUsageEdit = (record: IPSegment) => {
    setEditingRecord(record);
    setUsageMethodValue(record.usageMethod || '');
  };

  const handleUsageSave = () => {
    if (!editingRecord) return;
    ipSegmentStorage.update(editingRecord.id, { usageMethod: usageMethodValue });
    loadData();
    saveDataToFile(true);
    setEditingRecord(null);
    message.success('使用方式已更新');
  };

  // 是否在用切换
  const handleInUseToggle = (record: IPSegment, checked: boolean) => {
    ipSegmentStorage.update(record.id, { gttInUse: checked });
    loadData();
    saveDataToFile(true);
  };

  // 移出 GTT 管理
  const handleRemove = (id: string) => {
    ipSegmentStorage.update(id, { gttManaged: false });
    loadData();
    saveDataToFile(true);
    message.success('已移出 GTT 管理');
  };

  // 手动添加
  const nonGttSegments = useMemo(() => {
    if (!addModalOpen) return [];
    return ipSegments
      .filter(seg => !seg.gttManaged)
      .filter(seg => {
        if (!addSearch.trim()) return true;
        const kw = addSearch.trim().toLowerCase();
        return seg.segment.toLowerCase().includes(kw) ||
          (seg.supplier || '').toLowerCase().includes(kw) ||
          (seg.asn || '').toLowerCase().includes(kw);
      });
  }, [ipSegments, addModalOpen, addSearch]);

  const handleAddConfirm = () => {
    if (!addSelectedKeys.length) { message.warning('请选择要添加的 IP 段'); return; }
    const all = ipSegmentStorage.getAll();
    const keySet = new Set(addSelectedKeys);
    const updated = all.map(seg =>
      keySet.has(seg.id) ? { ...seg, gttManaged: true, gttInUse: true, updatedAt: new Date().toISOString() } : seg,
    );
    ipSegmentStorage.save(updated);
    setIpSegments(updated);
    saveDataToFile(true);
    setAddModalOpen(false);
    setAddSelectedKeys([]);
    setAddSearch('');
    message.success(`已添加 ${addSelectedKeys.length} 个 IP 段到 GTT 管理`);
  };

  const columns: ColumnsType<IPSegment> = [
    {
      title: 'IP段',
      dataIndex: 'segment',
      key: 'segment',
      width: 160,
      fixed: 'left',
      sorter: (a, b) => a.segment.localeCompare(b.segment),
      render: (text: string) => <Text strong style={{ fontFamily: 'monospace', fontSize: 13 }}>{text}</Text>,
    },
    {
      title: '供应商',
      dataIndex: 'supplier',
      key: 'supplier',
      width: 100,
      filters: [...new Set(gttSegments.map(s => s.supplier))].map(s => ({ text: s, value: s })),
      onFilter: (value, record) => record.supplier === value,
      render: (text: string) => <Tag>{text}</Tag>,
    },
    {
      title: 'ASN',
      dataIndex: 'asn',
      key: 'asn',
      width: 100,
      render: (text: string) => text || '-',
    },
    {
      title: '宣告地区',
      dataIndex: 'usageArea',
      key: 'usageArea',
      width: 130,
      filters: [...new Set(gttSegments.map(s => s.usageArea).filter(Boolean))].map(a => ({ text: a, value: a })),
      onFilter: (value, record) => record.usageArea === value,
    },
    {
      title: '项目组',
      dataIndex: 'projectGroups',
      key: 'projectGroups',
      width: 120,
      render: (groups: string[]) =>
        groups?.length ? groups.map(g => <Tag key={g} color="blue">{g}</Tag>) : <Text type="secondary">-</Text>,
    },
    {
      title: '购买时间',
      dataIndex: 'purchaseDate',
      key: 'purchaseDate',
      width: 110,
      sorter: (a, b) => (a.purchaseDate || '').localeCompare(b.purchaseDate || ''),
      render: (d: string) => d ? dayjs(d).format('YYYY-MM-DD') : '-',
    },
    {
      title: '费用($)',
      dataIndex: 'monthlyPrice',
      key: 'monthlyPrice',
      width: 90,
      sorter: (a, b) => (a.monthlyPrice || 0) - (b.monthlyPrice || 0),
      render: (v: number) => v ? `$${v.toFixed(2)}` : '-',
    },
    {
      title: '使用方式',
      dataIndex: 'usageMethod',
      key: 'usageMethod',
      width: 180,
      render: (text: string, record: IPSegment) => (
        <Space size={4}>
          {text ? (
            <Tooltip title={text}><span style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{text}</span></Tooltip>
          ) : (
            <Text type="secondary">-</Text>
          )}
          {canEdit && (
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openUsageEdit(record)} style={{ padding: 0 }} />
          )}
        </Space>
      ),
    },
    {
      title: '是否在用',
      dataIndex: 'gttInUse',
      key: 'gttInUse',
      width: 90,
      render: (val: boolean | undefined, record: IPSegment) => {
        if (isCancelled(record)) return <Tag color="default">已取消</Tag>;
        return canEdit ? (
          <Switch
            size="small"
            checked={val !== false}
            onChange={(checked) => handleInUseToggle(record, checked)}
          />
        ) : (
          <Tag color={val !== false ? 'green' : 'default'}>{val !== false ? '在用' : '未使用'}</Tag>
        );
      },
    },
    {
      title: '备注',
      dataIndex: 'remark',
      key: 'remark',
      width: 120,
      render: (text: string) => text ? (
        <Tooltip title={text}><span style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{text}</span></Tooltip>
      ) : <Text type="secondary">-</Text>,
    },
    ...(canEdit ? [{
      title: '操作',
      key: 'action',
      width: 80,
      fixed: 'right' as const,
      render: (_: any, record: IPSegment) => (
        record.supplier !== 'GTT' ? (
          <Popconfirm title="确定将此 IP 段移出 GTT 管理？" onConfirm={() => handleRemove(record.id)} okText="确定" cancelText="取消">
            <Button type="link" size="small" danger icon={<DeleteOutlined />}>移出</Button>
          </Popconfirm>
        ) : null
      ),
    }] : []),
  ];

  const addColumns: ColumnsType<IPSegment> = [
    { title: 'IP段', dataIndex: 'segment', key: 'segment', width: 160, render: (t: string) => <Text style={{ fontFamily: 'monospace' }}>{t}</Text> },
    { title: '供应商', dataIndex: 'supplier', key: 'supplier', width: 100, render: (t: string) => <Tag>{t}</Tag> },
    { title: 'ASN', dataIndex: 'asn', key: 'asn', width: 90 },
    { title: '宣告地区', dataIndex: 'usageArea', key: 'usageArea', width: 120 },
    { title: '项目组', dataIndex: 'projectGroups', key: 'projectGroups', width: 120, render: (g: string[]) => g?.join(', ') || '-' },
  ];

  const renderTable = (data: IPSegment[]) => (
    <Table
      columns={columns}
      dataSource={data}
      rowKey="id"
      size="small"
      scroll={{ x: 1300 }}
      pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
    />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Row gutter={16}>
        <Col span={6}><Card size="small"><Statistic title="GTT 管理总数" value={gttSegments.length} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="在用" value={activeSegments.length} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="未使用" value={unusedSegments.length} valueStyle={{ color: '#faad14' }} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="已取消" value={cancelledSegments.length} valueStyle={{ color: '#ff4d4f' }} /></Card></Col>
      </Row>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Input
          placeholder="搜索 IP段 / 供应商 / ASN / 使用方式"
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          allowClear
          style={{ width: 320 }}
        />
        {canEdit && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setAddModalOpen(true); setAddSelectedKeys([]); setAddSearch(''); }}>
            手动添加 IP 段
          </Button>
        )}
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'active', label: `在用IP段 (${activeSegments.length})`, children: renderTable(displayActive) },
          { key: 'unused', label: `未使用IP段 (${unusedSegments.length})`, children: renderTable(displayUnused) },
          { key: 'cancelled', label: `已取消IP段 (${cancelledSegments.length})`, children: renderTable(displayCancelled) },
        ]}
      />

      {/* 使用方式编辑 Modal */}
      <Modal
        title={`编辑使用方式 — ${editingRecord?.segment || ''}`}
        open={!!editingRecord}
        onOk={handleUsageSave}
        onCancel={() => setEditingRecord(null)}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Input.TextArea
          value={usageMethodValue}
          onChange={e => setUsageMethodValue(e.target.value)}
          placeholder="请输入使用方式描述"
          rows={3}
          maxLength={500}
          showCount
        />
      </Modal>

      {/* 手动添加 Modal */}
      <Modal
        title="手动添加 IP 段到 GTT 管理"
        open={addModalOpen}
        onOk={handleAddConfirm}
        onCancel={() => setAddModalOpen(false)}
        okText={`添加 (${addSelectedKeys.length})`}
        cancelText="取消"
        width={800}
        destroyOnClose
      >
        <div style={{ marginBottom: 12 }}>
          <Input
            placeholder="搜索 IP段 / 供应商 / ASN"
            prefix={<SearchOutlined />}
            value={addSearch}
            onChange={e => setAddSearch(e.target.value)}
            allowClear
          />
        </div>
        <Table
          columns={addColumns}
          dataSource={nonGttSegments}
          rowKey="id"
          size="small"
          scroll={{ y: 400 }}
          pagination={{ pageSize: 50, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
          rowSelection={{
            selectedRowKeys: addSelectedKeys,
            onChange: (keys) => setAddSelectedKeys(keys as string[]),
          }}
        />
      </Modal>
    </div>
  );
};

export default GttManagement;
