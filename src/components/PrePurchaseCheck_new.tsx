import React, { useState, useCallback, useMemo } from 'react';
import {
  Card, Row, Col, Button, Table, Tag, Space, Input, Select, InputNumber,
  Typography, Spin, Alert, Tooltip, Badge, Modal, message, Divider,
  Checkbox, Tabs, Form, Switch,
} from 'antd';
import {
  SearchOutlined, ShoppingCartOutlined, FilterOutlined, BugOutlined,
  ReloadOutlined, CheckCircleOutlined,
  WarningOutlined, CloudServerOutlined, TeamOutlined,
} from '@ant-design/icons';

const { Text, Title, Link } = Typography;

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface MarketItem {
  address: string;
  cidr: number;
  segment: string;       // address/cidr
  price: number;         // 月费 USD
  registry: string;      // ARIN / RIPE / APNIC �?  country?: string;
  city?: string;
  serviceUuid?: string;
  marketUuid?: string;
  // 检测结�?  abSegKey?: string;     // A.B �?  dupCount?: number;     // 已有�?AB 段数�?  abuseScore?: number | null;   // null=未检�?  abuseChecking?: boolean;
}

interface LeasedSegment {
  segment: string;
  address: string;
  cidr: number;
  status: string;
  nextDueDate: string | null;
  recurringAmount: number;
  serviceUuid: string;
  marketServiceUuid: string;
  registry: string;
  loa: { uuid: string; asn: number; asName: string; status: string }[];
  hasAsn: boolean;
  remark: string;
  projectGroups: string[];
  renewalStatus: string | null;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const REGISTRY_OPTIONS = [
  { label: '全部', value: '' },
  { label: 'ARIN', value: 'ARIN' },
  { label: 'RIPE', value: 'RIPE' },
  { label: 'APNIC', value: 'APNIC' },
  { label: 'LACNIC', value: 'LACNIC' },
  { label: 'AFRINIC', value: 'AFRINIC' },
];

const SORT_OPTIONS = [
  { label: '价格升序', value: 'price' },
  { label: '价格降序', value: 'price_desc' },
];

// ─── 主组�?───────────────────────────────────────────────────────────────────

const PrePurchaseCheck: React.FC = () => {
  // 搜索参数
  const [prefixLength, setPrefixLength] = useState(24);
  const [registry, setRegistry] = useState('');
  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState('price');
  const [limit, setLimit] = useState(100);

  // 数据
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);

  // 已有 IP 段的 A/B 段统�?  const [existingAbMap, setExistingAbMap] = useState<Map<string, number>>(new Map());

  // 选择
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // 智能筛�?  const [smartFilter, setSmartFilter] = useState(false);

