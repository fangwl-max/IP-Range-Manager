import React, { useState, useCallback } from 'react';
import { Card, Input, Button, Table, Space, Alert, Typography, message, Tag, Spin, InputNumber } from 'antd';
import { LinkOutlined, GlobalOutlined, SearchOutlined } from '@ant-design/icons';
import { forEachConcurrent, DETECTION_MAX_CONCURRENCY } from '../utils/asyncConcurrent';

const { Text, Link: TextLink } = Typography;
const { TextArea } = Input;

/** https://cheburcheck.ru/check?target=... 中的 IPv4 前缀，含掩码 */
export const CHEBURCHECK_CHECK_BASE = 'https://cheburcheck.ru/check';

function normalizeToIpv4Cidr(token: string): string | null {
  const t = token.trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const a = +m[1];
  const b = +m[2];
  const c = +m[3];
  const d = +m[4];
  const p = m[5] !== undefined ? +m[5] : 32;
  if ([a, b, c, d, p].some((x) => isNaN(x) || x < 0)) return null;
  if (a > 255 || b > 255 || c > 255 || d > 255 || p > 32) return null;
  return `${a}.${b}.${c}.${d}/${p}`;
}

function parseCidrList(text: string): string[] {
  const tokens = text.split(/[\n\r,，\s;；]+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const cidr = normalizeToIpv4Cidr(t);
    if (!cidr || seen.has(cidr)) continue;
    seen.add(cidr);
    out.push(cidr);
  }
  return out;
}

export function buildCheburcheckCheckUrl(ipv4Cidr: string): string {
  return `${CHEBURCHECK_CHECK_BASE}?target=${encodeURIComponent(ipv4Cidr)}`;
}

/** 列表项：与 /api/cheburcheck/lookup 响应对齐 */
export interface CheburcheckRow {
  key: string;
  cidr: string;
  url: string;
  loading?: boolean;
  success?: boolean;
  fetchError?: string;
  parseMessage?: string;
  available?: boolean;
  statusTitle?: string;
  subheading?: string;
  cdn?: string;
  rkn?: string;
}

function mapListValue(ru: string | undefined): string {
  if (!ru) return '—';
  if (ru === 'Не найден') return '未发现';
  return ru;
}

function formatSummary(row: CheburcheckRow): string {
  if (row.loading) return '…';
  if (row.fetchError) return row.fetchError;
  if (row.parseMessage) return row.parseMessage;
  const parts: string[] = [];
  if (row.subheading) {
    parts.push(
      row.subheading === 'Ограничений не обнаружено' ? '未发现限制' : row.subheading,
    );
  } else if (row.statusTitle) {
    parts.push(row.statusTitle);
  }
  return parts.length ? parts.join(' · ') : '—';
}

async function lookupCheburcheck(cidr: string): Promise<{
  success: boolean;
  message?: string;
  available?: boolean;
  statusTitle?: string;
  subheading?: string;
  cdn?: string;
  rkn?: string;
}> {
  const q = `/api/cheburcheck/lookup?target=${encodeURIComponent(cidr)}`;
  let res: Response;
  let data: {
    success?: boolean;
    message?: string;
    available?: boolean;
    statusTitle?: string;
    subheading?: string;
    cdn?: string;
    rkn?: string;
  };
  try {
    res = await fetch(q);
    data = (await res.json()) as typeof data;
  } catch (e: any) {
    return { success: false, message: e?.message || '网络错误' };
  }
  if (!res.ok) {
    return { success: false, message: data.message || `HTTP ${res.status}` };
  }
  if (!data.success) {
    return { success: false, message: data.message || '检测失败' };
  }
  return {
    success: true,
    available: data.available,
    statusTitle: data.statusTitle,
    subheading: data.subheading,
    cdn: data.cdn,
    rkn: data.rkn,
  };
}

function isLikelyTimeout(msg: string | undefined): boolean {
  if (!msg) return false;
  const t = msg.toLowerCase();
  return /timeout|超时|time.?out|timed out/i.test(t);
}

/** 超时时自动再请求一次 */
async function lookupCheburcheckWithTimeoutRetry(
  cidr: string,
): Promise<{
  success: boolean;
  message?: string;
  available?: boolean;
  statusTitle?: string;
  subheading?: string;
  cdn?: string;
  rkn?: string;
}> {
  const first = await lookupCheburcheck(cidr);
  if (first.success) return first;
  if (isLikelyTimeout(first.message)) {
    return lookupCheburcheck(cidr);
  }
  return first;
}

export interface CheburcheckRussiaPanelProps {
  embedded?: boolean;
}

