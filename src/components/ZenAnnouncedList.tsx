import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Tabs, Table, Tag, Space, Input, Select, Button, message, Spin, Row, Col, Statistic, Card, Typography } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';

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

const ZecTab: React.FC = () => {
  const [data, setData] = useState<ZecCidrRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterCidr, setFilterCidr] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [filterAsn, setFilterAsn] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterNetwork, setFilterNetwork] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zen/announced/zec');
      const json = await res.json();
      if (json.success) {
        setData(json.data || []);
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

  const regionOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data) {
      if (r.regionId && !map.has(r.regionId)) {
        map.set(r.regionId, r._regionLabel || r.regionId);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([v, l]) => ({ label: `${l} (${v})`, value: v }));
  }, [data]);

  const statusOptions = useMemo(() => {
    const set = new Set(data.map(r => r.status).filter(Boolean));
    return [...set].sort().map(s => ({ label: ZEC_STATUS_CN[s] || s, value: s }));
  }, [data]);

  const networkOptions = useMemo(() => {
    const set = new Set(data.map(r => r.networkType).filter(Boolean));
    return [...set].sort().map(s => ({ label: NETWORK_TYPE_CN[s] || s, value: s }));
  }, [data]);

  const filtered = useMemo(() => {
    return data.filter(r => {
      if (filterCidr && !r.cidrBlock?.includes(filterCidr)) return false;
      if (filterRegion && r.regionId !== filterRegion) return false;
      if (filterAsn && !String(r.asn || '').includes(filterAsn)) return false;
      if (filterStatus && r.status !== filterStatus) return false;
      if (filterNetwork && r.networkType !== filterNetwork) return false;
      return true;
    });
  }, [data, filterCidr, filterRegion, filterAsn, filterStatus, filterNetwork]);

  const columns = [
    { title: 'IP段', dataIndex: 'cidrBlock', key: 'cidrBlock', width: 160 },
    {
      title: '区域', key: 'regionId', width: 180,
      render: (_: any, r: ZecCidrRow) => {
        const label = r._regionLabel || r.regionId;
        return <span>{label}{label !== r.regionId ? <Text type="secondary" style={{ fontSize: 11 }}> ({r.regionId})</Text> : ''}</span>;
      },
    },
    { title: 'ASN', dataIndex: 'asn', key: 'asn', width: 80 },
    {
      title: '网络类型', key: 'networkType', width: 100,
      render: (_: any, r: ZecCidrRow) => NETWORK_TYPE_CN[r.networkType || ''] || r.networkType || '-',
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 110,
      render: (s: string) => <Tag color={getStatusColor(s)}>{ZEC_STATUS_CN[s] || s}</Tag>,
    },
    {
      title: '已用/总量', key: 'usage', width: 100,
      render: (_: any, r: ZecCidrRow) => {
        const used = r.usedCount ?? (r as any).used_count;
        const total = r.totalCount ?? (r as any).total_count;
        return `${used ?? '-'}/${total ?? '-'}`;
      },
    },
    {
      title: '计费模式', key: 'chargeType', width: 90,
      render: (_: any, r: ZecCidrRow) => {
        const ct = r.chargeType || (r as any).charge_type || '';
        return CHARGE_TYPE_CN[ct] || ct || '-';
      },
    },
    { title: '创建时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
  ];

  return (
    <Spin spinning={loading}>
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="ZEC IP段总数" value={data.length} /></Card></Col>
        <Col><Card size="small"><Statistic title="筛选结果" value={filtered.length} /></Card></Col>
      </Row>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input placeholder="IP段" prefix={<SearchOutlined />} allowClear value={filterCidr} onChange={e => setFilterCidr(e.target.value)} style={{ width: 160 }} />
        <Select placeholder="区域" allowClear value={filterRegion || undefined} onChange={v => setFilterRegion(v || '')} options={regionOptions} style={{ width: 150 }} showSearch />
        <Input placeholder="ASN" allowClear value={filterAsn} onChange={e => setFilterAsn(e.target.value)} style={{ width: 100 }} />
        <Select placeholder="状态" allowClear value={filterStatus || undefined} onChange={v => setFilterStatus(v || '')} options={statusOptions} style={{ width: 150 }} />
        <Select placeholder="网络类型" allowClear value={filterNetwork || undefined} onChange={v => setFilterNetwork(v || '')} options={networkOptions} style={{ width: 140 }} />
        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
      </Space>
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey="cidrId"
        size="small"
        pagination={{ defaultPageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
      />
    </Spin>
  );
};

const VobTab: React.FC = () => {
  const [data, setData] = useState<BmcCidrRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterCidr, setFilterCidr] = useState('');
  const [filterZone, setFilterZone] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zen/announced/bmc');
      const json = await res.json();
      if (json.success) {
        setData(json.data || []);
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

  const zoneOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of data) {
      if (r.zoneId && !map.has(r.zoneId)) {
        map.set(r.zoneId, r._zoneLabel || r.zoneId);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([v, l]) => ({ label: `${l} (${v})`, value: v }));
  }, [data]);

  const statusOptions = useMemo(() => {
    const set = new Set(data.map(r => r.status).filter(Boolean));
    return [...set].sort().map(s => ({ label: BMC_STATUS_CN[s] || s, value: s }));
  }, [data]);

  const filtered = useMemo(() => {
    return data.filter(r => {
      const cidr = r.cidrBlock || r.cidrBlockName || '';
      if (filterCidr && !cidr.includes(filterCidr)) return false;
      if (filterZone && r.zoneId !== filterZone) return false;
      if (filterStatus && r.status !== filterStatus) return false;
      return true;
    });
  }, [data, filterCidr, filterZone, filterStatus]);

  const columns = [
    {
      title: 'IP段', key: 'cidr', width: 160,
      render: (_: any, r: BmcCidrRow) => r.cidrBlock || r.cidrBlockName || '-',
    },
    { title: '名称', dataIndex: 'cidrBlockName', key: 'cidrBlockName', width: 160 },
    {
      title: '区域', key: 'zoneId', width: 150,
      render: (_: any, r: BmcCidrRow) => {
        const label = r._zoneLabel || r.zoneId;
        return <span>{label}{label !== r.zoneId ? <Text type="secondary" style={{ fontSize: 11 }}> ({r.zoneId})</Text> : ''}</span>;
      },
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 110,
      render: (s: string) => <Tag color={getStatusColor(s)}>{BMC_STATUS_CN[s] || s}</Tag>,
    },
    {
      title: '关联实例', key: 'instances', width: 100,
      render: (_: any, r: BmcCidrRow) => (r.instanceIds?.length || 0) > 0
        ? <Tag color="blue">{r.instanceIds!.length} 个</Tag>
        : <Text type="secondary">无</Text>,
    },
    { title: '创建时间', dataIndex: 'createTime', key: 'createTime', width: 170 },
  ];

  return (
    <Spin spinning={loading}>
      <Row gutter={16} style={{ marginBottom: 12 }}>
        <Col><Card size="small"><Statistic title="VOB IP段总数" value={data.length} /></Card></Col>
        <Col><Card size="small"><Statistic title="筛选结果" value={filtered.length} /></Card></Col>
      </Row>
      <Space wrap style={{ marginBottom: 12 }}>
        <Input placeholder="IP段" prefix={<SearchOutlined />} allowClear value={filterCidr} onChange={e => setFilterCidr(e.target.value)} style={{ width: 160 }} />
        <Select placeholder="区域" allowClear value={filterZone || undefined} onChange={v => setFilterZone(v || '')} options={zoneOptions} style={{ width: 150 }} showSearch />
        <Select placeholder="状态" allowClear value={filterStatus || undefined} onChange={v => setFilterStatus(v || '')} options={statusOptions} style={{ width: 150 }} />
        <Button icon={<ReloadOutlined />} onClick={fetchData} loading={loading}>刷新</Button>
      </Space>
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey="cidrBlockId"
        size="small"
        pagination={{ defaultPageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
      />
    </Spin>
  );
};

const ZenAnnouncedList: React.FC = () => {
  return (
    <Tabs
      size="small"
      items={[
        { key: 'zec', label: 'ZEC-IP段', children: <ZecTab /> },
        { key: 'vob', label: 'VOB-IP段', children: <VobTab /> },
      ]}
    />
  );
};

export default ZenAnnouncedList;
