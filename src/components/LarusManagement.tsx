import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Tag, Space, Alert, Typography, Input, Badge, Drawer, Descriptions, Spin,
} from 'antd';
import { ReloadOutlined, SearchOutlined, SyncOutlined, DownloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

const { Text, Link } = Typography;

interface LarusAllocation {
  asn: string;
  loa_path: string | null;
  alloc_id: number;
}

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
  // 详情字段（点击「详情」或「获取 ASN/LOA」后填充）
  asn?: string;
  loa_path?: string;
  allocations?: LarusAllocation[];
}

// route_status：0=未创建（Larus 黄点）、2=已创建（绿点）、其他=异常（红点）
const routeTag = (status: number, text?: string) => {
  if (status === 2) return <Tag color="green">已创建</Tag>;
  if (status === 0) return <Tag color="orange">未创建</Tag>;
  return <Tag color="red">{text || `状态${status}`}</Tag>;
};

// status 与 Larus 合同订单状态同源（已用 197 个合同交叉验证）：
// 3=active 生效中、4=expired 已过期、5=invalid 已失效
const STATUS_TEXT: Record<number, { label: string; color: string }> = {
  3: { label: '生效中', color: 'green' },
  4: { label: '已过期', color: 'red' },
  5: { label: '已失效', color: 'default' },
};

const statusTag = (status: number) => {
  const s = STATUS_TEXT[status];
  if (s) return <Tag color={s.color}>{s.label}</Tag>;
  return <Tag>{`状态${status}`}</Tag>;
};

