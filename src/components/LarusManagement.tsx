import React, { useEffect, useState, useCallback } from 'react';
import {
  Table, Button, Tag, Space, Alert, Typography, Input, Badge, Drawer, Descriptions, Spin, Modal, List, message as antdMessage,
  Row, Col, Card, Statistic, Progress, Divider, Form, Tooltip,
} from 'antd';
import { ReloadOutlined, SearchOutlined, SyncOutlined, DownloadOutlined, CloudUploadOutlined, PlusOutlined, DeleteOutlined, SettingOutlined, CheckCircleOutlined, WarningOutlined, CopyOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAuth } from '../contexts/AuthContext';

const { Text, Link } = Typography;

interface LarusAllocation {
  asn: string;
  loa_path: string | null;
  alloc_id: number;
}

interface LarusIrrData {
  rpki?: string | null;
  whois?: string | null;
  radb?: string | null;
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
  asn?: string;
  loa_path?: string;
  allocations?: LarusAllocation[];
  irr_data?: LarusIrrData | null;
  purchase_date?: string | null;
  expiry_date?: string | null;
}

const routeTag = (status: number, text?: string) => {
  if (status === 2) return <Tag color="green">已创建</Tag>;
  if (status === 0) return <Tag color="orange">未创建</Tag>;
  return <Tag color="red">{text || `状态${status}`}</Tag>;
};

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

interface LarusStats {
  totalSegments: number;
  totalIps: number;
  announced: number;
  notAnnounced: number;
  activeSegments: number;
}

