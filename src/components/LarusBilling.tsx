import React, { useEffect, useState, useCallback } from 'react';
import { Table, Button, Tag, Tooltip, Space, Alert, Typography, Input } from 'antd';
import { ReloadOutlined, SearchOutlined, WarningOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

const { Text } = Typography;

interface LarusItem {
  id: number;
  contract_id: number;
  ip_cidr: string;
  total_ips: number;
  route_status: number;
  route_status_text: string;
  status: number;
  duplicate_flag: boolean;
  api_created_flag: boolean;
}

const LarusBilling: React.FC = () => {
  const [items, setItems] = useState<LarusItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cachedAt, setCachedAt] = useState<string>('');
  const [stale, setStale] = useState(false);
  const [warning, setWarning] = useState('');
  const [search, setSearch] = useState('');
  const [cookieInput, setCookieInput] = useState('');
  const [savingCookie, setSavingCookie] = useState(false);
  const [configured, setConfigured] = useState(true);

  const loadIps = useCallback(async (refresh = false) => {
    setLoading(true);
    setWarning('');
    try {
      const url = `/api/larus/ips${refresh ? '?refresh=1' : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!data.success) {
        if (data.message?.includes('Cookie')) setConfigured(false);
        setWarning(data.message || '加载失败');
        return;
      }
      setConfigured(true);
      setItems(data.items || []);
      setCachedAt(data.cachedAt || '');
      setStale(!!data.stale);
      if (data.warning) setWarning(data.warning);
    } catch (e: any) {
      setWarning(e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadIps(); }, [loadIps]);

  const saveCookie = async () => {
    if (!cookieInput.trim()) return;
    setSavingCookie(true);
    try {
      const res = await fetch('/api/larus/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: cookieInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setCookieInput('');
        setConfigured(true);
        loadIps(true);
      }
    } finally {
      setSavingCookie(false);
    }
  };

  const filtered = search
    ? items.filter(it => it.ip_cidr.includes(search) || String(it.contract_id).includes(search))
    : items;

  const routeStatusTag = (text: string, status: number) => {
    if (status === 2) return <Tag color="green">{text || '已宣告'}</Tag>;
    if (status === 1) return <Tag color="orange">{text || '部分宣告'}</Tag>;
    return <Tag color="default">{text || `状态 ${status}`}</Tag>;
  };

  const columns: ColumnsType<LarusItem> = [
    {
      title: 'IP 段',
      dataIndex: 'ip_cidr',
      key: 'ip_cidr',
      width: 170,
      render: (v: string) => <Text code style={{ whiteSpace: 'nowrap' }}>{v}</Text>,
      sorter: (a, b) => a.ip_cidr.localeCompare(b.ip_cidr),
    },
    {
      title: 'IP 数量',
      dataIndex: 'total_ips',
      key: 'total_ips',
      width: 90,
      align: 'right',
      sorter: (a, b) => a.total_ips - b.total_ips,
    },
    {
      title: '合同 ID',
      dataIndex: 'contract_id',
      key: 'contract_id',
      width: 90,
    },
    {
      title: '宣告状态',
      key: 'route_status',
      width: 130,
      render: (_: any, r: LarusItem) => routeStatusTag(r.route_status_text, r.route_status),
      filters: [
        { text: '已宣告', value: 2 },
        { text: '部分宣告', value: 1 },
        { text: '其他', value: 0 },
      ],
      onFilter: (val, r) => val === 2 ? r.route_status === 2 : val === 1 ? r.route_status === 1 : r.route_status !== 1 && r.route_status !== 2,
    },
    {
      title: '租赁状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (v: number) => v === 2 ? <Tag color="green">Active</Tag> : <Tag color="red">状态 {v}</Tag>,
    },
    {
      title: '标记',
      key: 'flags',
      width: 100,
      render: (_: any, r: LarusItem) => (
        <Space size={4}>
          {r.duplicate_flag && <Tooltip title="Duplicate"><Tag color="orange">Dup</Tag></Tooltip>}
          {r.api_created_flag && <Tooltip title="API 创建"><Tag color="blue">API</Tag></Tooltip>}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* Cookie 配置区 */}
      {!configured && (
        <Alert
          type="warning"
          showIcon
          message="Larus Session Cookie 未配置或已过期"
          description={
            <div style={{ marginTop: 8 }}>
              <Input.TextArea
                rows={3}
                value={cookieInput}
                onChange={e => setCookieInput(e.target.value)}
                placeholder="粘贴浏览器 Cookie 字符串（F12 → Network → ip-list → Request Headers → Cookie）"
              />
              <Button type="primary" size="small" style={{ marginTop: 8 }} loading={savingCookie} onClick={saveCookie}>
                保存并刷新
              </Button>
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {warning && !loading && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={warning}
          style={{ marginBottom: 12 }}
          closable
        />
      )}

      {/* 工具栏 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索 IP段 / 合同 ID"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 220 }}
        />
        <span style={{ flex: 1 }} />
        {cachedAt && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {stale ? '⚠ 数据可能过期 · ' : ''}缓存时间：{new Date(cachedAt).toLocaleString('zh-CN')}
          </Text>
        )}
        <Button icon={<ReloadOutlined />} onClick={() => loadIps(true)} loading={loading}>
          刷新
        </Button>
      </div>

      <Table<LarusItem>
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        size="small"
        pagination={false}
        scroll={{ x: 700 }}
        summary={() => (
          <Table.Summary fixed>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {filtered.length} 条{search ? `（过滤自 ${items.length} 条）` : ''}
                </Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} colSpan={4} align="right">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  合计 IP：{filtered.reduce((s, r) => s + r.total_ips, 0).toLocaleString()}
                </Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />

      {/* Cookie 更新入口（已配置时折叠显示） */}
      {configured && (
        <div style={{ marginTop: 16, padding: '12px 16px', background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Cookie 过期后可在此更新：</Text>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <Input
              value={cookieInput}
              onChange={e => setCookieInput(e.target.value)}
              placeholder="粘贴新的 Cookie 字符串"
              style={{ flex: 1 }}
            />
            <Button size="small" loading={savingCookie} onClick={saveCookie} disabled={!cookieInput.trim()}>
              更新
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default LarusBilling;
