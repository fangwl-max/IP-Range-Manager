import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Alert,
  Modal,
  Spin,
  Tag,
  Tabs,
  Select,
  Statistic,
  Row,
  Col,
  Badge,
  Tooltip,
  Divider,
  message,
  Popconfirm,
  Input,
  InputNumber,
} from 'antd';
import {
  ReloadOutlined,
  DollarOutlined,
  CloudServerOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  SyncOutlined,
  MailOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { RENEWAL_STATUS_OPTIONS, RENEWAL_STATUS_DISPLAY } from '../types';

const { Title } = Typography;

interface ServicesMeta {
  current_page: number;
  last_page: number;
  per_page: number;
  total: number;
}

const REGISTRY_COLORS: Record<string, string> = {
  arin: 'blue', ripencc: 'purple', apnic: 'cyan', afrinic: 'orange', lacnic: 'green',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'green', terminated: 'red', cancelled: 'red', pending: 'blue', suspended: 'orange',
};

const LOA_STATUS_COLORS: Record<string, string> = {
  active: 'green', pending: 'blue', cancelled: 'red', expired: 'orange',
};

/** 根据供应商判断是否需要加 4% 手续费（仅 IPXO 供应商） */
const calcFee = (amount: number | null | undefined, supplier?: string): number => {
  if (amount == null) return 0;
  const isIpxo = !supplier || supplier.trim().toLowerCase() === 'ipxo';
  return isIpxo ? Number(amount) * 1.04 : Number(amount);
};
const fmtFee = (amount: number | null | undefined, supplier?: string): string => {
  if (amount == null) return '-';
  return '$' + calcFee(amount, supplier).toFixed(2);
};

const IPXOBilling: React.FC = () => {
  // 发票
  const [invoices, setInvoices] = useState<any[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesMeta, setInvoicesMeta] = useState<{ total: number }>({ total: 0 });

  // 活跃服务
  const [services, setServices] = useState<any[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [servicesMeta, setServicesMeta] = useState<ServicesMeta>({ current_page: 1, last_page: 1, per_page: 15, total: 0 });
  const [servicesPage, setServicesPage] = useState(1);
  const [servicesPageSize, setServicesPageSize] = useState(15);
  const [servicesStatus, setServicesStatus] = useState<string>('active');

  // 近期续费
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcomingDays, setUpcomingDays] = useState(14);

  // 已续费 IP 段（过往已续费，默认近 3 天）
  const [renewed, setRenewed] = useState<any[]>([]);
  const [renewedLoading, setRenewedLoading] = useState(false);
  const [renewedDays, setRenewedDays] = useState(3);
  const [renewedSupplierFilter, setRenewedSupplierFilter] = useState<string>('IPXO');
  // 用于取消进行中的 renewed 请求，防止竞态导致旧数据覆盖新数据
  const renewedAbortRef = useRef<AbortController | null>(null);

  // 行内编辑状态（续费状态 & 备注）
  const [editingRenewalSegment, setEditingRenewalSegment] = useState<string | null>(null);
  const [editingRemarkSegment, setEditingRemarkSegment] = useState<string | null>(null);
  const [editingRemarkValue, setEditingRemarkValue] = useState('');

  // 同步
  const [syncPreviewVisible, setSyncPreviewVisible] = useState(false);
  const [syncPreviewLoading, setSyncPreviewLoading] = useState(false);
  const [syncExecuting, setSyncExecuting] = useState(false);
  const [syncPreview, setSyncPreview] = useState<any>(null);
  const [syncMode, setSyncMode] = useState<'all' | 'add_only' | 'status_only'>('all');

  // 发送邮件提醒
  const [notifySending, setNotifySending] = useState(false);

  // 已租用IP → 同步到IP管理
  const [leasedSyncLoading, setLeasedSyncLoading] = useState(false);
  const [leasedSyncExecuting, setLeasedSyncExecuting] = useState(false);
  const [leasedSyncVisible, setLeasedSyncVisible] = useState(false);
  const [leasedSyncPreview, setLeasedSyncPreview] = useState<any>(null);

  // 近期续费 - 批量编辑续费状态
  const [upcomingSelectedKeys, setUpcomingSelectedKeys] = useState<string[]>([]);
  const [batchStatusSetting, setBatchStatusSetting] = useState(false);
  // 行内设置状态中
  const [inlineSaving, setInlineSaving] = useState(false);

  // 缓存状态
  const [cacheStatus, setCacheStatus] = useState<any>(null);
  const [cacheRefreshing, setCacheRefreshing] = useState(false);

  const [activeTab, setActiveTab] = useState('upcoming');

  // 加载发票
  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    try {
      const res = await fetch('/api/ipxo/invoices');
      const json = await res.json();
      if (json.success) {
        const raw = json.data;
        const list = Array.isArray(raw) ? raw : raw?.data ?? raw?.items ?? raw?.invoices ?? [];
        setInvoices(list);
        setInvoicesMeta({ total: raw?.meta?.total ?? list.length });
      } else {
        message.error('获取发票失败: ' + (json.message || '未知错误'));
      }
    } catch (e: any) {
      message.error('获取发票失败: ' + e.message);
    } finally {
      setInvoicesLoading(false);
    }
  }, []);

  // 加载活跃服务（服务端分页）
  const loadServices = useCallback(async (page: number, pageSize: number, status: string) => {
    setServicesLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), per_page: String(pageSize) });
      if (status) params.set('status', status);
      const res = await fetch(`/api/ipxo/services?${params}`);
      const json = await res.json();
      if (json.success) {
        const raw = json.data;
        setServices(Array.isArray(raw) ? raw : raw?.data ?? []);
        if (raw?.meta) setServicesMeta(raw.meta);
      } else {
        message.error('获取服务列表失败: ' + (json.message || '未知错误'));
      }
    } catch (e: any) {
      message.error('获取服务列表失败: ' + e.message);
    } finally {
      setServicesLoading(false);
    }
  }, []);

  // 加载缓存状态
  const loadCacheStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/ipxo/cache/status');
      const json = await res.json();
      if (json.success) setCacheStatus(json);
    } catch { /* 静默 */ }
  }, []);

  // 刷新缓存（全量拉取）
  const handleCacheRefresh = async () => {
    setCacheRefreshing(true);
    message.loading({ content: '正在全量拉取 IPXO 数据，约需 60 秒...', key: 'cache', duration: 120 });
    try {
      const res = await fetch('/api/ipxo/cache/refresh', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        message.success({ content: json.message, key: 'cache', duration: 4 });
        loadCacheStatus();
        loadInvoices();
        loadServices(servicesPage, servicesPageSize, servicesStatus);
        loadUpcoming(upcomingDays);
      } else {
        message.error({ content: '缓存刷新失败: ' + (json.message || '未知错误'), key: 'cache', duration: 4 });
      }
    } catch (e: any) {
      message.error({ content: '缓存刷新失败: ' + e.message, key: 'cache', duration: 4 });
    } finally {
      setCacheRefreshing(false);
    }
  };

  // 发送邮件提醒（传递近期续费数据 + 已续费数据，内容与近期续费页保持一致）
  const handleSendNotify = async () => {
    setNotifySending(true);
    try {
      const res = await fetch('/api/notify/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: upcoming, renewedItems: renewed }),
      });
      const json = await res.json();
      if (json.success) {
        message.success(json.message);
      } else {
        message.error('发送失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('发送失败: ' + e.message);
    } finally {
      setNotifySending(false);
    }
  };

  // 已租用IP → 同步到IP管理：预览
  const handleLeasedSyncPreview = async () => {
    setLeasedSyncLoading(true);
    setLeasedSyncPreview(null);
    setLeasedSyncVisible(true);
    try {
      const res = await fetch('/api/ipxo/services/sync-leased');
      const json = await res.json();
      if (json.success) {
        setLeasedSyncPreview(json);
      } else {
        message.error('预览失败: ' + json.message);
        setLeasedSyncVisible(false);
      }
    } catch (e: any) {
      message.error('预览失败: ' + e.message);
      setLeasedSyncVisible(false);
    } finally {
      setLeasedSyncLoading(false);
    }
  };

  // 已租用IP → 同步到IP管理：执行
  const handleLeasedSyncExecute = async () => {
    setLeasedSyncExecuting(true);
    try {
      const res = await fetch('/api/ipxo/services/sync-leased', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        message.success(json.message);
        setLeasedSyncVisible(false);
        setLeasedSyncPreview(null);
      } else {
        message.error('同步失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('同步失败: ' + e.message);
    } finally {
      setLeasedSyncExecuting(false);
    }
  };

  // 加载已续费 IP 段
  const loadRenewed = useCallback(async (days: number) => {
    // 取消上一个未完成的请求
    if (renewedAbortRef.current) renewedAbortRef.current.abort();
    const controller = new AbortController();
    renewedAbortRef.current = controller;
    setRenewedLoading(true);
    try {
      const res = await fetch(`/api/ipxo/services/renewed?days=${days}`, { signal: controller.signal });
      const json = await res.json();
      if (json.success) {
        // 按 IP 段去重，防止竞态或数据异常导致重复显示
        const data: any[] = json.data ?? [];
        const seen = new Set<string>();
        const deduped = data.filter(item => {
          const bs = item.billing_service;
          const key = bs?.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        setRenewed(deduped);
      }
    } catch (e: any) {
      if (e.name === 'AbortError') return; // 被取消，忽略
    } finally {
      setRenewedLoading(false);
    }
  }, []);

  // 批量设置近期续费 IP 段的续费状态（写独立状态文件）
  const handleBatchSetStatus = async (newStatus: string) => {
    if (upcomingSelectedKeys.length === 0) return;
    setBatchStatusSetting(true);
    try {
      const res = await fetch('/api/ipxo/upcoming/set-renewal-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: upcomingSelectedKeys, renewalStatus: newStatus }),
      });
      const json = await res.json();
      if (json.success) {
        message.success(`已更新 ${upcomingSelectedKeys.length} 个 IP 段的续费状态`);
        setUpcomingSelectedKeys([]);
        loadUpcoming(upcomingDays);
        loadRenewed(renewedDays);
      } else {
        message.error('更新失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('更新失败: ' + e.message);
    } finally {
      setBatchStatusSetting(false);
    }
  };

  // 行内设置单个 IP 段的续费状态
  const handleInlineSetStatus = async (segment: string, newStatus: string) => {
    setInlineSaving(true);
    try {
      const res = await fetch('/api/ipxo/upcoming/set-renewal-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: [segment], renewalStatus: newStatus }),
      });
      const json = await res.json();
      if (json.success) {
        setUpcoming(prev => prev.map(item => {
          const bs = item.billing_service || {};
          const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          if (seg === segment) return { ...item, _localRenewalStatus: newStatus };
          return item;
        }));
        loadRenewed(renewedDays);
      } else {
        message.error('更新失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('更新失败: ' + e.message);
    } finally {
      setInlineSaving(false);
      setEditingRenewalSegment(null);
    }
  };

  // 行内设置单个 IP 段的备注
  const handleInlineSetRemark = async (segment: string, remark: string) => {
    setInlineSaving(true);
    try {
      const res = await fetch('/api/ipxo/upcoming/set-remark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segment, remark }),
      });
      const json = await res.json();
      if (json.success) {
        setUpcoming(prev => prev.map(item => {
          const bs = item.billing_service || {};
          const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          if (seg === segment) return { ...item, _localRemark: remark };
          return item;
        }));
        setRenewed(prev => prev.map(item => {
          const bs = item.billing_service || {};
          const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
          if (seg === segment) return { ...item, _localRemark: remark };
          return item;
        }));
      } else {
        message.error('备注更新失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('备注更新失败: ' + e.message);
    } finally {
      setInlineSaving(false);
      setEditingRemarkSegment(null);
    }
  };

  // 同步预览
  const handleSyncPreview = async (mode: 'all' | 'add_only' | 'status_only' = 'all') => {
    setSyncMode(mode);
    setSyncPreviewLoading(true);
    setSyncPreview(null);
    setSyncPreviewVisible(true);
    try {
      const res = await fetch(`/api/ipxo/sync?mode=${mode}`);
      const json = await res.json();
      if (json.success) {
        setSyncPreview(json);
      } else {
        message.error('获取同步预览失败: ' + (json.message || '未知错误'));
        setSyncPreviewVisible(false);
      }
    } catch (e: any) {
      message.error('获取同步预览失败: ' + e.message);
      setSyncPreviewVisible(false);
    } finally {
      setSyncPreviewLoading(false);
    }
  };

  // 执行同步
  const handleSyncExecute = async () => {
    setSyncExecuting(true);
    try {
      const res = await fetch(`/api/ipxo/sync?mode=${syncMode}`, { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        message.success(json.message || '同步完成');
        setSyncPreviewVisible(false);
        setSyncPreview(null);
      } else {
        message.error('同步失败: ' + (json.message || '未知错误'));
      }
    } catch (e: any) {
      message.error('同步失败: ' + e.message);
    } finally {
      setSyncExecuting(false);
    }
  };

  // 加载近期续费
  const loadUpcoming = useCallback(async (days: number) => {
    setUpcomingLoading(true);
    try {
      const res = await fetch(`/api/ipxo/services/upcoming?days=${days}`);
      const json = await res.json();
      if (json.success) {
        setUpcoming(json.data ?? []);
      } else {
        message.error('获取近期续费失败: ' + (json.message || '未知错误'));
      }
    } catch (e: any) {
      message.error('获取近期续费失败: ' + e.message);
    } finally {
      setUpcomingLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvoices();
    loadServices(servicesPage, servicesPageSize, servicesStatus);
    loadUpcoming(upcomingDays);
    loadCacheStatus();
    loadRenewed(renewedDays);
  }, []); // eslint-disable-line

  const handleServicesTableChange = (pagination: any) => {
    const newPage = pagination.current;
    const newSize = pagination.pageSize;
    setServicesPage(newPage);
    setServicesPageSize(newSize);
    loadServices(newPage, newSize, servicesStatus);
  };

  const handleStatusChange = (val: string) => {
    setServicesStatus(val);
    setServicesPage(1);
    loadServices(1, servicesPageSize, val);
  };

  // 发票列
  const invoiceColumns = [
    {
      title: '发票编号',
      dataIndex: 'invoice_number',
      key: 'invoice_number',
      render: (v: string, r: any) => v || r.id || r.uuid || '-',
    },
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      render: (v: any, r: any) => {
        const val = v || r.created_at;
        if (!val) return '-';
        return typeof val === 'number' ? dayjs.unix(val).format('YYYY-MM-DD') : dayjs(val).format('YYYY-MM-DD');
      },
      sorter: (a: any, b: any) => (a.date ?? 0) - (b.date ?? 0),
    },
    {
      title: '金额',
      key: 'total',
      align: 'right' as const,
      render: (_: any, r: any) => {
        const amount = r.subtotal_with_taxes ?? r.total ?? r.amount;
        const currency = r.currency || 'USD';
        return amount != null ? `${currency} ${Number(amount).toFixed(2)}` : '-';
      },
      sorter: (a: any, b: any) =>
        (a.subtotal_with_taxes ?? a.total ?? 0) - (b.subtotal_with_taxes ?? b.total ?? 0),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string) => {
        if (!v) return '-';
        const colorMap: Record<string, string> = { paid: 'green', unpaid: 'orange', overdue: 'red', pending: 'blue', refunded: 'cyan', cancelled: 'default' };
        return <Tag color={colorMap[v.toLowerCase()] || 'default'}>{v}</Tag>;
      },
    },
    {
      title: '到期日',
      dataIndex: 'date_due',
      key: 'date_due',
      render: (v: any) => v ? dayjs.unix(v).format('YYYY-MM-DD') : '-',
    },
    {
      title: '项目数',
      dataIndex: 'items_count',
      key: 'items_count',
      render: (v: number) => v ?? '-',
    },
  ];

  // 活跃服务列
  const serviceColumns = [
    {
      title: 'IP 段',
      key: 'subnet',
      width: 150,
      render: (_: any, r: any) => {
        const bs = r.billing_service || {};
        return bs.address && bs.cidr != null
          ? <span style={{ fontFamily: 'monospace', fontWeight: 500 }}>{bs.address}/{bs.cidr}</span>
          : '-';
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_: any, r: any) => {
        const v = r.billing_service?.status;
        if (!v) return '-';
        return <Tag color={STATUS_COLORS[v.toLowerCase()] || 'default'}>{v}</Tag>;
      },
    },
    {
      title: 'RIR',
      key: 'registry',
      width: 90,
      render: (_: any, r: any) => {
        const reg = r.market_service?.registry;
        if (!reg) return '-';
        return <Tag color={REGISTRY_COLORS[reg.toLowerCase()] || 'default'}>{reg.toUpperCase()}</Tag>;
      },
    },
    {
      title: '月费 (USD)',
      key: 'price',
      align: 'right' as const,
      width: 110,
      render: (_: any, r: any) => {
        const amount = r.billing_service?.recurring_amount;
        return amount != null ? `$${Number(amount).toFixed(2)}` : '-';
      },
      sorter: (a: any, b: any) =>
        (a.billing_service?.recurring_amount ?? 0) - (b.billing_service?.recurring_amount ?? 0),
    },
    {
      title: '下次到期',
      key: 'next_due_date',
      width: 110,
      render: (_: any, r: any) => {
        const ts = r.billing_service?.next_due_date;
        return ts ? dayjs.unix(ts).format('YYYY-MM-DD') : '-';
      },
      sorter: (a: any, b: any) =>
        (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0),
    },
    {
      title: 'LOA',
      key: 'loa_count',
      width: 60,
      align: 'center' as const,
      render: (_: any, r: any) => {
        const loas = r.loa;
        return Array.isArray(loas) ? loas.length : '-';
      },
    },
    {
      title: 'ASN / LOA 状态',
      key: 'asn',
      render: (_: any, r: any) => {
        const loas: any[] = Array.isArray(r.loa) ? r.loa : [];
        if (loas.length === 0) return <span style={{ color: '#999' }}>—</span>;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {loas.map((loa: any) => (
              <Space key={loa.uuid} size={4} wrap>
                <span style={{ fontFamily: 'monospace', fontSize: 12 }}>AS{loa.asn}</span>
                <span style={{ fontSize: 12, color: '#555' }}>— {loa.as_name}</span>
                <Tag color={LOA_STATUS_COLORS[loa.status?.toLowerCase()] || 'default'} style={{ fontSize: 11, padding: '0 4px' }}>
                  {loa.status}
                </Tag>
              </Space>
            ))}
          </div>
        );
      },
    },
    {
      title: 'Service UUID',
      key: 'service_uuid',
      width: 120,
      ellipsis: true,
      render: (_: any, r: any) => {
        const uuid = r.market_service?.uuid || r.billing_service?.uuid;
        return uuid ? <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{uuid}</span> : '-';
      },
    },
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title level={4} style={{ margin: 0 }}>IPXO 账单管理</Title>
          <Space>
            <Select
              value={syncMode}
              onChange={(val) => setSyncMode(val)}
              style={{ width: 130 }}
              options={[
                { label: '同步全部', value: 'all' },
                { label: '仅同步新增', value: 'add_only' },
                { label: '仅同步状态', value: 'status_only' },
              ]}
            />
            <Button
              icon={<SyncOutlined />}
              onClick={() => handleSyncPreview(syncMode)}
              loading={syncPreviewLoading}
            >
              同步到 IP 管理
            </Button>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => { loadInvoices(); loadServices(servicesPage, servicesPageSize, servicesStatus); loadUpcoming(upcomingDays); }}
              loading={invoicesLoading || servicesLoading || upcomingLoading}
            >
              刷新数据
            </Button>
          </Space>
        </div>
        {cacheStatus && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
            {cacheStatus.exists ? (
              <>
                <Tag color={cacheStatus.isExpired ? 'orange' : 'green'}>
                  {cacheStatus.isExpired ? '缓存已过期' : '缓存有效'}
                </Tag>
                <span style={{ fontSize: 12, color: '#666' }}>
                  更新于 {cacheStatus.cachedAt?.slice(0, 16).replace('T', ' ')}（{cacheStatus.ageMinutes} 分钟前）
                </span>
                <span style={{ fontSize: 12, color: '#666' }}>
                  服务 {cacheStatus.servicesCount} 条 · 发票 {cacheStatus.invoicesCount} 条
                </span>
              </>
            ) : (
              <Tag color="red">尚无缓存</Tag>
            )}
            <Button
              size="small"
              icon={<SyncOutlined spin={cacheRefreshing} />}
              loading={cacheRefreshing}
              onClick={handleCacheRefresh}
            >
              {cacheStatus.exists ? '刷新缓存' : '立即缓存'}
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={(key) => {
            setActiveTab(key);
            if (key === 'upcoming') loadRenewed(renewedDays);
          }}
          items={[
            {
              key: 'upcoming',
              label: (
                <Space>
                  <Badge count={upcoming.filter(r => {
                    const due = r.billing_service?.next_due_date;
                    return due && due - Math.floor(Date.now() / 1000) <= 3 * 86400;
                  }).length} size="small" offset={[4, 0]}>
                    <Space><WarningOutlined />近期续费</Space>
                  </Badge>
                </Space>
              ),
              children: (
                <>
                  <Row gutter={16} style={{ marginBottom: 16 }} align="middle">
                    <Col flex="auto">
                      <Space>
                        <span>查看未来</span>
                        <Select
                          value={upcomingDays}
                          onChange={(val) => { setUpcomingDays(val); loadUpcoming(val); }}
                          style={{ width: 90 }}
                          options={[
                            { label: '5 天', value: 5 },
                            { label: '7 天', value: 7 },
                            { label: '14 天', value: 14 },
                            { label: '30 天', value: 30 },
                          ]}
                        />
                        <span>内到期的 IP 段</span>
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={upcomingLoading}
                          onClick={() => { loadUpcoming(upcomingDays); loadRenewed(renewedDays); }}
                        >刷新</Button>
                      </Space>
                    </Col>
                    <Col>
                      <Space>
                        {upcomingSelectedKeys.length > 0 && (
                          <Space>
                            <span style={{ fontSize: 13, color: '#666' }}>已选 {upcomingSelectedKeys.length} 个</span>
                            <Select
                              placeholder="批量设置续费状态"
                              style={{ width: 140 }}
                              loading={batchStatusSetting}
                              options={[
                                { label: '✅ 已续费', value: 'renewed' },
                                { label: '❌ 取消续费', value: 'cancelled' },
                                { label: '🔄 恢复待续费', value: 'not_renewed' },
                                { label: '💰 已退款', value: 'refunded' },
                              ]}
                              onChange={(val) => handleBatchSetStatus(val)}
                            />
                          </Space>
                        )}
                        <Button
                          icon={<MailOutlined />}
                          type="primary"
                          loading={notifySending}
                          disabled={upcoming.length === 0}
                          onClick={handleSendNotify}
                        >
                          发送提醒
                        </Button>
                      </Space>
                    </Col>
                  </Row>

                  {(() => {
                    const urgent = upcoming.filter(r => {
                      const due = r.billing_service?.next_due_date;
                      return due && due - Math.floor(Date.now() / 1000) <= 3 * 86400;
                    });
                    if (urgent.length === 0) return null;
                    return (
                      <Alert
                        type="error"
                        showIcon
                        icon={<WarningOutlined />}
                        style={{ marginBottom: 12 }}
                        message={`⚠️ 紧急提醒：${urgent.length} 个 IP 段将在 3 天内到期续费`}
                        description={urgent.map(r => {
                          const bs = r.billing_service;
                          const daysLeft = Math.ceil((bs.next_due_date - Math.floor(Date.now() / 1000)) / 86400);
                          return `${bs.address}/${bs.cidr}（${daysLeft <= 0 ? '今日到期' : `还剩 ${daysLeft} 天`}，${fmtFee(bs.recurring_amount, r._localSupplier)}/月）`;
                        }).join('　|　')}
                      />
                    );
                  })()}

                  {/* 合计信息放在表格上方 */}
                  {upcoming.length > 0 && (() => {
                    const totalFee = upcoming.reduce((acc, r) => acc + calcFee(r.billing_service?.recurring_amount, r._localSupplier), 0);
                    return (
                      <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f0f5ff', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 24 }}>
                        <span style={{ fontWeight: 600 }}>合计 {upcoming.length} 个 IP 段</span>
                        <span>月费合计：<strong style={{ color: '#1677ff' }}>${totalFee.toFixed(2)}</strong></span>
                      </div>
                    );
                  })()}

                  <Table
                    loading={upcomingLoading}
                    dataSource={upcoming}
                    rowKey={(r, i) => r.market_service?.uuid || r.billing_service?.uuid || `up-${i}`}
                    size="small"
                    scroll={{ x: 1100 }}
                    pagination={false}
                    rowSelection={{
                      selectedRowKeys: upcomingSelectedKeys,
                      onChange: (keys) => setUpcomingSelectedKeys(keys as string[]),
                    }}
                    rowClassName={(r) => {
                      const due = r.billing_service?.next_due_date;
                      const secsLeft = due ? due - Math.floor(Date.now() / 1000) : Infinity;
                      if (secsLeft <= 86400) return 'row-urgent-critical';
                      if (secsLeft <= 3 * 86400) return 'row-urgent-warning';
                      return '';
                    }}
                    columns={[
                      {
                        title: 'IP 段',
                        key: 'subnet',
                        width: 150,
                        render: (_: any, r: any) => {
                          const bs = r.billing_service || {};
                          return bs.address
                            ? <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{bs.address}/{bs.cidr}</span>
                            : '-';
                        },
                      },
                      {
                        title: '到期日',
                        key: 'next_due_date',
                        width: 120,
                        defaultSortOrder: 'ascend' as const,
                        sorter: (a: any, b: any) =>
                          (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0),
                        render: (_: any, r: any) => {
                          const ts = r.billing_service?.next_due_date;
                          if (!ts) return '-';
                          const secsLeft = ts - Math.floor(Date.now() / 1000);
                          const daysLeft = Math.ceil(secsLeft / 86400);
                          const dateStr = dayjs.unix(ts).format('YYYY-MM-DD');
                          let color = '#52c41a';
                          if (daysLeft <= 1) color = '#ff4d4f';
                          else if (daysLeft <= 3) color = '#fa8c16';
                          else if (daysLeft <= 5) color = '#fadb14';
                          return (
                            <Tooltip title={daysLeft <= 0 ? '今日到期！' : `还剩 ${daysLeft} 天`}>
                              <Space size={4}>
                                <ClockCircleOutlined style={{ color }} />
                                <span style={{ color, fontWeight: daysLeft <= 3 ? 700 : 400 }}>{dateStr}</span>
                                <Tag color={daysLeft <= 1 ? 'red' : daysLeft <= 3 ? 'orange' : daysLeft <= 5 ? 'gold' : 'green'} style={{ fontSize: 11 }}>
                                  {daysLeft <= 0 ? '今日到期' : `${daysLeft}天后`}
                                </Tag>
                              </Space>
                            </Tooltip>
                          );
                        },
                      },
                      {
                        title: '月费+手续费 (USD)',
                        key: 'price',
                        width: 130,
                        align: 'right' as const,
                        render: (_: any, r: any) => {
                          const amount = r.billing_service?.recurring_amount;
                          return amount != null
                            ? <span style={{ fontWeight: 600 }}>{fmtFee(amount, r._localSupplier)}</span>
                            : '-';
                        },
                        sorter: (a: any, b: any) =>
                          calcFee(a.billing_service?.recurring_amount, a._localSupplier) - calcFee(b.billing_service?.recurring_amount, b._localSupplier),
                      },
                      {
                        title: 'RIR',
                        key: 'registry',
                        width: 90,
                        render: (_: any, r: any) => {
                          const reg = r.market_service?.registry;
                          if (!reg) return '-';
                          return <Tag color={REGISTRY_COLORS[reg.toLowerCase()] || 'default'}>{reg.toUpperCase()}</Tag>;
                        },
                      },
                      {
                        title: 'LOA',
                        key: 'loa_count',
                        width: 60,
                        align: 'center' as const,
                        render: (_: any, r: any) => Array.isArray(r.loa) ? r.loa.length : '-',
                      },
                      {
                        title: 'ASN / LOA 状态',
                        key: 'asn',
                        width: 220,
                        render: (_: any, r: any) => {
                          const loas: any[] = Array.isArray(r.loa) ? r.loa : [];
                          if (loas.length === 0) return <span style={{ color: '#999' }}>—</span>;
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              {loas.map((loa: any) => (
                                <Space key={loa.uuid} size={4} wrap>
                                  <span style={{ fontFamily: 'monospace', fontSize: 12 }}>AS{loa.asn}</span>
                                  <span style={{ fontSize: 12, color: '#555' }}>— {loa.as_name}</span>
                                  <Tag color={LOA_STATUS_COLORS[loa.status?.toLowerCase()] || 'default'} style={{ fontSize: 11, padding: '0 4px' }}>
                                    {loa.status}
                                  </Tag>
                                </Space>
                              ))}
                            </div>
                          );
                        },
                      },
                      {
                        title: '供应商',
                        key: 'supplier',
                        width: 90,
                        render: (_: any, r: any) => {
                          const s = r._localSupplier;
                          return s ? <Tag>{s}</Tag> : <span style={{ color: '#ccc' }}>-</span>;
                        },
                      },
                      {
                        title: '项目组',
                        key: 'projectGroups',
                        width: 160,
                        render: (_: any, r: any) => {
                          const groups: string[] = r._localProjectGroups || [];
                          if (groups.length === 0) return <span style={{ color: '#ccc' }}>-</span>;
                          return (
                            <Space size={2} wrap>
                              {groups.map((g: string) => <Tag key={g} style={{ fontSize: 11 }}>{g}</Tag>)}
                            </Space>
                          );
                        },
                      },
                      {
                        title: '是否续费',
                        key: 'renewalStatus',
                        width: 130,
                        render: (_: any, r: any) => {
                          const bs = r.billing_service || {};
                          const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
                          const status = r._localRenewalStatus || 'not_renewed';
                          const display = RENEWAL_STATUS_DISPLAY[status as keyof typeof RENEWAL_STATUS_DISPLAY];
                          const statusColor = status === 'cancelled' ? 'orange' : status === 'renewed' ? 'green' : status === 'refunded' ? 'blue' : 'default';

                          if (editingRenewalSegment === seg) {
                            return (
                              <Select
                                size="small"
                                autoFocus
                                defaultValue={status}
                                style={{ width: 110 }}
                                loading={inlineSaving}
                                onChange={(val) => handleInlineSetStatus(seg, val)}
                                onBlur={() => setEditingRenewalSegment(null)}
                                options={[
                                  { label: '待续费', value: 'not_renewed' },
                                  { label: '已续费', value: 'renewed' },
                                  { label: '取消续费', value: 'cancelled' },
                                  { label: '已退款', value: 'refunded' },
                                ]}
                              />
                            );
                          }
                          return (
                            <Space size={4}>
                              <Tag color={statusColor} style={{ cursor: 'pointer' }} onClick={() => setEditingRenewalSegment(seg)}>
                                {display?.text || status}
                              </Tag>
                              <EditOutlined style={{ fontSize: 11, color: '#999', cursor: 'pointer' }} onClick={() => setEditingRenewalSegment(seg)} />
                            </Space>
                          );
                        },
                      },
                      {
                        title: '备注',
                        key: 'remark',
                        render: (_: any, r: any) => {
                          const bs = r.billing_service || {};
                          const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
                          const remark = r._localRemark || '';

                          if (editingRemarkSegment === seg) {
                            return (
                              <Space size={4}>
                                <Input
                                  size="small"
                                  autoFocus
                                  defaultValue={remark}
                                  style={{ width: 160 }}
                                  onChange={(e) => setEditingRemarkValue(e.target.value)}
                                  onPressEnter={() => handleInlineSetRemark(seg, editingRemarkValue)}
                                />
                                <Button size="small" type="text" icon={<CheckOutlined style={{ color: '#52c41a' }} />} loading={inlineSaving} onClick={() => handleInlineSetRemark(seg, editingRemarkValue)} />
                                <Button size="small" type="text" icon={<CloseOutlined style={{ color: '#999' }} />} onClick={() => setEditingRemarkSegment(null)} />
                              </Space>
                            );
                          }
                          return (
                            <Space size={4}>
                              {remark ? (
                                <Tooltip title={remark}>
                                  <span style={{ color: '#666', fontSize: 13, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{remark}</span>
                                </Tooltip>
                              ) : (
                                <span style={{ color: '#ccc', fontSize: 12 }}>-</span>
                              )}
                              <EditOutlined style={{ fontSize: 11, color: '#999', cursor: 'pointer' }} onClick={() => { setEditingRemarkSegment(seg); setEditingRemarkValue(remark); }} />
                            </Space>
                          );
                        },
                      },
                    ]}
                  />

                  {/* 已续费 IP 段分区 */}
                  <Divider orientation="left" style={{ marginTop: 24 }}>
                    <Space>
                      <CheckCircleOutlined style={{ color: '#52c41a' }} />
                      <span style={{ color: '#52c41a', fontWeight: 600 }}>近期已续费</span>
                      <Select
                        size="small"
                        value={renewedDays}
                        onChange={(val) => { setRenewedDays(val); loadRenewed(val); }}
                        style={{ width: 80 }}
                        options={[
                          { label: '近1天', value: 1 },
                          { label: '近3天', value: 3 },
                          { label: '近7天', value: 7 },
                          { label: '近14天', value: 14 },
                          { label: '近30天', value: 30 },
                        ]}
                      />
                      <Select
                        size="small"
                        value={renewedSupplierFilter}
                        onChange={(val) => setRenewedSupplierFilter(val)}
                        style={{ minWidth: 90 }}
                        allowClear
                        placeholder="全部供应商"
                        options={[
                          { label: '全部', value: '' },
                          ...Array.from(new Set(renewed.map(r => r._localSupplier).filter(Boolean)))
                            .sort()
                            .map(s => ({ label: s as string, value: s as string })),
                        ]}
                      />
                      <Button size="small" icon={<ReloadOutlined />} loading={renewedLoading} onClick={() => loadRenewed(renewedDays)}>刷新</Button>
                    </Space>
                  </Divider>

                  {(() => {
                    const filteredRenewed = renewedSupplierFilter
                      ? renewed.filter(r => r._localSupplier === renewedSupplierFilter)
                      : renewed;
                    return filteredRenewed.length === 0 && !renewedLoading ? (
                      <div style={{ color: '#999', textAlign: 'center', padding: '16px 0', fontSize: 13 }}>
                        近 {renewedDays} 天内暂无已续费的 IP 段{renewedSupplierFilter ? `（供应商：${renewedSupplierFilter}）` : ''}
                      </div>
                    ) : (
                      <Table
                        loading={renewedLoading}
                        dataSource={filteredRenewed}
                        rowKey={(r, i) => r.market_service?.uuid || r.billing_service?.uuid || `ren-${i}`}
                        size="small"
                        scroll={{ x: 900 }}
                        pagination={false}
                      columns={[
                        {
                          title: 'IP 段',
                          key: 'subnet',
                          width: 150,
                          render: (_: any, r: any) => {
                            const bs = r.billing_service || {};
                            return bs.address
                              ? <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#52c41a' }}>{bs.address}/{bs.cidr}</span>
                              : '-';
                          },
                        },
                        {
                          title: '续费日',
                          key: 'next_due_date',
                          width: 120,
                          sorter: (a: any, b: any) =>
                            (a.billing_service?.next_due_date ?? 0) - (b.billing_service?.next_due_date ?? 0),
                          render: (_: any, r: any) => {
                            const ts = r.billing_service?.next_due_date;
                            return ts ? dayjs.unix(ts).format('YYYY-MM-DD') : '-';
                          },
                        },
                        {
                          title: '月费+手续费 (USD)',
                          key: 'price',
                          width: 130,
                          align: 'right' as const,
                          render: (_: any, r: any) => {
                            const amount = r.billing_service?.recurring_amount;
                            return amount != null ? <span style={{ fontWeight: 600 }}>{fmtFee(amount, r._localSupplier)}</span> : '-';
                          },
                        },
                        {
                          title: 'RIR',
                          key: 'registry',
                          width: 90,
                          render: (_: any, r: any) => {
                            const reg = r.market_service?.registry;
                            if (!reg) return '-';
                            return <Tag color={REGISTRY_COLORS[reg.toLowerCase()] || 'default'}>{reg.toUpperCase()}</Tag>;
                          },
                        },
                        {
                          title: '状态',
                          key: 'renewalStatus',
                          width: 100,
                          render: () => <Tag color="green"><CheckCircleOutlined /> 已续费</Tag>,
                        },
                        {
                          title: '供应商',
                          key: 'supplier',
                          width: 90,
                          render: (_: any, r: any) => {
                            const s = r._localSupplier;
                            return s ? <Tag>{s}</Tag> : <span style={{ color: '#ccc' }}>-</span>;
                          },
                        },
                        {
                          title: '项目组',
                          key: 'projectGroups',
                          width: 160,
                          render: (_: any, r: any) => {
                            const groups: string[] = r._localProjectGroups || [];
                            if (groups.length === 0) return <span style={{ color: '#ccc' }}>-</span>;
                            return (
                              <Space size={2} wrap>
                                {groups.map((g: string) => <Tag key={g} style={{ fontSize: 11 }}>{g}</Tag>)}
                              </Space>
                            );
                          },
                        },
                        {
                          title: '备注',
                          key: 'remark',
                          render: (_: any, r: any) => {
                            const bs = r.billing_service || {};
                            const seg = bs.address && bs.cidr != null ? `${bs.address}/${bs.cidr}` : '';
                            const remark = r._localRemark || '';
                            if (editingRemarkSegment === seg) {
                              return (
                                <Space size={4}>
                                  <Input
                                    size="small"
                                    autoFocus
                                    defaultValue={remark}
                                    style={{ width: 160 }}
                                    onChange={(e) => setEditingRemarkValue(e.target.value)}
                                    onPressEnter={() => handleInlineSetRemark(seg, editingRemarkValue)}
                                  />
                                  <Button size="small" type="text" icon={<CheckOutlined style={{ color: '#52c41a' }} />} loading={inlineSaving} onClick={() => handleInlineSetRemark(seg, editingRemarkValue)} />
                                  <Button size="small" type="text" icon={<CloseOutlined style={{ color: '#999' }} />} onClick={() => setEditingRemarkSegment(null)} />
                                </Space>
                              );
                            }
                            return (
                              <Space size={4}>
                                {remark ? (
                                  <Tooltip title={remark}>
                                    <span style={{ color: '#666', fontSize: 13, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{remark}</span>
                                  </Tooltip>
                                ) : (
                                  <span style={{ color: '#ccc', fontSize: 12 }}>-</span>
                                )}
                                <EditOutlined style={{ fontSize: 11, color: '#999', cursor: 'pointer' }} onClick={() => { setEditingRemarkSegment(seg); setEditingRemarkValue(remark); }} />
                              </Space>
                            );
                          },
                        },
                      ]}
                    />
                    );
                  })()}
                </>
              ),
            },
            {
              key: 'services',
              label: (
                <Space>
                  <CloudServerOutlined />
                  {`已租用 IP (${servicesMeta.total})`}
                </Space>
              ),
              children: (
                <>
                  <Row gutter={16} style={{ marginBottom: 16 }}>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic title="记录数" value={servicesMeta.total} />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic title="LOA" value={services.reduce((acc, r) => acc + (Array.isArray(r.loa) ? r.loa.length : 0), 0)} suffix={`/ ${services.length} 条`} />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic
                          title="月费合计 (USD)"
                          value={services.reduce((acc, r) => acc + (r.billing_service?.recurring_amount ?? 0), 0).toFixed(2)}
                          prefix="$"
                        />
                      </Card>
                    </Col>
                    <Col span={6}>
                      <Card size="small">
                        <Statistic
                          title="RIR 分布"
                          formatter={() => {
                            const counts: Record<string, number> = {};
                            services.forEach(r => {
                              const reg = r.market_service?.registry?.toUpperCase();
                              if (reg) counts[reg] = (counts[reg] || 0) + 1;
                            });
                            return (
                              <Space wrap size={4}>
                                {Object.entries(counts).map(([k, v]) => (
                                  <Tag key={k} color={REGISTRY_COLORS[k.toLowerCase()] || 'default'}>{k}: {v}</Tag>
                                ))}
                              </Space>
                            );
                          }}
                        />
                      </Card>
                    </Col>
                  </Row>

                  <div style={{ marginBottom: 12 }}>
                    <Space>
                      <span>状态筛选：</span>
                      <Select
                        value={servicesStatus}
                        onChange={handleStatusChange}
                        style={{ width: 140 }}
                        options={[
                          { label: '全部', value: '' },
                          { label: 'Active（租用中）', value: 'active' },
                          { label: 'Terminated', value: 'terminated' },
                          { label: 'Pending', value: 'pending' },
                          { label: 'Suspended', value: 'suspended' },
                        ]}
                      />
                      <Button
                        icon={<SyncOutlined />}
                        onClick={handleLeasedSyncPreview}
                        loading={leasedSyncLoading}
                      >
                        同步到 IP 管理
                      </Button>
                    </Space>
                  </div>

                  <Table
                    loading={servicesLoading}
                    dataSource={services}
                    columns={serviceColumns}
                    rowKey={(r, i) => r.market_service?.uuid || r.billing_service?.uuid || `svc-${i}`}
                    size="small"
                    scroll={{ x: 1100 }}
                    pagination={{
                      current: servicesPage,
                      pageSize: servicesPageSize,
                      total: servicesMeta.total,
                      showSizeChanger: true,
                      pageSizeOptions: ['15', '30', '50', '100'],
                      showTotal: (t) => `共 ${t} 条 / 第 ${servicesMeta.current_page} 页，共 ${servicesMeta.last_page} 页`,
                    }}
                    onChange={handleServicesTableChange}
                  />
                </>
              ),
            },
            {
              key: 'invoices',
              label: (
                <Space>
                  <DollarOutlined />
                  {`发票 (${invoicesMeta.total || invoices.length})`}
                </Space>
              ),
              children: (
                <Table
                  loading={invoicesLoading}
                  dataSource={invoices}
                  columns={invoiceColumns}
                  rowKey={(r, i) => r.uuid || r.id || r.invoice_number || `inv-${i}`}
                  size="small"
                  pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
                />
              ),
            },
          ]}
        />
      </Card>

      {/* 同步预览弹窗 */}
      <Modal
        title={
          <Space>
            <SyncOutlined />
            同步 IPXO 数据到 IP 管理
            <Tag color="blue">
              {syncMode === 'all' ? '全部' : syncMode === 'add_only' ? '仅新增' : '仅同步状态'}
            </Tag>
          </Space>
        }
        open={syncPreviewVisible}
        onCancel={() => { setSyncPreviewVisible(false); setSyncPreview(null); }}
        width={780}
        footer={[
          <Button key="cancel" onClick={() => { setSyncPreviewVisible(false); setSyncPreview(null); }}>取消</Button>,
          <Button
            key="execute"
            type="primary"
            icon={<SyncOutlined />}
            loading={syncExecuting}
            disabled={!syncPreview || (syncPreview.toAdd === 0 && syncPreview.toUpdate === 0)}
            onClick={handleSyncExecute}
          >
            确认同步
          </Button>,
        ]}
      >
        {syncPreviewLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin tip="正在从 IPXO 拉取全量数据并比对，请稍候..." />
            <div style={{ marginTop: 12, color: '#999', fontSize: 12 }}>数据量较大，可能需要 30~60 秒</div>
          </div>
        ) : syncPreview ? (
          <div>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={6}><Statistic title="IPXO 总服务数" value={syncPreview.ipxoTotal} /></Col>
              <Col span={6}><Statistic title="本地 IP 段数" value={syncPreview.localTotal} /></Col>
              <Col span={6}><Statistic title="待新增" value={syncPreview.toAdd} valueStyle={{ color: '#52c41a' }} /></Col>
              <Col span={6}><Statistic title="待更新状态" value={syncPreview.toUpdate} valueStyle={{ color: '#fa8c16' }} /></Col>
            </Row>

            {syncPreview.toAdd === 0 && syncPreview.toUpdate === 0 && (
              <Alert type="success" showIcon message="本地数据与 IPXO 已完全同步，无需操作" />
            )}

            {syncPreview.toAddItems?.length > 0 && (
              <>
                <Divider orientation="left"><Tag color="green">新增 {syncPreview.toAdd} 条</Tag>IPXO 有但本地未录入的 IP 段</Divider>
                <Table
                  size="small"
                  dataSource={syncPreview.toAddItems}
                  rowKey={(r: any, i: any) => r.marketUuid || `add-${i}`}
                  pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
                  columns={[
                    { title: 'IP 段', key: 'seg', render: (_: any, r: any) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.segment}</span> },
                    { title: 'RIR', dataIndex: 'registry', key: 'registry', render: (v: string) => v ? <Tag color={REGISTRY_COLORS[v.toLowerCase()] || 'default'}>{v.toUpperCase()}</Tag> : '-' },
                    { title: '月费', dataIndex: 'monthlyPrice', key: 'price', align: 'right' as const, render: (v: number) => `$${Number(v).toFixed(2)}` },
                    { title: '续费日', dataIndex: 'nextDueDate', key: 'due' },
                    { title: 'LOA 数', key: 'loa', render: (_: any, r: any) => Array.isArray(r.loa) ? r.loa.length : '-' },
                  ]}
                />
              </>
            )}

            {syncPreview.toUpdateItems?.filter((i: any) => i._action === 'update_status').length > 0 && (
              <>
                <Divider orientation="left"><Tag color="orange">更新状态 {syncPreview.toUpdate} 条</Tag>IPXO 已终止、本地仍为 renewed/not_renewed</Divider>
                <Table
                  size="small"
                  dataSource={syncPreview.toUpdateItems.filter((i: any) => i._action === 'update_status')}
                  rowKey={(r: any, i: any) => r.localId || `upd-${i}`}
                  pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 条` }}
                  columns={[
                    { title: 'IP 段', key: 'seg', render: (_: any, r: any) => <span style={{ fontFamily: 'monospace' }}>{r.segment}</span> },
                    { title: '原状态', dataIndex: 'oldRenewalStatus', key: 'old', render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
                    { title: '→ 新状态', dataIndex: 'newRenewalStatus', key: 'new', render: (v: string) => v ? <Tag color="orange">{v}</Tag> : '-' },
                    { title: 'IPXO 状态', dataIndex: 'ipxoStatus', key: 'ipxo', render: (v: string) => <Tag color="red">{v}</Tag> },
                    { title: '月费', dataIndex: 'monthlyPrice', key: 'price', align: 'right' as const, render: (v: number) => `$${Number(v).toFixed(2)}` },
                  ]}
                />
              </>
            )}

            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message="同步说明"
              description="新增的 IP 段将标记为 IPXO API 来源，使用地区、项目组等信息需同步后在 IP 管理中手动补充。同步操作不可撤销，建议确认后再执行。"
            />
          </div>
        ) : null}
      </Modal>

      {/* 已租用IP同步预览弹窗 */}
      <Modal
        title="同步到 IP 管理 — 预览"
        open={leasedSyncVisible}
        onCancel={() => { setLeasedSyncVisible(false); setLeasedSyncPreview(null); }}
        width={700}
        footer={[
          <Button key="cancel" onClick={() => { setLeasedSyncVisible(false); setLeasedSyncPreview(null); }}>取消</Button>,
          <Button
            key="exec"
            type="primary"
            loading={leasedSyncExecuting}
            disabled={!leasedSyncPreview || (leasedSyncPreview.toAdd === 0 && leasedSyncPreview.toCancel === 0)}
            onClick={handleLeasedSyncExecute}
          >
            确认执行
          </Button>,
        ]}
      >
        {leasedSyncLoading ? (
          <div style={{ textAlign: 'center', padding: 32 }}><Spin tip="正在计算差异..." /></div>
        ) : leasedSyncPreview ? (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={6}><Card size="small"><Statistic title="IPXO缓存总数" value={leasedSyncPreview.cacheTotal} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="本地总数" value={leasedSyncPreview.localTotal} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="待新增" value={leasedSyncPreview.toAdd} valueStyle={{ color: '#52c41a' }} /></Card></Col>
              <Col span={6}><Card size="small"><Statistic title="待取消" value={leasedSyncPreview.toCancel} valueStyle={{ color: '#fa8c16' }} /></Card></Col>
            </Row>

            {leasedSyncPreview.toAdd === 0 && leasedSyncPreview.toCancel === 0 && (
              <Alert type="success" showIcon message="数据已是最新，无需同步" />
            )}

            {leasedSyncPreview.toAddItems?.length > 0 && (
              <>
                <Divider orientation="left" plain><span style={{ color: '#52c41a' }}>待新增 {leasedSyncPreview.toAdd} 条</span></Divider>
                <Table
                  size="small"
                  dataSource={leasedSyncPreview.toAddItems}
                  rowKey="segment"
                  pagination={{ pageSize: 5, simple: true }}
                  columns={[
                    { title: 'IP 段', dataIndex: 'segment', key: 'seg', render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span> },
                    { title: '月费', dataIndex: 'monthlyPrice', key: 'price', align: 'right' as const, render: (v: number) => `$${Number(v).toFixed(2)}` },
                    { title: '续费日', dataIndex: 'nextDueDate', key: 'due' },
                    { title: 'RIR', dataIndex: 'registry', key: 'rir', render: (v: string) => v ? <Tag>{v.toUpperCase()}</Tag> : '-' },
                  ]}
                />
              </>
            )}

            {leasedSyncPreview.toCancelItems?.length > 0 && (
              <>
                <Divider orientation="left" plain><span style={{ color: '#fa8c16' }}>待取消 {leasedSyncPreview.toCancel} 条（本地有，IPXO缓存已无）</span></Divider>
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 8 }}
                  message="以下 IP 段在本地标记为 IPXO 来源，但 IPXO 缓存中已无 active 记录，将设为「取消续费」，取消日期为续费日前一天"
                />
                <Table
                  size="small"
                  dataSource={leasedSyncPreview.toCancelItems}
                  rowKey="segment"
                  pagination={{ pageSize: 5, simple: true }}
                  columns={[
                    { title: 'IP 段', dataIndex: 'segment', key: 'seg', render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span> },
                    { title: '本地状态', dataIndex: 'oldRenewalStatus', key: 'status', render: (v: string) => <Tag>{v}</Tag> },
                    { title: '续费日', dataIndex: 'renewalDate', key: 'renewal' },
                    { title: '取消日（执行后）', dataIndex: 'cancellationDate', key: 'cancel', render: (v: string) => v ? <Tag color="orange">{v}</Tag> : '-' },
                  ]}
                />
              </>
            )}
          </>
        ) : null}
      </Modal>
    </div>
  );
};

export default IPXOBilling;
