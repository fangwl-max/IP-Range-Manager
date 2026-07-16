import React, { useState, useEffect } from 'react';
import {
  Card,
  Form,
  Input,
  Select,
  Button,
  Space,
  Typography,
  Table,
  message,
  Collapse,
  Alert,
  Tag,
  Modal,
  DatePicker,
  InputNumber,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  CopyOutlined,
  SyncOutlined,
  MinusOutlined,
} from '@ant-design/icons';
import { ipSegmentStorage, supplierStorage, usageAreaStorage, projectGroupStorage, asnStorage, asnGroupStorage } from '../utils/storage';
import { normalizeAsnDigitsOnly } from '../utils/asn-normalize';
import { IPSegment } from '../types';
import dayjs from 'dayjs';
import GatewayPingDetection from './GatewayPingDetection';
import CheburcheckRussiaPanel from './CheburcheckRussiaPanel';
import BgpUpstreamReceptionPanel from './BgpUpstreamReceptionPanel';
import BgpHeDetectionPanel from './BgpHeDetectionPanel';

const { TextArea } = Input;
const { Text, Title } = Typography;
const { Panel } = Collapse;

interface IRRServer {
  [key: string]: string;
}

interface IRRScope {
  [key: string]: string;
}

interface VerifyAllResult {
  asn: string;
  prefixes: string[];
  server: string;
  overall_ok: boolean;
  multi_irr: boolean;
  full_matrix: boolean;
  db_names: string[];
  db_scopes: IRRScope;
  all_rpki_ok: boolean;
  as_check: {
    ok: boolean;
    has_aset: boolean;
    raw: string | Record<string, string>;
    error?: string | null;
    found_in?: string | null;
    matrix?: Record<string, string>;
  };
  prefix_checks: Array<{
    prefix: string;
    has_route: boolean;
    origin_match: boolean;
    ok: boolean;
    found_in?: string | null;
    matrix?: Record<string, string>;
    rpki?: {
      ok: boolean;
      status: string;
      prefix: string;
      asn: string;
    };
    raw?: string;
    route_objects?: Array<{ route: string; origin: string | null }>;
  }>;
}

/** 从 IPv4 字符串提取 AB 段，如 192.168.1.0/24 -> 192.168 */
function extractAbSegment(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{1,3})\.(\d{1,3})\./);
  if (!match) return null;
  const a = parseInt(match[1], 10);
  const b = parseInt(match[2], 10);
  if (a > 255 || b > 255) return null;
  return `${a}.${b}`;
}

/** 计算 IP 段到期时间：已取消用取消逻辑，否则用续费日 */
function getSegmentExpiry(segment: IPSegment): dayjs.Dayjs | null {
  if (segment.renewalStatus === 'cancelled' && segment.cancellationDate && segment.purchaseDate) {
    const cancellationDate = dayjs(segment.cancellationDate);
    const purchaseDate = dayjs(segment.purchaseDate);
    if (!cancellationDate.isValid() || !purchaseDate.isValid()) return null;
    if (segment.renewalDate) {
      const renewalDate = dayjs(segment.renewalDate);
      if (renewalDate.isValid()) {
        if (renewalDate.isAfter(cancellationDate)) return renewalDate;
        if (renewalDate.isBefore(cancellationDate) || renewalDate.isSame(cancellationDate, 'day')) {
          return renewalDate.add(1, 'month');
        }
      }
    }
    return cancellationDate.date(purchaseDate.date());
  }
  if (segment.renewalDate && dayjs(segment.renewalDate).isValid()) {
    return dayjs(segment.renewalDate);
  }
  return null;
}

function formatAsnFromOrigin(o: unknown): string | null {
  const n = normalizeAsnDigitsOnly(o);
  return n || null;
}

interface TurkmenAbCompareResult {
  abSegment: string;
  turkmenBlocked: boolean;
  purchaseDate: string;
  expiryDate: string;
  segments: IPSegment[];
}

