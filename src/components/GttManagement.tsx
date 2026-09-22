import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Table, Tabs, Button, Space, Tag, Switch, Input, Modal, message, Form, Select,
  Typography, Card, Popconfirm, Tooltip, Statistic, Row, Col, Checkbox,
} from 'antd';
import {
  PlusOutlined, EditOutlined, DeleteOutlined, SearchOutlined,
  CheckOutlined, CloseOutlined,
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

  const [activeTab, setActiveTab] = useUrlTab(1, ['active', 'unused', 'cancelled', 'all'] as const, 'active');
  const [ipSegments, setIpSegments] = useState<IPSegment[]>([]);
  const [searchText, setSearchText] = useState('');

  // 使用方式内联编辑
  const [editingUsageId, setEditingUsageId] = useState<string | null>(null);
  const [editingUsageValue, setEditingUsageValue] = useState('');
  const usageSavingRef = useRef(false);

  // 手动添加 Modal
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addSelectedKeys, setAddSelectedKeys] = useState<string[]>([]);

  // 批量编辑
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);
  const [batchEditVisible, setBatchEditVisible] = useState(false);
  const [batchEditForm] = Form.useForm();

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

  // Tab 切换清空选中
  const handleTabChange = useCallback((key: string) => {
    setActiveTab(key);
    setSelectedRowKeys([]);
  }, [setActiveTab]);

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
      String(seg.supplier || '').toLowerCase().includes(kw) ||
      String(seg.asn || '').toLowerCase().includes(kw) ||
      String(seg.usageMethod || '').toLowerCase().includes(kw) ||
      String(seg.remark || '').toLowerCase().includes(kw),
    );
  }, [searchText]);

  const displayActive = useMemo(() => filterBySearch(activeSegments), [filterBySearch, activeSegments]);
  const displayUnused = useMemo(() => filterBySearch(unusedSegments), [filterBySearch, unusedSegments]);
  const displayCancelled = useMemo(() => filterBySearch(cancelledSegments), [filterBySearch, cancelledSegments]);
  const displayAll = useMemo(() => filterBySearch(gttSegments), [filterBySearch, gttSegments]);

  // ── 使用方式内联编辑 ──

  const startUsageEdit = (record: IPSegment) => {
    setEditingUsageId(record.id);
    setEditingUsageValue(record.usageMethod || '');
  };

  const saveUsageInline = useCallback(() => {
    if (usageSavingRef.current || !editingUsageId) return;
    usageSavingRef.current = true;
    const seg = ipSegments.find(s => s.id === editingUsageId);
    const oldVal = seg?.usageMethod || '';
    if (editingUsageValue !== oldVal) {
      ipSegmentStorage.update(editingUsageId, { usageMethod: editingUsageValue });
      loadData();
      saveDataToFile(true);
    }
    setEditingUsageId(null);
    setTimeout(() => { usageSavingRef.current = false; }, 0);
  }, [editingUsageId, editingUsageValue, ipSegments, loadData, saveDataToFile]);

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

  // ── 手动添加 ──

  const nonGttSegments = useMemo(() => {
    if (!addModalOpen) return [];
    return ipSegments
      .filter(seg => !seg.gttManaged)
      .filter(seg => {
        if (!addSearch.trim()) return true;
        const kw = addSearch.trim().toLowerCase();
        return seg.segment.toLowerCase().includes(kw) ||
          String(seg.supplier || '').toLowerCase().includes(kw) ||
          String(seg.asn || '').toLowerCase().includes(kw);
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

  // ── 批量编辑 ──

  const handleBatchEditSubmit = async () => {
    if (!selectedRowKeys.length) { message.warning('请先选择要编辑的 IP 段'); return; }
    try {
      const values = await batchEditForm.validateFields();
      const updateData: Partial<IPSegment> = {};

      const usageVal = (values.usageMethod || '').trim();
      if (usageVal) updateData.usageMethod = usageVal;

      if (values.gttInUse !== undefined && values.gttInUse !== null) {
        updateData.gttInUse = values.gttInUse;
      }

      const remarkVal = (values.remark || '').trim();
      const remarkOverwrite = !!values.remarkOverwrite;
      if (remarkVal && remarkOverwrite) {
        updateData.remark = remarkVal;
      }

      if (Object.keys(updateData).length === 0 && remarkVal === '') {
        message.warning('请至少填写一个要修改的字段');
        return;
      }

      let successCount = 0;
      const allSnap = ipSegmentStorage.getAll();
      selectedRowKeys.forEach(key => {
        try {
          if (remarkVal && !remarkOverwrite) {
            const existing = allSnap.find(s => s.id === key);
            const existingRemark = (existing?.remark || '').trim();
            const newRemark = existingRemark ? `${existingRemark} ${remarkVal}` : remarkVal;
            ipSegmentStorage.update(key, { ...updateData, remark: newRemark });
          } else {
            ipSegmentStorage.update(key, updateData);
          }
          successCount++;
        } catch (e) {
          console.error('批量更新失败:', key, e);
        }
      });

      if (successCount > 0) {
        message.success(`成功更新 ${successCount} 条记录`);
        setBatchEditVisible(false);
        batchEditForm.resetFields();
        setSelectedRowKeys([]);
        loadData();
        saveDataToFile(true);
      }
    } catch (e) {
      console.error('批量编辑失败:', e);
    }
  };

  const handleBatchToggleInUse = (inUse: boolean) => {
    let count = 0;
    selectedRowKeys.forEach(key => {
      try {
        ipSegmentStorage.update(key, { gttInUse: inUse });
        count++;
      } catch { /* skip */ }
    });
    if (count > 0) {
      message.success(`已将 ${count} 个 IP 段设为${inUse ? '在用' : '未使用'}`);
      setSelectedRowKeys([]);
      loadData();
      saveDataToFile(true);
    }
  };

  // ── 表格列 ──

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
      render: (text: string, record: IPSegment) => {
        if (canEdit && editingUsageId === record.id) {
          return (
            <Input
              size="small"
              autoFocus
              value={editingUsageValue}
              onChange={e => setEditingUsageValue(e.target.value)}
              onPressEnter={saveUsageInline}
              onBlur={saveUsageInline}
              style={{ width: '100%' }}
              placeholder="输入使用方式"
            />
          );
        }
        return (
          <div
            style={{ cursor: canEdit ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 4, minHeight: 22 }}
            onClick={() => canEdit && startUsageEdit(record)}
          >
            {text ? (
              <Tooltip title={text}>
                <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{text}</span>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{canEdit ? '点击输入' : '-'}</Text>
            )}
            {canEdit && <EditOutlined style={{ color: '#999', fontSize: 12 }} />}
          </div>
        );
      },
    },
    {
      title: '是否在用',
      dataIndex: 'gttInUse',
      key: 'gttInUse',
      width: 90,
      filters: [
        { text: '在用', value: 'active' },
        { text: '未使用', value: 'unused' },
        { text: '已取消', value: 'cancelled' },
      ],
      onFilter: (value, record) => {
        if (value === 'cancelled') return isCancelled(record);
        if (value === 'unused') return !isCancelled(record) && record.gttInUse === false;
        return !isCancelled(record) && record.gttInUse !== false;
      },
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
      scroll={{ x: 1300, y: 'calc(100vh - 380px)' }}
      pagination={false}
      rowSelection={canEdit ? {
        columnWidth: 46,
        selectedRowKeys,
        onChange: (keys) => setSelectedRowKeys(keys as string[]),
      } : undefined}
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

      {/* 批量操作工具栏 */}
      {canEdit && selectedRowKeys.length > 0 && (
        <div style={{ background: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: 6, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text strong>已选择 {selectedRowKeys.length} 项</Text>
          <Button type="primary" size="small" onClick={() => { setBatchEditVisible(true); batchEditForm.resetFields(); }}>
            批量编辑
          </Button>
          <Popconfirm title={`确定将选中的 ${selectedRowKeys.length} 个 IP 段设为在用？`} onConfirm={() => handleBatchToggleInUse(true)} okText="确定" cancelText="取消">
            <Button size="small" icon={<CheckOutlined />}>批量设为在用</Button>
          </Popconfirm>
          <Popconfirm title={`确定将选中的 ${selectedRowKeys.length} 个 IP 段设为未使用？`} onConfirm={() => handleBatchToggleInUse(false)} okText="确定" cancelText="取消">
            <Button size="small" icon={<CloseOutlined />}>批量设为未使用</Button>
          </Popconfirm>
          <Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
        </div>
      )}

      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          { key: 'active', label: `在用IP段 (${activeSegments.length})`, children: renderTable(displayActive) },
          { key: 'unused', label: `未使用IP段 (${unusedSegments.length})`, children: renderTable(displayUnused) },
          { key: 'cancelled', label: `已取消IP段 (${cancelledSegments.length})`, children: renderTable(displayCancelled) },
          { key: 'all', label: `全部IP段 (${gttSegments.length})`, children: renderTable(displayAll) },
        ]}
      />

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

      {/* 批量编辑 Modal */}
      <Modal
        title={`批量编辑 (已选择 ${selectedRowKeys.length} 条)`}
        open={batchEditVisible}
        onOk={handleBatchEditSubmit}
        onCancel={() => { setBatchEditVisible(false); batchEditForm.resetFields(); }}
        okText="批量更新"
        cancelText="取消"
        width={600}
        destroyOnClose
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          只填写需要批量修改的字段，留空的字段将保持不变
        </Text>
        <Form form={batchEditForm} layout="vertical">
          <Form.Item name="usageMethod" label="使用方式">
            <Input.TextArea placeholder="留空则不修改" rows={2} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="gttInUse" label="是否在用">
            <Select allowClear placeholder="留空则不修改">
              <Select.Option value={true}>在用</Select.Option>
              <Select.Option value={false}>未使用</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="备注">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item name="remark" noStyle>
                <Input.TextArea placeholder="留空则不修改" rows={2} maxLength={500} showCount />
              </Form.Item>
              <Form.Item name="remarkOverwrite" valuePropName="checked" noStyle>
                <Checkbox>覆盖原备注（不勾选则追加）</Checkbox>
              </Form.Item>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default GttManagement;
