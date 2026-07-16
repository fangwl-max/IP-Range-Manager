import React, { useState, useCallback } from 'react';
import { Card, Input, Button, Table, Space, Alert, Typography, message, Tag, Spin, InputNumber } from 'antd';
import { GlobalOutlined, LinkOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { forEachConcurrent, DETECTION_MAX_CONCURRENCY } from '../utils/asyncConcurrent';

const { Title, Text, Link: TextLink } = Typography;
const { TextArea } = Input;

export const BGP_HE_BASE = 'https://bgp.he.net';

function parsePrefixLines(text: string): string[] {
  const tokens = text.split(/[\n\r,，\s;；]+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.length < 5 || t.length > 128 || !t.includes('/') || !/^[0-9a-fA-F.:\/\-]+$/i.test(t)) {
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function buildBgpHeNetUrl(prefix: string): string {
  return `${BGP_HE_BASE}/net/${prefix.replace(/^\//, '')}`;
}

export type BgpHeCountSource =
  | 'delegation_parent'
  | 'delegation_no_parent'
  | 'he_visibility'
  | 'bgpview'
  | 'he_announced'
  | 'merged'
  | 'none';

export interface BgpHeRow {
  key: string;
  prefix: string;
  heUrl: string;
  loading?: boolean;
  success?: boolean;
  fetchError?: string;
  routeCount: number | null;
  countSource: BgpHeCountSource;
  /** 分解：HE Visibility 行 / Announced by 表行 / BGPView 去重 ASN 数 — 便于对照「单层/双层」 */
  heVisibilityTableRows: number;
  announcedTableRows: number;
  bgpUniqAsnCount: number;
  announcedBy: Array<{
    origin: string;
    originRegistrant: string;
    prefix: string;
    prefixRegistrant: string;
  }>;
  delegations: Array<{
    registry: string;
    status: string;
    parentPrefix: string;
    cc: string;
  }>;
  bogonLine: string | null;
  bgpviewAsns: Array<{ asn?: number; name?: string }> | null;
}

async function fetchBgpHe(prefix: string): Promise<{
  success: boolean;
  message?: string;
  heUrl: string;
  routeCount: number | null;
  countSource: BgpHeCountSource;
  heVisibilityTableRows: number;
  announcedTableRows: number;
  bgpUniqAsnCount: number;
  announcedBy: BgpHeRow['announcedBy'];
  delegations: BgpHeRow['delegations'];
  bogonLine: string | null;
  bgpviewAsns: BgpHeRow['bgpviewAsns'];
}> {
  const res = await fetch(`/api/bgphe/lookup?prefix=${encodeURIComponent(prefix)}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    return {
      success: false,
      message: (data.message as string) || `HTTP ${res.status}`,
      heUrl: (data.heUrl as string) || buildBgpHeNetUrl(prefix),
      routeCount: null,
      countSource: 'none',
      heVisibilityTableRows: 0,
      announcedTableRows: 0,
      bgpUniqAsnCount: 0,
      announcedBy: [],
      delegations: [],
      bogonLine: null,
      bgpviewAsns: null,
    };
  }
  if (!data.success) {
    return {
      success: false,
      message: (data.message as string) || '查询失败',
      heUrl: (data.heUrl as string) || buildBgpHeNetUrl(prefix),
      routeCount: null,
      countSource: 'none',
      heVisibilityTableRows: 0,
      announcedTableRows: 0,
      bgpUniqAsnCount: 0,
      announcedBy: [],
      delegations: [],
      bogonLine: null,
      bgpviewAsns: null,
    };
  }
  const rc = data.routeCount;
  return {
    success: true,
    heUrl: String(data.heUrl || buildBgpHeNetUrl(prefix)),
    routeCount: rc === null || rc === undefined ? null : Number(rc),
    countSource: (data.countSource as BgpHeCountSource) || 'none',
    heVisibilityTableRows: Number(data.heVisibilityTableRows) || 0,
    announcedTableRows: Number(data.announcedTableRows) || 0,
    bgpUniqAsnCount: Number(data.bgpUniqAsnCount) || 0,
    announcedBy: (data.announcedBy as BgpHeRow['announcedBy']) || [],
    delegations: (data.delegations as BgpHeRow['delegations']) || [],
    bogonLine: (data.bogonLine as string) || null,
    bgpviewAsns: (data.bgpviewAsns as BgpHeRow['bgpviewAsns']) || null,
  };
}

function countLabel(s: BgpHeCountSource): string {
  if (s === 'delegation_parent') return 'Matching delegations 含严格父前缀→2层';
  if (s === 'delegation_no_parent') return 'Delegations 可解析且无更广父前缀→1层';
  if (s === 'he_visibility') return 'HE Visibility 实测行→层';
  if (s === 'bgpview') return 'BGPView 宣告源ASN数→层（多源如 MOAS 常为 2 层）';
  if (s === 'he_announced') return 'HE Announced by 表行数→层';
  if (s === 'merged') return 'HE 表行与 BGPView 源数一致时合并';
  return '无';
}

const announcedCols: ColumnsType<BgpHeRow['announcedBy'][number]> = [
  { title: 'Origin (ASN)', dataIndex: 'origin', key: 'o', width: 120 },
  { title: 'Origin 注册机构', dataIndex: 'originRegistrant', key: 'or', ellipsis: true },
  { title: 'Prefix', dataIndex: 'prefix', key: 'p', width: 160, ellipsis: true },
  { title: 'Prefix 注册方', dataIndex: 'prefixRegistrant', key: 'pr', ellipsis: true },
];

const deleCols: ColumnsType<BgpHeRow['delegations'][number]> = [
  { title: 'Registry', dataIndex: 'registry', key: 'r', width: 90 },
  { title: 'Status', dataIndex: 'status', key: 's', width: 100 },
  { title: '父级前缀', dataIndex: 'parentPrefix', key: 'pp', width: 160, ellipsis: true },
  { title: 'CC', dataIndex: 'cc', key: 'c', width: 80, ellipsis: true },
];

const BgpHeDetectionPanel: React.FC<{ embedded?: boolean }> = ({ embedded = true }) => {
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<BgpHeRow[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [concurrency, setConcurrency] = useState(6);

  const run = useCallback(async () => {
    const list = parsePrefixLines(raw);
    if (list.length === 0) {
      message.warning('请输入带掩码的 IPv4/IPv6 前缀，如 147.125.148.0/24（每行一个）');
      return;
    }
    const result: BgpHeRow[] = list.map((prefix) => ({
      key: prefix,
      prefix,
      heUrl: buildBgpHeNetUrl(prefix),
      loading: true,
      success: false,
      routeCount: null,
      countSource: 'none',
      heVisibilityTableRows: 0,
      announcedTableRows: 0,
      bgpUniqAsnCount: 0,
      announcedBy: [],
      delegations: [],
      bogonLine: null,
      bgpviewAsns: null,
    }));
    setRows([...result]);
    setDetecting(true);

    const indices = list.map((_, i) => i);
    const failSuffix = '（二次检测仍失败）';

    const probeAt = async (i: number, isRetry: boolean) => {
      const prefix = list[i];
      try {
        const d = await fetchBgpHe(prefix);
        if (d.success) {
          result[i] = {
            key: prefix,
            prefix,
            heUrl: d.heUrl,
            loading: false,
            success: true,
            routeCount: d.routeCount,
            countSource: d.countSource,
            heVisibilityTableRows: d.heVisibilityTableRows,
            announcedTableRows: d.announcedTableRows,
            bgpUniqAsnCount: d.bgpUniqAsnCount,
            announcedBy: d.announcedBy,
            delegations: d.delegations,
            bogonLine: d.bogonLine,
            bgpviewAsns: d.bgpviewAsns,
          };
        } else {
          const err = (d.message as string | undefined)?.trim()
            ? String(d.message)
            : '查询失败';
          result[i] = {
            key: prefix,
            prefix,
            heUrl: d.heUrl,
            loading: false,
            success: false,
            fetchError: isRetry ? `${err}${failSuffix}` : err,
            routeCount: null,
            countSource: 'none',
            heVisibilityTableRows: 0,
            announcedTableRows: 0,
            bgpUniqAsnCount: 0,
            announcedBy: [],
            delegations: [],
            bogonLine: null,
            bgpviewAsns: null,
          };
        }
      } catch (e: any) {
        const base = e?.message || '请求失败';
        result[i] = {
          key: prefix,
          prefix,
          heUrl: buildBgpHeNetUrl(prefix),
          loading: false,
          success: false,
          fetchError: isRetry ? `${base}${failSuffix}` : base,
          routeCount: null,
          countSource: 'none',
          heVisibilityTableRows: 0,
          announcedTableRows: 0,
          bgpUniqAsnCount: 0,
          announcedBy: [],
          delegations: [],
          bogonLine: null,
          bgpviewAsns: null,
        };
      }
      setRows([...result]);
    };

    await forEachConcurrent(indices, concurrency, async (i) => {
      await probeAt(i, false);
    });

    const okAfterFirst = indices.filter((i) => result[i].success).length;
    const failedAfterFirst = indices.filter((i) => !result[i].success);
    if (failedAfterFirst.length > 0) {
      for (const i of failedAfterFirst) {
        const prefix = list[i];
        result[i] = {
          key: prefix,
          prefix,
          heUrl: buildBgpHeNetUrl(prefix),
          loading: true,
          success: false,
          routeCount: null,
          countSource: 'none',
          heVisibilityTableRows: 0,
          announcedTableRows: 0,
          bgpUniqAsnCount: 0,
          announcedBy: [],
          delegations: [],
          bogonLine: null,
          bgpviewAsns: null,
        };
      }
      setRows([...result]);
      await forEachConcurrent(failedAfterFirst, concurrency, async (i) => {
        await probeAt(i, true);
      });
    }

    setDetecting(false);
    const ok = result.filter((r) => r.success).length;
    const retryOk = ok - okAfterFirst;
    message.success(
      retryOk > 0
        ? `完成 ${ok} / ${list.length}（其中 ${retryOk} 条经二次检测成功）`
        : `完成 ${ok} / ${list.length}`
    );
  }, [raw, concurrency]);

  const cardStyle: React.CSSProperties = embedded
    ? { borderRadius: 6 }
    : { borderRadius: 6, maxWidth: 1200, margin: '0 auto' };

  return (
    <div>
      {!embedded && (
        <div style={{ marginBottom: 20 }}>
          <Title level={2} style={{ marginBottom: 8 }}>
            BGP.HE 检测
          </Title>
          <Text type="secondary" style={{ fontSize: 13 }}>
            Hurricane Electric BGP Toolkit — 与侧栏「IP段检测」下其他工具独立成页
          </Text>
        </div>
      )}
    <Card style={cardStyle}>
      <Alert
        type="info"
        showIcon
        icon={<GlobalOutlined />}
        message="Hurricane Electric BGP 工具包（bgp.he.net）"
        description={
          <span>
            解析 <TextLink href={`${BGP_HE_BASE}/`} target="_blank" rel="noopener noreferrer">bgp.he.net</TextLink> 的
            <Text strong> Network Info</Text>（Announced by、Matching delegations）。<Text strong>IPv4</Text> 时「层」优先看{' '}
            <Text strong>Matching delegations</Text> 中「父级前缀」列是否含比查询前缀更短掩码且覆盖该前缀的 CIDR：有则视为
            <Text strong> 2 层</Text>，可解析且均无更广父块则 <Text strong>1 层</Text>；无法从该列解析出 CIDR 时（含 IPv6）再回退：HE{' '}
            <Text code>Visibility</Text> 表行，或 <Text strong>max(Announced by 表行, BGPView 去重 ASN)</Text>。以服务端返回为准；完整图请在 HE 原站核对。
          </span>
        }
        style={{ marginBottom: 16 }}
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>
          IP 前缀（每行一个，须含掩码，如 147.125.148.0/24）
        </Text>
        <TextArea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          rows={6}
          placeholder="147.125.148.0/24"
          style={{ borderRadius: 6, fontFamily: 'monospace' }}
        />
        <Space wrap align="center">
          <Space size="small">
            <Text style={{ fontSize: 13 }}>并发数</Text>
            <InputNumber
              min={1}
              max={DETECTION_MAX_CONCURRENCY}
              value={concurrency}
              disabled={detecting}
              onChange={(v) => setConcurrency(typeof v === 'number' ? v : 6)}
              style={{ width: 72 }}
            />
          </Space>
          <Button
            type="primary"
            icon={<SearchOutlined />}
            loading={detecting}
            onClick={() => void run()}
            style={{ borderRadius: 6, height: 36 }}
          >
            开始检测
          </Button>
        </Space>
      </Space>

      {rows.length > 0 && (
        <Table<BgpHeRow>
          style={{ marginTop: 20 }}
          size="small"
          pagination={false}
          rowKey="key"
          dataSource={rows}
          columns={[
            {
              title: 'IP 前缀',
              dataIndex: 'prefix',
              key: 'prefix',
              width: 180,
              render: (p: string) => <Text code>{p}</Text>,
            },
            {
              title: '路由表层数',
              key: 'n',
              width: 200,
              render: (_: unknown, r: BgpHeRow) => {
                if (r.loading) return <Spin size="small" />;
                if (r.fetchError) {
                  return (
                    <Tag color="error" title={r.fetchError}>
                      失败
                    </Tag>
                  );
                }
                if (r.routeCount == null) {
                  return <Text type="secondary">—</Text>;
                }
                return (
                  <Space direction="vertical" size={0}>
                    <Text strong style={{ fontSize: 15 }}>
                      {r.routeCount} 层
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {countLabel(r.countSource)}
                    </Text>
                  </Space>
                );
              },
            },
            {
              title: '操作',
              key: 'op',
              width: 150,
              render: (_: unknown, r: BgpHeRow) => (
                <Button
                  type="link"
                  size="small"
                  icon={<LinkOutlined />}
                  href={r.heUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ padding: 0 }}
                >
                  在 HE 打开
                </Button>
              ),
            },
          ]}
          expandable={{
            rowExpandable: (r) => Boolean(r.success),
            expandedRowRender: (r) => {
              if (!r.success) {
                return <Text type="secondary">无详情</Text>;
              }
              if (
                r.announcedBy.length === 0 &&
                r.delegations.length === 0 &&
                !r.bogonLine &&
                !r.bgpviewAsns?.length
              ) {
                return (
                  <Text type="secondary" style={{ padding: '0 0 8px 12px' }}>
                    未解析到 Network Info 表格，可能 bgp.he.net 页面结构已变更。请用「在 HE 打开」查看原页。
                  </Text>
                );
              }
              return (
                <div style={{ padding: '0 0 12px 12px' }}>
                  <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                    {r.announcedBy.length > 0 && (
                      <div>
                        <Text strong>Announced by</Text>
                        <Table
                          size="small"
                          pagination={false}
                          rowKey={(_, i) => `a-${i}`}
                          dataSource={r.announcedBy}
                          columns={announcedCols}
                        />
                      </div>
                    )}
                    {r.delegations.length > 0 && (
                      <div>
                        <Text strong>Matching delegations</Text>
                        <Table
                          size="small"
                          pagination={false}
                          rowKey={(_, i) => `d-${i}`}
                          dataSource={r.delegations}
                          columns={deleCols}
                        />
                      </div>
                    )}
                    {r.bogonLine && (
                      <Alert type="warning" message={r.bogonLine} showIcon />
                    )}
                    {r.countSource === 'bgpview' && r.bgpviewAsns && r.bgpviewAsns.length > 0 && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        BGPView 宣告方（节选）：{r.bgpviewAsns.slice(0, 8).map((x) => `AS${x.asn}`).join('、')}
                        {r.bgpviewAsns.length > 8 ? '…' : ''}
                      </Text>
                    )}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      层数依据：Visibility 行={r.heVisibilityTableRows}，Announced by 表行=
                      {r.announcedTableRows}，BGPView 宣告源ASN(去重)={r.bgpUniqAsnCount}。
                      {r.countSource === 'delegation_parent' &&
                        ' 已按 Matching delegations 中「父级前缀」判定存在更广分配块 → 2 层。'}
                      {r.countSource === 'delegation_no_parent' &&
                        ' 已按「父级前缀」列解析：无严格父块 → 1 层。'}
                      {r.countSource === 'he_visibility' && ' 已采用 Visibility 实测。'}
                      {r.countSource !== 'delegation_parent' &&
                        r.countSource !== 'delegation_no_parent' &&
                        r.countSource !== 'he_visibility' &&
                        r.countSource !== 'none' &&
                        ' 静态页/BGPView 取下标为最大值以对应「单层/多层」路由视图。'}
                    </Text>
                  </Space>
                </div>
              );
            },
          }}
        />
      )}
    </Card>
    </div>
  );
};

export default BgpHeDetectionPanel;