const CheburcheckRussiaPanel: React.FC<CheburcheckRussiaPanelProps> = ({ embedded = true }) => {
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<CheburcheckRow[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [concurrency, setConcurrency] = useState(6);

  const runDetection = useCallback(async () => {
    const list = parseCidrList(raw);
    if (list.length === 0) {
      message.warning('未解析到有效 IPv4 前缀。请输入 CIDR，如 82.153.54.0/24 或单 IP 自动按 /32。');
      return;
    }
    const result: CheburcheckRow[] = list.map((cidr) => ({
      key: cidr,
      cidr,
      url: buildCheburcheckCheckUrl(cidr),
      loading: true,
    }));
    setRows(result);
    setDetecting(true);

    const indices = list.map((_, i) => i);
    const failSuffix = '（二次检测仍失败）';

    const probeAt = async (i: number, isRetry: boolean) => {
      const cidr = list[i];
      const url = buildCheburcheckCheckUrl(cidr);
      try {
        const r = await lookupCheburcheckWithTimeoutRetry(cidr);
        if (r.success) {
          result[i] = {
            key: cidr,
            cidr,
            url,
            loading: false,
            success: true,
            available: r.available,
            statusTitle: r.statusTitle,
            subheading: r.subheading,
            cdn: r.cdn,
            rkn: r.rkn,
          };
        } else {
          const err = (r.message as string | undefined)?.trim() ? String(r.message) : '失败';
          result[i] = {
            key: cidr,
            cidr,
            url,
            loading: false,
            success: false,
            fetchError: isRetry ? `${err}${failSuffix}` : err,
          };
        }
      } catch (e: any) {
        const base =
          e?.message || '请求失败（请使用本机 npm run dev / preview 并确保可访问 cheburcheck.ru）';
        result[i] = {
          key: cidr,
          cidr,
          url,
          loading: false,
          success: false,
          fetchError: isRetry ? `${base}${failSuffix}` : base,
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
        const cidr = list[i];
        result[i] = {
          key: cidr,
          cidr,
          url: buildCheburcheckCheckUrl(cidr),
          loading: true,
        };
      }
      setRows([...result]);
      await forEachConcurrent(failedAfterFirst, concurrency, async (i) => {
        await probeAt(i, true);
      });
    }

    setDetecting(false);
    const ok = result.filter((x) => x.success).length;
    const retryOk = ok - okAfterFirst;
    message.success(
      retryOk > 0
        ? `检测完成：成功 ${ok} / ${list.length}（其中 ${retryOk} 条经二次检测成功）`
        : `检测完成：成功 ${ok} / ${list.length}`
    );
  }, [raw, concurrency]);

  const cardStyle: React.CSSProperties = embedded
    ? { borderRadius: 6 }
    : { borderRadius: 6, maxWidth: 1100, margin: '0 auto' };

  return (
    <Card style={cardStyle}>
      <Alert
        type="info"
        showIcon
        icon={<GlobalOutlined />}
        message="俄罗斯「Cheburcheck」检测（第三方）"
        description={
          <span>
            在 <Text strong>npm run dev</Text> / <Text strong>npm run preview</Text> 下由本机接口拉取{' '}
            <TextLink href={CHEBURCHECK_CHECK_BASE} target="_blank" rel="noopener noreferrer">
              cheburcheck.ru
            </TextLink>{' '}
            结果页并解析主状态（是否可访问）、CDN 与 РКН 列表信息。纯静态托管无中间件时无法代拉，请使用「在 Cheburcheck 打开」。
          </span>
        }
        style={{ marginBottom: 16 }}
      />
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
            IPv4 前缀（每行一个，支持逗号/空格分隔）
          </Text>
          <TextArea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            placeholder="82.153.54.0/24&#10;1.2.3.4/32"
            style={{ borderRadius: 6, fontFamily: 'monospace' }}
          />
        </div>
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
            onClick={() => void runDetection()}
            style={{ borderRadius: 6, height: 36, padding: '0 24px' }}
          >
            开始检测
          </Button>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          查询参数与官方一致，例如{' '}
          <Text code>{CHEBURCHECK_CHECK_BASE}?target=82.153.54.0%2F24</Text>
        </Text>
      </Space>

      {rows.length > 0 && (
        <Table<CheburcheckRow>
          style={{ marginTop: 20 }}
          size="small"
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: 1000 }}
          rowKey="key"
          dataSource={rows}
          columns={[
            {
              title: 'IPv4 前缀',
              dataIndex: 'cidr',
              key: 'cidr',
              width: 210,
              ellipsis: false,
              render: (c: string) => (
                <Text
                  code
                  style={{
                    whiteSpace: 'nowrap',
                    display: 'inline-block',
                    padding: '2px 6px',
                    margin: '-2px 0',
                  }}
                >
                  {c}
                </Text>
              ),
            },
            {
              title: '是否可用',
              key: 'avail',
              width: 100,
              align: 'center',
              render: (_: unknown, r: CheburcheckRow) => {
                if (r.loading) return <Spin size="small" />;
                if (r.fetchError) {
                  return (
                    <Tag color="warning" title={r.fetchError}>
                      失败
                    </Tag>
                  );
                }
                if (r.success) {
                  return r.available ? (
                    <Tag color="success">可用</Tag>
                  ) : (
                    <Tag color="error">不可用</Tag>
                  );
                }
                return <Tag>—</Tag>;
              },
            },
            {
              title: '摘要',
              key: 'sum',
              ellipsis: true,
              render: (_: unknown, r: CheburcheckRow) => {
                if (r.loading) return <Text type="secondary">拉取中…</Text>;
                return <Text style={{ fontSize: 12 }}>{formatSummary(r)}</Text>;
              },
            },
            {
              title: 'CDN',
              key: 'cdn',
              width: 88,
              render: (_: unknown, r: CheburcheckRow) => {
                if (r.loading) return '…';
                if (!r.success) return '—';
                return <Text style={{ fontSize: 12 }}>{mapListValue(r.cdn)}</Text>;
              },
            },
            {
              title: 'РКН',
              key: 'rkn',
              width: 88,
              render: (_: unknown, r: CheburcheckRow) => {
                if (r.loading) return '…';
                if (!r.success) return '—';
                return <Text style={{ fontSize: 12 }}>{mapListValue(r.rkn)}</Text>;
              },
            },
            {
              title: '操作',
              key: 'open',
              width: 140,
              render: (_: unknown, r: CheburcheckRow) => (
                <Button
                  type="link"
                  size="small"
                  icon={<LinkOutlined />}
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ padding: 0 }}
                >
                  在 Cheburcheck 打开
                </Button>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
};

export default CheburcheckRussiaPanel;
