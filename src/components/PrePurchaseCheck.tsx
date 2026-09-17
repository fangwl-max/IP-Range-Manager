import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  Card, Row, Col, Button, Table, Tag, Space, Input, Select, InputNumber,
  Typography, Spin, Alert, Tooltip, Badge, Modal, message, Divider,
  Checkbox, Tabs, Form, Switch, Popconfirm, Radio, List, Result, Empty,
} from 'antd';
import {
  SearchOutlined, ShoppingCartOutlined, FilterOutlined, BugOutlined,
  ReloadOutlined, CheckCircleOutlined,
  WarningOutlined, CloudServerOutlined, TeamOutlined, CopyOutlined, LinkOutlined,
  DeleteOutlined, StopOutlined, ExclamationCircleOutlined, CheckOutlined, CloseOutlined,
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
  purchaseDate: string;
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

const COUNTRY_OPTIONS = [
  { label: '全部', value: '' },
  { label: '美国 (US)', value: 'US' },
  { label: '英国 (GB)', value: 'GB' },
  { label: '德国 (DE)', value: 'DE' },
  { label: '法国 (FR)', value: 'FR' },
  { label: '荷兰 (NL)', value: 'NL' },
  { label: '加拿大 (CA)', value: 'CA' },
  { label: '澳大利亚 (AU)', value: 'AU' },
  { label: '日本 (JP)', value: 'JP' },
  { label: '新加坡 (SG)', value: 'SG' },
  { label: '韩国 (KR)', value: 'KR' },
  { label: '中国 (CN)', value: 'CN' },
  { label: '中国香港 (HK)', value: 'HK' },
  { label: '中国台湾 (TW)', value: 'TW' },
  { label: '印度 (IN)', value: 'IN' },
  { label: '巴西 (BR)', value: 'BR' },
  { label: '俄罗斯 (RU)', value: 'RU' },
  { label: '南非 (ZA)', value: 'ZA' },
  { label: '瑞士 (CH)', value: 'CH' },
  { label: '瑞典 (SE)', value: 'SE' },
  { label: '挪威 (NO)', value: 'NO' },
  { label: '芬兰 (FI)', value: 'FI' },
  { label: '丹麦 (DK)', value: 'DK' },
  { label: '爱尔兰 (IE)', value: 'IE' },
  { label: '意大利 (IT)', value: 'IT' },
  { label: '西班牙 (ES)', value: 'ES' },
  { label: '葡萄牙 (PT)', value: 'PT' },
  { label: '波兰 (PL)', value: 'PL' },
  { label: '捷克 (CZ)', value: 'CZ' },
  { label: '罗马尼亚 (RO)', value: 'RO' },
  { label: '保加利亚 (BG)', value: 'BG' },
  { label: '奥地利 (AT)', value: 'AT' },
  { label: '比利时 (BE)', value: 'BE' },
  { label: '卢森堡 (LU)', value: 'LU' },
  { label: '乌克兰 (UA)', value: 'UA' },
  { label: '土耳其 (TR)', value: 'TR' },
  { label: '以色列 (IL)', value: 'IL' },
  { label: '阿联酋 (AE)', value: 'AE' },
  { label: '墨西哥 (MX)', value: 'MX' },
  { label: '阿根廷 (AR)', value: 'AR' },
  { label: '智利 (CL)', value: 'CL' },
  { label: '哥伦比亚 (CO)', value: 'CO' },
  { label: '印度尼西亚 (ID)', value: 'ID' },
  { label: '泰国 (TH)', value: 'TH' },
  { label: '马来西亚 (MY)', value: 'MY' },
  { label: '越南 (VN)', value: 'VN' },
  { label: '菲律宾 (PH)', value: 'PH' },
  { label: '新西兰 (NZ)', value: 'NZ' },
  { label: '尼日利亚 (NG)', value: 'NG' },
  { label: '肯尼亚 (KE)', value: 'KE' },
  { label: '埃及 (EG)', value: 'EG' },
  { label: '立陶宛 (LT)', value: 'LT' },
  { label: '拉脱维亚 (LV)', value: 'LV' },
  { label: '爱沙尼亚 (EE)', value: 'EE' },
  { label: '匈牙利 (HU)', value: 'HU' },
  { label: '斯洛伐克 (SK)', value: 'SK' },
  { label: '克罗地亚 (HR)', value: 'HR' },
  { label: '塞尔维亚 (RS)', value: 'RS' },
  { label: '冰岛 (IS)', value: 'IS' },
];

// ─── 主组件 ───────────────────────────────────────────────────────────────────

const PrePurchaseCheck: React.FC = () => {
  const [activeTab, setActiveTab] = useUrlTab(1, ['market', 'lookup', 'leased'] as const, 'market');
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
  const [existingSegmentSet, setExistingSegmentSet] = useState<Set<string>>(new Set());
  const [existingAbHistory, setExistingAbHistory] = useState<Map<string, { segment: string; purchaseDate: string }[]>>(new Map());

  // 选择
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  // 智能筛选
  const [smartFilterModalVisible, setSmartFilterModalVisible] = useState(false);
  const [sfDedupAb, setSfDedupAb] = useState(true);
  const [sfDedupKeepCount, setSfDedupKeepCount] = useState(1);
  const [sfDedupSortBy, setSfDedupSortBy] = useState<'price_asc' | 'price_desc'>('price_asc');
  const [sfExcludeExisting, setSfExcludeExisting] = useState(false);
  const [sfExcludeExistingSegment, setSfExcludeExistingSegment] = useState(true);
  const [sfNoAbuse, setSfNoAbuse] = useState(false);
  const [sfNoPurchaseDays, setSfNoPurchaseDays] = useState<number | null>(null);
  const [sfPriceFilterMin, setSfPriceFilterMin] = useState<number | null>(null);
  const [sfPriceFilterMax, setSfPriceFilterMax] = useState<number | null>(null);
  const smartFilterActiveCount = useMemo(() => {
    let c = 0;
    if (sfDedupAb) c++;
    if (sfExcludeExisting) c++;
    if (sfExcludeExistingSegment) c++;
    if (sfNoAbuse) c++;
    if (sfNoPurchaseDays != null) c++;
    if (sfPriceFilterMin != null || sfPriceFilterMax != null) c++;
    return c;
  }, [sfDedupAb, sfExcludeExisting, sfExcludeExistingSegment, sfNoAbuse, sfNoPurchaseDays, sfPriceFilterMin, sfPriceFilterMax]);

  // 购物车状态
  const [cartVisible, setCartVisible] = useState(false);
  const [cart, setCart] = useState<any>(null);
  const [cartLoading, setCartLoading] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);
  const [cartAddedSegments, setCartAddedSegments] = useState<Set<string>>(new Set());

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

  // LOA 移除（取消 ASN 授权）
  const [removingLoaKey, setRemovingLoaKey] = useState<string | null>(null);

  // 取消续费 Modal
  const [cancelRenewalVisible, setCancelRenewalVisible] = useState(false);
  const [cancelRenewalLoading, setCancelRenewalLoading] = useState(false);
  const [cancelType, setCancelType] = useState<'end_of_period' | 'immediate'>('end_of_period');
  const [cancelReason, setCancelReason] = useState('End of project');
  const [cancelResults, setCancelResults] = useState<{ subnet: string; ok: boolean; message: string }[]>([]);

  // ── 精准查询 state ────────────────────────────────────────────────────
  const [lookupInput, setLookupInput] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResults, setLookupResults] = useState<{
    notation: string; available: boolean; price?: number;
    registry?: string; country?: string; city?: string; serviceUuid?: string; error?: string;
  }[]>([]);
  const [lookupSelectedKeys, setLookupSelectedKeys] = useState<string[]>([]);
  const [addingLookupToCart, setAddingLookupToCart] = useState(false);

  // ── 通用复制工具 ─────────────────────────────────────────────────────
  const copyText = useCallback((text: string, label?: string) => {
    const doFallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      message.success(label ? `已复制: ${label}` : '已复制');
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => message.success(label ? `已复制: ${label}` : '已复制'))
        .catch(doFallback);
    } else {
      doFallback();
    }
  }, []);

  // ── 加载已有 IP 段的 AB 段统计（包含所有历史购买段，含已取消） ────────
  const loadExistingSegments = useCallback(async () => {
    try {
      const res = await fetch('/api/get-data');
      const json = res.ok ? await res.json() : {};
      const segs: any[] = json?.ipSegments || [];
      const map = new Map<string, number>();
      const segSet = new Set<string>();
      const historyMap = new Map<string, { segment: string; purchaseDate: string }[]>();
      segs.forEach(s => {
        if (!s.segment) return;
        segSet.add(s.segment.trim());
        const parts = s.segment.split('.');
        if (parts.length >= 2) {
          const abKey = `${parts[0]}.${parts[1]}`;
          map.set(abKey, (map.get(abKey) || 0) + 1);
          const arr = historyMap.get(abKey) || [];
          arr.push({ segment: s.segment.trim(), purchaseDate: s.purchaseDate || s.createdAt || '' });
          historyMap.set(abKey, arr);
        }
      });
      // 按购买日期降序排列（最近的在前）
      for (const [, arr] of historyMap) {
        arr.sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
      }
      setExistingAbMap(map);
      setExistingSegmentSet(segSet);
      setExistingAbHistory(historyMap);
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
    setCartAddedSegments(new Set());
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

  // ── 精准查询：查询指定 IP 段是否在 IPXO 市场可租用 ────────────────────
  const handleLookup = useCallback(async () => {
    const lines = lookupInput.split(/[\n,，；; ]+/).map(s => s.trim()).filter(s => /^[\d.]+\/\d+$/.test(s));
    if (lines.length === 0) { message.warning('请输入至少一个有效 IP 段，格式如 1.2.3.0/24'); return; }
    setLookupLoading(true);
    setLookupResults([]);
    setLookupSelectedKeys([]);
    try {
      const res = await fetch('/api/ipxo/market/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notations: lines }),
      });
      const json = await res.json();
      if (json.success) {
        setLookupResults(json.results || []);
        const available = (json.results || []).filter((r: any) => r.available).length;
        if (available > 0) message.success(`找到 ${available}/${lines.length} 个 IP 段可租用`);
        else message.info(`查询完成，${lines.length} 个 IP 段均未在市场中找到`);
      } else {
        message.error('查询失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('查询异常: ' + e.message);
    } finally {
      setLookupLoading(false);
    }
  }, [lookupInput]);

  const handleAddLookupToCart = useCallback(async () => {
    const selected = lookupResults.filter(r => r.available && lookupSelectedKeys.includes(r.notation));
    if (selected.length === 0) { message.warning('请先勾选可租用的 IP 段'); return; }
    setAddingLookupToCart(true);
    try {
      const res = await fetch('/api/ipxo/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selected.map(i => ({
          address: i.notation.split('/')[0],
          cidr: parseInt(i.notation.split('/')[1] || '24', 10),
          price: i.price || 0,
          registry: i.registry || '',
        }))),
      });
      const json = await res.json();
      if (json.success) {
        const succeeded = json.results?.filter((r: any) => (r.status >= 200 && r.status < 300) || r.uncertain).length || 0;
        if (succeeded > 0) {
          message.success(`成功添加 ${succeeded} 个 IP 段到购物车`);
          setLookupSelectedKeys([]);
        } else {
          message.warning('添加失败，可能已在购物车或不可购买');
        }
      } else {
        message.error('添加失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('添加失败: ' + e.message);
    } finally {
      setAddingLookupToCart(false);
    }
  }, [lookupResults, lookupSelectedKeys]);

  // ── 智能筛选：多条件组合 ────────────────────────────────────────────────
  const smartFilteredItems = useMemo(() => {
    if (smartFilterActiveCount === 0) return items;
    let result = [...items];
    if (sfExcludeExistingSegment) {
      result = result.filter(i => !existingSegmentSet.has(i.segment));
    }
    if (sfExcludeExisting) {
      result = result.filter(i => (i.dupCount || 0) === 0);
    }
    if (sfNoAbuse) {
      result = result.filter(i => i.abuseScore == null || i.abuseScore === 0);
    }
    if (sfNoPurchaseDays != null) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - sfNoPurchaseDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      result = result.filter(i => {
        const records = existingAbHistory.get(i.abSegKey || '') || [];
        if (records.length === 0) return true;
        return records.every(rec => (rec.purchaseDate?.slice(0, 10) || '') < cutoffStr);
      });
    }
    if (sfPriceFilterMin != null) {
      result = result.filter(i => i.price >= sfPriceFilterMin);
    }
    if (sfPriceFilterMax != null) {
      result = result.filter(i => i.price <= sfPriceFilterMax);
    }
    if (sfDedupAb) {
      const groups = new Map<string, MarketItem[]>();
      for (const item of result) {
        const key = item.abSegKey || item.segment;
        const arr = groups.get(key) || [];
        arr.push(item);
        groups.set(key, arr);
      }
      result = [];
      for (const arr of groups.values()) {
        arr.sort((a, b) => sfDedupSortBy === 'price_asc' ? a.price - b.price : b.price - a.price);
        result.push(...arr.slice(0, sfDedupKeepCount));
      }
    }
    return result;
  }, [items, smartFilterActiveCount, sfDedupAb, sfDedupKeepCount, sfDedupSortBy, sfExcludeExisting, sfExcludeExistingSegment, existingSegmentSet, sfNoAbuse, sfNoPurchaseDays, existingAbHistory, sfPriceFilterMin, sfPriceFilterMax]);

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
        const succeeded = json.results?.filter((r: any) => (r.status >= 200 && r.status < 300) || r.uncertain).length || 0;
        const uncertain = json.results?.filter((r: any) => r.uncertain).length || 0;
        const failed = (json.results?.length || 0) - succeeded;
        if (succeeded > 0) {
          const confirmedSegments = json.results
            ?.filter((r: any) => (r.status >= 200 && r.status < 300) || r.uncertain)
            .map((r: any) => `${r.address}/${r.cidr}`) || [];
          setCartAddedSegments(prev => new Set([...prev, ...confirmedSegments]));
          setSelectedKeys(prev => prev.filter(k => !confirmedSegments.includes(k)));
          const msg = uncertain > 0
            ? `${succeeded} 个 IP 段已提交（其中 ${uncertain} 个因超时无法确认，请到 IPXO 平台验证）`
            : `成功添加 ${succeeded} 个 IP 段到购物车`;
          message.success(msg);
        }
        if (failed > 0) {
          const failedDetails = json.results
            ?.filter((r: any) => r.status >= 300 || (r.status > 0 && r.status < 200))
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

  // ── 移除单条 LOA（取消 ASN 授权） ──────────────────────────────────────
  const handleRemoveLoa = useCallback(async (segment: LeasedSegment, loaUuid: string) => {
    setRemovingLoaKey(loaUuid);
    try {
      const res = await fetch('/api/ipxo/loa/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceUuid: segment.serviceUuid, loaUuid, subnet: segment.segment }),
      });
      const json = await res.json();
      if (json.success) {
        message.success(json.message || `已移除 ${segment.segment} 的 ASN 授权`);
        loadLeasedSegments(leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch, leasedNoPaging);
      } else {
        message.error('移除失败: ' + (json.message || '未知错误'));
      }
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setRemovingLoaKey(null);
    }
  }, [leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch, leasedNoPaging, loadLeasedSegments]);

  // ── 批量取消续费 ────────────────────────────────────────────────────────
  const handleCancelRenewal = useCallback(async () => {
    setCancelRenewalLoading(true);
    setCancelResults([]);
    const services = leasedItems
      .filter(i => leasedSelectedKeys.includes(i.segment))
      .map(i => ({ billingUuid: i.serviceUuid, marketUuid: i.marketServiceUuid, subnet: i.segment }));
    try {
      const res = await fetch('/api/ipxo/services/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ services, type: cancelType, reason: cancelReason }),
      });
      const json = await res.json();
      const results: { subnet: string; ok: boolean; message: string }[] = (json.results || []).map((r: any) => ({
        subnet: r.subnet || r.billingUuid || '',
        ok: !!r.ok,
        message: r.message || '',
      }));
      setCancelResults(results);
      const successCount = results.filter(r => r.ok).length;
      if (successCount > 0) {
        message.success(`成功取消 ${successCount}/${results.length} 个 IP 段续费`);
        setLeasedSelectedKeys([]);
        loadLeasedSegments(leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch, leasedNoPaging);
      } else {
        message.error('所有请求均失败，请查看详情');
      }
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setCancelRenewalLoading(false);
    }
  }, [leasedItems, leasedSelectedKeys, cancelType, cancelReason,
      leasedPage, leasedPageSize, leasedNoAsnOnly, leasedSearch, leasedNoPaging, loadLeasedSegments]);

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
        <Tooltip title="点击复制">
          <span
            style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}
            onClick={(e) => { e.stopPropagation(); copyText(v, v); }}
          >
            {v} <CopyOutlined style={{ fontSize: 11, color: '#999' }} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: 'A/B 段',
      key: 'ab',
      width: 100,
      sorter: (a: MarketItem, b: MarketItem) => (a.dupCount || 0) - (b.dupCount || 0),
      render: (_: any, r: MarketItem) => {
        const dup = r.dupCount || 0;
        const dupColor = dup === 0 ? 'green' : dup <= 7 ? 'blue' : dup <= 19 ? 'orange' : 'red';
        return (
          <Space size={4}>
            <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.abSegKey}</Text>
            {dup > 0 ? (
              <Tag color={dupColor} style={{ fontSize: 11, margin: 0 }}>
                {dup}
              </Tag>
            ) : (
              <Tag color="green" style={{ fontSize: 11, margin: 0 }}>
                <CheckCircleOutlined />
              </Tag>
            )}
          </Space>
        );
      },
    },
    {
      title: '同AB段购买记录',
      key: 'abHistory',
      width: 200,
      render: (_: any, r: MarketItem) => {
        const records = existingAbHistory.get(r.abSegKey || '') || [];
        if (records.length === 0) return <Text type="secondary" style={{ fontSize: 12 }}>无</Text>;
        const show = records.slice(0, 2);
        const rest = records.slice(2);
        return (
          <div style={{ lineHeight: '20px' }}>
            {show.map((rec, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{rec.segment}</Text>
                <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{rec.purchaseDate?.slice(0, 10) || '-'}</Text>
              </div>
            ))}
            {rest.length > 0 && (
              <details style={{ margin: 0 }}>
                <summary style={{ cursor: 'pointer', color: '#1677ff', fontSize: 11, textAlign: 'right' }}>
                  +{rest.length} 条
                </summary>
                {rest.map((rec, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                    <Text style={{ fontFamily: 'monospace', fontSize: 13 }}>{rec.segment}</Text>
                    <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{rec.purchaseDate?.slice(0, 10) || '-'}</Text>
                  </div>
                ))}
              </details>
            )}
          </div>
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
                  {r.abuseScore === 0 ? '✓ 无滥用记录' : `⚠ 最高评分 ${r.abuseScore}`}
                </Tag>
                {abuseData && (
                  <Space direction="vertical" size={0}>
                    <Text style={{ fontSize: 10, color: '#888' }}>
                      {abuseData.reportedIpCount != null
                        ? `${abuseData.reportedIpCount} 个IP被举报 / 共 ${abuseData.totalReports} 次`
                        : `举报 ${abuseData.totalReports} 次`}
                    </Text>
                  </Space>
                )}
              </Space>
            )}
            <a
              href={`https://www.abuseipdb.com/check-block/${r.segment}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11 }}
            >
              <LinkOutlined /> 查看详情
            </a>
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
        activeKey={activeTab}
        onChange={setActiveTab}
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
                      <Select
                        value={countryCode}
                        onChange={setCountryCode}
                        placeholder="选择国家"
                        style={{ width: 160 }}
                        allowClear
                        showSearch
                        filterOption={(input, option) =>
                          (option?.label as string ?? '').toLowerCase().includes(input.toLowerCase()) ||
                          (option?.value as string ?? '').toLowerCase().includes(input.toLowerCase())
                        }
                        options={COUNTRY_OPTIONS}
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
                      <InputNumber value={limit} onChange={v => setLimit(v ?? 100)} min={1} max={5000} style={{ width: 90 }} />
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
                          {smartFilterActiveCount > 0 && items.length !== displayItems.length &&
                            <Text type="secondary">（已从 {items.length} 个过滤）</Text>}
                        </Text>
                        <Divider type="vertical" />
                        <Badge count={smartFilterActiveCount} size="small" offset={[2, -2]}>
                          <Button
                            icon={<FilterOutlined />}
                            type={smartFilterActiveCount > 0 ? 'primary' : 'default'}
                            ghost={smartFilterActiveCount > 0}
                            onClick={() => setSmartFilterModalVisible(true)}
                          >
                            智能筛选
                          </Button>
                        </Badge>
                        {smartFilterActiveCount > 0 && (
                          <Button size="small" type="link" danger onClick={() => {
                            setSfDedupAb(false); setSfDedupKeepCount(1); setSfDedupSortBy('price_asc');
                            setSfExcludeExisting(false);
                            setSfNoAbuse(false); setSfPriceFilterMin(null); setSfPriceFilterMax(null);
                            setSelectedKeys([]);
                          }}>清除筛选</Button>
                        )}
                        {dupItems.length > 0 && <Tag color="orange" icon={<WarningOutlined />}>{dupItems.length} 个与现有 AB 段重复</Tag>}
                      </Space>
                      <Space>
                        {selectedKeys.length > 0 && <>
                          <Text type="secondary">已选 {selectedKeys.length} 个，月费：<strong>${totalSelectedFee.toFixed(2)}</strong></Text>
                          <Button onClick={() => setSelectedKeys([])}>取消全选</Button>
                          <Button icon={<CopyOutlined />} onClick={() => copyText(selectedKeys.join('\n'), `${selectedKeys.length} 个IP段`)}>复制IP段</Button>
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
                      pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: ['20','50','100','200'], showTotal: t => `共 ${t} 条`, onChange: () => setSelectedKeys([]) }}
                      rowSelection={{
                        selectedRowKeys: selectedKeys,
                        onChange: keys => setSelectedKeys(keys as string[]),
                        getCheckboxProps: (record: any) => ({
                          disabled: cartAddedSegments.has(record.segment),
                          title: cartAddedSegments.has(record.segment) ? '已添加到购物车' : undefined,
                        }),
                      }}
                      rowClassName={(r) => (r.dupCount || 0) > 0 ? 'row-dup-ab' : ''}
                    />
                  )}
                </Card>
              </div>
            ),
          },
          {
            key: 'lookup',
            label: <Space><SearchOutlined />精准查询</Space>,
            children: (
              <div>
                <Card size="small" style={{ marginBottom: 16 }}>
                  <Row gutter={[12, 8]} align="top">
                    <Col flex="1">
                      <Input.TextArea
                        value={lookupInput}
                        onChange={e => setLookupInput(e.target.value)}
                        placeholder={'输入要查询的 IP 段，每行一个或用逗号/空格分隔，格式如 1.2.3.0/24\n例如：\n1.2.3.0/24\n4.5.6.0/23\n7.8.9.0/22'}
                        autoSize={{ minRows: 4, maxRows: 12 }}
                        style={{ fontFamily: 'monospace', fontSize: 13 }}
                        allowClear
                        onPressEnter={e => { if (e.ctrlKey || e.metaKey) handleLookup(); }}
                      />
                      <Text type="secondary" style={{ fontSize: 12 }}>支持每行一个、逗号、空格分隔；Ctrl+Enter 快捷查询</Text>
                    </Col>
                    <Col>
                      <Button
                        type="primary"
                        icon={<SearchOutlined />}
                        loading={lookupLoading}
                        onClick={handleLookup}
                        style={{ height: 36 }}
                      >
                        查询是否可租
                      </Button>
                    </Col>
                  </Row>
                </Card>

                {lookupResults.length > 0 && (
                  <Card
                    size="small"
                    title={
                      <Space>
                        <span>查询结果</span>
                        <Tag color="blue">{lookupResults.length} 个</Tag>
                        <Tag color="green">{lookupResults.filter(r => r.available).length} 个可租</Tag>
                        <Tag color="default">{lookupResults.filter(r => !r.available).length} 个不可用</Tag>
                      </Space>
                    }
                    extra={
                      lookupSelectedKeys.length > 0 && (
                        <Space>
                          <Button
                            icon={<CopyOutlined />}
                            size="small"
                            onClick={() => copyText(lookupSelectedKeys.join('\n'), `${lookupSelectedKeys.length} 个IP段`)}
                          >
                            复制IP段 ({lookupSelectedKeys.length})
                          </Button>
                          <Button
                            type="primary"
                            icon={<ShoppingCartOutlined />}
                            size="small"
                            loading={addingLookupToCart}
                            onClick={handleAddLookupToCart}
                          >
                            加入购物车 ({lookupSelectedKeys.length})
                          </Button>
                          <Button size="small" onClick={() => setLookupSelectedKeys([])}>取消选择</Button>
                        </Space>
                      )
                    }
                  >
                    <Table
                      dataSource={lookupResults}
                      rowKey="notation"
                      size="small"
                      pagination={false}
                      rowSelection={{
                        selectedRowKeys: lookupSelectedKeys,
                        onChange: keys => setLookupSelectedKeys(keys as string[]),
                        getCheckboxProps: (r: any) => ({ disabled: !r.available }),
                      }}
                      columns={[
                        {
                          title: 'IP 段',
                          dataIndex: 'notation',
                          key: 'notation',
                          width: 165,
                          render: (v: string) => (
                            <Tooltip title="点击复制">
                              <span
                                style={{ fontFamily: 'monospace', fontWeight: 600, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}
                                onClick={(e) => { e.stopPropagation(); copyText(v, v); }}
                              >
                                {v} <CopyOutlined style={{ fontSize: 11, color: '#999' }} />
                              </span>
                            </Tooltip>
                          ),
                        },
                        {
                          title: '状态',
                          key: 'available',
                          width: 100,
                          render: (_: any, r: any) => r.available
                            ? <Tag color="green" icon={<CheckOutlined />}>可租用</Tag>
                            : <Tag color="default" icon={<CloseOutlined />}>{r.error || '不可用'}</Tag>,
                        },
                        {
                          title: '月费 (USD)',
                          key: 'price',
                          width: 110,
                          align: 'right' as const,
                          render: (_: any, r: any) => r.available && r.price != null
                            ? <Text style={{ fontWeight: 600, color: '#1677ff' }}>${Number(r.price).toFixed(2)}</Text>
                            : <Text type="secondary">—</Text>,
                        },
                        {
                          title: 'RIR',
                          key: 'registry',
                          width: 80,
                          render: (_: any, r: any) => r.registry ? <Tag>{r.registry}</Tag> : <Text type="secondary">—</Text>,
                        },
                        {
                          title: '地区',
                          key: 'geo',
                          width: 150,
                          render: (_: any, r: any) => {
                            const geo = [r.country, r.city].filter(Boolean).join(' / ');
                            return geo ? <Text style={{ fontSize: 12 }}>{geo}</Text> : <Text type="secondary">—</Text>;
                          },
                        },
                      ]}
                    />
                  </Card>
                )}

                {lookupResults.length === 0 && !lookupLoading && (
                  <Card>
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={<Text type="secondary">输入 IP 段后点击「查询是否可租」检测 IPXO 市场中是否有对应段可租用</Text>}
                    />
                  </Card>
                )}
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
                          // 开启"仅无 ASN"时清空搜索，避免两个过滤器叠加导致 0 结果
                          if (v) {
                            setLeasedSearch('');
                            setLeasedSearchInput('');
                            if (leasedDebounceRef.current) clearTimeout(leasedDebounceRef.current);
                            loadLeasedSegments(1, leasedPageSize, true, '', leasedNoPaging);
                          } else {
                            loadLeasedSegments(1, leasedPageSize, false, leasedSearch, leasedNoPaging);
                          }
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
                      <>
                        <Col>
                          <Button type="primary" icon={<TeamOutlined />} onClick={() => setLoaModalVisible(true)}>
                            设置 ASN（{leasedSelectedKeys.length} 个）
                          </Button>
                        </Col>
                        <Col>
                          <Button
                            danger icon={<StopOutlined />}
                            onClick={() => { setCancelResults([]); setCancelRenewalVisible(true); }}
                          >
                            取消续费（{leasedSelectedKeys.length} 个）
                          </Button>
                        </Col>
                      </>
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
                        { title: 'ASN', key: 'asn', width: 260,
                          render: (_: any, r: LeasedSegment) => r.loa.length > 0
                            ? <Space direction="vertical" size={2}>
                                {r.loa.map(l => (
                                  <Space key={l.uuid} size={4} align="center">
                                    <Tag color={l.status === 'Active' ? 'green' : 'orange'} style={{ fontSize: 11, marginRight: 0 }}>AS{l.asn}</Tag>
                                    <Text style={{ fontSize: 11 }} type="secondary">{l.asName}</Text>
                                    <Popconfirm
                                      title={`确认移除 AS${l.asn} 对 ${r.segment} 的授权？`}
                                      description="此操作将通过 IPXO API 删除 LOA 授权，不可撤销。"
                                      onConfirm={() => handleRemoveLoa(r, l.uuid)}
                                      okText="确认移除" cancelText="取消"
                                      okButtonProps={{ danger: true }}
                                    >
                                      <Button
                                        type="text" danger size="small"
                                        icon={<DeleteOutlined />}
                                        loading={removingLoaKey === l.uuid}
                                        style={{ padding: '0 2px', height: 18 }}
                                      />
                                    </Popconfirm>
                                  </Space>
                                ))}
                              </Space>
                            : <Tag color="red" icon={<WarningOutlined />}>未设置 ASN</Tag> },
                        { title: '月费', dataIndex: 'recurringAmount', key: 'recurringAmount', width: 100, align: 'right' as const,
                          render: (v: number) => v != null ? `$${Number(v).toFixed(2)}` : '-' },
                        { title: 'RIR', dataIndex: 'registry', key: 'registry', width: 80,
                          render: (v: string) => v ? <Tag>{v.toUpperCase()}</Tag> : '-' },
                        { title: '购买日', dataIndex: 'purchaseDate', key: 'purchaseDate', width: 110,
                          render: (v: string) => v || '-' },
                        { title: '续费日', dataIndex: 'nextDueDate', key: 'nextDueDate', width: 110,
                          render: (v: string) => v || '-' },
                        { title: '续费状态', dataIndex: 'renewalStatus', key: 'renewalStatus', width: 100,
                          render: (v: string | null) => {
                            if (v === 'cancelled') return <Tag color="warning">到期取消</Tag>;
                            if (v === 'refunded') return <Tag color="error">已退款</Tag>;
                            if (v === 'renewed') return <Tag color="success">未取消</Tag>;
                            return <Tag color="default">未取消</Tag>;
                          }},
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

      {/* 取消续费 Modal */}
      <Modal
        title={<Space><ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />取消 IP 段续费</Space>}
        open={cancelRenewalVisible}
        onCancel={() => setCancelRenewalVisible(false)}
        onOk={handleCancelRenewal}
        confirmLoading={cancelRenewalLoading}
        okText="确认取消续费"
        cancelText="返回"
        okButtonProps={{ danger: true, disabled: cancelResults.length > 0 }}
        width={600}
      >
        {cancelResults.length === 0 ? (
          <>
            <Alert
              type="warning" showIcon
              message="操作警告"
              description="取消续费后，IP 段将在到期日停止服务（到期取消）或立即停止（立即取消）。此操作通过 IPXO API 执行，请谨慎确认。"
              style={{ marginBottom: 16 }}
            />
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">待取消 IP 段（{leasedSelectedKeys.length} 个）：</Text>
              <div style={{ maxHeight: 100, overflowY: 'auto', marginTop: 6, padding: '6px 8px', background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4 }}>
                {leasedItems.filter(i => leasedSelectedKeys.includes(i.segment)).map(i => (
                  <Space key={i.segment} size={8} style={{ display: 'block', marginBottom: 2 }}>
                    <Tag style={{ fontFamily: 'monospace' }}>{i.segment}</Tag>
                    {i.nextDueDate && <Text type="secondary" style={{ fontSize: 11 }}>续费日 {i.nextDueDate}</Text>}
                  </Space>
                ))}
              </div>
            </div>
            <Form layout="vertical">
              <Form.Item label="取消方式">
                <Radio.Group value={cancelType} onChange={e => setCancelType(e.target.value)}>
                  <Radio value="end_of_period">到期取消（到期日后停止，推荐）</Radio>
                  <Radio value="immediate"><Text type="danger">立即取消（立刻停止服务）</Text></Radio>
                </Radio.Group>
              </Form.Item>
              <Form.Item label="取消原因">
                <Input
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  placeholder="填写取消原因（发送给 IPXO）"
                />
              </Form.Item>
            </Form>
          </>
        ) : (
          <>
            <div style={{ marginBottom: 12 }}>
              <Text strong>执行结果：</Text>
            </div>
            <List
              size="small"
              dataSource={cancelResults}
              renderItem={item => (
                <List.Item>
                  <Space>
                    <Tag color={item.ok ? 'success' : 'error'}>{item.ok ? '成功' : '失败'}</Tag>
                    <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{item.subnet}</Text>
                    <Text type={item.ok ? undefined : 'danger'} style={{ fontSize: 12 }}>{item.message}</Text>
                  </Space>
                </List.Item>
              )}
            />
          </>
        )}
      </Modal>

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

      {/* 智能筛选弹窗 */}
      <Modal
        title={<Space><FilterOutlined />智能筛选条件</Space>}
        open={smartFilterModalVisible}
        onCancel={() => setSmartFilterModalVisible(false)}
        onOk={() => { setSmartFilterModalVisible(false); setSelectedKeys([]); }}
        okText="应用"
        cancelText="关闭"
        width={480}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Checkbox checked={sfDedupAb} onChange={e => setSfDedupAb(e.target.checked)}>
            过滤重复 AB 段
          </Checkbox>
          {sfDedupAb && (
            <div style={{ marginLeft: 24 }}>
              <Space size={16}>
                <span>每组保留 <InputNumber value={sfDedupKeepCount} onChange={v => setSfDedupKeepCount(v || 1)} min={1} max={50} style={{ width: 65 }} /> 个</span>
                <span>排序：
                  <Select value={sfDedupSortBy} onChange={v => setSfDedupSortBy(v)} style={{ width: 110 }}>
                    <Select.Option value="price_asc">价格最低</Select.Option>
                    <Select.Option value="price_desc">价格最高</Select.Option>
                  </Select>
                </span>
              </Space>
            </div>
          )}
          <Checkbox checked={sfExcludeExistingSegment} onChange={e => setSfExcludeExistingSegment(e.target.checked)}>
            过滤已有 IP 段（隐藏 IP 段管理中已存在的段）
          </Checkbox>
          <Checkbox checked={sfExcludeExisting} onChange={e => setSfExcludeExisting(e.target.checked)}>
            排除已有 AB 段（隐藏与现有 IP 重复的 AB 段）
          </Checkbox>
          <div>
            <Checkbox
              checked={sfNoPurchaseDays != null}
              onChange={e => setSfNoPurchaseDays(e.target.checked ? 180 : null)}
            >
              近期无同AB段购买记录
            </Checkbox>
            {sfNoPurchaseDays != null && (
              <div style={{ marginLeft: 24, marginTop: 4 }}>
                <span>仅显示近 <InputNumber value={sfNoPurchaseDays} onChange={v => setSfNoPurchaseDays(v || 1)} min={1} max={3650} style={{ width: 75 }} /> 天内无购买记录的</span>
              </div>
            )}
          </div>
          <Checkbox checked={sfNoAbuse} onChange={e => setSfNoAbuse(e.target.checked)}>
            仅显示无滥用记录（排除滥用评分 &gt; 0 的，需先检测）
          </Checkbox>
          <div>
            <Checkbox
              checked={sfPriceFilterMin != null || sfPriceFilterMax != null}
              onChange={e => {
                if (!e.target.checked) { setSfPriceFilterMin(null); setSfPriceFilterMax(null); }
              }}
            >
              价格范围过滤
            </Checkbox>
            <div style={{ marginLeft: 24, marginTop: 4 }}>
              <InputNumber value={sfPriceFilterMin} onChange={v => setSfPriceFilterMin(v)} min={0} precision={0} placeholder="最低" style={{ width: 90 }} />
              <Text style={{ margin: '0 8px' }}>~</Text>
              <InputNumber value={sfPriceFilterMax} onChange={v => setSfPriceFilterMax(v)} min={0} precision={0} placeholder="最高" style={{ width: 90 }} />
              <Text type="secondary" style={{ marginLeft: 8 }}>USD/月</Text>
            </div>
          </div>
        </Space>
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

