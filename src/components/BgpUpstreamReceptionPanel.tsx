import React, { useState, useCallback } from 'react';
import { Card, Input, Button, Table, Alert, Typography, Tag, Space, message } from 'antd';
import { LinkOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';

const { Text } = Typography;

export interface Tier1ReceptionResultRow {
  input?: string;
  prefix?: string;
  success: boolean;
  error?: string;
  originAsn?: string;
  pathObservationCount?: number;
  tier1Count?: number;
  tier1Details?: Array<{ asn: string; name: string }>;
  receptionLikelyOk?: boolean;
  bgpToolsConnectivityUrl?: string;
}

interface BgpUpstreamReceptionPanelProps {
  /** 嵌入「综合检测」页时传 true，与网关 Ping 等子页一致 */
  embedded?: boolean;
}

const BgpUpstreamReceptionPanel: React.FC<BgpUpstreamReceptionPanelProps> = ({ embedded: _embedded }) => {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Tier1ReceptionResultRow[]>([]);

  const run = useCallback(async () => {
    const prefixes = text
      .split(/[\n\r,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (prefixes.length === 0) {
      message.warning('请输入至少一个 IPv4 前缀（如 74.1.46.0/24）');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch('/api/bgp/tier1-reception', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        message.error(data.message || '请求失败');
        setRows([]);
        return;
      }
      setRows((data.results || []) as Tier1ReceptionResultRow[]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '网络错误';
      message.error(msg);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [text]);

  const columns: ColumnsType<Tier1ReceptionResultRow> = [
    {
      title: '前缀',
      key: 'prefix',
      width: 160,
      render: (_, r) => {
        if (!r.success) return <Text type="danger">{r.input?.trim() || '—'}</Text>;
        return <Text code>{r.prefix}</Text>;
      },
    },
    {
      title: '起源 ASN',
      dataIndex: 'originAsn',
      width: 100,
      render: (v: string | undefined, r) => {
        if (!r.success) return '—';
        return v || '—';
      },
    },
    {
      title: '路径观测数',
      dataIndex: 'pathObservationCount',
      width: 100,
      render: (n: number | undefined, r) => (r.success ? (n ?? '—') : '—'),
    },
    {
      title: 'Tier 1 数量',
      key: 'tier1Count',
      width: 100,
      render: (_, r) => {
        if (!r.success) return '—';
        return r.tier1Count ?? 0;
      },
    },
    {
      title: '路径中的 Tier 1（抽样）',
      key: 'tier1Details',
      ellipsis: true,
      render: (_, r) => {
        if (!r.success) return <Text type="secondary">—</Text>;
        const list = r.tier1Details || [];
        if (list.length === 0) return <Text type="secondary">未发现预置列表中的 Tier1 ASN</Text>;
        return (
          <Space size={[4, 4]} wrap>
            {list.map((t) => (
              <Tag key={t.asn} color="blue">
                AS{t.asn} {t.name}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '接收判断',
      key: 'receptionLikelyOk',
      width: 120,
      render: (_, r) => {
        if (!r.success) {
          return (
            <Tag icon={<CloseCircleOutlined />} color="error">
              {r.error || '失败'}
            </Tag>
          );
        }
        const ok = !!r.receptionLikelyOk;
        return ok ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            较好（≥2 个 Tier1）
          </Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />} color="warning">
            未达阈值（需 ≥2）
          </Tag>
        );
      },
    },
    {
      title: '对照',
      key: 'link',
      width: 100,
      render: (_, r) => {
        const u = r.bgpToolsConnectivityUrl;
        if (!u) return '—';
        return (
          <a href={u} target="_blank" rel="noopener noreferrer">
            <LinkOutlined /> bgp.tools
          </a>
        );
      },
    },
  ];

  return (
    <Card style={{ borderRadius: 6 }}>
      <Alert
        message="供应商 / 上游接收（Tier 1 启发式）"
        description={
          <span>
            本页通过 RIPE Stat{' '}
            <Text code>looking-glass</Text> 收集各采集点宣告的 <Text code>as_path</Text>，统计路径中出现的常见
            Tier 1 ASN 种类数。<Text strong>当同一路径样本中至少出现 2 个不同 Tier 1 ASN 时</Text>，视为与 bgp.tools Connectivity
            页中「沿上游进入多条国际骨干」的现象接近，可辅助判断该前缀已被上游较好接收。
            <br />
            <Text type="secondary">
              bgp.tools 页面有反爬与 X-Frame 限制，无法在站内嵌入；右侧链接仅供人工对照同一前缀的 Connectivity 图。
            </Text>
          </span>
        }
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Input.TextArea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="每行一个 IPv4 前缀，或用空格/逗号分隔，例如：&#10;74.1.46.0/24&#10;185.223.155.0/24"
          style={{ borderRadius: 6 }}
        />
        <Button type="primary" onClick={run} loading={loading} style={{ borderRadius: 6, height: 36 }}>
          开始检测
        </Button>
        <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
          单次最多 30 个前缀；阈值可在服务端常量中调整（当前为路径中 ≥2 个预置 Tier1 ASN）。
        </Text>
      </Space>

      {rows.length > 0 ? (
        <Table<Tier1ReceptionResultRow>
          style={{ marginTop: 16 }}
          rowKey={(r, i) => `${r.prefix || r.input || 'row'}-${i}`}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 10, showSizeChanger: true }}
          scroll={{ x: 980 }}
          size="small"
        />
      ) : null}
    </Card>
  );
};

export default BgpUpstreamReceptionPanel;