const IRRDetection: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('auto');
  const [irrServers, setIrrServers] = useState<IRRServer>({});
  const [irrScopes, setIrrScopes] = useState<IRRScope>({});
  const [loading, setLoading] = useState(false);
  const [autoForm] = Form.useForm();
  const [routingForm] = Form.useForm();
  const [turkmenForm] = Form.useForm();

  const [autoResult, setAutoResult] = useState<VerifyAllResult | null>(null);
  const [routingResults, setRoutingResults] = useState<Array<{ resource: string; data: any; error?: string }>>([]);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [turkmenAbResults, setTurkmenAbResults] = useState<TurkmenAbCompareResult[]>([]);
  const [turkmenExpandedRows, setTurkmenExpandedRows] = useState<Set<string>>(new Set());
  
  // 批量同步相关状态
  const [irrSelectedRowKeys, setIrrSelectedRowKeys] = useState<React.Key[]>([]);
  const [routingSelectedRowKeys, setRoutingSelectedRowKeys] = useState<React.Key[]>([]);
  const [syncModalVisible, setSyncModalVisible] = useState(false);
  const [syncForm] = Form.useForm();
  const [syncSegments, setSyncSegments] = useState<
    Array<{ segment: string; asn: string; additionalAsns: string[]; primaryAsnInBgp?: boolean }>
  >([]);

  useEffect(() => {
    // 加载 IRR 服务器列表
    fetch('/api/irr/servers')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        setIrrServers(data.servers || {});
        setIrrScopes(data.scopes || {});
      })
      .catch(err => {
        console.error('Failed to load IRR servers:', err);
        message.error('加载 IRR 服务器列表失败，请确保开发服务器已启动');
      });
  }, []);

  const cellText = (v: string) => {
    if (v === 'ok') return '✓';
    if (v === 'wrong_origin') return '≠';
    return '—';
  };

  const cellClass = (v: string) => {
    if (v === 'ok') return { color: '#52c41a', fontWeight: 600 };
    if (v === 'wrong_origin') return { color: '#faad14' };
    return { color: '#8c8c8c' };
  };

  const rpkiCellText = (rpki: any) => {
    if (!rpki) return '—';
    const s = rpki.status || '';
    if (s === 'valid') return '✓';
    if (['invalid_asn', 'invalid_length'].includes(s)) return '≠';
    return '—';
  };

  const rpkiCellClass = (rpki: any) => {
    if (!rpki) return { color: '#8c8c8c' };
    const s = rpki.status || '';
    if (s === 'valid') return { color: '#52c41a', fontWeight: 600 };
    if (['invalid_asn', 'invalid_length'].includes(s)) return { color: '#faad14' };
    return { color: '#8c8c8c' };
  };

  const renderAutoReport = (data: VerifyAllResult) => {
    const overallOk = data.overall_ok;
    const fullMatrix = data.full_matrix;
    const dbNames = data.db_names || [];

    // 重新排列数据库顺序：RADB在前，其他按原顺序
    const sortedDbNames = ['radb', ...dbNames.filter(db => db !== 'radb')];

    const matrixColumns = [
      {
        title: '检测项',
        dataIndex: 'item',
        key: 'item',
        width: 200,
        fixed: 'left' as const,
        render: (text: string) => <Text code style={{ fontSize: 13 }}>{text}</Text>,
      },
      // RPKI 列放在第二位
      {
        title: (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 500 }}>RPKI</div>
            <div style={{ fontSize: 10, color: '#8c8c8c', fontWeight: 'normal', marginTop: 2 }}>ROA 验证</div>
          </div>
        ),
        dataIndex: 'rpki',
        key: 'rpki',
        align: 'center' as const,
        width: 100,
        render: (rpki: any) => (
          <Text style={rpkiCellClass(rpki)}>{rpkiCellText(rpki)}</Text>
        ),
      },
      // RADB 列放在第三位
      ...sortedDbNames.map(db => ({
        title: (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 500 }}>{db}</div>
            {data.db_scopes[db] && (
              <div style={{ fontSize: 10, color: '#8c8c8c', fontWeight: 'normal', marginTop: 2 }}>
                {data.db_scopes[db]}
              </div>
            )}
          </div>
        ),
        dataIndex: db,
        key: db,
        align: 'center' as const,
        width: 100,
        render: (val: string) => (
          <Text style={cellClass(val)}>{cellText(val)}</Text>
        ),
      })),
    ];

    const matrixData = [
      {
        key: 'as',
        item: 'AS/AS-set',
        rpki: null,
        ...Object.fromEntries(sortedDbNames.map(db => [db, data.as_check?.matrix?.[db] || 'none'])),
      },
      ...data.prefix_checks.map((p, idx) => ({
        key: `prefix-${idx}`,
        item: p.prefix,
        rpki: p.rpki,
        ...Object.fromEntries(sortedDbNames.map(db => [db, p.matrix?.[db] || 'none'])),
      })),
    ];

    return (
      <div style={{ marginTop: 24 }}>
        {/* 结果卡片 */}
        <Card
          style={{
            borderRadius: 6,
            borderLeft: `4px solid ${overallOk ? '#52c41a' : '#ff4d4f'}`,
            padding: 0,
          }}
          bodyStyle={{ padding: '20px' }}
        >
          {/* 状态标题 */}
          <div style={{ marginBottom: 16 }}>
            <Space>
              {overallOk ? (
                <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />
              ) : (
                <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />
              )}
              <Text strong style={{ fontSize: 16, color: '#000' }}>
                {overallOk ? '全部通过' : '存在问题'}
              </Text>
              <Text style={{ fontSize: 14, color: '#8c8c8c' }}>
                — {data.asn}
                {fullMatrix && ' (全库检测)'}
              </Text>
            </Space>
          </div>

          {/* 图例 */}
          {fullMatrix && (
            <div style={{ marginBottom: 16, fontSize: 13, color: '#595959' }}>
              <Space size="large">
                <span>
                  <Text style={{ color: '#52c41a', fontWeight: 600 }}>✓</Text> 匹配
                </span>
                <span>
                  <Text style={{ color: '#faad14', fontWeight: 600 }}>≠</Text> 有 route 但 origin 不符
                </span>
                <span>
                  <Text style={{ color: '#8c8c8c' }}>—</Text> 未找到
                </span>
              </Space>
            </div>
          )}

          {/* 批量操作按钮 */}
          {irrSelectedRowKeys.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <Button
                type="primary"
                icon={<SyncOutlined />}
                onClick={() => handleBatchSyncIRR(irrSelectedRowKeys, data)}
              >
                批量同步到IP段管理 ({irrSelectedRowKeys.length} 个)
              </Button>
              <Button
                style={{ marginLeft: 8 }}
                onClick={() => setIrrSelectedRowKeys([])}
              >
                取消选择
              </Button>
            </div>
          )}

          {/* 结果表格 */}
          {fullMatrix && (
            <div style={{ marginTop: 16 }}>
              <Table
                columns={matrixColumns}
                dataSource={matrixData}
                pagination={false}
                size="small"
                scroll={{ x: 'max-content' }}
                bordered
                style={{
                  fontSize: 13,
                }}
                rowSelection={{
                  selectedRowKeys: irrSelectedRowKeys,
                  onChange: (selectedKeys) => {
                    setIrrSelectedRowKeys(selectedKeys);
                  },
                  getCheckboxProps: (record: any) => ({
                    disabled: record.key === 'as', // 禁用AS/AS-set行的选择
                  }),
                }}
              />
            </div>
          )}

          {/* 非全库矩阵模式的简单结果展示 */}
          {!fullMatrix && (
            <div style={{ marginTop: 16 }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Space>
                  {data.as_check?.ok ? (
                    <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  ) : (
                    <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                  )}
                  <Text>
                    AS/AS-set: {data.as_check?.ok ? '已配置' : '未找到'}
                    {data.as_check?.found_in && ` (${data.as_check.found_in})`}
                  </Text>
                </Space>
                {data.prefix_checks.map((p, idx) => (
                  <Space key={idx}>
                    {p.ok ? (
                      <CheckCircleOutlined style={{ color: '#52c41a' }} />
                    ) : p.has_route ? (
                      <ExclamationCircleOutlined style={{ color: '#faad14' }} />
                    ) : (
                      <MinusOutlined style={{ color: '#8c8c8c' }} />
                    )}
                    <Text>
                      {p.prefix}: IRR {p.ok ? `✓ ${p.found_in || ''}` : p.has_route ? '≠' : '—'} | RPKI{' '}
                      {p.rpki?.ok ? '✓' : p.rpki?.status ? `≠ ${p.rpki.status}` : '—'}
                    </Text>
                  </Space>
                ))}
              </Space>
            </div>
          )}

          {/* 原始响应 */}
          <Collapse style={{ marginTop: 16 }}>
            <Panel header="查看原始 IRR 响应" key="raw">
              <Collapse>
                <Panel header="AS 查询" key="as-raw">
                  <pre style={{
                    background: '#f5f5f5',
                    padding: 12,
                    borderRadius: 4,
                    overflow: 'auto',
                    maxHeight: 400,
                    fontSize: 12,
                    fontFamily: 'monospace',
                  }}>
                    {typeof data.as_check?.raw === 'object' && data.as_check.raw
                      ? Object.entries(data.as_check.raw)
                          .map(([k, v]) => `[${k}]\n${v}`)
                          .join('\n---\n')
                      : data.as_check?.raw || data.as_check?.error || '无'}
                  </pre>
                </Panel>
                {data.prefix_checks.map((p, idx) => (
                  <Panel header={p.prefix} key={`prefix-${idx}`}>
                    <pre style={{
                      background: '#f5f5f5',
                      padding: 12,
                      borderRadius: 4,
                      overflow: 'auto',
                      maxHeight: 400,
                      fontSize: 12,
                      fontFamily: 'monospace',
                    }}>
                      {typeof p.raw === 'string' ? p.raw : p.raw ? JSON.stringify(p.raw, null, 2) : '无'}
                    </pre>
                  </Panel>
                ))}
              </Collapse>
            </Panel>
          </Collapse>
        </Card>
      </div>
    );
  };

  const handleAutoSubmit = async (values: any) => {
    setLoading(true);
    setAutoResult(null);
    try {
      const prefixes = values.prefixes
        .split(/[\n\s,]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);

      // 如果选择"全库检测"，则设置full_matrix为true
      const isFullDetection = values.server === 'full';
      const server = isFullDetection ? 'radb' : (values.server || 'radb');

      const response = await fetch('/api/irr/verify/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asn: normalizeAsnDigitsOnly(values.asn),
          prefixes,
          server: server,
          multi_irr: false,
          full_matrix: isFullDetection,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || response.statusText);
      }

      const data = await response.json();
      setAutoResult(data);
    } catch (err: any) {
      message.error(`错误: ${err.message || '检测失败'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleRoutingSubmit = async (values: any) => {
    setLoading(true);
    setRoutingResults([]);
    setRoutingSelectedRowKeys([]);
    try {
      const resourcesInput = (values.resources || '').trim();
      if (!resourcesInput) {
        message.error('请输入 IP 前缀或 AS 号');
        setLoading(false);
        return;
      }

      // 解析多个资源（支持换行、空格、逗号分隔）
      const resources = resourcesInput
        .split(/[\n\s,]+/)
        .map((s: string) => s.trim())
        .filter(Boolean);

      // 规范化：无 CIDR 的 IPv4 补全 /32，IPv6 补全 /128
      const normalizeResource = (r: string): string => {
        const t = r.trim();
        if (t.includes('/')) return t;
        if (t.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) return `${t}/32`;
        if (t.includes(':')) return `${t}/128`;
        return t;
      };
      const normalizedResources = resources.map(normalizeResource);

      if (normalizedResources.length === 0) {
        message.error('请输入至少一个 IP 前缀或 AS 号');
        setLoading(false);
        return;
      }

      // 批量检测
      const results = await Promise.all(
        normalizedResources.map(async (resource: string) => {
          try {
            const response = await fetch('/api/routing/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ resource }),
            });

            if (!response.ok) {
              let errorMsg = response.statusText;
              try {
                const err = await response.json();
                errorMsg = err.error || errorMsg;
              } catch (e) {
                // 忽略JSON解析错误
              }
              return { resource, error: errorMsg, data: null };
            }

            let data;
            try {
              data = await response.json();
            } catch (e) {
              return { resource, error: '响应解析失败', data: null };
            }

            return { resource, data, error: null };
          } catch (err: any) {
            console.error(`检测资源 ${resource} 失败:`, err);
            return { resource, error: err.message || '检测失败', data: null };
          }
        })
      );

      setRoutingResults(results);
    } catch (err: any) {
      console.error('路由检测提交失败:', err);
      message.error(`错误: ${err.message || '检测失败'}`);
      setRoutingResults([]);
    } finally {
      setLoading(false);
    }
  };

  const renderRoutingResults = (results: Array<{ resource: string; data: any; error?: string }>) => {
    if (!results || !Array.isArray(results) || results.length === 0) {
      return null;
    }

    try {
      // 计算成功和生效ASN的数量
      const successCount = results.filter(r => !r.error && r.data && r.data.status === 'ok').length;
      const activeAsnCount = results.reduce((sum, r) => {
        if (r.error || !r.data || r.data.status !== 'ok') return sum;
        const apiData = r.data.data || {};
        const routes = Array.isArray(apiData.routes) ? apiData.routes : [];
        return sum + routes.filter((route: any) => route.in_bgp === true || route.in_bgp === 'True').length;
      }, 0);
      // 计算有生效ASN的资源数量
      const resourcesWithActiveAsn = results.filter(r => {
        if (r.error || !r.data || r.data.status !== 'ok') return false;
        const apiData = r.data.data || {};
        const routes = Array.isArray(apiData.routes) ? apiData.routes : [];
        return routes.some((route: any) => route.in_bgp === true || route.in_bgp === 'True');
      }).length;
      const overallOk = resourcesWithActiveAsn === results.length && successCount === results.length;

      // 准备表格数据 - 使用 Prefix Routing Consistency 数据格式
      const tableData = results.map((result, idx) => {
        try {
          const { resource, data, error } = result;
          
          // 处理错误情况
          if (error || !data || data.status !== 'ok') {
            return {
              key: idx,
              resource: resource || `资源${idx + 1}`,
              status: 'error',
              routes: [],
              activeAsns: [],
              inactiveAsns: [],
              displayedAsns: [],
              hiddenAsns: [],
              error: error || (data && data.message) || '检测失败',
            };
          }

          const apiData = data.data || {};
          // Prefix Routing Consistency API 返回的数据格式
          const allRoutes = Array.isArray(apiData.routes) ? apiData.routes : [];
          
          // 1. 优先匹配与查询的IP段完全一致的路由
          const normalizedResource = (resource || '').trim().toLowerCase();
          let routes = allRoutes.filter((route: any) => {
            const routePrefix = (route.prefix || '').trim().toLowerCase();
            return routePrefix === normalizedResource;
          });
          
          // 2. 若无完全匹配，使用最具体的前缀（最长掩码）对应的路由
          if (routes.length === 0 && allRoutes.length > 0) {
            const sortedBySpecificity = [...allRoutes].sort((a: any, b: any) => {
              const lenA = parseInt(String((a.prefix || '').split('/')[1] || '0'), 10);
              const lenB = parseInt(String((b.prefix || '').split('/')[1] || '0'), 10);
              return lenB - lenA;
            });
            routes = [sortedBySpecificity[0]];
          }
          
          if (routes.length === 0) {
            return {
              key: idx,
              resource: resource || `资源${idx + 1}`,
              status: 'error',
              routes: [],
              activeAsns: [],
              inactiveAsns: [],
              displayedAsns: [],
              hiddenAsns: [],
              error: '未找到匹配的路由信息',
            };
          }

          // 处理所有路由，提取ASN信息（origin 转为 AS 格式展示）
          const allAsns = routes.map((route: any) => {
            const o = route.origin;
            const originStr = o != null && o !== '' ? (typeof o === 'number' ? `AS${o}` : (String(o).toUpperCase().startsWith('AS') ? String(o) : `AS${o}`)) : '-';
            return {
            origin: originStr,
            asnName: route.asn_name && route.asn_name !== '-' ? route.asn_name : '-',
            inBgp: route.in_bgp === true || route.in_bgp === 'True',
            inWhois: route.in_whois === true || route.in_whois === 'True',
            prefix: route.prefix || resource || '-',
            irrSources: Array.isArray(route.irr_sources) 
              ? route.irr_sources.join(', ') 
              : (route.irr_sources || '-'),
            // RPKI和VRP信息（从API返回的数据中提取，如果存在）
            rpkiValid: route.rpki_valid !== undefined ? route.rpki_valid : null,
            vrpMatches: route.vrp_matches !== undefined ? route.vrp_matches : null,
          };
          });

          // 分离生效的ASN（in_bgp为true）和其他ASN
          const activeAsns = allAsns.filter((asn: any) => asn.inBgp);
          const inactiveAsns = allAsns.filter((asn: any) => !asn.inBgp);

          // 如果没有生效的ASN，显示最近使用过的ASN（in_whois为true的）
          let displayedAsns: any[] = [];
          let hiddenAsns: any[] = [];
          
          if (activeAsns.length > 0) {
            // 有生效的ASN，显示生效的
            displayedAsns = activeAsns;
            hiddenAsns = inactiveAsns;
          } else if (allAsns.length === 1) {
            // 只有一个ASN，直接显示
            displayedAsns = allAsns;
            hiddenAsns = [];
          } else {
            // 没有生效的ASN，显示最近使用过的（in_whois为true的）
            const recentAsns = inactiveAsns.filter((asn: any) => asn.inWhois);
            const otherAsns = inactiveAsns.filter((asn: any) => !asn.inWhois);
            displayedAsns = recentAsns.length > 0 ? recentAsns : inactiveAsns.slice(0, 1); // 如果没有in_whois的，至少显示一个
            hiddenAsns = recentAsns.length > 0 ? otherAsns : inactiveAsns.slice(1);
          }

          // 状态：基于是否有生效的ASN来判断
          const hasActiveAsn = activeAsns.length > 0;
          // 如果所有ASN都生效，则为ok；如果有部分生效，则为warning；如果没有生效，则为error
          const allActive = allAsns.length > 0 && allAsns.every((asn: any) => asn.inBgp);

          return {
            key: idx,
            resource: resource || `资源${idx + 1}`,
            status: allActive ? 'ok' : hasActiveAsn ? 'warning' : 'error',
            routes: allAsns,
            activeAsns,
            inactiveAsns,
            displayedAsns, // 要显示的ASN
            hiddenAsns, // 隐藏的ASN
            error: null,
          };
        } catch (e) {
          // 单个结果处理失败时的降级处理
          return {
            key: idx,
            resource: result.resource || `资源${idx + 1}`,
            status: 'error',
            routes: [],
            activeAsns: [],
            inactiveAsns: [],
            displayedAsns: [],
            hiddenAsns: [],
            error: '数据处理失败',
          };
        }
      });

    const columns = [
      {
        title: 'IP 前缀',
        dataIndex: 'resource',
        key: 'resource',
        width: 200,
        fixed: 'left' as const,
        render: (text: string) => (
          <Space>
            <Text code style={{ fontSize: 15, cursor: 'pointer' }} onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                message.success(`已复制: ${text}`);
              } catch (err) {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                  document.execCommand('copy');
                  message.success(`已复制: ${text}`);
                } catch (e) {
                  message.error('复制失败，请手动复制');
                }
                document.body.removeChild(textArea);
              }
            }}>
              {text}
            </Text>
            <CopyOutlined style={{ fontSize: 12, color: '#8c8c8c', cursor: 'pointer' }} onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                message.success(`已复制: ${text}`);
              } catch (err) {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                document.body.appendChild(textArea);
                textArea.select();
                try {
                  document.execCommand('copy');
                  message.success(`已复制: ${text}`);
                } catch (e) {
                  message.error('复制失败，请手动复制');
                }
                document.body.removeChild(textArea);
              }
            }} />
          </Space>
        ),
      },
      {
        title: 'ASN 号',
        key: 'asns',
        width: 350,
        render: (_: any, record: any) => {
          if (record.error || !record.routes || record.routes.length === 0) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const { displayedAsns = [], hiddenAsns = [], activeAsns = [] } = record;
          const isExpanded = expandedRows.has(record.key);
          const hasHidden = hiddenAsns && hiddenAsns.length > 0;
          const isSingleAsn = (record.routes || []).length === 1;

          return (
            <div>
              {/* 显示的ASN */}
              {displayedAsns && displayedAsns.length > 0 && (
                <div style={{ marginBottom: hasHidden && !isSingleAsn ? 4 : 0 }}>
                  <Space wrap>
                    {displayedAsns.map((asn: any, asnIdx: number) => {
                      const isActive = asn.inBgp;
                      return (
                        <div key={`displayed-${asnIdx}`} style={{ marginBottom: isExpanded ? 8 : 0 }}>
                          <Tag
                            color={isActive ? 'green' : 'default'}
                            style={{ 
                              fontSize: 12,
                              ...(isActive ? {} : {
                                backgroundColor: '#f5f5f5',
                                color: '#8c8c8c',
                                borderColor: '#d9d9d9',
                              })
                            }}
                          >
                            {asn.origin}
                          </Tag>
                          {isExpanded && (
                            <div style={{ marginTop: 4, fontSize: 11, color: '#666', lineHeight: '1.5' }}>
                              <div>BGP: <Tag color={asn.inBgp ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.inBgp ? '是' : '否'}</Tag></div>
                              <div>IRR: <Tag color={asn.inWhois ? 'blue' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.inWhois ? '是' : '否'}</Tag></div>
                              {asn.rpkiValid !== null && (
                                <div>RPKI: <Tag color={asn.rpkiValid ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.rpkiValid ? '有效' : '无效'}</Tag></div>
                              )}
                              {asn.vrpMatches !== null && (
                                <div>VRP: <Tag color={asn.vrpMatches ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.vrpMatches ? '匹配' : '不匹配'}</Tag></div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {hasHidden && !isExpanded && !isSingleAsn && (
                      <Button
                        type="link"
                        size="small"
                        onClick={() => {
                          const newExpanded = new Set(expandedRows);
                          newExpanded.add(record.key);
                          setExpandedRows(newExpanded);
                        }}
                        style={{ padding: 0, height: 'auto', fontSize: 11 }}
                      >
                        展开 ({hiddenAsns.length} 个其他ASN)
                      </Button>
                    )}
                  </Space>
                </div>
              )}

              {/* 隐藏的ASN - 点击展开后显示 */}
              {hasHidden && isExpanded && (
                <div>
                  {hiddenAsns.map((asn: any, asnIdx: number) => (
                    <div key={`hidden-${asnIdx}`} style={{ marginBottom: 8 }}>
                      <Tag
                        color="default"
                        style={{ 
                          fontSize: 12,
                          backgroundColor: '#f5f5f5',
                          color: '#8c8c8c',
                          borderColor: '#d9d9d9',
                        }}
                      >
                        {asn.origin}
                      </Tag>
                      <div style={{ marginTop: 4, fontSize: 11, color: '#666', lineHeight: '1.5' }}>
                        <div>BGP: <Tag color={asn.inBgp ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.inBgp ? '是' : '否'}</Tag></div>
                        <div>IRR: <Tag color={asn.inWhois ? 'blue' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.inWhois ? '是' : '否'}</Tag></div>
                        {asn.rpkiValid !== null && (
                          <div>RPKI: <Tag color={asn.rpkiValid ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.rpkiValid ? '有效' : '无效'}</Tag></div>
                        )}
                        {asn.vrpMatches !== null && (
                          <div>VRP: <Tag color={asn.vrpMatches ? 'green' : 'default'} style={{ fontSize: 10, margin: 0 }}>{asn.vrpMatches ? '匹配' : '不匹配'}</Tag></div>
                        )}
                      </div>
                    </div>
                  ))}
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      const newExpanded = new Set(expandedRows);
                      newExpanded.delete(record.key);
                      setExpandedRows(newExpanded);
                    }}
                    style={{ padding: 0, height: 'auto', fontSize: 11, marginTop: 4 }}
                  >
                    收起
                  </Button>
                </div>
              )}

            </div>
          );
        },
      },
      {
        title: 'BGP',
        key: 'bgp',
        width: 100,
        align: 'center' as const,
        render: (_: any, record: any) => {
          if (record.error || !record.routes || record.routes.length === 0) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const totalRoutes = record.routes.length;
          const bgpCount = record.routes.filter((r: any) => r.inBgp).length;
          const bgpStatus = bgpCount > 0;

          return (
            <Tag color={bgpStatus ? 'green' : 'default'} style={{ fontSize: 12 }}>
              {bgpStatus ? '是' : '否'}
            </Tag>
          );
        },
      },
      {
        title: 'IRR',
        key: 'irr',
        width: 100,
        align: 'center' as const,
        render: (_: any, record: any) => {
          if (record.error || !record.routes || record.routes.length === 0) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const totalRoutes = record.routes.length;
          const whoisCount = record.routes.filter((r: any) => r.inWhois).length;
          const irrStatus = whoisCount > 0;

          return (
            <Tag color={irrStatus ? 'blue' : 'default'} style={{ fontSize: 12 }}>
              {irrStatus ? '是' : '否'}
            </Tag>
          );
        },
      },
      {
        title: 'RPKI',
        key: 'rpki',
        width: 100,
        align: 'center' as const,
        render: (_: any, record: any) => {
          if (record.error || !record.routes || record.routes.length === 0) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const hasRpkiInfo = record.routes.some((r: any) => r.rpkiValid !== null);
          if (!hasRpkiInfo) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const rpkiValidCount = record.routes.filter((r: any) => r.rpkiValid === true).length;
          const rpkiStatus = rpkiValidCount > 0;

          return (
            <Tag color={rpkiStatus ? 'green' : 'default'} style={{ fontSize: 12 }}>
              {rpkiStatus ? '有效' : '无效'}
            </Tag>
          );
        },
      },
      {
        title: 'VRP',
        key: 'vrp',
        width: 100,
        align: 'center' as const,
        render: (_: any, record: any) => {
          if (record.error || !record.routes || record.routes.length === 0) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const hasVrpInfo = record.routes.some((r: any) => r.vrpMatches !== null);
          if (!hasVrpInfo) {
            return <Text style={{ fontSize: 12, color: '#8c8c8c' }}>-</Text>;
          }

          const vrpMatchCount = record.routes.filter((r: any) => r.vrpMatches === true).length;
          const vrpStatus = vrpMatchCount > 0;

          return (
            <Tag color={vrpStatus ? 'green' : 'default'} style={{ fontSize: 12 }}>
              {vrpStatus ? '匹配' : '不匹配'}
            </Tag>
          );
        },
      },
      {
        title: '操作',
        key: 'action',
        width: 120,
        fixed: 'right' as const,
        render: (_: any, record: any) => {
          if (!record || !record.resource) return '-';
          return (
            <a
              href={`https://stat.ripe.net/resource/${encodeURIComponent(record.resource)}#tab=routing`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12 }}
            >
              查看详情
            </a>
          );
        },
      },
    ];

      return (
        <div style={{ marginTop: 24 }}>
          <Card
            style={{
              borderRadius: 6,
              borderLeft: `4px solid ${
                overallOk ? '#52c41a' : resourcesWithActiveAsn > 0 ? '#faad14' : '#ff4d4f'
              }`,
              padding: 0,
            }}
            bodyStyle={{ padding: '20px' }}
          >
            {/* 状态标题 */}
            <div style={{ marginBottom: 16 }}>
              <Space>
                {overallOk ? (
                  <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} />
                ) : resourcesWithActiveAsn > 0 ? (
                  <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 20 }} />
                ) : (
                  <CloseCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />
                )}
              <Text strong style={{ fontSize: 16, color: '#000' }}>
                {overallOk ? '全部有生效ASN' : resourcesWithActiveAsn > 0 ? '部分有生效ASN' : '无生效ASN'}
              </Text>
                <Text style={{ fontSize: 14, color: '#8c8c8c' }}>
                  — 共检测 {results.length} 个资源，生效ASN {activeAsnCount} 个
                </Text>
              </Space>
            </div>

            {routingSelectedRowKeys.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <Button
                  type="primary"
                  icon={<SyncOutlined />}
                  onClick={() => handleBatchSyncRouting(routingSelectedRowKeys, tableData)}
                >
                  同步选中到 IP 段管理 ({routingSelectedRowKeys.length})
                </Button>
                <Button style={{ marginLeft: 8 }} onClick={() => setRoutingSelectedRowKeys([])}>
                  取消选择
                </Button>
              </div>
            )}

            {/* 结果表格 */}
            <Table
              rowSelection={{
                selectedRowKeys: routingSelectedRowKeys,
                onChange: setRoutingSelectedRowKeys,
                getCheckboxProps: (record: any) => ({
                  disabled: !!(record.error || !record.routes?.length),
                }),
              }}
              columns={columns}
              dataSource={tableData}
              pagination={false}
              size="small"
              scroll={{ x: 'max-content' }}
              bordered
              style={{
                fontSize: 13,
              }}
            />
          </Card>
        </div>
      );
    } catch (error: any) {
      console.error('渲染路由检测结果失败:', error);
      return (
        <Card style={{ marginTop: 16, borderRadius: 6 }}>
          <Alert
            message="渲染错误"
            description={error?.message || String(error) || '无法显示检测结果'}
            type="error"
            showIcon
          />
        </Card>
      );
    }
  };

  // 批量同步路由检测结果：主 ASN 优先 BGP 已宣告的，其余写入 additionalAsns
  const handleBatchSyncRouting = (selectedKeys: React.Key[], tableData: any[]) => {
    const segmentsToSync: Array<{
      segment: string;
      asn: string;
      additionalAsns: string[];
      primaryAsnInBgp: boolean;
    }> = [];

    selectedKeys.forEach((key) => {
      const record = tableData.find((r) => r.key === key);
      if (record && !record.error && Array.isArray(record.routes) && record.routes.length > 0) {
        const pairs = (record.routes as any[])
          .map((r) => ({
            asn: formatAsnFromOrigin(r.origin),
            inBgp: r.inBgp === true || r.inBgp === 'True',
          }))
          .filter((p): p is { asn: string; inBgp: boolean } => !!p.asn);
        if (pairs.length === 0) return;
        const uniqueOrdered: string[] = [];
        const seen = new Set<string>();
        for (const p of pairs) {
          if (!seen.has(p.asn)) {
            seen.add(p.asn);
            uniqueOrdered.push(p.asn);
          }
        }
        const hasAnyInBgp = pairs.some((p) => p.inBgp);
        const primary = pairs.find((p) => p.inBgp)?.asn || uniqueOrdered[0];
        const additionalAsns = uniqueOrdered.filter((a) => a !== primary);
        segmentsToSync.push({
          segment: record.resource,
          asn: primary,
          additionalAsns,
          primaryAsnInBgp: hasAnyInBgp,
        });
      }
    });

    if (segmentsToSync.length === 0) {
      message.warning('没有可同步的 IP 段（请勾选有 ASN 信息的行）');
      return;
    }

    setSyncSegments(segmentsToSync);
    setSyncModalVisible(true);
  };

  // 批量同步IRR检测结果到IP段管理
  const handleBatchSyncIRR = (selectedKeys: React.Key[], data: VerifyAllResult) => {
    const segmentsToSync: Array<{ segment: string; asn: string; additionalAsns: string[] }> = [];

    selectedKeys.forEach(key => {
      if (typeof key === 'string' && key.startsWith('prefix-')) {
        const idx = parseInt(key.replace('prefix-', ''));
        const prefixCheck = data.prefix_checks[idx];
        if (prefixCheck && prefixCheck.ok) {
          segmentsToSync.push({
            segment: prefixCheck.prefix,
            asn: normalizeAsnDigitsOnly(data.asn),
            additionalAsns: [],
          });
        }
      }
    });

    if (segmentsToSync.length === 0) {
      message.warning('没有可同步的IP段');
      return;
    }

    setSyncSegments(segmentsToSync);
    setSyncModalVisible(true);
  };

  // 土库曼 AB 段对比提交
  const handleTurkmenSubmit = (values: { prefixes?: string }) => {
    const raw = (values.prefixes || '').trim();
    if (!raw) {
      message.error('请输入至少一个 IP 段');
      return;
    }
    const inputs = raw.split(/[\n\s,]+/).map(s => s.trim()).filter(Boolean);
    const inputAbSet = new Set<string>();
    for (const s of inputs) {
      const ab = extractAbSegment(s);
      if (ab) inputAbSet.add(ab);
    }
    if (inputAbSet.size === 0) {
      message.error('未能从输入中解析出有效 IPv4 AB 段（如 192.168.1.0/24）');
      return;
    }
    const allSegments = ipSegmentStorage.getAll();
    const abMap = new Map<string, IPSegment[]>();
    for (const seg of allSegments) {
      const ab = extractAbSegment(seg.segment);
      if (!ab) continue;
      if (!abMap.has(ab)) abMap.set(ab, []);
      abMap.get(ab)!.push(seg);
    }
    const results: TurkmenAbCompareResult[] = [];
    for (const ab of Array.from(inputAbSet).sort()) {
      const segments = abMap.get(ab) || [];
      const turkmenBlocked = segments.some(s =>
        Array.isArray(s.blockedCountries) && s.blockedCountries.includes('turkmenistan')
      );
      let purchaseDate = '';
      let expiryDate = '';
      if (segments.length > 0) {
        const dates = segments.filter(s => s.purchaseDate).map(s => s.purchaseDate);
        purchaseDate = dates.length ? dates.sort()[0] : '';
        const expiries = segments
          .map(s => getSegmentExpiry(s))
          .filter((e): e is dayjs.Dayjs => e != null);
        expiryDate = expiries.length
          ? expiries.reduce((a, b) => (a.isAfter(b) ? a : b)).format('YYYY-MM-DD')
          : '';
      }
      results.push({ abSegment: ab, turkmenBlocked, purchaseDate, expiryDate, segments });
    }
    setTurkmenAbResults(results);
  };

  // 处理同步提交
  const handleSyncSubmit = async () => {
    try {
      const values = await syncForm.validateFields();
      const segments = ipSegmentStorage.getAll();
      const suppliers = supplierStorage.getAll();
      const usageAreas = usageAreaStorage.getAll();
      const projectGroups = projectGroupStorage.getAll();

      let updatedCount = 0;
      let createdCount = 0;

      syncSegments.forEach((item) => {
        const { segment, asn, additionalAsns, primaryAsnInBgp } = item;
        const asnStored = normalizeAsnDigitsOnly(asn);
        const additionalStored = Array.from(
          new Set((additionalAsns || []).map((a) => normalizeAsnDigitsOnly(a)).filter(Boolean)),
        ).filter((a) => a !== asnStored);
        const existingSegment = segments.find(s => s.segment.toLowerCase().trim() === segment.toLowerCase().trim());
        
        if (existingSegment) {
          const patch: Partial<IPSegment> = {
            asn: asnStored,
            additionalAsns: additionalStored,
          };
          if (primaryAsnInBgp !== undefined) {
            patch.primaryAsnInBgp = primaryAsnInBgp;
          }
          ipSegmentStorage.update(existingSegment.id, patch);
          updatedCount++;
        } else {
          // 创建新的IP段
          const now = new Date().toISOString();
          const purchaseDate = values.purchaseDate ? values.purchaseDate.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
          const renewalDate = values.renewalDate ? values.renewalDate.format('YYYY-MM-DD') : dayjs().add(1, 'year').format('YYYY-MM-DD');
          
          const newSegment: IPSegment = {
            id: `ip-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            segment,
            asn: asnStored,
            additionalAsns: additionalStored.length > 0 ? additionalStored : undefined,
            supplier: values.supplier || '',
            usageArea: values.usageArea || '',
            purchaseDate,
            renewalDate,
            cancellationDate: values.cancellationDate ? values.cancellationDate.format('YYYY-MM-DD') : '',
            monthlyPrice: values.monthlyPrice || 0,
            renewalStatus: 'not_renewed',
            projectGroups: values.projectGroups || [],
            serverLocations: [],
            blockedCountries: [],
            createdAt: now,
            updatedAt: now,
            ...(primaryAsnInBgp !== undefined ? { primaryAsnInBgp } : {}),
          };

          // 如果有项目组和购买日期，创建初始历程记录
          if (values.projectGroups && values.projectGroups.length > 0 && values.purchaseDate) {
            newSegment.history = [{
              id: `history-${newSegment.id}-initial`,
              projectGroup: Array.isArray(values.projectGroups) ? values.projectGroups[0] : values.projectGroups,
              startDate: purchaseDate,
              endDate: undefined,
              createdAt: now,
              updatedAt: now,
            }];
          }

          ipSegmentStorage.add(newSegment);
          createdCount++;
        }
      });

      // 保存到文件
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
        await fetch('/api/save-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(allData, null, 2),
        });
      } catch (e) {
        console.error('保存到文件失败:', e);
      }

      message.success(`同步完成：更新 ${updatedCount} 个，新增 ${createdCount} 个`);
      setSyncModalVisible(false);
      setSyncSegments([]);
      syncForm.resetFields();
      setRoutingSelectedRowKeys([]);
      setIrrSelectedRowKeys([]);
    } catch (error: any) {
      if (error.errorFields) {
        // 表单验证错误
        return;
      }
      message.error(`同步失败: ${error.message || '未知错误'}`);
    }
  };

  const tabButtons = [
    { key: 'auto', label: 'IRR检测' },
    { key: 'routing', label: '路由检测' },
    { key: 'gateway-ping', label: '网关Ping检测' },
    { key: 'russia-chebur', label: '俄罗斯检测' },
    { key: 'upstream-tier1', label: '上游接收(Tier1)' },
    { key: 'bgp-he', label: 'BGP.HE检测' },
    { key: 'turkmen', label: '土库曼AB段对比' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        {/* 页面标题 */}
        <div style={{ marginBottom: 24 }}>
          <Title level={2} style={{ marginBottom: 8, fontSize: 24 }}>
            IP段检测
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            验证 AS、AS-set 和路由对象在 Internet Routing Registry 中的注册情况 · IRR ≠ RPKI · 含网关 Ping（ping.pe）、上游 Tier1
            接收启发式（RIPE LG）、俄罗斯 Cheburcheck 与 BGP 宣告查询（BGP.HE 见侧栏「IP段检测 → BGP.HE」）
          </Text>
        </div>

        {/* 标签页按钮 */}
        <div style={{ marginBottom: 24, display: 'flex', gap: 8 }}>
          {tabButtons.map(tab => (
            <Button
              key={tab.key}
              type={activeTab === tab.key ? 'primary' : 'default'}
              onClick={() => setActiveTab(tab.key)}
              style={{
                borderRadius: 6,
                height: 36,
                padding: '0 16px',
                fontSize: 14,
              }}
            >
              {tab.label}
            </Button>
          ))}
        </div>

        {/* IRR检测 */}
        {activeTab === 'auto' ? (
        <Card style={{ borderRadius: 6 }}>
          <Form form={autoForm} layout="vertical" onFinish={handleAutoSubmit}>
            <Form.Item
              name="asn"
              label={<Text strong style={{ fontSize: 13 }}>AS 号</Text>}
              rules={[{ required: true, message: '请输入 AS 号' }]}
            >
              <Input
                placeholder="例如: 402044"
                style={{ borderRadius: 6, height: 36 }}
              />
            </Form.Item>
            <Form.Item
              name="prefixes"
              label={<Text strong style={{ fontSize: 13 }}>IP 段（每行一个，或用空格/逗号分隔）</Text>}
              rules={[{ required: true, message: '请输入 IP 段' }]}
            >
              <TextArea
                rows={6}
                placeholder="107.158.108.0/24&#10;93.95.113.0/24&#10;173.232.182.0/24"
                style={{ borderRadius: 6 }}
              />
            </Form.Item>
            <Form.Item name="server" label={<Text strong style={{ fontSize: 13 }}>IRR 数据库</Text>} initialValue="full">
              <Select style={{ borderRadius: 6, height: 36 }}>
                <Select.Option value="full">全库检测</Select.Option>
                {Object.entries(irrServers).map(([key]) => (
                  <Select.Option key={key} value={key}>
                    {key}
                    {irrScopes[key] && ` · ${irrScopes[key]}`}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                style={{ borderRadius: 6, height: 36, padding: '0 24px' }}
              >
                开始检测
              </Button>
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              支持 9 个 IRR 数据库：RIPE、RADB、ARIN、APNIC、LACNIC、AFRINIC、NTTCOM、LEVEL3、ALTDB。
              「全库检测」：一次性查询全部 9 个数据库，展示每个库的详细结果表。
            </Text>
          </Form>
          {autoResult && renderAutoReport(autoResult)}
        </Card>
        ) : null}

        {/* 路由检测 */}
        {activeTab === 'routing' ? (
        <Card style={{ borderRadius: 6 }}>
          <Form form={routingForm} layout="vertical" onFinish={handleRoutingSubmit}>
            <Form.Item
              name="resources"
              label={<Text strong style={{ fontSize: 13 }}>IP 段（每行一个，或用空格/逗号分隔）</Text>}
              rules={[{ required: true, message: '请输入 IP 前缀或 AS 号' }]}
            >
              <TextArea
                rows={6}
                placeholder="185.223.155.0/24&#10;150.241.138.0/24&#10;AS3333"
                style={{ borderRadius: 6 }}
              />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                style={{ borderRadius: 6, height: 36, padding: '0 24px' }}
              >
                开始检测
              </Button>
            </Form.Item>
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
              通过 RIPE Stat Prefix Routing Consistency API 检测 IP 前缀的路由一致性，比较路由注册表（IRR/Whois）和实际 BGP 路由行为的一致性。支持批量检测多个 IP 段。检测结果表格可勾选行，将 ASN 与 BGP
              勾选后可同步到 IP 段管理：主 ASN 优先 BGP 已宣告，其余 ASN 在列表中点击主 ASN 后查看。
            </Text>
          </Form>
          {routingResults && routingResults.length > 0 && (
            <div>
              {(() => {
                try {
                  return renderRoutingResults(routingResults);
                } catch (error: any) {
                  console.error('渲染路由检测结果时出错:', error);
                  return (
                    <Card style={{ marginTop: 16, borderRadius: 6 }}>
                      <Alert
                        message="显示错误"
                        description={error?.message || '无法显示检测结果，请查看控制台获取详细信息'}
                        type="error"
                        showIcon
                      />
                    </Card>
                  );
                }
              })()}
            </div>
          )}
        </Card>
        ) : null}

        {/* 网关 Ping 检测（ping.pe + BGP，内含多卡片） */}
        {activeTab === 'gateway-ping' ? <GatewayPingDetection embedded /> : null}

        {/* 俄罗斯 Cheburcheck（第三方在线：CDN / РКН 等，仅生成 target 链接） */}
        {activeTab === 'russia-chebur' ? <CheburcheckRussiaPanel embedded /> : null}

        {/* 上游 / Tier1 接收（RIPE LG 路径，对照 bgp.tools Connectivity） */}
        {activeTab === 'upstream-tier1' ? <BgpUpstreamReceptionPanel embedded /> : null}

        {/* BGP.HE 检测 */}
        {activeTab === 'bgp-he' ? <BgpHeDetectionPanel embedded /> : null}

        {/* 土库曼AB段对比 */}
        {activeTab === 'turkmen' ? (
        <Card style={{ borderRadius: 6 }}>
          <Alert
            message="土库曼按 AB 段封堵"
            description="土库曼会把 AB 段相同的 IP 段全部墙掉。输入待购买的 IP 段，系统将对比 IP 段管理中同 AB 段的记录，帮助筛选未被墙的 AB 段。"
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Form form={turkmenForm} layout="vertical" onFinish={handleTurkmenSubmit}>
            <Form.Item
              name="prefixes"
              label={<Text strong style={{ fontSize: 13 }}>IP 段（每行一个，或用空格/逗号分隔）</Text>}
              rules={[{ required: true, message: '请输入 IP 段' }]}
            >
              <TextArea
                rows={6}
                placeholder="192.168.1.0/24&#10;10.0.0.0/8&#10;172.16.0.0/16"
                style={{ borderRadius: 6 }}
              />
            </Form.Item>
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                style={{ borderRadius: 6, height: 36, padding: '0 24px' }}
              >
                开始对比
              </Button>
            </Form.Item>
          </Form>
          {turkmenAbResults.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <Table
                dataSource={turkmenAbResults}
                rowKey="abSegment"
                pagination={false}
                size="small"
                bordered
                expandable={{
                  expandedRowKeys: Array.from(turkmenExpandedRows),
                  onExpand: (expanded, record) => {
                    const next = new Set(turkmenExpandedRows);
                    if (expanded) next.add(record.abSegment);
                    else next.delete(record.abSegment);
                    setTurkmenExpandedRows(next);
                  },
                  expandedRowRender: (record) => {
                    const empty = record.segments.length === 0;
                    return (
                      <div style={{ padding: '8px 16px', background: '#fafafa' }}>
                        <Text strong style={{ fontSize: 12 }}>匹配的 IP 段：</Text>
                        {empty && (
                          <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>IP段管理中暂无同 AB 段记录</Text>
                        )}
                        {!empty && (
                          <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                            {record.segments.map((s) => (
                              <li key={s.id} style={{ fontSize: 12, marginBottom: 4 }}>
                                <Text code>{s.segment}</Text>
                                {s.blockedCountries?.includes('turkmenistan') && (
                                  <Tag color="error" style={{ marginLeft: 8 }}>土库曼被墙</Tag>
                                )}
                                {s.purchaseDate && (
                                  <Text type="secondary" style={{ marginLeft: 8 }}>购买: {s.purchaseDate}</Text>
                                )}
                                {s.renewalDate && (
                                  <Text type="secondary" style={{ marginLeft: 8 }}>续费: {s.renewalDate}</Text>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  },
                }}
                columns={[
                  {
                    title: 'AB 段',
                    dataIndex: 'abSegment',
                    key: 'abSegment',
                    width: 120,
                    render: (text: string) => <Text code strong>{text}</Text>,
                  },
                  {
                    title: '土库曼被墙',
                    dataIndex: 'turkmenBlocked',
                    key: 'turkmenBlocked',
                    width: 120,
                    render: (v: boolean) => (
                      <Tag color={v ? 'error' : 'success'}>{v ? '是' : '否'}</Tag>
                    ),
                  },
                  {
                    title: '购买时间',
                    dataIndex: 'purchaseDate',
                    key: 'purchaseDate',
                    width: 120,
                  },
                  {
                    title: '到期时间',
                    dataIndex: 'expiryDate',
                    key: 'expiryDate',
                    width: 120,
                  },
                  {
                    title: '匹配数',
                    key: 'count',
                    width: 80,
                    render: (_: any, r: TurkmenAbCompareResult) => r.segments.length,
                  },
                ]}
              />
            </div>
          )}
        </Card>
        ) : null}

        {/* 说明 */}
        <Card style={{ marginTop: 24, borderRadius: 6, background: '#f5f5f5' }}>
          <Text style={{ fontSize: 12 }}>
            <strong>说明：</strong> IRR（Internet Routing Registry）与 RPKI 是两套独立的体系。运营商宣告校验通常以 IRR
            为准，请勿仅以 RPKI 检索界面判断。RADB、RIPE 等均为 IRR 的数据库节点。
          </Text>
        </Card>

        {/* 批量同步模态框 */}
        <Modal
          title="批量同步到IP段管理"
          open={syncModalVisible}
        onOk={handleSyncSubmit}
        onCancel={() => {
          setSyncModalVisible(false);
          syncForm.resetFields();
        }}
        width={600}
        okText="同步"
        cancelText="取消"
      >
        <Alert
          message={`将同步 ${syncSegments.length} 个IP段的ASN信息`}
          description={
            <div style={{ marginTop: 8 }}>
              {syncSegments.map((s, idx) => (
                <div key={idx} style={{ fontSize: 12, marginBottom: 4 }}>
                  {s.segment} → {s.asn}
                  {s.primaryAsnInBgp === false ? (
                    <Text type="warning" style={{ marginLeft: 8 }}>
                      （BGP 未宣告，主 ASN 在列表中为未生效样式）
                    </Text>
                  ) : null}
                  {s.additionalAsns.length > 0 ? (
                    <Text type="secondary" style={{ marginLeft: 8 }}>
                      （另有 {s.additionalAsns.length} 个 ASN 写入「其余」）
                    </Text>
                  ) : null}
                </div>
              ))}
            </div>
          }
          type="info"
          style={{ marginBottom: 16 }}
        />
        <Form form={syncForm} layout="vertical">
          <Form.Item
            label="供应商"
            name="supplier"
          >
            <Select placeholder="选择供应商（新增IP段时使用）" allowClear>
              {supplierStorage.getAll().map(s => (
                <Select.Option key={s.id} value={s.name}>{s.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="使用地区"
            name="usageArea"
          >
            <Select placeholder="选择使用地区（新增IP段时使用）" allowClear>
              {usageAreaStorage.getAll().map(a => (
                <Select.Option key={a.id} value={a.name}>{a.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="项目组"
            name="projectGroups"
          >
            <Select
              mode="multiple"
              placeholder="选择项目组（新增IP段时使用）"
              allowClear
            >
              {projectGroupStorage.getAll().map(g => (
                <Select.Option key={g.id} value={g.name}>{g.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            label="购买日期"
            name="purchaseDate"
          >
            <DatePicker style={{ width: '100%' }} placeholder="选择购买日期（新增IP段时使用）" />
          </Form.Item>
          <Form.Item
            label="续费日期"
            name="renewalDate"
          >
            <DatePicker style={{ width: '100%' }} placeholder="选择续费日期（新增IP段时使用）" />
          </Form.Item>
          <Form.Item
            label="月价格（元）"
            name="monthlyPrice"
          >
            <InputNumber style={{ width: '100%' }} placeholder="输入月价格（新增IP段时使用）" min={0} />
          </Form.Item>
        </Form>
        <Alert
          message="提示"
          description="若 IP 段已存在：更新主 ASN 及「其余 ASN」列表（IRR 同步会清空其余 ASN）。若不存在：使用上述字段新建，续费状态固定为「无」。"
          type="warning"
          style={{ marginTop: 16 }}
        />
      </Modal>
      </div>
    </div>
  );
};

export default IRRDetection;
