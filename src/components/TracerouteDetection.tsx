import React, { useState } from 'react';
import {
  Card, Input, Button, Space, Typography, Table, Tag, Collapse, Alert, message,
} from 'antd';
import {
  PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, NodeIndexOutlined,
} from '@ant-design/icons';
import { deriveGatewayIPv4 } from './GatewayPingDetection';

const { Text } = Typography;
const { TextArea } = Input;

interface TracerouteHop {
  hop: number;
  ip: string;
  rtt1: string;
  rtt2: string;
  rtt3: string;
}

interface TracerouteResult {
  raw: string;            // 原始 CIDR 输入
  targetIp: string;       // 转换后的目标 IP
  status: 'pending' | 'running' | 'done' | 'error';
  hops: TracerouteHop[];
  rawOutput: string;
  error?: string;
  partial?: boolean;
}

interface Props {
  embedded?: boolean;
}

/** 解析多行/逗号/空格分隔的 CIDR 输入，返回去重的 { raw, targetIp } 列表 */
function parseInputs(text: string): Array<{ raw: string; targetIp: string }> {
  const tokens = text.split(/[\n\r,，\s]+/).map(s => s.trim()).filter(Boolean);
  const out: Array<{ raw: string; targetIp: string }> = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const ip = deriveGatewayIPv4(raw);
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    out.push({ raw, targetIp: ip });
  }
  return out;
}

const hopColumns = [
  {
    title: '跳数', dataIndex: 'hop', key: 'hop', width: 65,
    render: (v: number) => <Text strong>{v}</Text>,
  },
  {
    title: 'IP 地址', dataIndex: 'ip', key: 'ip', width: 180,
    render: (v: string) => v === '*' ? <Text type="secondary">*</Text> : <Text code>{v}</Text>,
  },
  { title: 'RTT1', dataIndex: 'rtt1', key: 'rtt1', width: 100 },
  { title: 'RTT2', dataIndex: 'rtt2', key: 'rtt2', width: 100 },
  { title: 'RTT3', dataIndex: 'rtt3', key: 'rtt3', width: 100 },
];

const TracerouteDetection: React.FC<Props> = () => {
  const [inputText, setInputText] = useState('');
  const [results, setResults] = useState<TracerouteResult[]>([]);
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    const targets = parseInputs(inputText);
    if (targets.length === 0) {
      message.warning('请输入至少一个有效的 IP 段');
      return;
    }

    const initResults: TracerouteResult[] = targets.map(t => ({
      raw: t.raw,
      targetIp: t.targetIp,
      status: 'pending',
      hops: [],
      rawOutput: '',
    }));
    setResults(initResults);
    setRunning(true);

    // 逐个执行 traceroute（避免服务器同时开太多进程）
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      setResults(prev => prev.map((r, idx) =>
        idx === i ? { ...r, status: 'running' } : r
      ));

      try {
        const res = await fetch(`/api/traceroute/run?ip=${encodeURIComponent(target.targetIp)}`);
        const data = await res.json();
        if (data.success) {
          setResults(prev => prev.map((r, idx) =>
            idx === i ? {
              ...r,
              status: 'done',
              hops: data.hops || [],
              rawOutput: data.raw || '',
              partial: data.partial,
            } : r
          ));
        } else {
          setResults(prev => prev.map((r, idx) =>
            idx === i ? { ...r, status: 'error', error: data.message } : r
          ));
        }
      } catch (e: any) {
        setResults(prev => prev.map((r, idx) =>
          idx === i ? { ...r, status: 'error', error: e.message } : r
        ));
      }
    }

    setRunning(false);
  };

  const statusTag = (r: TracerouteResult) => {
    switch (r.status) {
      case 'pending':
        return <Tag>等待中</Tag>;
      case 'running':
        return <Tag color="processing" icon={<LoadingOutlined />}>执行中</Tag>;
      case 'done':
        return <Tag color="success" icon={<CheckCircleOutlined />}>
          {r.partial ? '部分完成' : '完成'} ({r.hops.length} 跳)
        </Tag>;
      case 'error':
        return <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>;
    }
  };

  return (
    <Card style={{ borderRadius: 6 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <div>
          <Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
            IP 段（每行一个，或用空格/逗号分隔）
          </Text>
          <TextArea
            rows={5}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="78.105.149.0/24&#10;145.79.155.0/24&#10;89.207.177.0/24"
            style={{ borderRadius: 6 }}
          />
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            输入 IP 段后，系统会自动取首个可用主机地址（如 78.105.149.0/24 → 78.105.149.1）执行 traceroute
          </Text>
        </div>

        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          loading={running}
          onClick={handleRun}
          style={{ borderRadius: 6, height: 36, padding: '0 24px' }}
        >
          开始检测
        </Button>

        {results.length > 0 && (
          <div>
            <Alert
              type="info"
              showIcon
              message={
                <span>
                  共 {results.length} 个目标，
                  已完成 {results.filter(r => r.status === 'done').length}，
                  失败 {results.filter(r => r.status === 'error').length}
                </span>
              }
              style={{ marginBottom: 16 }}
            />

            <Collapse
              defaultActiveKey={results.map((_, i) => String(i))}
              items={results.map((r, i) => ({
                key: String(i),
                label: (
                  <Space>
                    <NodeIndexOutlined />
                    <Text code>{r.raw}</Text>
                    <Text type="secondary">→</Text>
                    <Text>traceroute {r.targetIp}</Text>
                    {statusTag(r)}
                  </Space>
                ),
                children: (
                  <div>
                    {r.status === 'error' && (
                      <Alert type="error" message={r.error || '执行失败'} style={{ marginBottom: 12 }} />
                    )}
                    {r.hops.length > 0 && (
                      <Table
                        dataSource={r.hops}
                        columns={hopColumns}
                        rowKey="hop"
                        size="small"
                        pagination={false}
                        bordered
                        style={{ marginBottom: 12 }}
                        rowClassName={(record) => record.ip === '*' ? 'traceroute-timeout-row' : ''}
                      />
                    )}
                    {r.rawOutput && (
                      <Collapse
                        size="small"
                        items={[{
                          key: 'raw',
                          label: <Text type="secondary" style={{ fontSize: 12 }}>原始输出</Text>,
                          children: (
                            <pre style={{
                              background: '#1a1a2e',
                              color: '#a8d8ea',
                              padding: 12,
                              borderRadius: 6,
                              fontSize: 12,
                              fontFamily: 'monospace',
                              maxHeight: 300,
                              overflow: 'auto',
                              whiteSpace: 'pre-wrap',
                              margin: 0,
                            }}>
                              {r.rawOutput}
                            </pre>
                          ),
                        }]}
                      />
                    )}
                    {r.status === 'running' && (
                      <div style={{ textAlign: 'center', padding: 24 }}>
                        <LoadingOutlined style={{ fontSize: 24, color: '#1677ff' }} />
                        <div style={{ marginTop: 8 }}>
                          <Text type="secondary">正在执行 traceroute，请稍候...</Text>
                        </div>
                      </div>
                    )}
                  </div>
                ),
              }))}
            />
          </div>
        )}
      </Space>
    </Card>
  );
};

export default TracerouteDetection;
