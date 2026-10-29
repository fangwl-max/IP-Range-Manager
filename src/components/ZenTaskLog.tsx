import React, { useState, useEffect, useCallback } from 'react';
import { Table, Tag, Button, Space, Typography, Tooltip } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

const { Text } = Typography;

interface TaskLogEntry {
  id: string;
  startedAt: string;
  completedAt: string;
  action: string;
  username: string;
  dryRun: boolean;
  cidrs: string[];
  status: 'success' | 'partial' | 'error';
  errorMessage?: string;
  summary: { total: number; success: number; failed: number; skipped: number };
}

const ACTION_LABELS: Record<string, string> = {
  zec_announce: 'ZEC 宣告',
  vob_announce: 'VOB 宣告',
  eip_delete: 'EIP 删除',
  zec_cidr_delete: 'ZEC 取消宣告',
  byoip_withdraw: 'BYOIP 取消宣告',
  byoip_withdraw_by_id: 'BYOIP 按ID取消',
};

const ACTION_COLORS: Record<string, string> = {
  zec_announce: 'blue',
  vob_announce: 'cyan',
  eip_delete: 'volcano',
  zec_cidr_delete: 'orange',
  byoip_withdraw: 'orange',
  byoip_withdraw_by_id: 'orange',
};

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  success: { color: 'success', label: '成功' },
  partial: { color: 'warning', label: '部分失败' },
  error: { color: 'error', label: '失败' },
};

const ZenTaskLog: React.FC = () => {
  const [logs, setLogs] = useState<TaskLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/zen/task-log?limit=200');
      const data = await res.json();
      if (data.ok) setLogs(data.logs || []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const columns = [
    {
      title: '时间',
      dataIndex: 'startedAt',
      key: 'time',
      width: 160,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
      sorter: (a: TaskLogEntry, b: TaskLogEntry) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      defaultSortOrder: 'descend' as const,
    },
    {
      title: '操作者',
      dataIndex: 'username',
      key: 'username',
      width: 100,
    },
    {
      title: '类型',
      dataIndex: 'action',
      key: 'action',
      width: 140,
      filters: Object.entries(ACTION_LABELS).map(([k, v]) => ({ text: v, value: k })),
      onFilter: (value: any, r: TaskLogEntry) => r.action === String(value),
      render: (v: string, r: TaskLogEntry) => (
        <Space size={4}>
          <Tag color={ACTION_COLORS[v] || 'default'}>{ACTION_LABELS[v] || v}</Tag>
          {r.dryRun && <Tag>演练</Tag>}
        </Space>
      ),
    },
    {
      title: 'IP 段',
      dataIndex: 'cidrs',
      key: 'cidrs',
      ellipsis: true,
      render: (cidrs: string[]) => {
        if (!cidrs?.length) return '-';
        const display = cidrs.slice(0, 3).join(', ');
        const more = cidrs.length > 3 ? ` +${cidrs.length - 3}` : '';
        return (
          <Tooltip title={cidrs.join('\n')} overlayStyle={{ whiteSpace: 'pre-wrap', maxWidth: 400 }}>
            <Text style={{ fontFamily: 'monospace', fontSize: 12 }}>{display}{more}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      filters: Object.entries(STATUS_TAG).map(([k, v]) => ({ text: v.label, value: k })),
      onFilter: (value: any, r: TaskLogEntry) => r.status === String(value),
      render: (v: string, r: TaskLogEntry) => {
        const st = STATUS_TAG[v] || { color: 'default', label: v };
        return (
          <Tooltip title={r.errorMessage}>
            <Tag color={st.color}>{st.label}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '结果',
      key: 'summary',
      width: 180,
      render: (_: any, r: TaskLogEntry) => {
        const s = r.summary;
        if (!s) return '-';
        const parts: string[] = [];
        if (s.success > 0) parts.push(`成功 ${s.success}`);
        if (s.failed > 0) parts.push(`失败 ${s.failed}`);
        if (s.skipped > 0) parts.push(`跳过 ${s.skipped}`);
        return <Text style={{ fontSize: 12 }}>{parts.join(' / ') || `共 ${s.total}`}</Text>;
      },
    },
    {
      title: '耗时',
      key: 'duration',
      width: 80,
      render: (_: any, r: TaskLogEntry) => {
        if (!r.startedAt || !r.completedAt) return '-';
        const ms = new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
      },
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text type="secondary">记录所有 ZEN 宣告和取消宣告任务的执行结果</Text>
        <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>刷新</Button>
      </div>
      <Table
        dataSource={logs}
        columns={columns}
        rowKey="id"
        size="small"
        loading={loading}
        pagination={{ pageSize: 50, showSizeChanger: true, showTotal: t => `共 ${t} 条` }}
      />
    </div>
  );
};

export default ZenTaskLog;