const LarusManagement: React.FC = () => {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
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
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ total: number; synced: number; skipped: number; failed: number; results: any[] } | null>(null);

  const [stats, setStats] = useState<LarusStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<LarusItem | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 单条 ASN 操作
  const [asnActionLoading, setAsnActionLoading] = useState<string>('');
  const [asnInput, setAsnInput] = useState('');
  const [asnSetDrawerOpen, setAsnSetDrawerOpen] = useState(false);
  const [asnSetItem, setAsnSetItem] = useState<LarusItem | null>(null);

  // LOA 联系信息
  interface LoaContact { name: string; company: string; country_code: string; country_name: string; city: string; phone: string; email: string; address: string; }
  const emptyContact: LoaContact = { name: '', company: '', country_code: '', country_name: '', city: '', phone: '', email: '', address: '' };
  const [loaContact, setLoaContact] = useState<LoaContact>(emptyContact);
  const [loaContactDraft, setLoaContactDraft] = useState<LoaContact>(emptyContact);
  const [savingContact, setSavingContact] = useState(false);
  const [loaContactModalOpen, setLoaContactModalOpen] = useState(false);

  // 日期刷新
  const [datesLoading, setDatesLoading] = useState<Set<number>>(new Set());

  const refreshDates = useCallback(async (routeIds: number[]) => {
    if (!routeIds.length) return;
    setDatesLoading(prev => new Set([...prev, ...routeIds]));
    try {
      const res = await fetch('/api/larus/dates-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_ids: routeIds }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setItems(prev => prev.map(it => {
        const updated = (data.results as Array<{ id: number; purchase_date: string | null; expiry_date: string | null }>)
          .find(r => r.id === it.id);
        return updated !== undefined ? { ...it, purchase_date: updated.purchase_date, expiry_date: updated.expiry_date } : it;
      }));
      antdMessage.success(`日期已刷新（${data.results?.length ?? routeIds.length} 条）`);
    } catch (e: any) {
      antdMessage.error(e.message || '日期刷新失败');
    } finally {
      setDatesLoading(prev => {
        const next = new Set(prev);
        routeIds.forEach(id => next.delete(id));
        return next;
      });
    }
  }, []);

  // IRR 刷新
  const [irrLoading, setIrrLoading] = useState<Set<number>>(new Set());

  const refreshIrr = useCallback(async (routeIds: number[]) => {
    if (!routeIds.length) return;
    setIrrLoading(prev => new Set([...prev, ...routeIds]));
    try {
      const res = await fetch('/api/larus/irr-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_ids: routeIds }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setItems(prev => prev.map(it => {
        const updated = (data.results as Array<{ id: number; irr_data: LarusIrrData | null }>)
          .find(r => r.id === it.id);
        return updated !== undefined ? { ...it, irr_data: updated.irr_data } : it;
      }));
      antdMessage.success(`IRR 状态已刷新（${data.results?.length ?? routeIds.length} 条）`);
    } catch (e: any) {
      antdMessage.error(e.message || 'IRR 刷新失败');
    } finally {
      setIrrLoading(prev => {
        const next = new Set(prev);
        routeIds.forEach(id => next.delete(id));
        return next;
      });
    }
  }, []);

  // 按 IP 段刷新核心信息（ASN / LOA / allocations）
  const [routesLoading, setRoutesLoading] = useState<Set<number>>(new Set());

  const refreshRoutes = useCallback(async (routeIds: number[]) => {
    if (!routeIds.length) return;
    setRoutesLoading(prev => new Set([...prev, ...routeIds]));
    try {
      const res = await fetch('/api/larus/routes-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_ids: routeIds }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      setItems(prev => prev.map(it => {
        const updated = (data.results as Array<{ id: number; asn: string | null; loa_path: string | null; allocations: LarusAllocation[] }>)
          .find(r => r.id === it.id);
        return updated !== undefined
          ? { ...it, asn: updated.asn ?? undefined, loa_path: updated.loa_path ?? undefined, allocations: updated.allocations }
          : it;
      }));
      antdMessage.success(`已刷新 ${data.results?.length ?? routeIds.length} 条 IP 段`);
    } catch (e: any) {
      antdMessage.error(e.message || '刷新失败');
    } finally {
      setRoutesLoading(prev => {
        const next = new Set(prev);
        routeIds.forEach(id => next.delete(id));
        return next;
      });
    }
  }, []);

  // 批量操作
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [batchSetOpen, setBatchSetOpen] = useState(false);
  const [batchAsnInput, setBatchAsnInput] = useState('');
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchErrors, setBatchErrors] = useState<string[]>([]);
  const [batchResultOpen, setBatchResultOpen] = useState(false);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => antdMessage.success('已复制'));
  };

  const syncLoa = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/larus/sync-loa', { method: 'POST' });
      const data = await res.json();
      if (!data.success) { antdMessage.error(data.message || '同步失败'); return; }
      setSyncResult({ total: data.total, synced: data.synced, skipped: data.skipped ?? 0, failed: data.failed, results: data.results || [] });
    } catch (e: any) {
      antdMessage.error(e.message || '同步请求失败');
    } finally {
      setSyncing(false);
    }
  };

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const res = await fetch('/api/larus/stats');
      const data = await res.json();
      if (data.success) setStats(data);
    } catch { /* ignore */ } finally {
      setStatsLoading(false);
    }
  }, []);

  const cancelAsn = async (routeId: number, alloc_id: number, asn: string) => {
    const key = `cancel-${alloc_id}`;
    setAsnActionLoading(key);
    try {
      const res = await fetch('/api/larus/asn-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alloc_id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      antdMessage.success(`AS${asn} 已取消`);
      const remaining = (list?: LarusAllocation[]) => (list || []).filter(a => a.alloc_id !== alloc_id);
      setItems(prev => prev.map(it => {
        if (it.id !== routeId) return it;
        const allocations = remaining(it.allocations);
        return { ...it, allocations, asn: allocations[0]?.asn, loa_path: allocations[0]?.loa_path ?? undefined };
      }));
      if (detailItem?.id === routeId) {
        setDetailData((prev: any) => prev ? { ...prev, allocations: remaining(prev.allocations) } : prev);
      }
      loadStats();
    } catch (e: any) {
      antdMessage.error(e.message || '取消失败');
    } finally {
      setAsnActionLoading('');
    }
  };

  const setAsn = async () => {
    if (!asnSetItem || !asnInput.trim()) return;
    const asn = asnInput.trim().replace(/^AS/i, '');
    const key = `set-${asnSetItem.id}`;
    setAsnActionLoading(key);
    try {
      const res = await fetch('/api/larus/asn-set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route_id: asnSetItem.id, asn, ip_cidr: asnSetItem.ip_cidr }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message);
      antdMessage.success(`AS${asn} 设置成功`);
      setAsnSetDrawerOpen(false);
      setAsnInput('');
      if (detailItem?.id === asnSetItem.id) {
        openDetail(asnSetItem);
      }
      loadStats();
    } catch (e: any) {
      antdMessage.error(e.message || '设置失败');
    } finally {
      setAsnActionLoading('');
    }
  };

  // 批量设置 ASN
  const batchSetAsn = async () => {
    const asn = batchAsnInput.trim().replace(/^AS/i, '');
    if (!asn || !selectedRowKeys.length) return;
    setBatchLoading(true);
    setBatchProgress({ done: 0, total: selectedRowKeys.length });
    const errors: string[] = [];
    for (let i = 0; i < selectedRowKeys.length; i++) {
      const routeId = selectedRowKeys[i] as number;
      const item = items.find(it => it.id === routeId);
      try {
        const res = await fetch('/api/larus/asn-set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ route_id: routeId, asn, ip_cidr: item?.ip_cidr || '' }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '设置失败');
      } catch (e: any) {
        errors.push(`${item?.ip_cidr || routeId}: ${e.message}`);
      }
      setBatchProgress({ done: i + 1, total: selectedRowKeys.length });
    }
    setBatchLoading(false);
    setBatchErrors(errors);
    if (errors.length === 0) {
      antdMessage.success(`${selectedRowKeys.length} 条IP段已设置 AS${asn}`);
      setBatchSetOpen(false);
      setBatchAsnInput('');
      setSelectedRowKeys([]);
      loadIps();
      loadStats();
    } else {
      setBatchResultOpen(true);
      if (errors.length < selectedRowKeys.length) {
        loadIps();
        loadStats();
      }
    }
    setBatchProgress(null);
  };

  // 批量取消 ASN
  const batchCancelAsn = async () => {
    const targets = [...selectedRowKeys] as number[];
    const errors: string[] = [];
    setBatchLoading(true);
    for (let i = 0; i < targets.length; i++) {
      const routeId = targets[i];
      const item = items.find(it => it.id === routeId);
      antdMessage.loading({ content: `正在取消 ${i + 1}/${targets.length}...`, key: 'batch-cancel', duration: 0 });
      try {
        const res = await fetch('/api/larus/asn-cancel-by-route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ route_id: routeId }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || '取消失败');
      } catch (e: any) {
        errors.push(`${item?.ip_cidr || routeId}: ${e.message}`);
      }
    }
    setBatchLoading(false);
    antdMessage.destroy('batch-cancel');
    setSelectedRowKeys([]);
    setBatchErrors(errors);
    loadIps();
    loadStats();
    if (errors.length === 0) {
      antdMessage.success(`${targets.length} 条IP段的 ASN 已全部取消`);
    } else {
      antdMessage.warning(`${targets.length - errors.length} 成功，${errors.length} 失败`);
      setBatchResultOpen(true);
    }
  };

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

  const loadLoaContact = useCallback(async () => {
    try {
      const res = await fetch('/api/larus/loa-contact');
      const data = await res.json();
      if (data.success && data.contact) {
        const c = { ...emptyContact, ...data.contact } as LoaContact;
        setLoaContact(c);
        setLoaContactDraft(c);
      }
    } catch { /* ignore */ }
  }, []);

  const saveLoaContact = async () => {
    setSavingContact(true);
    try {
      const res = await fetch('/api/larus/loa-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loaContactDraft),
      });
      const data = await res.json();
      if (data.success) {
        setLoaContact(loaContactDraft);
        antdMessage.success('联系信息已保存');
      } else {
        antdMessage.error(data.message || '保存失败');
      }
    } catch (e: any) {
      antdMessage.error(e.message || '保存失败');
    } finally {
      setSavingContact(false);
    }
  };

  useEffect(() => { loadIps(); loadStats(); loadLoaContact(); }, [loadIps, loadStats, loadLoaContact]);

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
        antdMessage.success('Cookie 已保存，正在刷新数据...');
        setCookieDrawerOpen(false);
        setCookieInput('');
        loadIps(true);
      } else {
        antdMessage.error('保存失败：' + (data.message || '未知错误'));
      }
    } catch (e: any) {
      antdMessage.error('请求失败：' + e.message);
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
      render: (v: string) => (
        <Tooltip title="点击复制" mouseEnterDelay={0.5}>
          <Text code style={{ whiteSpace: 'nowrap', fontSize: 14, cursor: 'pointer' }} onClick={() => copyToClipboard(v)}>{v}</Text>
        </Tooltip>
      ),
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
      title: '购买时间',
      key: 'purchase_date',
      width: 110,
      sorter: (a, b) => (a.purchase_date || '').localeCompare(b.purchase_date || ''),
      render: (_: any, r: LarusItem) => r.purchase_date
        ? <Text style={{ fontSize: 12 }}>{r.purchase_date}</Text>
        : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>,
    },
    {
      title: '到期时间',
      key: 'expiry_date',
      width: 125,
      sorter: (a, b) => (a.expiry_date || '').localeCompare(b.expiry_date || ''),
      render: (_: any, r: LarusItem) => {
        const expiry = r.expiry_date;
        const loading = datesLoading.has(r.id);
        if (!expiry) {
          return (
            <Space size={4}>
              <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
              <Button size="small" icon={<SyncOutlined />} loading={loading} style={{ fontSize: 11, height: 20, padding: '0 6px' }} onClick={() => refreshDates([r.id])}>刷新</Button>
            </Space>
          );
        }
        const daysLeft = Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000);
        const color = daysLeft < 0 ? 'red' : daysLeft <= 30 ? 'orange' : undefined;
        return (
          <Space size={4}>
            <Text style={{ fontSize: 12, color }}>{expiry}</Text>
            <Button size="small" icon={<SyncOutlined />} loading={loading} style={{ fontSize: 11, height: 20, padding: '0 6px' }} onClick={() => refreshDates([r.id])} />
          </Space>
        );
      },
    },
    {
      title: '续费状态',
      dataIndex: 'status',
      key: 'renewal_status',
      width: 90,
      filters: [
        { text: '生效中', value: 3 },
        { text: '即将到期', value: 'soon' },
        { text: '已过期', value: 4 },
        { text: '已失效', value: 5 },
      ],
      onFilter: (val, r) => {
        if (val === 'soon') {
          if (r.status !== 3 || !r.expiry_date) return false;
          return Math.ceil((new Date(r.expiry_date).getTime() - Date.now()) / 86400000) <= 30;
        }
        return r.status === Number(val);
      },
      render: (_: any, r: LarusItem) => {
        if (r.status === 3 && r.expiry_date) {
          const daysLeft = Math.ceil((new Date(r.expiry_date).getTime() - Date.now()) / 86400000);
          if (daysLeft <= 30) return <Tag color="orange">即将到期 {daysLeft}d</Tag>;
        }
        const map: Record<number, { label: string; color: string }> = {
          3: { label: '生效中', color: 'green' },
          4: { label: '已过期', color: 'red' },
          5: { label: '已失效', color: 'default' },
        };
        const s = map[r.status];
        return s ? <Tag color={s.color}>{s.label}</Tag> : <Tag>{`状态${r.status}`}</Tag>;
      },
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
      width: 190,
      render: (_: any, r: LarusItem) => {
        const allocs = r.allocations;
        if (allocs?.length) {
          return (
            <Space direction="vertical" size={2}>
              {allocs.map(a => (
                <Space key={a.alloc_id} size={4}>
                  <Tooltip title="点击复制" mouseEnterDelay={0.5}>
                    <Text code style={{ fontSize: 14, cursor: 'pointer' }} onClick={() => copyToClipboard(`AS${a.asn}`)}>AS{a.asn}</Text>
                  </Tooltip>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    loading={asnActionLoading === `cancel-${a.alloc_id}`}
                    title="移除该条 ASN 分配"
                    style={{ fontSize: 11, height: 20, padding: '0 4px' }}
                    onClick={() => {
                      Modal.confirm({
                        title: `移除 ${r.ip_cidr} 的 AS${a.asn}？`,
                        content: '将删除该条 ASN 分配记录，不影响该 IP 段的其它 ASN，不可撤销。',
                        okType: 'danger',
                        okText: '确认移除',
                        cancelText: '返回',
                        onOk: () => cancelAsn(r.id, a.alloc_id, a.asn),
                      });
                    }}
                  />
                </Space>
              ))}
            </Space>
          );
        }
        return r.asn ? (
          <Tooltip title="点击复制" mouseEnterDelay={0.5}>
            <Text code style={{ fontSize: 14, cursor: 'pointer' }} onClick={() => copyToClipboard(`AS${r.asn}`)}>AS{r.asn}</Text>
          </Tooltip>
        ) : <Text type="secondary" style={{ fontSize: 14 }}>—</Text>;
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
      title: 'IRR状态',
      key: 'irr',
      width: 200,
      render: (_: any, r: LarusItem) => (
        <Space direction="vertical" size={2}>
          {r.irr_data ? (
            <Space size={3} wrap>
              <Tag color={r.irr_data.rpki === 'valid' ? 'green' : 'default'} style={{ margin: 0, fontSize: 11 }}>RPKI: {r.irr_data.rpki ?? '—'}</Tag>
              <Tag color={r.irr_data.whois === 'valid' ? 'green' : 'default'} style={{ margin: 0, fontSize: 11 }}>Whois: {r.irr_data.whois ?? '—'}</Tag>
              <Tag color={r.irr_data.radb === 'valid' ? 'green' : 'default'} style={{ margin: 0, fontSize: 11 }}>RADB: {r.irr_data.radb ?? '—'}</Tag>
            </Space>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>未获取</Text>
          )}
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={irrLoading.has(r.id)}
            onClick={() => refreshIrr([r.id])}
            style={{ fontSize: 11, height: 20, padding: '0 6px', lineHeight: '18px' }}
          >刷新</Button>
        </Space>
      ),
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
      width: 200,
      fixed: 'right',
      render: (_: any, r: LarusItem) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={routesLoading.has(r.id)}
            onClick={() => refreshRoutes([r.id])}
            title="重新拉取该 IP 段的分配记录 / ASN / LOA"
          >
            刷新
          </Button>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => { setAsnSetItem(r); setAsnInput(''); setAsnSetDrawerOpen(true); }}
          >
            设置ASN
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={asnActionLoading === `cancel-route-${r.id}`}
            onClick={() => {
              Modal.confirm({
                title: `取消 ${r.ip_cidr} 的所有 ASN？`,
                content: '将移除该IP段在 Larus 中的全部 ASN 分配，不可撤销。',
                okType: 'danger',
                okText: '确认取消',
                cancelText: '返回',
                onOk: async () => {
                  setAsnActionLoading(`cancel-route-${r.id}`);
                  try {
                    const res = await fetch('/api/larus/asn-cancel-by-route', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ route_id: r.id }),
                    });
                    const data = await res.json();
                    if (!data.success) throw new Error(data.message || '取消失败');
                    antdMessage.success(`${r.ip_cidr} ASN 已全部取消`);
                    setItems(prev => prev.map(it => it.id === r.id ? { ...it, allocations: [], asn: undefined, loa_path: undefined } : it));
                    loadStats();
                  } catch (e: any) {
                    antdMessage.error(e.message || '取消失败');
                  } finally {
                    setAsnActionLoading('');
                  }
                },
              });
            }}
          >
            取消ASN
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* 统计卡片 */}
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={8} md={5}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic title="IP段总数" value={stats?.totalSegments ?? '—'} loading={statsLoading} valueStyle={{ fontSize: 22 }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic title="生效中" value={stats?.activeSegments ?? '—'} loading={statsLoading} valueStyle={{ fontSize: 22, color: '#1677ff' }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic title="IP总量" value={stats ? stats.totalIps.toLocaleString() : '—'} loading={statsLoading} valueStyle={{ fontSize: 22 }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic title="路由已创建" value={stats?.announced ?? '—'} loading={statsLoading} valueStyle={{ fontSize: 22, color: '#52c41a' }} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '12px 16px' }}>
            <Statistic title="路由未创建" value={stats?.notAnnounced ?? '—'} loading={statsLoading} valueStyle={{ fontSize: 22, color: stats?.notAnnounced ? '#faad14' : undefined }} />
          </Card>
        </Col>
      </Row>

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
      <div style={{
        display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        position: 'sticky', top: -24, zIndex: 20,
        background: '#f4f6f9',
        padding: '24px 0 10px',
        margin: '-24px 0 4px',
      }}>
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
        <Button icon={<SyncOutlined />} onClick={() => refreshIrr(items.map(it => it.id))} loading={irrLoading.size > 0 && selectedRowKeys.length === 0}>IRR刷新</Button>
        <Button icon={<SyncOutlined />} onClick={() => refreshDates(items.map(it => it.id))} loading={datesLoading.size > 0 && selectedRowKeys.length === 0}>日期刷新</Button>
        <Button
          icon={<SyncOutlined />}
          onClick={() => refreshRoutes(selectedRowKeys.length ? selectedRowKeys as number[] : items.map(it => it.id))}
          loading={routesLoading.size > 0}
        >
          {selectedRowKeys.length ? `刷新选中 (${selectedRowKeys.length})` : '明细刷新'}
        </Button>
        <Button icon={<CloudUploadOutlined />} onClick={syncLoa} loading={syncing}>同步LOA到首都在线</Button>
        <Button icon={<SyncOutlined />} onClick={() => setCookieDrawerOpen(true)}>更新 Cookie</Button>
        {isAdmin && (
          <Button
            icon={loaContact.name ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <WarningOutlined style={{ color: '#faad14' }} />}
            onClick={() => { setLoaContactDraft(loaContact); setLoaContactModalOpen(true); }}
          >
            LOA 联系信息{loaContact.name ? '' : '（未配置）'}
          </Button>
        )}
      </div>

      {/* 批量操作栏 */}
      {selectedRowKeys.length > 0 && (
        <div style={{
          background: '#e6f4ff',
          border: '1px solid #91caff',
          borderRadius: 6,
          padding: '8px 16px',
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          position: 'sticky', top: 58, zIndex: 19,
        }}>
          <span style={{ color: '#1677ff', fontWeight: 500 }}>已选 {selectedRowKeys.length} 条</span>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => { setBatchAsnInput(''); setBatchProgress(null); setBatchSetOpen(true); }}
          >
            批量设置 ASN
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={batchLoading}
            onClick={() => {
              Modal.confirm({
                title: `确定取消 ${selectedRowKeys.length} 条IP段的所有 ASN？`,
                content: '此操作将移除这些IP段在 Larus 中的全部 ASN 分配，不可撤销。',
                okType: 'danger',
                okText: '确认取消',
                cancelText: '返回',
                onOk: batchCancelAsn,
              });
            }}
          >
            批量取消 ASN
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              const selected = filtered.filter(item => selectedRowKeys.includes(item.id));
              const text = selected.map(item => item.ip_cidr).join('\n');
              navigator.clipboard.writeText(text).then(() => antdMessage.success(`已复制 ${selected.length} 个IP段`));
            }}
          >
            复制IP段 ({selectedRowKeys.length})
          </Button>
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              const selected = filtered.filter(item => selectedRowKeys.includes(item.id));
              const lines = selected.map(item => {
                const asn = item.allocations?.[0]?.asn ?? item.asn;
                return asn ? `AS${asn}` : '';
              });
              navigator.clipboard.writeText(lines.join('\n')).then(() => antdMessage.success(`已复制 ${selected.length} 行 ASN`));
            }}
          >
            复制ASN
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={routesLoading.size > 0 && selectedRowKeys.length > 0}
            onClick={() => refreshRoutes(selectedRowKeys as number[])}
          >
            刷新明细 ({selectedRowKeys.length})
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={irrLoading.size > 0 && selectedRowKeys.length > 0}
            onClick={() => refreshIrr(selectedRowKeys as number[])}
          >
            刷新IRR ({selectedRowKeys.length})
          </Button>
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={datesLoading.size > 0 && selectedRowKeys.length > 0}
            onClick={() => refreshDates(selectedRowKeys as number[])}
          >
            刷新日期 ({selectedRowKeys.length})
          </Button>
          <Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
        </div>
      )}

      {/* IP 列表 */}
      <Table<LarusItem>
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        size="small"
        pagination={false}
        scroll={{ x: 1660 }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys),
          selections: [Table.SELECTION_ALL, Table.SELECTION_INVERT, Table.SELECTION_NONE],
        }}
        summary={() => (
          <Table.Summary fixed="bottom">
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={3}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  共 {filtered.length} 条{search ? `（过滤自 ${items.length} 条）` : ''}
                </Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} colSpan={7} align="right">
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

      {/* LOA 联系信息 Modal */}
      <Modal
        title="LOA 联系信息（设置 ASN 时使用）"
        open={loaContactModalOpen}
        onCancel={() => setLoaContactModalOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setLoaContactModalOpen(false)}>取消</Button>
            <Button type="primary" loading={savingContact} onClick={saveLoaContact}>保存联系信息</Button>
          </Space>
        }
        width={480}
      >
        <Alert
          type="info"
          showIcon
          message="设置 ASN 时 Larus API 需要联系人/公司信息，配置一次后无需每次填写"
          style={{ marginBottom: 14, fontSize: 12 }}
        />
        <Form layout="vertical" size="small">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="姓名 / 联系人">
                <Input value={loaContactDraft.name} onChange={e => setLoaContactDraft(d => ({ ...d, name: e.target.value }))} placeholder="Mel ness" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="公司名称">
                <Input value={loaContactDraft.company} onChange={e => setLoaContactDraft(d => ({ ...d, company: e.target.value }))} placeholder="ACME Corp" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="国家代码">
                <Input value={loaContactDraft.country_code} onChange={e => setLoaContactDraft(d => ({ ...d, country_code: e.target.value.toUpperCase().slice(0, 2) }))} placeholder="HK" maxLength={2} />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item label="国家名称" extra="需与 Larus 国家下拉的文本一致，如 Hong Kong China">
                <Input value={loaContactDraft.country_name} onChange={e => setLoaContactDraft(d => ({ ...d, country_name: e.target.value }))} placeholder="Hong Kong China" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="城市" extra="首次建 Route 时用作数据中心城市/名称">
                <Input value={loaContactDraft.city} onChange={e => setLoaContactDraft(d => ({ ...d, city: e.target.value }))} placeholder="Hong Kong" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="电话">
                <Input value={loaContactDraft.phone} onChange={e => setLoaContactDraft(d => ({ ...d, phone: e.target.value }))} placeholder="6462880788" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="邮箱">
                <Input value={loaContactDraft.email} onChange={e => setLoaContactDraft(d => ({ ...d, email: e.target.value }))} placeholder="contact@example.com" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item label="地址">
                <Input value={loaContactDraft.address} onChange={e => setLoaContactDraft(d => ({ ...d, address: e.target.value }))} placeholder="4409 Geraldine Lane" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

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
              <Descriptions.Item label="ASN / LOA">
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {detailData?.allocations?.length ? (
                    (detailData.allocations as LarusAllocation[]).map((a) => (
                      <div key={a.alloc_id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Text code>AS{a.asn}</Text>
                        {a.loa_path ? (
                          <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadLoa(a.loa_path!)}>
                            LOA
                          </Button>
                        ) : (
                          <Text type="secondary" style={{ fontSize: 12 }}>无 LOA</Text>
                        )}
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          loading={asnActionLoading === `cancel-${a.alloc_id}`}
                          onClick={() => {
                            Modal.confirm({
                              title: `确定取消 AS${a.asn}？`,
                              content: '此操作将从 Larus 系统中移除该 ASN 分配，不可撤销。',
                              okType: 'danger',
                              onOk: () => cancelAsn(detailItem!.id, a.alloc_id, a.asn),
                            });
                          }}
                        >
                          取消
                        </Button>
                      </div>
                    ))
                  ) : (detailData?.asn || detailItem?.asn) ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Text code>AS{detailData?.asn ?? detailItem?.asn}</Text>
                      {(detailData?.loa_path || detailItem?.loa_path) && (
                        <Button size="small" icon={<DownloadOutlined />} onClick={() => downloadLoa(detailData?.loa_path || detailItem?.loa_path!)}>
                          LOA
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>未设置 ASN</Text>
                  )}
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={() => { setAsnSetItem(detailItem); setAsnInput(''); setAsnSetDrawerOpen(true); }}
                  >
                    设置 ASN
                  </Button>
                </Space>
              </Descriptions.Item>
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

      {/* 同步结果 Modal */}
      <Modal
        title={`LOA 同步结果：${syncResult?.synced ?? 0} 新增 / ${syncResult?.skipped ?? 0} 已存在跳过 / ${syncResult?.failed ?? 0} 失败（共 ${syncResult?.total ?? 0} 个）`}
        open={!!syncResult}
        onCancel={() => setSyncResult(null)}
        footer={<Button type="primary" onClick={() => setSyncResult(null)}>关闭</Button>}
        width={560}
      >
        {syncResult && (
          <List
            size="small"
            dataSource={syncResult.results}
            style={{ maxHeight: 400, overflowY: 'auto' }}
            renderItem={(r: any) => (
              <List.Item style={{ padding: '4px 0' }}>
                <Space>
                  <Tag color={r.skipped ? 'default' : r.ok ? 'green' : 'red'}>
                    {r.skipped ? '已存在' : r.ok ? '新增' : '失败'}
                  </Tag>
                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.cidr}</span>
                  {r.asn && <span style={{ color: '#888', fontSize: 12 }}>AS{r.asn}</span>}
                  {!r.ok && <span style={{ color: '#f5222d', fontSize: 12 }}>{r.message}</span>}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Modal>

      {/* 单条 ASN 设置 Drawer */}
      <Drawer
        title={`设置 ASN — ${asnSetItem?.ip_cidr}`}
        open={asnSetDrawerOpen}
        onClose={() => { setAsnSetDrawerOpen(false); setAsnInput(''); }}
        width={380}
        footer={
          <Space>
            <Button onClick={() => { setAsnSetDrawerOpen(false); setAsnInput(''); }}>取消</Button>
            <Button
              type="primary"
              disabled={!asnInput.trim()}
              loading={asnActionLoading === `set-${asnSetItem?.id}`}
              onClick={setAsn}
            >
              确认设置
            </Button>
          </Space>
        }
      >
        <p style={{ color: '#666', fontSize: 13, marginBottom: 12 }}>
          为 <Text code>{asnSetItem?.ip_cidr}</Text> 在 Larus 系统中绑定 ASN。
        </p>
        <Input
          prefix={<Text type="secondary">AS</Text>}
          placeholder="输入 ASN 号码，如 12345"
          value={asnInput}
          onChange={e => setAsnInput(e.target.value.replace(/^AS/i, ''))}
          onPressEnter={setAsn}
        />
        <div style={{ marginTop: 16 }}>
          {loaContact.name ? (
            <Alert
              type="success"
              icon={<CheckCircleOutlined />}
              showIcon
              message={<span style={{ fontSize: 12 }}>将使用已配置联系信息：<b>{loaContact.name}</b> / {loaContact.company} / {loaContact.country_code}</span>}
              style={{ fontSize: 12 }}
            />
          ) : (
            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              message={
                <span style={{ fontSize: 12 }}>
                  LOA 联系信息未配置，API 可能失败。
                  <Button type="link" size="small" style={{ padding: '0 4px', fontSize: 12 }} onClick={() => { setLoaContactDraft(loaContact); setLoaContactModalOpen(true); }}>
                    立即配置
                  </Button>
                </span>
              }
            />
          )}
        </div>
      </Drawer>

      {/* 批量设置 ASN Modal */}
      <Modal
        title={`批量设置 ASN — 已选 ${selectedRowKeys.length} 条IP段`}
        open={batchSetOpen}
        onCancel={() => { if (!batchLoading) { setBatchSetOpen(false); setBatchAsnInput(''); setBatchProgress(null); } }}
        footer={null}
        closable={!batchLoading}
        maskClosable={!batchLoading}
      >
        {batchProgress ? (
          <div style={{ padding: '8px 0 16px' }}>
            <Progress
              percent={Math.round((batchProgress.done / batchProgress.total) * 100)}
              status={batchProgress.done < batchProgress.total ? 'active' : 'success'}
            />
            <div style={{ textAlign: 'center', color: '#666', marginTop: 8 }}>
              正在处理 {batchProgress.done} / {batchProgress.total}...
            </div>
          </div>
        ) : (
          <>
            <p style={{ color: '#666', marginBottom: 12 }}>
              将为选中的 <strong>{selectedRowKeys.length}</strong> 条IP段在 Larus 中各新增一条 ASN 分配记录。
            </p>
            <Input
              prefix={<Text type="secondary">AS</Text>}
              placeholder="输入 ASN 号码，如 12345"
              value={batchAsnInput}
              onChange={e => setBatchAsnInput(e.target.value.replace(/^AS/i, ''))}
              onPressEnter={batchSetAsn}
              autoFocus
            />
            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => { setBatchSetOpen(false); setBatchAsnInput(''); }}>取消</Button>
              <Button
                type="primary"
                disabled={!batchAsnInput.trim()}
                loading={batchLoading}
                onClick={batchSetAsn}
              >
                确认设置
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* 批量操作结果 Modal（有失败时显示） */}
      <Modal
        title="批量操作结果"
        open={batchResultOpen}
        onCancel={() => { setBatchResultOpen(false); setBatchErrors([]); }}
        footer={
          <Button type="primary" onClick={() => { setBatchResultOpen(false); setBatchErrors([]); setBatchSetOpen(false); setBatchAsnInput(''); setSelectedRowKeys([]); }}>
            关闭
          </Button>
        }
      >
        <p style={{ color: '#f5222d', marginBottom: 8 }}>以下 {batchErrors.length} 条操作失败：</p>
        <List
          size="small"
          dataSource={batchErrors}
          style={{ maxHeight: 300, overflowY: 'auto' }}
          renderItem={(msg: string) => (
            <List.Item style={{ padding: '4px 0', color: '#f5222d', fontSize: 13 }}>{msg}</List.Item>
          )}
        />
      </Modal>
    </div>
  );
};

export default LarusManagement;
