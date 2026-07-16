import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Card,
  Input,
  Button,
  Space,
  Typography,
  Alert,
  Collapse,
  Checkbox,
  Modal,
  Tabs,
  Table,
  Tag,
  Divider,
  message,
  Spin,
} from 'antd';
import {
  ThunderboltOutlined,
  LinkOutlined,
  GlobalOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';

const { Text, Paragraph, Link: TextLink } = Typography;

/** 从 IPv4 或 CIDR 推导常用「网关」探测地址（首个可用主机地址） */
export function deriveGatewayIPv4(input: string): string | null {
  const t = input.trim();
  const single = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (single) {
    const o = [1, 2, 3, 4].map((i) => parseInt(single[i], 10));
    if (o.some((x) => x > 255)) return null;
    return o.join('.');
  }
  const m = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  const c = parseInt(m[3], 10);
  const d = parseInt(m[4], 10);
  const p = parseInt(m[5], 10);
  if ([a, b, c, d, p].some((x) => isNaN(x) || x < 0)) return null;
  if (p > 32 || a > 255 || b > 255 || c > 255 || d > 255) return null;
  if (p === 32) return `${a}.${b}.${c}.${d}`;
  const ipNum = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const mask = p === 0 ? 0 : (~0 << (32 - p)) >>> 0;
  const network = ipNum & mask;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  let host = (network + 1) >>> 0;
  if (host === broadcast || host > broadcast) host = network;
  return [((host >>> 24) & 255), ((host >>> 16) & 255), ((host >>> 8) & 255), host & 255].join('.');
}

/** 多行/逗号/空格分隔的多个 IPv4 或 CIDR，按网关 IP 去重并保持顺序 */
export function parseProbeInputs(text: string): Array<{ raw: string; gateway: string }> {
  const tokens = text.split(/[\n\r,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const out: Array<{ raw: string; gateway: string }> = [];
  const seenGw = new Set<string>();
  for (const raw of tokens) {
    const gateway = deriveGatewayIPv4(raw);
    if (!gateway) continue;
    if (seenGw.has(gateway)) continue;
    seenGw.add(gateway);
    out.push({ raw, gateway });
  }
  return out;
}

export interface ParsedPingRow {
  geo: string;
  isp: string;
  lossPct: number;
}

/** 解析从 ping.pe 复制的表格文本（Tab 或多空格分列，需含 Loss 百分比） */
export function parsePingPePaste(text: string): ParsedPingRow[] {
  const out: ParsedPingRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^geo\b/i.test(line) && /loss/i.test(line)) continue;
    let parts = line.split('\t').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) {
      parts = line.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    }
    if (parts.length < 2) continue;
    let lossPct: number | null = null;
    for (const p of parts) {
      const exact = p.match(/^(\d{1,3})%$/);
      if (exact) {
        lossPct = Math.min(100, parseInt(exact[1], 10));
        break;
      }
      const inner = p.match(/(\d{1,3})%/);
      if (inner) {
        lossPct = Math.min(100, parseInt(inner[1], 10));
        break;
      }
    }
    if (lossPct === null) continue;
    out.push({ geo: parts[0], isp: parts[1] || '', lossPct });
  }
  return out;
}

function isGoogleRow(row: ParsedPingRow): boolean {
  return /google/i.test(row.isp) || /google/i.test(row.geo);
}

function isOvhRow(row: ParsedPingRow): boolean {
  return /ovh/i.test(row.isp) || /ovh/i.test(row.geo);
}

export interface GatewayPingDetectionProps {
  embedded?: boolean;
}

interface BgpAsnBrief {
  asn: number;
  name: string;
  description?: string;
  country_code?: string;
}

type BgpEntry = { loading: boolean; asns: BgpAsnBrief[]; error?: string };

interface PingHostJson {
  success: boolean;
  ok?: boolean;
  reachable?: boolean;
  sent?: number;
  received?: number;
  lost?: number;
  lossPercent?: number;
  avgMs?: number | null;
  error?: string;
  message?: string;
}

type PingEntry = { loading: boolean; data?: PingHostJson };