const LarusManagement: React.FC = () => {
  const [items, setItems] = useState<LarusItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [cachedAt, setCachedAt] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [autoRenewed, setAutoRenewed] = useState(false);
  const [warning, setWarning] = useState('');
  const [configured, setConfigured] = useState(true);
  const [search, setSearch] = useState('');
  const [cookieInput, setCookieInput] = useState('');
  const [savingCookie, setSavingCookie] = useState(false);
  const [cookieDrawerOpen, setCookieDrawerOpen] = useState(false);

  // 详情抽屉
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<LarusItem | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadIps = useCallback(async (refresh = false) => {
    setLoading(true);
    setWarning('');
    setAutoRenewed(false);
    try {
      const res = await fetch(`/api/larus/ips${refresh ? '?refresh=1' : ''}`);
      const data = await res.json();
      if (!data.success) {
        if (data.message?.includes('Cookie') || data.message?.includes('401') || data.message?.includes('403')) {
          setConfigured(false);
          setCookieDrawerOpen(true);
        }
        setWarning(data.message || '加载失败');
        return;
      }
      setConfigured(true);
      setItems(data.items || []);
      setCachedAt(data.cachedAt || '');
      setFromCache(!!data.fromCache);
      setAutoRenewed(!!data.cookieAutoRenewed);
      if (data.warning) setWarning(data.warning);
    } catch (e: any) {
      setWarning(e.message);
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
        setCookieDrawerOpen(false);
        loadIps(true);
      }
    } finally {
      setSavingCookie(false);
    }
  };

  const openDetail = async (item: LarusItem) => {
    setDetailItem(item);
    setDetailData(null);
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/larus/detail?id=${item.id}`);
      const json = await res.json();
      // 回写 allocations（含多 ASN 支持）到 items 列表
      if (json?.allocations?.length) {
        setItems(prev => prev.map(it => it.id === item.id ? {
          ...it,
          allocations: json.allocations,
          asn: json.allocations[0]?.asn,
          loa_path: json.allocations[0]?.loa_path,
        } : it));
      } else {
        if (json?.asn) setItems(prev => prev.map(it => it.id === item.id ? { ...it, asn: String(json.asn) } : it));
        if (json?.loa_path) setItems(prev => prev.map(it => it.id === item.id ? { ...it, loa_path: json.loa_path } : it));
      }
      setDetailData(json);
    } catch { /* ignore */ } finally {
      setDetailLoading(false);
    }
  };

  const downloadLoa = (loaPath: string) => {
    window.open(`/api/larus/loa?path=${encodeURIComponent(loaPath)}`, '_blank');
  };

  const filtered = search
    ? items.filter(it => {
        const allAsns = it.allocations?.map(a => a.asn).join(' ') || it.asn || '';
        return it.ip_cidr.includes(search) || String(it.contract_id).includes(search) || allAsns.includes(search);
      })
    : items;

  const columns: ColumnsType<LarusItem> = [
    {
      title: 'IP 段',
      dataIndex: 'ip_cidr',
      key: 'ip_cidr',
      width: 175,
      fixed: 'left',
      render: (v: string) => <Text code style={{ whiteSpace: 'nowrap', fontSize: 13 }}>{v}</Text>,
      sorter: (a, b) => a.ip_cidr.localeCompare(b.ip_cidr),
    },
    {
      title: 'IP 数',
      dataIndex: 'total_ips',
      key: 'total_ips',
      width: 75,
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
      title: '路由状态',
      key: 'route_status',
      width: 100,
      render: (_: any, r: LarusItem) => routeTag(r.route_status, r.route_status_text),
      filters: [
        { text: '已创建', value: 2 },
        { text: '未创建', value: 0 },
      ],
      onFilter: (val, r) => r.route_status === Number(val),
    },
    {
      title: '租赁状态',
      dataIndex: 'status',
      key: 'status',
      width: 95,
      render: (v: number) => statusTag(v),
      filters: [
        { text: '生效中', value: 3 },
        { text: '已过期', value: 4 },
        { text: '已失效', value: 5 },
      ],
      onFilter: (val, r) => r.status === Number(val),
    },
    {
      title: 'ASN',
      key: 'asn',
      width: 130,
      render: (_: any, r: LarusItem) => {
        const allocs = r.allocations;
        if (allocs?.length) {
          return (
            <Space direction="vertical" size={2}>
              {allocs.map(a => <Text key={a.alloc_id} code style={{ fontSize: 12 }}>AS{a.asn}</Text>)}
            </Space>
          );
        }
        return r.asn ? <Text code>AS{r.asn}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
      },
    },
    {
      title: 'LOA',
      key: 'loa',
      width: 110,
      render: (_: any, r: LarusItem) => {
        const allocs = r.allocations;
        if (allocs?.length) {
          const withLoa = allocs.filter(a => a.loa_path);
          if (!withLoa.length) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
          return (
            <Space direction="vertical" size={2}>
              {withLoa.map(a => (
                <Button key={a.alloc_id} size="small" icon={<DownloadOutlined />} onClick={() => downloadLoa(a.loa_path!)}>
                  AS{a.asn}
                </Button>
              ))}
            </Space>
          );
        }
        return r.loa_path ? (
          <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadLoa(r.loa_path!)}>下载</Button>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
        );
      },
    },
    {
      title: '标记',
      key: 'flags',
      width: 80,
      render: (_: any, r: LarusItem) => (
        <Space size={4}>
          {r.duplicate_flag && <Tag color="orange" style={{ fontSize: 11 }}>Dup</Tag>}
          {r.api_created_flag && <Tag color="blue" style={{ fontSize: 11 }}>API</Tag>}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_: any, r: LarusItem) => (
        <Space>
          <Button size="small" onClick={() => openDetail(r)}>详情</Button>
          <Link href={`https://larus.net/ipv4/manage-leased-ips`} target="_blank" style={{ fontSize: 12 }}>
            平台
          </Link>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* Cookie 过期提示 */}
      {!configured && (
        <Alert
          type="error"
          showIcon
          message="Larus Session Cookie 未配置或已过期，请更新"
          action={<Button size="small" onClick={() => setCookieDrawerOpen(true)}>更新 Cookie</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      {warning && (
        <Alert
          type="warning"
          showIcon
          message={warning}
          style={{ marginBottom: 12 }}
          closable
          onClose={() => setWarning('')}
        />
      )}

      {/* 工具栏 */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索 IP段 / 合同 ID / ASN"
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
        <span style={{ flex: 1 }} />
        {autoRenewed && (
          <Badge status="processing" text={<Text style={{ fontSize: 12 }} type="secondary">Cookie 已自动续期</Text>} />
        )}
        {cachedAt && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {fromCache ? '读取缓存' : '已刷新'} · {new Date(cachedAt).toLocaleString('zh-CN')}
          </Text>
        )}
        <Button icon={<ReloadOutlined />} onClick={() => loadIps(true)} loading={loading}>刷新</Button>
        <Button icon={<SyncOutlined />} onClick={() => setCookieDrawerOpen(true)}>更新 Cookie</Button>
      </div>

      {/* IP 列表 */}
      <Table<LarusItem>
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        size="small"
        pagination={false}
        scroll={{ x: 900 }}
        summary={() => (
          <Table.Summary fixed="bottom">
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {filtered.length} 条{search ? `（过滤自 ${items.length} 条）` : ''}
                </Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} colSpan={7} align="right">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  合计 IP：{filtered.reduce((s, r) => s + r.total_ips, 0).toLocaleString()}
                </Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </Table.Summary>
        )}
      />

      {/* Cookie 更新抽屉 */}
      <Drawer
        title="更新 Larus Cookie"
        open={cookieDrawerOpen}
        onClose={() => setCookieDrawerOpen(false)}
        width={520}
        footer={
          <Space>
            <Button onClick={() => setCookieDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={savingCookie} disabled={!cookieInput.trim()} onClick={saveCookie}>
              保存并刷新
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          message="获取步骤"
          description={
            <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: '1.8' }}>
              <li>登录 <a href="https://larus.net/ipv4/manage-leased-ips" target="_blank" rel="noreferrer">larus.net</a></li>
              <li>F12 → Network → 过滤 <code>ip-list</code></li>
              <li>点击该请求 → Headers → Request Headers → Cookie</li>
              <li>复制完整 Cookie 字符串粘贴到下方</li>
            </ol>
          }
          style={{ marginBottom: 16 }}
        />
        <Input.TextArea
          rows={6}
          value={cookieInput}
          onChange={e => setCookieInput(e.target.value)}
          placeholder="粘贴完整 Cookie 字符串..."
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
        <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
          系统会自动通过 Set-Cookie 响应续期 Session，通常无需频繁更新。
          如 30 天内无访问导致 remember_me token 失效时才需重新粘贴。
        </Text>
      </Drawer>

      {/* 详情抽屉 */}
      <Drawer
        title={`IP 段详情 — ${detailItem?.ip_cidr}`}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={480}
      >
        {detailLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : detailData ? (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="IP 段">{detailItem?.ip_cidr}</Descriptions.Item>
              <Descriptions.Item label="IP 数">{detailItem?.total_ips}</Descriptions.Item>
              <Descriptions.Item label="合同 ID">{detailItem?.contract_id}</Descriptions.Item>
              <Descriptions.Item label="路由状态">{routeTag(detailItem?.route_status ?? 0, detailItem?.route_status_text)}</Descriptions.Item>
              <Descriptions.Item label="租赁状态">{statusTag(detailItem?.status ?? 0)}</Descriptions.Item>
              {detailData?.allocations?.length ? (
                <Descriptions.Item label="ASN / LOA">
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    {(detailData.allocations as LarusAllocation[]).map((a) => (
                      <div key={a.alloc_id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Text code>AS{a.asn}</Text>
                        {a.loa_path ? (
                          <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadLoa(a.loa_path!)}>
                            下载 LOA
                          </Button>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12 }}>无 LOA</Text>
                        )}
                      </div>
                    ))}
                  </Space>
                </Descriptions.Item>
              ) : (
                <>
                  {(detailData?.asn || detailItem?.asn) && (
                    <Descriptions.Item label="ASN">
                      <Text code>AS{detailData?.asn ?? detailItem?.asn}</Text>
                    </Descriptions.Item>
                  )}
                  {(detailData?.loa_path || detailItem?.loa_path) && (
                    <Descriptions.Item label="LOA">
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        onClick={() => downloadLoa(detailData?.loa_path || detailItem?.loa_path!)}
                      >
                        下载 LOA
                      </Button>
                    </Descriptions.Item>
                  )}
                </>
              )}
              {detailData?.irr_data && (
                <Descriptions.Item label="IRR 状态">
                  <Space size={4}>
                    <Tag color={detailData.irr_data.rpki === 'valid' ? 'green' : 'default'}>RPKI: {detailData.irr_data.rpki ?? '—'}</Tag>
                    <Tag color={detailData.irr_data.whois === 'valid' ? 'green' : 'default'}>Whois: {detailData.irr_data.whois ?? '—'}</Tag>
                    <Tag color={detailData.irr_data.radb === 'valid' ? 'green' : 'default'}>RADB: {detailData.irr_data.radb ?? '—'}</Tag>
                  </Space>
                </Descriptions.Item>
              )}
            </Descriptions>
          </>
        ) : (
          <Alert type="warning" message="加载详情失败，请重试" />
        )}
      </Drawer>
    </div>
  );
};

export default LarusManagement;
