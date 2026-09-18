import React, { useState, useEffect, useCallback } from 'react';
import { Card, Table, Tag, Button, Space, Typography, Select } from 'antd';
import { ReloadOutlined, FileTextOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';

const { Text } = Typography;

interface AuditEntry {
  timestamp: string;
  userId: string;
  username: string;
  role: string;
  action: string;
  resource: string;
  ip?: string;
  details?: Record<string, any>;
}

const ACTION_COLOR: Record<string, string> = {
  'auth.login': 'green',
  'auth.logout': 'default',
  'ip_segment.save': 'blue',
  'user.create': 'cyan',
  'user.update': 'geekblue',
  'user.delete': 'red',
  'user.set_permissions': 'purple',
  'announce.zen': 'orange',
  'announce.zen_byoip': 'orange',
  'withdraw.zen_byoip': 'volcano',
};

const ACTION_LABELS: Record<string, string> = {
  'auth.login': '登录',
  'auth.logout': '退出',
  'ip_segment.save': 'IP段保存',
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'user.set_permissions': '修改权限',
  'announce.zen': 'ZEN宣告',
  'announce.zen_byoip': 'ZEN BYOIP宣告',
  'withdraw.zen_byoip': 'ZEN BYOIP撤播',
};

const AuditLogs: React.FC = () => {
  const { token } = useAuth();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/audit-logs?limit=500', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs || []);
        setTotal(data.total || 0);
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const filtered = actionFilter ? logs.filter(l => l.action === actionFilter) : logs;
  const uniqueActions = [...new Set(logs.map(l => l.action))].sort();

  const columns = [
    {
      title: '时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 170,
      render: (t: string) => new Date(t).toLocaleString('zh-CN'),
    },
    {
      title: '操作人',
      key: 'user',
      width: 140,
      render: (_: unknown, r: AuditEntry) => (
        <div>
          <Text strong>{r.username}</Text>
          <br />
          <Tag color={r.role === 'admin' ? 'red' : r.role === 'editor' ? 'blue' : 'default'} style={{ fontSize: 11 }}>
            {r.role === 'admin' ? '管理员' : r.role === 'editor' ? '编辑' : '只读'}
          </Tag>
        </div>
      ),
    },
    {
      title: '操作类型',
      dataIndex: 'action',
      key: 'action',
      width: 140,
      render: (action: string) => (
        <Tag color={ACTION_COLOR[action] || 'default'}>
          {ACTION_LABELS[action] || action}
        </Tag>
      ),
    },
    {
      title: '对象',
      dataIndex: 'resource',
      key: 'resource',
      width: 180,
      render: (v: string) => <Text code style={{ fontSize: 12 }}>{v}</Text>,
    },
    {
      title: '详情',
      dataIndex: 'details',
      key: 'details',
      render: (d: Record<string, any> | undefined) =>
        d ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(' | ')}
          </Text>
        ) : '-',
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      key: 'ip',
      width: 130,
      render: (ip: string) => <Text type="secondary" style={{ fontSize: 12 }}>{ip || '-'}</Text>,
    },
  ];

  return (
    <Card
      title={<><FileTextOutlined style={{ marginRight: 8 }} />操作日志</>}
      extra={
        <Space>
          <Select
            allowClear
            placeholder="过滤操作类型"
            style={{ width: 160 }}
            value={actionFilter}
            onChange={setActionFilter}
            options={uniqueActions.map(a => ({ value: a, label: ACTION_LABELS[a] || a }))}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchLogs} loading={loading}>
            刷新
          </Button>
        </Space>
      }
    >
      <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
        共 {total} 条记录，显示最新 {filtered.length} 条
      </div>
      <Table
        dataSource={filtered}
        columns={columns}
        rowKey={(r, i) => `${r.timestamp}-${i}`}
        loading={loading}
        size="small"
        pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: ['50', '100', '200'] }}
        scroll={{ x: 900 }}
      />
    </Card>
  );
};

export default AuditLogs;