function mapAsnsFromResponse(json: { success?: boolean; data?: unknown; message?: string }): {
  ok: boolean;
  asns: BgpAsnBrief[];
  message?: string;
} {
  if (!json.success) {
    return { ok: false, asns: [], message: json.message };
  }
  const d = json.data as { data?: { asns?: unknown }; asns?: unknown } | undefined;
  const rawAsns = d?.data?.asns || d?.asns || [];
  const list: BgpAsnBrief[] = (Array.isArray(rawAsns) ? rawAsns : []).flatMap(
    (x: { asn?: number; name?: string; description?: string; country_code?: string }) => {
      if (typeof x.asn !== 'number' || !Number.isFinite(x.asn)) return [];
      const item: BgpAsnBrief = {
        asn: x.asn,
        name: x.name || '',
        description: x.description,
        country_code: x.country_code,
      };
      return [item];
    }
  );
  return { ok: true, asns: list };
}

const GatewayPingDetection: React.FC<GatewayPingDetectionProps> = ({ embedded = false }) => {
  const { hasPermission } = useAuth();
  const canView = hasPermission('view_irr');

  const [inputsText, setInputsText] = useState('');
  const [probes, setProbes] = useState<Array<{ raw: string; gateway: string }>>([]);
  const [activeGateway, setActiveGateway] = useState<string | null>(null);
  const [bgpState, setBgpState] = useState<Record<string, BgpEntry>>({});
  const [pasteMap, setPasteMap] = useState<Record<string, string>>({});
  const [parsedMap, setParsedMap] = useState<Record<string, ParsedPingRow[]>>({});
  const [manualGMap, setManualGMap] = useState<Record<string, boolean>>({});
  const [manualOMap, setManualOMap] = useState<Record<string, boolean>>({});
  const [iframeKeyMap, setIframeKeyMap] = useState<Record<string, number>>({});
  const [pingState, setPingState] = useState<Record<string, PingEntry>>({});

  const [asModal, setAsModal] = useState<{ open: boolean; asn: number | null; heIp: string | null }>({
    open: false,
    asn: null,
    heIp: null,
  });
  const [asnDetail, setAsnDetail] = useState<unknown>(null);
  const [asnDetailLoading, setAsnDetailLoading] = useState(false);

  const applyProbes = useCallback(() => {
    const list = parseProbeInputs(inputsText);
    if (list.length === 0) {
      message.error('请输入至少一个合法 IPv4 或 CIDR（可换行、逗号或空格分隔）');
      return;
    }
    setProbes(list);
    setActiveGateway(list[0].gateway);
    setPasteMap({});
    setParsedMap({});
    setManualGMap({});
    setManualOMap({});
    setBgpState({});
    setPingState({});
    setIframeKeyMap((m) => {
      const next = { ...m };
      list.forEach((p) => {
        next[p.gateway] = (next[p.gateway] || 0) + 1;
      });
      return next;
    });
    message.success(`已应用 ${list.length} 个网关探测目标`);
  }, [inputsText]);

  /** 本机 ping 5 包（与各网关并行） */
  useEffect(() => {
    if (probes.length === 0) return;
    let cancelled = false;
    probes.forEach(({ gateway }) => {
      setPingState((s) => ({ ...s, [gateway]: { loading: true } }));
      fetch(`/api/ping/host?ip=${encodeURIComponent(gateway)}`)
        .then((r) => r.json())
        .then((json: PingHostJson) => {
          if (!cancelled) {
            setPingState((s) => ({ ...s, [gateway]: { loading: false, data: json } }));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPingState((s) => ({
              ...s,
              [gateway]: {
                loading: false,
                data: { success: false, error: '本机 ping 接口请求失败' },
              },
            }));
          }
        });
    });
    return () => {
      cancelled = true;
    };
  }, [probes]);

  useEffect(() => {
    if (probes.length === 0) return;
    let cancelled = false;

    const run = async () => {
      for (const { gateway } of probes) {
        if (cancelled) return;
        setBgpState((s) => ({
          ...s,
          [gateway]: { loading: true, asns: [], error: undefined },
        }));
        try {
          const res = await fetch(`/api/bgp/lookup-ip?ip=${encodeURIComponent(gateway)}`);
          const json = await res.json();
          if (cancelled) return;
          const mapped = mapAsnsFromResponse(json);
          if (!mapped.ok) {
            setBgpState((s) => ({
              ...s,
              [gateway]: { loading: false, asns: [], error: mapped.message || 'BGP 查询失败' },
            }));
          } else {
            setBgpState((s) => ({
              ...s,
              [gateway]: { loading: false, asns: mapped.asns },
            }));
          }
        } catch {
          if (!cancelled) {
            setBgpState((s) => ({
              ...s,
              [gateway]: { loading: false, asns: [], error: '网络错误' },
            }));
          }
        }
        await new Promise((r) => setTimeout(r, 350));
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [probes]);

  const bgpSummary = useMemo(() => {
    if (probes.length === 0) {
      return { loading: 0, withAsn: 0, pingOk: 0, pingLoading: 0 };
    }
    let loading = 0;
    let withAsn = 0;
    let pingOk = 0;
    let pingLoading = 0;
    for (const { gateway } of probes) {
      const st = bgpState[gateway];
      if (!st) continue;
      if (st.loading) loading++;
      else if (!st.error && st.asns.length > 0) withAsn++;
      const p = pingState[gateway];
      if (p?.loading) pingLoading++;
      if (p?.data?.success && p.data.reachable) pingOk++;
    }
    return { loading, withAsn, pingOk, pingLoading };
  }, [probes, bgpState, pingState]);

  const openAsModal = async (asn: number, heIp: string) => {
    setAsModal({ open: true, asn, heIp });
    setAsnDetail(null);
    setAsnDetailLoading(true);
    try {
      const res = await fetch(`/api/bgp/lookup-asn?asn=${encodeURIComponent(String(asn))}`);
      const json = await res.json();
      setAsnDetail(json.success ? json.data : { error: json.message });
    } catch {
      setAsnDetail({ error: '请求失败' });
    } finally {
      setAsnDetailLoading(false);
    }
  };

  const renderProbePanel = (gateway: string, raw: string) => {
    const parsedRows = parsedMap[gateway] || [];
    const pasteText = pasteMap[gateway] || '';
    const bgp = bgpState[gateway];
    const pingCell = pingState[gateway];
    const manualGoogleOk = manualGMap[gateway] || false;
    const manualOvhOk = manualOMap[gateway] || false;

    const unreachableRows = parsedRows.filter((r) => r.lossPct >= 100);
    const googleReachableParsed = parsedRows.some((r) => isGoogleRow(r) && r.lossPct < 100);
    const ovhReachableParsed = parsedRows.some((r) => isOvhRow(r) && r.lossPct < 100);
    const hasGoogleInPaste = parsedRows.some(isGoogleRow);
    const hasOvhInPaste = parsedRows.some(isOvhRow);
    const allUnreachable = parsedRows.length > 0 && parsedRows.every((r) => r.lossPct >= 100);
    const partialUnreachable =
      parsedRows.length > 0 && unreachableRows.length > 0 && unreachableRows.length < parsedRows.length;

    const googleRequiredOk = hasGoogleInPaste ? googleReachableParsed || manualGoogleOk : manualGoogleOk;
    const ovhRequiredOk = hasOvhInPaste ? ovhReachableParsed || manualOvhOk : manualOvhOk;

    let usability: { level: 'info' | 'success' | 'warning' | 'error'; text: string };
    if (parsedRows.length === 0) {
      usability = {
        level: 'info',
        text: '请在本标签对应的 ping.pe 页中查看，或粘贴该页的表格文本以判定 Google/OVH 与丢包。',
      };
    } else if (allUnreachable) {
      usability = { level: 'error', text: '网关不通：所有已解析探测点 Loss 均为 100%。' };
    } else if (!googleRequiredOk || !ovhRequiredOk) {
      usability = {
        level: 'warning',
        text: '此网关不可直接投入使用：须满足 Google 与 OVH 探测线均可达（Loss < 100%），请勾选人工确认或修正解析数据。',
      };
    } else {
      usability = {
        level: 'success',
        text: '按当前解析与规则：此网关 Google 与 OVH 均可达，且无「全网不通」判定。',
      };
    }

    const pingPeUrl = `https://ping.pe/${encodeURIComponent(gateway)}`;
    const iframeKey = iframeKeyMap[gateway] || 0;

    const parsePaste = () => {
      const rows = parsePingPePaste(pasteText);
      setParsedMap((m) => ({ ...m, [gateway]: rows }));
      if (rows.length === 0) {
        message.warning('未能解析出含 Loss% 的行');
      } else {
        message.success(`${gateway}：已解析 ${rows.length} 条`);
      }
    };

    return (
      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          原始输入示例：<Text code>{raw}</Text>
        </Text>

        <Card title={`本机 ICMP（5 个包）— ${gateway}`} style={{ marginBottom: 16 }}>
          {(!pingCell || pingCell.loading) && <Spin tip="本机 ping 中…" />}
          {pingCell?.data && !pingCell.loading && (
            <>
              {pingCell.data.success && (
                <Alert
                  type={pingCell.data.reachable ? 'success' : 'warning'}
                  showIcon
                  message={`整体结果：发送 ${pingCell.data.sent ?? 5}，收到 ${pingCell.data.received ?? 0}，丢失 ${pingCell.data.lost ?? 0}，丢包率 ${pingCell.data.lossPercent ?? 0}%`}
                  description={
                    [
                      pingCell.data.error,
                      pingCell.data.avgMs != null && pingCell.data.avgMs !== undefined
                        ? `平均往返时间约 ${pingCell.data.avgMs} ms`
                        : '未解析到平均延迟',
                    ]
                      .filter(Boolean)
                      .join('；') || undefined
                  }
                />
              )}
              {!pingCell.data.success && (
                <Alert
                  type="warning"
                  showIcon
                  message={pingCell.data.error || pingCell.data.message || '本机 ping 失败'}
                />
              )}
            </>
          )}
        </Card>

        <Card
          title={<><GlobalOutlined /> 宣告 AS（BGP）— {gateway}</>}
          loading={bgp?.loading}
          style={{ marginBottom: 16 }}
          extra={
            <TextLink href={`https://bgp.he.net/ip/${gateway}`} target="_blank" rel="noreferrer">
              Hurricane Electric <LinkOutlined />
            </TextLink>
          }
        >
          {bgp?.error && (
            <Alert type="warning" showIcon message={bgp.error} style={{ marginBottom: 12 }} />
          )}
          {!bgp?.loading && !bgp?.error && bgp && bgp.asns.length === 0 && (
            <Text type="secondary">未查到 ASN（或前缀无宣告）</Text>
          )}
          {bgp && bgp.asns.length > 0 && (
            <Space wrap>
              {bgp.asns.map((a) => (
                <Button
                  key={a.asn}
                  type="link"
                  onClick={() => openAsModal(a.asn, gateway)}
                  style={{ padding: 0, height: 'auto' }}
                >
                  <Tag color="blue" style={{ margin: 0, cursor: 'pointer' }}>
                    AS{a.asn} {a.name ? `— ${a.name}` : ''}
                  </Tag>
                </Button>
              ))}
            </Space>
          )}
        </Card>

        <Alert
          type={
            usability.level === 'success'
              ? 'success'
              : usability.level === 'error'
                ? 'error'
                : usability.level === 'warning'
                  ? 'warning'
                  : 'info'
          }
          showIcon
          icon={
            usability.level === 'success' ? (
              <CheckCircleOutlined />
            ) : usability.level === 'error' ? (
              <CloseCircleOutlined />
            ) : usability.level === 'warning' ? (
              <WarningOutlined />
            ) : undefined
          }
          message="可用性结论（本标签网关 · 粘贴解析 + 人工确认）"
          description={usability.text}
          style={{ marginBottom: 16 }}
        />

        <Card title="智能解析（从当前网关的 ping.pe 页复制表格）" style={{ marginBottom: 16 }}>
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            切换到本标签后，在下方嵌入页中复制表格，粘贴到此处并解析（每个网关单独一份）。
          </Paragraph>
          <Input.TextArea
            rows={5}
            value={pasteText}
            onChange={(e) => setPasteMap((m) => ({ ...m, [gateway]: e.target.value }))}
            placeholder="粘贴 ping.pe 表格文本…"
            style={{ marginBottom: 8 }}
          />
          <Button onClick={parsePaste} style={{ marginBottom: 12 }}>
            解析
          </Button>
          {parsedRows.length > 0 && (
            <>
              <Table
                size="small"
                pagination={false}
                rowKey={(_, i) => `${gateway}-${i}`}
                dataSource={parsedRows}
                columns={[
                  { title: '地区 / Geo', dataIndex: 'geo', key: 'geo', ellipsis: true },
                  { title: 'ISP', dataIndex: 'isp', key: 'isp', ellipsis: true },
                  {
                    title: 'Loss',
                    dataIndex: 'lossPct',
                    key: 'loss',
                    width: 90,
                    render: (v: number) => (
                      <Tag color={v >= 100 ? 'red' : v > 0 ? 'orange' : 'green'}>{v}%</Tag>
                    ),
                  },
                  {
                    title: '标记',
                    key: 'tag',
                    width: 120,
                    render: (_: unknown, row: ParsedPingRow) => (
                      <Space size={4}>
                        {isGoogleRow(row) && <Tag>Google</Tag>}
                        {isOvhRow(row) && <Tag color="purple">OVH</Tag>}
                      </Space>
                    ),
                  },
                ]}
              />
              <Divider />
              <Space direction="vertical" style={{ width: '100%' }}>
                <Checkbox
                  checked={manualGoogleOk}
                  onChange={(e) => setManualGMap((m) => ({ ...m, [gateway]: e.target.checked }))}
                  disabled={hasGoogleInPaste && googleReachableParsed}
                >
                  人工确认：Google 探测线已通（Loss &lt; 100%）
                  {hasGoogleInPaste && googleReachableParsed ? (
                    <Tag color="success" style={{ marginLeft: 8 }}>
                      已由解析确认
                    </Tag>
                  ) : null}
                </Checkbox>
                <Checkbox
                  checked={manualOvhOk}
                  onChange={(e) => setManualOMap((m) => ({ ...m, [gateway]: e.target.checked }))}
                  disabled={hasOvhInPaste && ovhReachableParsed}
                >
                  人工确认：OVH 探测线已通（Loss &lt; 100%）
                  {hasOvhInPaste && ovhReachableParsed ? (
                    <Tag color="success" style={{ marginLeft: 8 }}>
                      已由解析确认
                    </Tag>
                  ) : null}
                </Checkbox>
              </Space>
            </>
          )}
        </Card>

        {parsedRows.length > 0 && unreachableRows.length > 0 && (
          <Collapse
            style={{ marginBottom: 16 }}
            items={[
              {
                key: 'unreach',
                label: `不通地区（Loss 100%）共 ${unreachableRows.length} 条${partialUnreachable ? '' : '（全部不通）'}`,
                children: (
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {unreachableRows.map((r, i) => (
                      <li key={i}>
                        <Text code>{r.geo}</Text> — {r.isp}
                      </li>
                    ))}
                  </ul>
                ),
              },
            ]}
          />
        )}

        <Card title={`ping.pe 实时探测 — ${gateway}`}>
          <iframe
            key={iframeKey}
            title={`ping.pe-${gateway}`}
            src={pingPeUrl}
            style={{
              width: '100%',
              height: 560,
              border: '1px solid #d9d9d9',
              borderRadius: 8,
              background: '#000',
            }}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            若嵌入为空白，请{' '}
            <TextLink href={pingPeUrl} target="_blank" rel="noreferrer">
              在新窗口打开 ping.pe <LinkOutlined />
            </TextLink>
          </Paragraph>
        </Card>
      </div>
    );
  };

  if (!canView) {
    return (
      <Card>
        <Text type="secondary">无权限访问网关 Ping 检测</Text>
      </Card>
    );
  }

  return (
    <div>
      {!embedded && (
        <div className="app-header" style={{ marginBottom: 16 }}>
          <h1 className="app-title">网关 Ping 检测</h1>
        </div>
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="说明"
        description={
          <Paragraph style={{ marginBottom: 0 }}>
            本机对网关执行 <Text strong>ICMP ping 共 5 个包</Text> 并汇总丢包/延迟；宣告 AS 优先通过{' '}
            <Text strong>Team Cymru DNS</Text>（不依赖 api.bgpview.io），可选合并 BGPView。嵌入{' '}
            <TextLink href="https://ping.pe/" target="_blank" rel="noreferrer">ping.pe</TextLink>{' '}
            作全球多节点参考。多段按网关去重后分标签展示。
          </Paragraph>
        }
      />

      <Card title={<><ThunderboltOutlined /> 探测目标（支持多个）</>} style={{ marginBottom: 16 }}>
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
          每行一个 IPv4 或 CIDR，也可用英文逗号、空格分隔。同一网关（如 /24 与推导出的 .1）只保留一条。
        </Paragraph>
        <Input.TextArea
          rows={4}
          placeholder={'81.168.123.0/24\n192.168.1.1\n10.0.0.0/24'}
          value={inputsText}
          onChange={(e) => setInputsText(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        <Button type="primary" onClick={applyProbes}>
          应用网关并加载全部 ping.pe
        </Button>
        {probes.length > 0 && (
          <Text style={{ marginLeft: 16 }}>
            共 <Text strong>{probes.length}</Text> 个网关；本机 5 包可达{' '}
            <Text strong>{bgpSummary.pingOk}</Text> / {probes.length}
            {bgpSummary.pingLoading > 0 ? (
              <Text type="secondary"> （ping {bgpSummary.pingLoading} 个进行中…）</Text>
            ) : null}
            ；BGP 宣告：
            <Text strong>{bgpSummary.withAsn}</Text> / {probes.length}
            {bgpSummary.loading > 0 ? (
              <Text type="warning"> （{bgpSummary.loading} 个查询中…）</Text>
            ) : null}
          </Text>
        )}
      </Card>

      {probes.length > 0 && activeGateway && (
        <Tabs
          activeKey={activeGateway}
          onChange={(k) => setActiveGateway(k)}
          type="card"
          style={{ marginBottom: 16 }}
          items={probes.map((p) => {
            const st = bgpState[p.gateway];
            const pst = pingState[p.gateway];
            const loading = st?.loading || pst?.loading;
            const warn =
              Boolean(st?.error) ||
              Boolean(pst?.data?.error) ||
              Boolean(pst?.data?.success === true && pst.data.reachable === false);
            const suffix = loading ? ' …' : warn ? ' ⚠' : '';
            return {
              key: p.gateway,
              label: `${p.gateway}${suffix}`,
              children: renderProbePanel(p.gateway, p.raw),
            };
          })}
        />
      )}

      <Modal
        title={asModal.asn ? `AS${asModal.asn} 路径与宣告摘要` : 'AS 详情'}
        open={asModal.open}
        onCancel={() => setAsModal({ open: false, asn: null, heIp: null })}
        footer={null}
        width={720}
        destroyOnClose
      >
        <Tabs
          items={[
            {
              key: 'bgpview',
              label: 'BGPView 数据',
              children: asnDetailLoading ? (
                <Text type="secondary">加载中…</Text>
              ) : (
                <pre style={{ maxHeight: 360, overflow: 'auto', fontSize: 12, background: '#f5f5f5', padding: 12 }}>
                  {JSON.stringify(asnDetail, null, 2)}
                </pre>
              ),
            },
            {
              key: 'he',
              label: '外部路径图',
              children: (
                <Space direction="vertical">
                  <Text type="secondary">Hurricane Electric 提供 AS 关系与路径可视化（新窗口打开）。</Text>
                  {asModal.asn && (
                    <TextLink href={`https://bgp.he.net/AS${asModal.asn}`} target="_blank" rel="noreferrer">
                      打开 AS{asModal.asn} 页面 <LinkOutlined />
                    </TextLink>
                  )}
                  {asModal.heIp && (
                    <TextLink href={`https://bgp.he.net/ip/${asModal.heIp}`} target="_blank" rel="noreferrer">
                      打开 IP {asModal.heIp} 页面 <LinkOutlined />
                    </TextLink>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
};

export default GatewayPingDetection;
