import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useUrlTab } from '../hooks/useUrlTab';
import { Tabs, Table, Tag, Space, Input, Select, Button, message, Spin, Row, Col, Statistic, Card, Typography, Progress } from 'antd';
import { ReloadOutlined, SearchOutlined, FilterOutlined } from '@ant-design/icons';
import type { ColumnType } from 'antd/es/table';

const { Text } = Typography;

interface ZecCidrRow {
  cidrBlock: string;
  cidrId: string;
  regionId: string;
  status: string;
  asn?: string;
  networkType?: string;
  totalCount?: number;
  usedCount?: number;
  createTime?: string;
  chargeType?: string;
  _regionLabel?: string;
}

interface BmcCidrRow {
  cidrBlockId: string;
  cidrBlockName: string;
  cidrBlock: string;
  zoneId: string;
  status: string;
  instanceIds?: string[];
  createTime?: string;
  _zoneLabel?: string;
}

const ZEC_STATUS_CN: Record<string, string> = {
  BINDABLE: '可绑定',
  BINDABLE_WITH_EIP: '可绑定(EIP)',
  BINDABLE_WITH_SUBNET: '可绑定(子网)',
  BINDABLE_WITH_VPC: '可绑定(VPC)',
  AVAILABLE: '可用',
  IN_USE: '使用中',
  CREATE_FAILED: '创建失败',
  CREATING: '创建中',
  TERMINATING: '删除中',
  TERMINATED: '已删除',
};

const BMC_STATUS_CN: Record<string, string> = {
  BINDABLE: '可绑定',
  BINDABLE_WITH_INSTANCE: '可绑定(实例)',
  AVAILABLE: '可用',
  IN_USE: '使用中',
  CREATE_FAILED: '创建失败',
  CREATING: '创建中',
  TERMINATING: '删除中',
  TERMINATED: '已删除',
};

const STATUS_COLOR: Record<string, string> = {
  BINDABLE: 'green',
  BINDABLE_WITH_EIP: 'green',
  BINDABLE_WITH_SUBNET: 'green',
  BINDABLE_WITH_VPC: 'green',
  AVAILABLE: 'green',
  BINDABLE_WITH_NIC: 'green',
  BINDABLE_WITH_VPC_SUBNET: 'green',
  IN_USE: 'blue',
  BINDABLE_WITH_INSTANCE: 'blue',
  CREATE_FAILED: 'red',
  CREATING: 'orange',
  TERMINATING: 'orange',
  TERMINATED: 'default',
};

const NETWORK_TYPE_CN: Record<string, string> = {
  StandardBGP: '标准BGP',
  PremiumBGP: '精品BGP',
};

const CHARGE_TYPE_CN: Record<string, string> = {
  PREPAID: '预付费',
  POSTPAID: '后付费',
};

function getStatusColor(status: string): string {
  return STATUS_COLOR[status] || STATUS_COLOR[status?.toUpperCase()] || 'default';
}

/** 根据 CIDR 前缀计算可用主机数（/24 → 254） */
function cidrCapacity(cidrBlock: string): number {
  const prefix = parseInt((cidrBlock || '').split('/')[1] ?? '24', 10);
  if (isNaN(prefix) || prefix > 32) return 254;
  if (prefix >= 31) return Math.pow(2, 32 - prefix); // /31=/32 不减 network/broadcast
  return Math.pow(2, 32 - prefix) - 2;
}

/** 自定义 filterDropdown：多行 IP 段输入，每行一个（支持模糊匹配） */
function makeCidrFilterDropdown(column: string): ColumnType<any>['filterDropdown'] {
  return ({ setSelectedKeys, selectedKeys, confirm, clearFilters }) => {
    const val = String(selectedKeys[0] || '');
    return (
      <div style={{ padding: 8, width: 220 }}>
        <div style={{ marginBottom: 6, fontSize: 12, color: '#666' }}>每行一个，支持模糊匹配</div>
        <Input.TextArea
          placeholder={`输入 ${column} 进行筛选\n可输入多个，每行一条`}
          value={val}
          onChange={e => setSelectedKeys(e.target.value ? [e.target.value] : [])}
          rows={4}
          style={{ marginBottom: 8, display: 'block' }}
          autoFocus
        />
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<SearchOutlined />}
            onClick={() => confirm()}
          >
            筛选
          </Button>
          <Button
            size="small"
            onClick={() => { clearFilters?.(); confirm(); }}
          >
            重置
          </Button>
        </Space>
      </div>
    );
  };
}

