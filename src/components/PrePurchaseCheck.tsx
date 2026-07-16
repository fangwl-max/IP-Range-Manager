import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
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
  registry: string;      // ARIN / RIPE / APNIC 等
  country?: string;
  city?: string;
  serviceUuid?: string;
  marketUuid?: string;
  // 检测结果
  abSegKey?: string;     // A.B 段
  dupCount?: number;     // 已有同 AB 段数量
  abuseScore?: number | null;   // null=未检测
  abuseChecking?: boolean;
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

// ─── 主组件 ───────────────────────────────────────────────────────────────────

const PrePurchaseCheck: React.FC = () => {
  // 搜索参数
  const [prefixLength, setPrefixLength] = useState(24);
  const [registry, setRegistry] = useState('');
  const [countryCode, setCountryCode] = useState('');  // 国家地区
  const [priceMin, setPriceMin] = useState<number | null>(null);  // 最低月费
  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState('price');
  const [limit, setLimit] = useState(100);

  // 数据
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  // AbuseIPDB 检测中的段集合
  const [checkingAbuse, setCheckingAbuse] = useState<Set<string>>(new Set());
  // AbuseIPDB API Key 是否已配置
  const [abuseKeySet, setAbuseKeySet] = useState<boolean | null>(null);
  const [abuseKeyInput, setAbuseKeyInput] = useState('');
  const [abuseKeyModalVisible, setAbuseKeyModalVisible] = useState(false);
  const [savingAbuseKey, setSavingAbuseKey] = useState(false);

  // 已有 IP 段的 A/B 段统计
  const [existingAbMap, setExistingAbMap] = useState<Map<string, number>>(new Map());

  // 选择
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // 智能筛选
  const [smartFilter, setSmartFilter] = useState(false);

  // 购物车状态
  const [cartVisible, setCartVisible] = useState(false);
  const [cart, setCart] = useState<any>(null);
  const [cartLoading, setCartLoading] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);

  // ── 已租用 IP 段列表 ────────────────────────────────────────────────────
  const [leasedItems, setLeasedItems] = useState<LeasedSegment[]>([]);
  const [leasedLoading, setLeasedLoading] = useState(false);
  const [leasedTotal, setLeasedTotal] = useState(0);    // 过滤后总数（后端返回）
  const [leasedGrandTotal, setLeasedGrandTotal] = useState(0); // 全部总数（不含过滤）
  const [leasedPage, setLeasedPage] = useState(1);
  const [leasedPageSize, setLeasedPageSize] = useState(50);
  const [leasedNoAsnOnly, setLeasedNoAsnOnly] = useState(false);
  const [leasedSearch, setLeasedSearch] = useState('');
  const [leasedSearchInput, setLeasedSearchInput] = useState('');
  const [leasedCachedAt, setLeasedCachedAt] = useState('');
  const [leasedSelectedKeys, setLeasedSelectedKeys] = useState<string[]>([]);
  const [leasedNoPaging, setLeasedNoPaging] = useState(false); // 取消分页模式
  const leasedDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // LOA 设置 Modal
  const [loaModalVisible, setLoaModalVisible] = useState(false);
  const [loaAsn, setLoaAsn] = useState('');
  const [loaCompany, setLoaCompany] = useState('');
  const [loaAdding, setLoaAdding] = useState(false);

  // ── 加载已有 IP 段的 AB 段统计（包含所有历史购买段，含已取消） ────────
  const loadExistingSegments = useCallback(async () => {
    try {
      const res = await fetch('/api/get-data');
      const json = res.ok ? await res.json() : {};
      const segs: any[] = json?.ipSegments || [];
      const map = new Map<string, number>();
      segs.forEach(s => {
        if (!s.segment) return;
        // 包含所有历史购买段，不排除已取消的
        const parts = s.segment.split('.');
        if (parts.length >= 2) {
          const abKey = `${parts[0]}.${parts[1]}`;
          map.set(abKey, (map.get(abKey) || 0) + 1);
        }
      });
      setExistingAbMap(map);
    } catch (e) {
      console.error('加载现有 IP 段失败:', e);
    }
  }, []);

  // ── 检查 AbuseIPDB API Key 是否已配置 ──────────────────────────────────
  const checkAbuseKey = useCallback(async () => {
    try {
      const res = await fetch('/api/ipxo/config');
      const json = await res.json();
      setAbuseKeySet(!!(json?.data?.abuseipdbApiKeySet));
    } catch (_) {
      setAbuseKeySet(false);
    }
  }, []);

  // 保存 AbuseIPDB API Key
  const handleSaveAbuseKey = useCallback(async () => {
    if (!abuseKeyInput.trim()) { message.warning('请输入 API Key'); return; }
    setSavingAbuseKey(true);
    try {
      const res = await fetch('/api/ipxo/config/abuseipdb-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ abuseipdbApiKey: abuseKeyInput.trim() }),
      });
      const json = await res.json();
      if (json.success) {
        message.success('AbuseIPDB API Key 已保存');
        setAbuseKeySet(true);
        setAbuseKeyModalVisible(false);
        setAbuseKeyInput('');
      } else {
        message.error(json.message || '保存失败');
      }
    } catch (e: any) {
      message.error('保存失败: ' + e.message);
    } finally {
      setSavingAbuseKey(false);
    }
  }, [abuseKeyInput]);

  // 页面加载时检查 Key 配置
  useEffect(() => { checkAbuseKey(); }, [checkAbuseKey]);

  // ── 搜索可购买 IP 段 ────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    setSearching(true);
    setItems([]);
    setSelectedKeys([]);
    try {
      await loadExistingSegments();
      const params = new URLSearchParams();
      params.set('prefix_length', String(prefixLength));
      // RIR 过滤（registrar 参数）
      if (registry) params.set('registrar', registry.toLowerCase());
      // 国家地区过滤
      if (countryCode) params.set('geo_country_code', countryCode.toUpperCase());
      // 价格范围
      if (priceMin) params.set('price_min', String(priceMin));
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
        // IPXO 市场 API 返回字段：
        // address_string: IP 地址字符串
        // prefix_length: CIDR 长度
        // notation: "1.2.3.0/24"
        // pricing.price: 月费
        // registrar: 注册局（ripencc/arin/apnic 等）
        // geo_data.dbip / ip2location 等: 地理信息
        const addr = item.address_string || item.notation?.split('/')[0] || '';
        const cidr = item.prefix_length ?? prefixLength;
        const seg = item.notation || `${addr}/${cidr}`;
        const parts = addr.split('.');
        const abKey = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : '';
        // 取多个地理数据源的国家和城市（优先 ipgeolocation）
        const geoSources = item.geo_data ? Object.values(item.geo_data) : [];
        const geoFirst: any = (geoSources.find((s: any) => s?.country_name) || geoSources[0] || {}) as any;
        const countryName = geoFirst?.country_name || geoFirst?.country_code || '';
        const cityName = geoFirst?.city_name || '';
        return {
          address: addr,
          cidr,
          segment: seg,
          price: item.pricing?.price || 0,
          registry: (item.registrar || '').toUpperCase(),
          country: countryName,
          city: cityName,
          serviceUuid: item.pricing?.uuid || '',
          marketUuid: item.notation || '',
          abSegKey: abKey,
          dupCount: 0,
          abuseScore: null,
        };
      });

      // 计算重复 AB 段数量
      setExistingAbMap(prev => {
        const updated = mapped.map(m => ({
          ...m,
          dupCount: m.abSegKey ? (prev.get(m.abSegKey) || 0) : 0,
        }));
        setItems(updated);
        return prev;
      });

      if (mapped.length === 0) {
        message.info('未找到符合条件的 IP 段，请调整搜索条件');
      } else {
        message.success(`找到 ${mapped.length} 个可购买 IP 段`);
      }
    } catch (e: any) {
      message.error('搜索异常: ' + e.message);
    } finally {
      setSearching(false);
    }
  }, [prefixLength, registry, countryCode, priceMin, priceMax, sortBy, limit, loadExistingSegments]);

  // ── AbuseIPDB 检测：调用后端代理获取滥用数据 ───────────────────────────
  const handleCheckAbuse = useCallback(async (item: MarketItem) => {
    if (!abuseKeySet) {
      setAbuseKeyModalVisible(true);
      return;
    }
    setCheckingAbuse(prev => new Set(prev).add(item.segment));
    try {
      const res = await fetch(`/api/abuse-check?segment=${encodeURIComponent(item.segment)}`);
      const json = await res.json();
      if (json.success && json.data != null) {
        setItems(prev => prev.map(i =>
          i.segment === item.segment
            ? { ...i, abuseScore: json.data.abuseConfidenceScore ?? 0, _abuseData: json.data }
            : i
        ));
      } else {
        message.error('检测失败: ' + (json.message || '未知错误'));
        if (json.message?.includes('API Key')) {
          setAbuseKeySet(false);
          setAbuseKeyModalVisible(true);
        }
      }
    } catch (e: any) {
      message.error('检测异常: ' + e.message);
    } finally {
      setCheckingAbuse(prev => { const s = new Set(prev); s.delete(item.segment); return s; });
    }
  }, [abuseKeySet]);

  const handleCheckAbuseSelected = useCallback(async () => {
    if (selectedKeys.length === 0) {
      message.warning('请先选择要检测的 IP 段');
      return;
    }
    const selected = items.filter(i => selectedKeys.includes(i.segment));
    // 逐个检测，每次间隔 500ms 避免频率限制
    for (const item of selected) {
      await handleCheckAbuse(item);
      if (selected.length > 1) await new Promise(r => setTimeout(r, 500));
    }
  }, [selectedKeys, items, handleCheckAbuse]);

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
      message.warning('请先选择要加入购物车的 IP 段');
      return;
    }
    const selected = items.filter(i => selectedKeys.includes(i.segment));
    setAddingToCart(true);
    try {
      const res = await fetch('/api/ipxo/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selected.map(i => ({ address: i.address, cidr: i.cidr, price: i.price, registry: i.registry }))),
      });
      const json = await res.json();
      if (json.success) {
        const succeeded = json.results?.filter((r: any) => r.status === 200 || r.status === 201).length || 0;
        const failed = (json.results?.length || 0) - succeeded;
        if (succeeded > 0) {
          message.success(`成功添加 ${succeeded} 个 IP 段到购物车`);
        }
        if (failed > 0) {
          const failedDetails = json.results
            ?.filter((r: any) => r.status !== 200 && r.status !== 201)
            .map((r: any) => `${r.address}/${r.cidr}: ${r.body?.message || r.status}`)
            .join('; ');
          message.warning(`${failed} 个添加失败（${failedDetails || '可能已在购物车或不可购买'}）`);
        }
        if (succeeded === 0 && failed === 0) {
          message.info('未返回结果，请检查 IP 段是否仍在市场中');
        }
      } else {
        message.error('添加购物车失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('添加购物车失败: ' + e.message);
    } finally {
      setAddingToCart(false);
    }
  }, [selectedKeys, items]);

  // ── 查看购物车 ──────────────────────────────────────────────────────────
  const handleViewCart = useCallback(async () => {
    setCartLoading(true);
    setCartVisible(true);
    try {
      const res = await fetch('/api/ipxo/cart');
      const json = await res.json();
      setCart(json.success ? json.data : null);
      if (!json.success) message.error('获取购物车失败: ' + json.message);
    } catch (e: any) {
      message.error('获取购物车失败: ' + e.message);
    } finally {
      setCartLoading(false);
    }
  }, []);

  // ── 加载已租用 IP 段 ────────────────────────────────────────────────────
  // search 支持多值：空格/逗号/换行分隔，后端对每个关键词做 OR 模糊匹配
  const loadLeasedSegments = useCallback(async (
    page = leasedPage, pageSize = leasedPageSize,
    noAsnOnly = leasedNoAsnOnly, search = leasedSearch,
    noPaging = leasedNoPaging
  ) => {
    setLeasedLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(noPaging ? 1 : page),
        page_size: String(noPaging ? 9999 : pageSize),
        ...(noAsnOnly ? { no_asn: '1' } : {}),
        ...(search.trim() ? { search: search.trim() } : {}),
      });
      const res = await fetch(`/api/ipxo/leased-segments?${params}`);
      const json = await res.json();
      if (json.success) {
        setLeasedItems(json.data || []);
        setLeasedTotal(json.total || 0);
        // 第一次加载（无过滤）时记录总数
        if (!noAsnOnly && !search.trim()) {
          setLeasedGrandTotal(json.total || 0);
        }
        setLeasedCachedAt(json.cachedAt || '');
      } else {
        message.error('加载失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('加载失败: ' + e.message);
    } finally {
      setLeasedLoading(false);
    }
  }, [leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch, leasedNoPaging]);

  // ── 添加 LOA 到购物车 ───────────────────────────────────────────────────
  const handleAddLoa = useCallback(async () => {
    if (!loaAsn.trim()) {
      message.warning('请输入 ASN 号码');
      return;
    }
    const subnets = leasedItems
      .filter(i => leasedSelectedKeys.includes(i.segment))
      .map(i => i.segment);
    if (subnets.length === 0) {
      message.warning('请先在已租用 IP 段列表中勾选要设置的 IP 段');
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
        // 提示用户去平台付款
        Modal.info({
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

  // ── 表格列 ──────────────────────────────────────────────────────────────
  const columns = [
    {
      title: 'IP 段',
      dataIndex: 'segment',
      key: 'segment',
      width: 160,
      render: (v: string) => (
        <Text style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>{v}</Text>
      ),
    },
    {
      title: 'A/B 段',
      key: 'ab',
      width: 100,
      render: (_: any, r: MarketItem) => {
        const dup = r.dupCount || 0;
        return (
          <Space direction="vertical" size={2}>
            <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.abSegKey}</Text>
            {dup > 0 ? (
              <Tag color="orange" style={{ fontSize: 11 }}>
                <WarningOutlined /> 已有 {dup} 个
              </Tag>
            ) : (
              <Tag color="green" style={{ fontSize: 11 }}>
                <CheckCircleOutlined /> 无重复
              </Tag>
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
      title: '滥用检测',
      key: 'abuse',
      width: 170,
      render: (_: any, r: MarketItem) => {
        const isChecking = checkingAbuse.has(r.segment);
        const abuseData = (r as any)._abuseData;
        return (
          <Space size={4} direction="vertical">
            {abuseKeySet === false ? (
              <Button size="small" icon={<BugOutlined />} onClick={() => setAbuseKeyModalVisible(true)} type="dashed">
                配置 API Key
              </Button>
            ) : (
              <Button
                size="small"
                icon={<BugOutlined />}
                loading={isChecking}
                onClick={() => handleCheckAbuse(r)}
              >
                {r.abuseScore != null ? '重新检测' : '检测滥用'}
              </Button>
            )}
            {r.abuseScore != null && (
              <Space direction="vertical" size={1}>
                <Tag
                  color={r.abuseScore === 0 ? 'green' : r.abuseScore < 25 ? 'orange' : 'red'}
                  style={{ fontSize: 11, marginBottom: 0 }}
                >
                  {r.abuseScore === 0 ? '✓ 无滥用记录' : `⚠ 评分 ${r.abuseScore}`}
                </Tag>
                {abuseData && (
                  <Space direction="vertical" size={0}>
                    <Text style={{ fontSize: 10, color: '#888' }}>
                      举报 {abuseData.totalReports} 次 / {abuseData.numDistinctUsers} 用户
                    </Text>
                    {abuseData.isp && <Text style={{ fontSize: 10, color: '#888' }}>{abuseData.isp}</Text>}
                    {abuseData.isWhitelisted && <Tag color="blue" style={{ fontSize: 10 }}>白名单</Tag>}
                  </Space>
                )}
              </Space>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ padding: 24, background: '#f0f2f5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0 }}>
          <ShoppingCartOutlined style={{ color: '#1677ff', marginRight: 8 }} />
          购前检测
        </Title>
        <Text type="secondary">搜索 IPXO 市场可购买 IP 段，检测重复 AB 段、滥用情况，筛选后添加到购物车</Text>
      </div>
      {abuseKeySet === false && (
        <Alert
          type="warning"
          showIcon
          message="AbuseIPDB API Key 未配置"
          description="配置 API Key 后可直接在页面内检测 IP 段滥用情况，无需跳转外部网站。"
          action={<Button size="small" onClick={() => setAbuseKeyModalVisible(true)}>立即配置</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      <Tabs
        defaultActiveKey="market"
        items={[
          {
            key: 'market',
            label: <Space><SearchOutlined />市场搜索购买</Space>,
            children: (
              <div>
                <Card size="small" style={{ marginBottom: 16 }}>
                  <Row gutter={[12, 8]} align="middle" wrap>
                    <Col>
                      <Text>前缀长度：</Text>
                      <Select value={prefixLength} onChange={setPrefixLength} style={{ width: 80 }}
                        options={[{label:'/24',value:24},{label:'/23',value:23},{label:'/22',value:22},{label:'/21',value:21}]} />
                    </Col>
                    <Col>
                      <Text>RIR：</Text>
                      <Select value={registry} onChange={setRegistry} style={{ width: 100 }} options={REGISTRY_OPTIONS} />
                    </Col>
                    <Col>
                      <Text>国家/地区：</Text>
                      <Input
                        value={countryCode}
                        onChange={e => setCountryCode(e.target.value)}
                        placeholder="如 US / CN"
                        style={{ width: 80 }}
                        maxLength={2}
                        allowClear
                      />
                    </Col>
                    <Col>
                      <Text>月费 $</Text>
                      <InputNumber value={priceMin} onChange={v => setPriceMin(v)} min={0} precision={0} placeholder="最低" style={{ width: 72 }} />
                      <Text> ~ </Text>
                      <InputNumber value={priceMax} onChange={v => setPriceMax(v)} min={0} precision={0} placeholder="最高" style={{ width: 72 }} />
                    </Col>
                    <Col>
                      <Text>排序：</Text>
                      <Select value={sortBy} onChange={setSortBy} style={{ width: 110 }} options={SORT_OPTIONS} />
                    </Col>
                    <Col>
                      <Text>返回数量：</Text>
                      <Select value={limit} onChange={setLimit} style={{ width: 90 }} options={[50,100,200,500,1000].map(v=>({label:v,value:v}))} />
                    </Col>
                    <Col>
                      <Button type="primary" icon={<SearchOutlined />} loading={searching} onClick={handleSearch}>搜索</Button>
                    </Col>
                  </Row>
                </Card>

                {items.length > 0 && (
                  <Card size="small" style={{ marginBottom: 16 }}>
                    <Row justify="space-between" align="middle">
                      <Space wrap>
                        <Text>共 <strong>{displayItems.length}</strong> 个
                          {smartFilter && items.length !== displayItems.length &&
                            <Text type="secondary">（已从 {items.length} 个过滤）</Text>}
                        </Text>
                        <Divider type="vertical" />
                        <Checkbox checked={smartFilter} onChange={e => { setSmartFilter(e.target.checked); setSelectedKeys([]); }}>
                          <Tooltip title="每个 A/B 段只保留价格最低的一个">
                            <FilterOutlined /> 智能筛选（过滤重复 AB 段）
                          </Tooltip>
                        </Checkbox>
                        {dupItems.length > 0 && <Tag color="orange" icon={<WarningOutlined />}>{dupItems.length} 个与现有 AB 段重复</Tag>}
                      </Space>
                      <Space>
                        {selectedKeys.length > 0 && <>
                          <Text type="secondary">已选 {selectedKeys.length} 个，月费：<strong>${totalSelectedFee.toFixed(2)}</strong></Text>
                          <Button onClick={() => setSelectedKeys([])}>取消全选</Button>
                          <Button icon={<BugOutlined />} onClick={handleCheckAbuseSelected}>批量检测滥用</Button>
                          <Button type="primary" icon={<ShoppingCartOutlined />} loading={addingToCart} onClick={handleAddToCart}>加入购物车 ({selectedKeys.length})</Button>
                        </>}
                        <Button icon={<ShoppingCartOutlined />} onClick={handleViewCart}>查看购物车</Button>
                      </Space>
                    </Row>
                  </Card>
                )}

                <Card size="small" title={
                  items.length > 0
                    ? <Space><Text>搜索结果</Text><Badge count={displayItems.length} style={{ backgroundColor: '#1677ff' }} />
                        {selectedKeys.length > 0 && <Tag color="blue">已选 {selectedKeys.length} 个</Tag>}
                      </Space>
                    : '搜索结果'
                }>
                  {items.length === 0 && !searching ? (
                    <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                      <SearchOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block' }} />
                      设置搜索条件后点击「搜索」获取可购买 IP 段列表
                    </div>
                  ) : (
                    <Table<MarketItem>
                      loading={searching} dataSource={displayItems} columns={columns} rowKey="segment"
                      size="small" scroll={{ x: 800 }}
                      pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: ['20','50','100'], showTotal: t => `共 ${t} 条` }}
                      rowSelection={{ selectedRowKeys: selectedKeys, onChange: keys => setSelectedKeys(keys as string[]) }}
                      rowClassName={(r) => (r.dupCount || 0) > 0 ? 'row-dup-ab' : ''}
                    />
                  )}
                </Card>
              </div>
            ),
          },
          {
            key: 'leased',
            label: <Space><CloudServerOutlined />已租用 IP 段</Space>,
            children: (
              <div>
                {/* 统计卡片 */}
                {(leasedGrandTotal > 0 || leasedLoading) && (
                  <Row gutter={12} style={{ marginBottom: 12 }}>
                    <Col><Card size="small" bodyStyle={{ padding: '8px 16px' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>总计</Text>
                      <div style={{ fontSize: 22, fontWeight: 700, color: '#1677ff' }}>{leasedGrandTotal}</div>
                    </Card></Col>
                    <Col><Card size="small" bodyStyle={{ padding: '8px 16px' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>已设置 ASN</Text>
                      <div style={{ fontSize: 22, fontWeight: 700, color: '#52c41a' }}>
                        {leasedNoAsnOnly || leasedSearch ? '-' : leasedItems.filter(i => i.hasAsn).length + (leasedNoPaging ? 0 : (leasedGrandTotal - leasedItems.length))}
                      </div>
                    </Card></Col>
                    <Col><Card size="small" bodyStyle={{ padding: '8px 16px' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>未设置 ASN</Text>
                      <div style={{ fontSize: 22, fontWeight: 700, color: '#ff4d4f' }}>
                        {leasedNoPaging && !leasedSearch ? leasedItems.filter(i => !i.hasAsn).length : '-'}
                      </div>
                    </Card></Col>
                    {leasedSearch.trim() && (
                      <Col><Card size="small" bodyStyle={{ padding: '8px 16px' }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>筛选结果</Text>
                        <div style={{ fontSize: 22, fontWeight: 700, color: '#fa8c16' }}>{leasedTotal}</div>
                      </Card></Col>
                    )}
                  </Row>
                )}

                {/* 工具栏 */}
                <Card size="small" style={{ marginBottom: 12 }}>
                  <Row gutter={[12, 8]} align="middle" wrap>
                    <Col span={24}>
                      <Input.TextArea
                        value={leasedSearchInput}
                        onChange={e => {
                          const v = e.target.value;
                          setLeasedSearchInput(v);
                          // 防抖自动搜索（600ms）
                          if (leasedDebounceRef.current) clearTimeout(leasedDebounceRef.current);
                          leasedDebounceRef.current = setTimeout(() => {
                            setLeasedSearch(v);
                            setLeasedPage(1);
                            setLeasedSelectedKeys([]);
                            loadLeasedSegments(1, leasedPageSize, leasedNoAsnOnly, v, leasedNoPaging);
                          }, 600);
                        }}
                        placeholder={'搜索 IP 段，支持多值（空格/逗号/换行分隔），输入后自动搜索\n例如：192.168  或  1.2.3.0/24, 4.5.6.0/24'}
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        allowClear
                        style={{ fontFamily: 'monospace', fontSize: 13 }}
                      />
                    </Col>
                    <Col>
                      <Switch
                        checked={leasedNoAsnOnly}
                        onChange={v => {
                          setLeasedNoAsnOnly(v); setLeasedPage(1); setLeasedSelectedKeys([]);
                          loadLeasedSegments(1, leasedPageSize, v, leasedSearch, leasedNoPaging);
                        }}
                        checkedChildren="仅无 ASN" unCheckedChildren="全部"
                      />
                    </Col>
                    <Col>
                      <Button
                        icon={leasedNoPaging ? <CheckCircleOutlined /> : undefined}
                        type={leasedNoPaging ? 'primary' : 'default'}
                        ghost={leasedNoPaging}
                        onClick={() => {
                          const next = !leasedNoPaging;
                          setLeasedNoPaging(next);
                          setLeasedPage(1);
                          setLeasedSelectedKeys([]);
                          loadLeasedSegments(1, leasedPageSize, leasedNoAsnOnly, leasedSearch, next);
                        }}
                      >
                        {leasedNoPaging ? '已取消分页' : '取消分页'}
                      </Button>
                    </Col>
                    <Col>
                      <Button icon={<ReloadOutlined />} loading={leasedLoading}
                        onClick={() => loadLeasedSegments(leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch, leasedNoPaging)}>
                        刷新
                      </Button>
                    </Col>
                    {leasedSelectedKeys.length > 0 && (
                      <Col>
                        <Button type="primary" icon={<TeamOutlined />} onClick={() => setLoaModalVisible(true)}>
                          设置 ASN（{leasedSelectedKeys.length} 个）
                        </Button>
                      </Col>
                    )}
                    {leasedCachedAt && (
                      <Col>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          缓存：{new Date(leasedCachedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                        </Text>
                      </Col>
                    )}
                  </Row>
                </Card>

                {leasedItems.length === 0 && !leasedLoading ? (
                  <Card>
                    <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
                      <CloudServerOutlined style={{ fontSize: 32, marginBottom: 8, display: 'block' }} />
                      点击「刷新」加载已租用 IP 段列表
                    </div>
                  </Card>
                ) : (
                  <Card size="small">
                    <Table<LeasedSegment>
                      loading={leasedLoading} dataSource={leasedItems} rowKey="segment"
                      size="small" scroll={{ x: 900, y: leasedNoPaging ? 600 : undefined }}
                      rowSelection={{ selectedRowKeys: leasedSelectedKeys, onChange: keys => setLeasedSelectedKeys(keys as string[]) }}
                      pagination={leasedNoPaging ? false : {
                        current: leasedPage, pageSize: leasedPageSize, total: leasedTotal,
                        showTotal: t => `共 ${t} 个`, showSizeChanger: true, pageSizeOptions: ['20','50','100','200'],
                        onChange: (p, ps) => { setLeasedPage(p); setLeasedPageSize(ps); setLeasedSelectedKeys([]); loadLeasedSegments(p, ps, leasedNoAsnOnly, leasedSearch, false); },
                      }}
                      columns={[
                        { title: 'IP 段', dataIndex: 'segment', key: 'segment', width: 160,
                          render: (v: string) => <Text style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13 }}>{v}</Text> },
                        { title: 'ASN', key: 'asn', width: 220,
                          render: (_: any, r: LeasedSegment) => r.loa.length > 0
                            ? <Space direction="vertical" size={2}>
                                {r.loa.map(l => <Space key={l.uuid} size={4}>
                                  <Tag color={l.status === 'Active' ? 'green' : 'orange'} style={{ fontSize: 11 }}>AS{l.asn}</Tag>
                                  <Text style={{ fontSize: 11 }} type="secondary">{l.asName}</Text>
                                </Space>)}
                              </Space>
                            : <Tag color="red" icon={<WarningOutlined />}>未设置 ASN</Tag> },
                        { title: '月费', dataIndex: 'recurringAmount', key: 'recurringAmount', width: 100, align: 'right' as const,
                          render: (v: number) => v != null ? `$${Number(v).toFixed(2)}` : '-' },
                        { title: 'RIR', dataIndex: 'registry', key: 'registry', width: 80,
                          render: (v: string) => v ? <Tag>{v.toUpperCase()}</Tag> : '-' },
                        { title: '续费日', dataIndex: 'nextDueDate', key: 'nextDueDate', width: 110,
                          render: (v: string) => v || '-' },
                        { title: '项目组', key: 'projectGroups', width: 140,
                          render: (_: any, r: LeasedSegment) => r.projectGroups.length > 0
                            ? <Space wrap size={2}>{r.projectGroups.map(g => <Tag key={g} style={{ fontSize: 11 }}>{g}</Tag>)}</Space>
                            : <Text type="secondary" style={{ fontSize: 11 }}>-</Text> },
                        { title: '备注', dataIndex: 'remark', key: 'remark',
                          render: (v: string) => v ? <Text style={{ fontSize: 12 }}>{v}</Text> : <Text type="secondary" style={{ fontSize: 12 }}>-</Text> },
                      ]}
                      rowClassName={(r) => !r.hasAsn ? 'row-no-asn' : ''}
                    />
                  </Card>
                )}

                <Modal
                  title={<Space><TeamOutlined />为选中 IP 段设置 ASN</Space>}
                  open={loaModalVisible}
                  onCancel={() => setLoaModalVisible(false)}
                  onOk={handleAddLoa}
                  confirmLoading={loaAdding}
                  okText="验证并加入购物车"
                  cancelText="取消"
                  width={560}
                >
                  <Alert type="info" showIcon message="操作说明"
                    description="填写 ASN 后系统将调用 IPXO API 验证，并将 LOA 加入购物车。请前往 IPXO 平台（portal.ipxo.com）完成支付，LOA 才会生效。"
                    style={{ marginBottom: 16 }}
                  />
                  <div style={{ marginBottom: 12 }}>
                    <Text type="secondary">已选 IP 段（{leasedSelectedKeys.length} 个）：</Text>
                    <div style={{ maxHeight: 120, overflowY: 'auto', marginTop: 6, padding: '6px 8px', background: '#f5f5f5', borderRadius: 4 }}>
                      {leasedItems.filter(i => leasedSelectedKeys.includes(i.segment)).map(i => (
                        <Tag key={i.segment} style={{ fontFamily: 'monospace', marginBottom: 4 }}>{i.segment}</Tag>
                      ))}
                    </div>
                  </div>
                  <Form layout="vertical">
                    <Form.Item label="ASN 号码" required>
                      <Input value={loaAsn} onChange={e => setLoaAsn(e.target.value)} placeholder="例如：25198 或 AS25198" prefix="AS" />
                    </Form.Item>
                    <Form.Item label="公司名称（可选）">
                      <Input value={loaCompany} onChange={e => setLoaCompany(e.target.value)} placeholder="填写公司/组织名称（可留空）" />
                    </Form.Item>
                  </Form>
                </Modal>
              </div>
            ),
          },
        ]}
      />

      {/* 购物车弹窗 */}
      <Modal
        title={<Space><ShoppingCartOutlined />IPXO 购物车（本地记录）</Space>}
        open={cartVisible}
        onCancel={() => setCartVisible(false)}
        footer={[
          <Button key="close" onClick={() => setCartVisible(false)}>关闭</Button>,
          <Button key="refresh" icon={<ReloadOutlined />} loading={cartLoading} onClick={handleViewCart}>刷新</Button>,
          <Button key="clear" danger onClick={async () => {
            await fetch('/api/ipxo/cart', { method: 'DELETE' });
            message.success('本地购物车记录已清空');
            handleViewCart();
          }}>清空记录</Button>,
          <Button key="open" type="primary" onClick={() => window.open('https://portal.ipxo.com', '_blank')}>前往 IPXO 平台结算</Button>,
        ]}
        width={700}
      >
        <Spin spinning={cartLoading}>
          {cart ? (
            <div>
              {(() => {
                const cartItems: any[] = cart.items || [];
                if (cartItems.length === 0) return (
                  <div style={{ textAlign: 'center', padding: 32, color: '#999' }}>
                    <ShoppingCartOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
                    购物车为空，请在搜索结果中勾选 IP 段并点击「加入购物车」
                  </div>
                );
                const totalFee = cartItems.reduce((s, i) => s + (Number(i.price) || 0), 0);
                return (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      message={`购物车共 ${cartItems.length} 个 IP 段${totalFee > 0 ? `，月费合计约 $${totalFee.toFixed(2)}` : ''}`}
                      description="以下为本地记录，实际购物车状态请前往 IPXO 平台确认。成功结算后可点击「清空记录」。"
                      style={{ marginBottom: 12 }}
                    />
                    <Table
                      dataSource={cartItems}
                      rowKey={(r: any, i: any) => r.segment || String(i)}
                      size="small"
                      pagination={false}
                      columns={[
                        { title: 'IP 段', dataIndex: 'segment', key: 'segment', render: (v: string) => <Text style={{ fontFamily: 'monospace', fontWeight: 600 }}>{v}</Text> },
                        { title: '月费', dataIndex: 'price', key: 'price', align: 'right' as const, render: (v: number) => v ? `$${Number(v).toFixed(2)}` : '-' },
                        { title: 'RIR', dataIndex: 'registry', key: 'registry', render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
                        { title: '加入时间', dataIndex: 'addedAt', key: 'addedAt', render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-' },
                      ]}
                    />
                  </>
                );
              })()}
            </div>
          ) : (
            !cartLoading && <Alert type="warning" message="无法读取购物车记录" />
          )}
        </Spin>
      </Modal>

      {/* AbuseIPDB API Key 配置弹窗 */}
      <Modal
        title={<Space><BugOutlined />配置 AbuseIPDB API Key</Space>}
        open={abuseKeyModalVisible}
        onCancel={() => setAbuseKeyModalVisible(false)}
        onOk={handleSaveAbuseKey}
        confirmLoading={savingAbuseKey}
        okText="保存"
        cancelText="取消"
        width={500}
      >
        <Alert
          type="info"
          showIcon
          message="获取免费 API Key"
          description={
            <span>
              访问 <a href="https://www.abuseipdb.com/account/api" target="_blank" rel="noreferrer">abuseipdb.com/account/api</a> 注册账号并获取免费 API Key（每天 1000 次查询）。
              填入后即可在当前页面直接检测 IP 段的滥用情况。
            </span>
          }
          style={{ marginBottom: 16 }}
        />
        <Input
          value={abuseKeyInput}
          onChange={e => setAbuseKeyInput(e.target.value)}
          placeholder="粘贴 AbuseIPDB API Key"
          allowClear
        />
      </Modal>

      <style>{`
        .row-dup-ab { background: #fffbe6; }
        .row-dup-ab:hover td { background: #fff7cc !important; }
        .row-no-asn { background: #fff2f0; }
        .row-no-asn:hover td { background: #ffe7e0 !important; }
      `}</style>
    </div>
  );
};

export default PrePurchaseCheck;