  // 购物车状�?  const [cartVisible, setCartVisible] = useState(false);
  const [cart, setCart] = useState<any>(null);
  const [cartLoading, setCartLoading] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);

  // ── 已租�?IP 段列�?────────────────────────────────────────────────────
  const [leasedItems, setLeasedItems] = useState<LeasedSegment[]>([]);
  const [leasedLoading, setLeasedLoading] = useState(false);
  const [leasedTotal, setLeasedTotal] = useState(0);
  const [leasedPage, setLeasedPage] = useState(1);
  const [leasedPageSize, setLeasedPageSize] = useState(50);
  const [leasedNoAsnOnly, setLeasedNoAsnOnly] = useState(false);
  const [leasedSearch, setLeasedSearch] = useState('');
  const [leasedSearchInput, setLeasedSearchInput] = useState('');
  const [leasedCachedAt, setLeasedCachedAt] = useState('');
  const [leasedSelectedKeys, setLeasedSelectedKeys] = useState<string[]>([]);

  // LOA 设置 Modal
  const [loaModalVisible, setLoaModalVisible] = useState(false);
  const [loaAsn, setLoaAsn] = useState('');
  const [loaCompany, setLoaCompany] = useState('');
  const [loaAdding, setLoaAdding] = useState(false);

  // ── 加载已有 IP 段的 AB 段统�?──────────────────────────────────────────
  const loadExistingSegments = useCallback(async () => {
    try {
      const res = await fetch('/api/get-data');
      const json = res.ok ? await res.json() : {};
      const segs: any[] = json?.ipSegments || [];
      const map = new Map<string, number>();
      segs.forEach(s => {
        if (!s.segment || s.renewalStatus === 'cancelled') return;
        const parts = s.segment.split('.');
        if (parts.length >= 2) {
          const abKey = `${parts[0]}.${parts[1]}`;
          map.set(abKey, (map.get(abKey) || 0) + 1);
        }
      });
      setExistingAbMap(map);
    } catch (e) {
      console.error('加载现有 IP 段失�?', e);
    }
  }, []);

  // ── 搜索可购�?IP �?────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    setSearching(true);
    setItems([]);
    setSelectedKeys([]);
    try {
      await loadExistingSegments();
      const params = new URLSearchParams();
      params.set('prefix_length', String(prefixLength));
      if (registry) params.set('geo_region_code', registry); // registry filter
      if (priceMax) params.set('price_max', String(priceMax));
      params.set('sort', sortBy);
      params.set('limit', String(limit));

      const res = await fetch(`/api/ipxo/market/search?${params.toString()}`);
      const json = await res.json();

      if (!json.success) {
        message.error('搜索失败: ' + (json.message || json.data?.message || '未知错误'));
        return;
      }

      const rawItems: any[] = json.data?.data || json.data?.items || [];
      const mapped: MarketItem[] = rawItems.map((item: any) => {
        const addr = item.address || item.ip || '';
        const cidr = item.cidr || item.prefix_length || prefixLength;
        const seg = `${addr}/${cidr}`;
        const parts = addr.split('.');
        const abKey = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : '';
        return {
          address: addr,
          cidr,
          segment: seg,
          price: item.price || item.monthly_price || 0,
          registry: item.registry || item.rir || '',
          country: item.country || item.geo_country_code || '',
          city: item.city || item.geo_city || '',
          serviceUuid: item.service_uuid || item.uuid || '',
          marketUuid: item.market_uuid || '',
          abSegKey: abKey,
          dupCount: 0,
          abuseScore: null,
        };
      });

      // 计算重复 AB 段数�?      setExistingAbMap(prev => {
        const updated = mapped.map(m => ({
          ...m,
          dupCount: m.abSegKey ? (prev.get(m.abSegKey) || 0) : 0,
        }));
        setItems(updated);
        return prev;
      });

      if (mapped.length === 0) {
        message.info('未找到符合条件的 IP 段，请调整搜索条�?);
      } else {
        message.success(`找到 ${mapped.length} 个可购买 IP 段`);
      }
    } catch (e: any) {
      message.error('搜索异常: ' + e.message);
    } finally {
      setSearching(false);
    }
  }, [prefixLength, registry, priceMax, sortBy, limit, loadExistingSegments]);

  // ── AbuseIPDB 检测（通过后端代理，或直接打开网站）──────────────────────
  const handleCheckAbuse = useCallback(async (item: MarketItem) => {
    // 直接在新标签打开 AbuseIPDB 检测页�?    window.open(`https://www.abuseipdb.com/check-block/${item.segment}`, '_blank');
  }, []);

  const handleCheckAbuseSelected = useCallback(() => {
    if (selectedKeys.length === 0) {
      message.warning('请先选择要检测的 IP �?);
      return;
    }
    const selected = items.filter(i => selectedKeys.includes(i.segment));
    if (selected.length > 5) {
      Modal.confirm({
        title: '批量打开检测页�?,
        content: `将在新标签页中打开 ${selected.length} �?AbuseIPDB 检测页面，确认继续？`,
        onOk: () => {
          selected.forEach(item => {
            window.open(`https://www.abuseipdb.com/check-block/${item.segment}`, '_blank');
          });
        },
      });
    } else {
      selected.forEach(item => {
        window.open(`https://www.abuseipdb.com/check-block/${item.segment}`, '_blank');
      });
    }
  }, [selectedKeys, items]);

  // ── 智能筛选：每个 AB 段只保留一个（价格最低的）────────────────────────
  const smartFilteredItems = useMemo(() => {
    if (!smartFilter) return items;
    const seen = new Map<string, MarketItem>();
    for (const item of items) {
      const key = item.abSegKey || item.segment;
      const existing = seen.get(key);
      if (!existing || item.price < existing.price) {
        seen.set(key, item);
      }
    }
    return [...seen.values()];
  }, [items, smartFilter]);

  // ── 添加到购物车 ────────────────────────────────────────────────────────
  const handleAddToCart = useCallback(async () => {
    if (selectedKeys.length === 0) {
      message.warning('请先选择要加入购物车�?IP �?);
      return;
    }
    const selected = items.filter(i => selectedKeys.includes(i.segment));
    setAddingToCart(true);
    try {
      const res = await fetch('/api/ipxo/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selected.map(i => ({ address: i.address, cidr: i.cidr }))),
      });
      const json = await res.json();
      if (json.success) {
        const succeeded = json.results?.filter((r: any) => r.status === 200 || r.status === 201).length || 0;
        const failed = (json.results?.length || 0) - succeeded;
        if (succeeded > 0) message.success(`成功添加 ${succeeded} �?IP 段到购物车`);
        if (failed > 0) message.warning(`${failed} 个添加失败（可能已在购物车中或不可购买）`);
      } else {
        message.error('添加购物车失�? ' + json.message);
      }
    } catch (e: any) {
      message.error('添加购物车失�? ' + e.message);
    } finally {
      setAddingToCart(false);
    }
  }, [selectedKeys, items]);

  // ── 查看购物�?──────────────────────────────────────────────────────────
  const handleViewCart = useCallback(async () => {
    setCartLoading(true);
    setCartVisible(true);
    try {
      const res = await fetch('/api/ipxo/cart');
      const json = await res.json();
      setCart(json.success ? json.data : null);
      if (!json.success) message.error('获取购物车失�? ' + json.message);
    } catch (e: any) {
      message.error('获取购物车失�? ' + e.message);
    } finally {
      setCartLoading(false);
    }
  }, []);

  // ── 加载已租�?IP �?────────────────────────────────────────────────────
  const loadLeasedSegments = useCallback(async (
    page = leasedPage, pageSize = leasedPageSize,
    noAsnOnly = leasedNoAsnOnly, search = leasedSearch
  ) => {
    setLeasedLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
        ...(noAsnOnly ? { no_asn: '1' } : {}),
        ...(search ? { search } : {}),
      });
      const res = await fetch(`/api/ipxo/leased-segments?${params}`);
      const json = await res.json();
      if (json.success) {
        setLeasedItems(json.data || []);
        setLeasedTotal(json.total || 0);
        setLeasedCachedAt(json.cachedAt || '');
      } else {
        message.error('加载失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('加载失败: ' + e.message);
    } finally {
      setLeasedLoading(false);
    }
  }, [leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch]);

  // ── 添加 LOA 到购物车 ───────────────────────────────────────────────────
  const handleAddLoa = useCallback(async () => {
    if (!loaAsn.trim()) {
      message.warning('请输�?ASN 号码');
      return;
    }
    const subnets = leasedItems
      .filter(i => leasedSelectedKeys.includes(i.segment))
      .map(i => i.segment);
    if (subnets.length === 0) {
      message.warning('请先在已租用 IP 段列表中勾选要设置�?IP �?);
      return;
    }
    setLoaAdding(true);
    try {
      const res = await fetch('/api/ipxo/loa/add-to-cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asn: parseInt(loaAsn.replace(/[^0-9]/g, ''), 10),
          subnets,
          companyName: loaCompany,
        }),
      });
      const json = await res.json();
      if (json.success) {
        message.success(json.message);
        setLoaModalVisible(false);
        setLeasedSelectedKeys([]);
        // 提示用户去平台付�?        Modal.info({
          title: 'LOA 已加入购物车',
          content: (
            <div>
              <p>{json.message}</p>
              <p style={{ color: '#ff4d4f', fontWeight: 600 }}>
                ⚠️ 请前往 IPXO 平台完成支付，LOA 才会生效
              </p>
            </div>
          ),
          okText: '前往 IPXO 平台',
          onOk: () => window.open('https://portal.ipxo.com', '_blank'),
        });
      } else {
        message.error(json.message);
      }
    } catch (e: any) {
      message.error('操作失败: ' + e.message);
    } finally {
      setLoaAdding(false);
    }
  }, [loaAsn, loaCompany, leasedSelectedKeys, leasedItems]);

  // ── 统计 ────────────────────────────────────────────────────────────────
  const displayItems = smartFilteredItems;
  const selectedItems = displayItems.filter(i => selectedKeys.includes(i.segment));
  const totalSelectedFee = selectedItems.reduce((s, i) => s + i.price, 0);
  const dupItems = displayItems.filter(i => (i.dupCount || 0) > 0);

  // ── 表格�?──────────────────────────────────────────────────────────────
  const columns = [
    {
      title: 'IP �?,
      dataIndex: 'segment',
      key: 'segment',
      width: 160,
      render: (v: string) => (
        <Text style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>{v}</Text>
      ),
    },
    {
      title: 'A/B �?,
      key: 'ab',
      width: 100,
      render: (_: any, r: MarketItem) => {
        const dup = r.dupCount || 0;
        return (
          <Space direction="vertical" size={2}>
            <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.abSegKey}</Text>
            {dup > 0 ? (
              <Tag color="orange" style={{ fontSize: 11 }}>
                <WarningOutlined /> 已有 {dup} �?              </Tag>
            ) : (
              <Tag color="green" style={{ fontSize: 11 }}>
                <CheckCircleOutlined /> 无重�?              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: '月费 (USD)',
      dataIndex: 'price',
      key: 'price',
      width: 110,
      align: 'right' as const,
      sorter: (a: MarketItem, b: MarketItem) => a.price - b.price,
      render: (v: number) => (
        <Text style={{ fontWeight: 600, color: '#1677ff' }}>
          ${Number(v).toFixed(2)}
        </Text>
      ),
    },
    {
      title: 'RIR',
      dataIndex: 'registry',
      key: 'registry',
      width: 80,
      render: (v: string) => v ? <Tag>{v}</Tag> : '-',
    },
    {
      title: '地区',
      key: 'geo',
      width: 120,
      render: (_: any, r: MarketItem) => (
        <Text style={{ fontSize: 12 }}>
          {[r.country, r.city].filter(Boolean).join(' / ') || '-'}
        </Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: any, r: MarketItem) => (
        <Button
          size="small"
          icon={<BugOutlined />}
          onClick={() => handleCheckAbuse(r)}
          title="�?AbuseIPDB 检测此 IP 段滥用情�?
        >
          检测滥�?        </Button>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, background: '#f0f2f5', minHeight: '100vh' }}>
      {/* 页头 */}
      <div style={{ marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0 }}>
          <ShoppingCartOutlined style={{ color: '#1677ff', marginRight: 8 }} />
          购前检�?        </Title>
        <Text type="secondary">搜索 IPXO 市场可购�?IP 段，检测重�?AB 段、滥用情况，筛选后添加到购物车</Text>
      </div>

      <Tabs
        defaultActiveKey="market"
        items={[
          {
            key: 'market',
            label: <Space><SearchOutlined />市场搜索购买</Space>,
            children: (
              <div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle" wrap>
          <Col>
            <Text>前缀长度�?/Text>
            <Select
              value={prefixLength}
              onChange={setPrefixLength}
              style={{ width: 80 }}
              options={[
                { label: '/24', value: 24 },
                { label: '/23', value: 23 },
                { label: '/22', value: 22 },
                { label: '/21', value: 21 },
              ]}
            />
          </Col>
          <Col>
            <Text>RIR 筛选：</Text>
            <Select
              value={registry}
              onChange={setRegistry}
              style={{ width: 110 }}
              options={REGISTRY_OPTIONS}
            />
          </Col>
          <Col>
            <Text>最高月费：</Text>
            <InputNumber
              value={priceMax}
              onChange={v => setPriceMax(v)}
              min={0}
              precision={0}
              prefix="$"
              placeholder="不限"
              style={{ width: 100 }}
            />
          </Col>
          <Col>
            <Text>排序�?/Text>
            <Select
              value={sortBy}
              onChange={setSortBy}
              style={{ width: 110 }}
              options={SORT_OPTIONS}
            />
          </Col>
          <Col>
            <Text>返回数量�?/Text>
            <Select
              value={limit}
              onChange={setLimit}
              style={{ width: 90 }}
              options={[50, 100, 200, 500].map(v => ({ label: v, value: v }))}
            />
          </Col>
          <Col>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={searching}
              onClick={handleSearch}
            >
              搜索
            </Button>
          </Col>
        </Row>
      </Card>

      {/* 操作�?*/}
      {items.length > 0 && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Row justify="space-between" align="middle">
            <Space wrap>
              <Text>
                �?<strong>{displayItems.length}</strong> �?                {smartFilter && items.length !== displayItems.length && (
                  <Text type="secondary">（已�?{items.length} 个过滤）</Text>
                )}
              </Text>
              <Divider type="vertical" />
              <Checkbox
                checked={smartFilter}
                onChange={e => { setSmartFilter(e.target.checked); setSelectedKeys([]); }}
              >
                <Tooltip title="每个 A/B 段只保留价格最低的一个，减少同网段重�?>
                  <FilterOutlined /> 智能筛选（过滤重复 AB 段）
                </Tooltip>
              </Checkbox>
              {dupItems.length > 0 && (
                <Tag color="orange" icon={<WarningOutlined />}>
                  {dupItems.length} 个与现有 AB 段重�?                </Tag>
              )}
            </Space>
            <Space>
              {selectedKeys.length > 0 && (
                <>
                  <Text type="secondary">已�?{selectedKeys.length} 个，月费合计�?strong>${totalSelectedFee.toFixed(2)}</strong></Text>
                  <Button
                    icon={<BugOutlined />}
                    onClick={handleCheckAbuseSelected}
                  >
                    批量检测滥�?                  </Button>
                  <Button
                    type="primary"
                    icon={<ShoppingCartOutlined />}
                    loading={addingToCart}
                    onClick={handleAddToCart}
                  >
                    加入购物�?({selectedKeys.length})
                  </Button>
                </>
              )}
              <Button icon={<ShoppingCartOutlined />} onClick={handleViewCart}>
                查看购物�?              </Button>
            </Space>
          </Row>
        </Card>
      )}

      {/* 结果表格 */}
      <Card
        size="small"
        title={
          items.length > 0
            ? <Space>
                <Text>搜索结果</Text>
                <Badge count={displayItems.length} style={{ backgroundColor: '#1677ff' }} />
                {selectedKeys.length > 0 && (
                  <Tag color="blue">已�?{selectedKeys.length} �?/Tag>
                )}
              </Space>
            : '搜索结果'
        }
      >
        {items.length === 0 && !searching ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
            <SearchOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block' }} />
            设置搜索条件后点击「搜索」获取可购买 IP 段列�?          </div>
        ) : (
          <Table<MarketItem>
            loading={searching}
            dataSource={displayItems}
            columns={columns}
            rowKey="segment"
            size="small"
            scroll={{ x: 800 }}
            pagination={{
              pageSize: 50,
              showSizeChanger: true,
              pageSizeOptions: ['20', '50', '100'],
              showTotal: t => `�?${t} 条`,
            }}
            rowSelection={{
              selectedRowKeys: selectedKeys,
              onChange: keys => setSelectedKeys(keys as string[]),
              getCheckboxProps: () => ({}),
            }}
            rowClassName={(r) => (r.dupCount || 0) > 0 ? 'row-dup-ab' : ''}
          />
        )}
      </Card>
      {/* �?以上是第一�?Tab（市场搜索）的内容结�?*/}
      {/* 购物车弹�?—�?放在 Tabs 外，但此处暂时是占位，真正的 Modal 在下方渲染树�?*/}
                const total = cart.total || cart.data?.total || 0;
                if (cartItems.length === 0) {
                  return <div style={{ textAlign: 'center', padding: 32, color: '#999' }}>购物车为�?/div>;
                }
                return (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      message={`购物车共 ${cartItems.length} �?IP 段，总计�?$${Number(total).toFixed(2)}/月`}
                      style={{ marginBottom: 12 }}
                    />
                    <Table
                      dataSource={cartItems}
                      rowKey={(r, i) => r.uuid || r.service_uuid || String(i)}
                      size="small"
                      pagination={false}
                      columns={[