const ZecTab: React.FC = () => {
  const [data, setData] = useState<ZecCidrRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filteredCount, setFilteredCount] = useState(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zen/announced/zec');
      const json = await res.json();
      if (json.success) {
        setData(json.data || []);
        setFilteredCount((json.data || []).length);
      } else {
        message.error('获取 ZEC IP 段失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 列头筛选选项
  const regionFilters = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data) {
      if (r.regionId && !map.has(r.regionId)) {
        map.set(r.regionId, r._regionLabel || r.regionId);
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([v, l]) => ({ text: `${l}${l !== v ? ` (${v})` : ''}`, value: v }));
  }, [data]);

  const asnFilters = useMemo(() => {
    const set = new Set(data.map(r => r.asn).filter((x): x is string => !!x));
    return [...set].sort((a, b) => Number(a) - Number(b)).map(v => ({ text: `AS${v}`, value: v }));
  }, [data]);

  const statusFilters = useMemo(() => {
    const set = new Set(data.map(r => r.status).filter(Boolean));
    return [...set].sort().map(s => ({ text: ZEC_STATUS_CN[s] || s, value: s }));
  }, [data]);

  const networkFilters = useMemo(() => {
    const set = new Set(data.map(r => r.networkType).filter((x): x is string => !!x));
    return [...set].sort().map(s => ({ text: NETWORK_TYPE_CN[s] || s, value: s }));
  }, [data]);

  const columns: ColumnType<ZecCidrRow>[] = [
    {
      title: 'IP段',
      dataIndex: 'cidrBlock',
      key: 'cidrBlock',
      width: 165,
      filterDropdown: makeCidrFilterDropdown('IP段'),
      filterIcon: (filtered: boolean) => <SearchOutlined style={{ color: filtered ? '#1677ff' : undefined }} />,
      onFilter: (value, record) => {
        const lines = String(value).split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) return true;
        return lines.some(c => (record.cidrBlock || '').includes(c));
      },
    },
    {
      title: '区域',
      key: 'regionId',
      width: 180,
      filters: regionFilters,
      filterMultiple: true,
      onFilter: (value, record) => record.regionId === value,
      render: (_: any, r: ZecCidrRow) => {
        const label = r._regionLabel || r.regionId;
        return (
          <span>
            {label}
            {label !== r.regionId && <Text type="secondary" style={{ fontSize: 11 }}> ({r.regionId})</Text>}
          </span>
        );
      },
    },
    {
      title: 'ASN',
      dataIndex: 'asn',
      key: 'asn',
      width: 90,
      filters: asnFilters,
      filterMultiple: true,
      onFilter: (value, record) => String(record.asn || '') === value,
      render: (v: string) => v ? <Text code style={{ fontSize: 12 }}>AS{v}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: '网络类型',
      key: 'networkType',
      width: 115,
      filters: networkFilters,
      filterMultiple: true,
      onFilter: (value, record) => record.networkType === value,
      render: (_: any, r: ZecCidrRow) => NETWORK_TYPE_CN[r.networkType || ''] || r.networkType || '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      filters: statusFilters,
      filterMultiple: true,
      onFilter: (value, record) => record.status === value,
      render: (s: string) => <Tag color={getStatusColor(s)}>{ZEC_STATUS_CN[s] || s}</Tag>,
    },
    {
      title: '已用/总量',
      key: 'usage',
      width: 130,
      sorter: (a, b) => (a.usedCount ?? 0) - (b.usedCount ?? 0),
      render: (_: any, r: ZecCidrRow) => {
        const used = r.usedCount ?? (r as any).used_count ?? 0;
        const apiTotal = r.totalCount ?? (r as any).total_count;
        const total = (apiTotal != null && apiTotal > 0) ? apiTotal : cidrCapacity(r.cidrBlock);
        const pct = total > 0 ? Math.round((used / total) * 100) : 0;
        const color = pct >= 90 ? '#ff4d4f' : pct >= 70 ? '#faad14' : '#52c41a';
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Text style={{ fontSize: 12 }}>{used} / {total}</Text>
            <Progress
              percent={pct}
              size="small"
              showInfo={false}
              strokeColor={color}
              style={{ margin: 0, lineHeight: 1 }}
            />
          </Space>
        );
      },
    },
    {
      title: '计费模式',
      key: 'chargeType',
      width: 90,
      render: (_: any, r: ZecCidrRow) => {
        const ct = r.chargeType || (r as any).charge_type || '';
        return CHARGE_TYPE_CN[ct] || ct || '—';
      },
    },
    { title: '创建时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
  ];

  return (
    <Spin spinning={loading}>
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="ZEC IP段总数" value={data.length} /></Card></Col>
        <Col><Card size="small"><Statistic title="筛选结果" value={filteredCount} /></Card></Col>
        <Col style={{ display: 'flex', alignItems: 'center' }}>
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
        </Col>
      </Row>
      <Table
        dataSource={data}
        columns={columns}
        rowKey="cidrId"
        size="small"
        pagination={{ defaultPageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
        onChange={(_, __, ___, extra) => setFilteredCount(extra.currentDataSource.length)}
      />
    </Spin>
  );
};

const VobTab: React.FC = () => {
  const [data, setData] = useState<BmcCidrRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filteredCount, setFilteredCount] = useState(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zen/announced/bmc');
      const json = await res.json();
      if (json.success) {
        setData(json.data || []);
        setFilteredCount((json.data || []).length);
      } else {
        message.error('获取 VOB IP 段失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const zoneFilters = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data) {
      if (r.zoneId && !map.has(r.zoneId)) {
        map.set(r.zoneId, r._zoneLabel || r.zoneId);
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([v, l]) => ({ text: `${l}${l !== v ? ` (${v})` : ''}`, value: v }));
  }, [data]);

  const statusFilters = useMemo(() => {
    const set = new Set(data.map(r => r.status).filter(Boolean));
    return [...set].sort().map(s => ({ text: BMC_STATUS_CN[s] || s, value: s }));
  }, [data]);

  const columns: ColumnType<BmcCidrRow>[] = [
    {
      title: 'IP段',
      key: 'cidr',
      width: 165,
      filterDropdown: makeCidrFilterDropdown('IP段'),
      filterIcon: (filtered: boolean) => <SearchOutlined style={{ color: filtered ? '#1677ff' : undefined }} />,
      onFilter: (value, record) => {
        const cidr = record.cidrBlock || record.cidrBlockName || '';
        const lines = String(value).split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) return true;
        return lines.some(c => cidr.includes(c));
      },
      render: (_: any, r: BmcCidrRow) => r.cidrBlock || r.cidrBlockName || '—',
    },
    { title: '名称', dataIndex: 'cidrBlockName', key: 'cidrBlockName', width: 160 },
    {
      title: '区域',
      key: 'zoneId',
      width: 150,
      filters: zoneFilters,
      filterMultiple: true,
      onFilter: (value, record) => record.zoneId === value,
      render: (_: any, r: BmcCidrRow) => {
        const label = r._zoneLabel || r.zoneId;
        return (
          <span>
            {label}
            {label !== r.zoneId && <Text type="secondary" style={{ fontSize: 11 }}> ({r.zoneId})</Text>}
          </span>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      filters: statusFilters,
      filterMultiple: true,
      onFilter: (value, record) => record.status === value,
      render: (s: string) => <Tag color={getStatusColor(s)}>{BMC_STATUS_CN[s] || s}</Tag>,
    },
    {
      title: '关联实例',
      key: 'instances',
      width: 100,
      render: (_: any, r: BmcCidrRow) =>
        (r.instanceIds?.length || 0) > 0
          ? <Tag color="blue">{r.instanceIds!.length} 个</Tag>
          : <Text type="secondary">无</Text>,
    },
    { title: '创建时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
  ];

  return (
    <Spin spinning={loading}>
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="VOB IP段总数" value={data.length} /></Card></Col>
        <Col><Card size="small"><Statistic title="筛选结果" value={filteredCount} /></Card></Col>
        <Col style={{ display: 'flex', alignItems: 'center' }}>
          <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
        </Col>
      </Row>
      <Table
        dataSource={data}
        columns={columns}
        rowKey="cidrBlockId"
        size="small"
        pagination={{ defaultPageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
        onChange={(_, __, ___, extra) => setFilteredCount(extra.currentDataSource.length)}
      />
    </Spin>
  );
};

const ZenAnnouncedList: React.FC = () => {
  const [tab, setTab] = useUrlTab(2, ['zec', 'vob'] as const, 'zec');
  return (
    <Tabs
      size="small"
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: 'zec', label: 'ZEC-IP段', children: <ZecTab /> },
        { key: 'vob', label: 'VOB-IP段', children: <VobTab /> },
      ]}
    />
  );
};

export default ZenAnnouncedList;
