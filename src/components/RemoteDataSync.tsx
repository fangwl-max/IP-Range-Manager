import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Select, Input, Checkbox, Button, Alert, Descriptions,
  Space, Typography, Divider, message as antMessage, Form,
  InputNumber, Table, Popconfirm, Tag, Result,
} from 'antd';
import { useAuth } from '../contexts/AuthContext';
import { LockOutlined } from '@ant-design/icons';
import {
  CloudDownloadOutlined, EyeOutlined, CheckCircleOutlined,
  WarningOutlined, PlusOutlined, EditOutlined, DeleteOutlined,
  ApiOutlined,
} from '@ant-design/icons';

const { Text, Title } = Typography;

interface SshServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface FileSyncResult {
  success: boolean;
  message?: string;
  size?: number;
  dryRun?: boolean;
  written?: boolean;
  segments?: number;
  asns?: number;
  suppliers?: number;
  projectGroups?: number;
  cachedAt?: string;
  count?: number;
  userCount?: number;
  groupACount?: number;
  groupBCount?: number;
  upcomingCount?: number;
  backupPath?: string;
}

interface SyncResponse {
  success: boolean;
  message?: string;
  server?: string;
  dryRun?: boolean;
  results?: Record<string, FileSyncResult>;
}

const FILE_OPTIONS = [
  { label: 'ip-data.json — IP段、ASN、供应商、项目组全量数据', value: 'ip-data.json' },
  { label: 'users.json — 用户账号与权限', value: 'users.json' },
  { label: 'notify-config.json — 通知配置（邮件）', value: 'notify-config.json' },
  { label: 'ipxo-config.json — IPXO API 配置', value: 'ipxo-config.json' },
  { label: 'asn-standby-groups.json — ASN 备用分组数据', value: 'asn-standby-groups.json' },
  { label: 'ipxo-upcoming-status.json — IPXO 续租状态', value: 'ipxo-upcoming-status.json' },
  { label: 'ipxo-cache.json — IPXO API 缓存', value: 'ipxo-cache.json' },
];

const formatSize = (bytes: number) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const RemoteDataSync: React.FC = () => {
  const { hasPermission } = useAuth();

  // ── SSH 服务器管理 ──────────────────────────────────────
  const [servers, setServers] = useState<SshServer[]>([]);
  const [showServerForm, setShowServerForm] = useState(false);
  const [editingServer, setEditingServer] = useState<SshServer | null>(null);
  const [savingServer, setSavingServer] = useState(false);
  const [testingId, setTestingId] = useState<string>('');
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message?: string }>>({});
  const [serverForm] = Form.useForm();

  const loadServers = useCallback(async () => {
    try {
      const res = await fetch('/api/ssh-servers');
      const data = await res.json();
      if (data.success) setServers(data.servers || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);

  const handleSaveServer = async () => {
    try {
      const values = await serverForm.validateFields();
      setSavingServer(true);
      const body = {
        id: editingServer?.id || '',
        name: values.name,
        host: values.host,
        port: values.port || 22,
        username: values.username,
        password: values.password,
      };
      const res = await fetch('/api/ssh-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        antMessage.success(editingServer ? '服务器已更新' : '服务器已添加');
        setEditingServer(null);
        setShowServerForm(false);
        serverForm.resetFields();
        loadServers();
      } else {
        antMessage.error(data.message || '保存失败');
      }
    } catch (e: any) {
      if (e?.errorFields) return;
      antMessage.error(e.message);
    } finally {
      setSavingServer(false);
    }
  };

  const handleDeleteServer = async (id: string) => {
    try {
      const res = await fetch(`/api/ssh-servers?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        antMessage.success('已删除');
        if (serverId === id) setServerId('');
        loadServers();
      }
    } catch (e: any) {
      antMessage.error(e.message);
    }
  };

  const handleTestServer = async (id: string) => {
    setTestingId(id);
    setTestResults(prev => ({ ...prev, [id]: undefined as any }));
    try {
      const res = await fetch(`/api/ssh-servers/test?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      setTestResults(prev => ({ ...prev, [id]: data }));
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [id]: { success: false, message: e.message } }));
    } finally {
      setTestingId('');
    }
  };

  // ── 同步操作 ──────────────────────────────────────────
  const [serverId, setServerId] = useState<string>('');
  const [remotePath, setRemotePath] = useState('/app');
  const [selectedFiles, setSelectedFiles] = useState<string[]>(['ip-data.json']);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResponse | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const doSync = async (dryRun: boolean) => {
    if (!serverId) { antMessage.warning('请选择目标服务器'); return; }
    if (!remotePath.trim()) { antMessage.warning('请填写远程项目路径'); return; }
    if (selectedFiles.length === 0) { antMessage.warning('请至少选择一个同步文件'); return; }

    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const resp = await fetch('/api/remote-sync/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, remotePath: remotePath.trim(), files: selectedFiles, dryRun }),
      });
      const data: SyncResponse = await resp.json();
      if (!data.success) {
        setSyncError(data.message || '同步失败');
      } else {
        setSyncResult(data);
        if (!dryRun) {
          const anyWritten = Object.values(data.results || {}).some(r => r.success && r.written);
          if (anyWritten) antMessage.success('数据同步成功，原文件已备份');
        }
      }
    } catch (e: any) {
      setSyncError(e?.message || '请求失败');
    } finally {
      setSyncing(false);
    }
  };

  const selectedServerObj = servers.find(s => s.id === serverId);

  if (!hasPermission('remote-sync')) {
    return (
      <Result
        icon={<LockOutlined style={{ color: '#faad14' }} />}
        title="权限不足"
        subTitle="您没有访问远程数据同步的权限。"
      />
    );
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <Title level={4} style={{ marginBottom: 4 }}>远程数据同步</Title>
      <Text type="secondary">
        配置 SSH 服务器，从远端平台实例拉取 ip-data.json 等数据文件覆盖本地。写入前自动备份。
      </Text>

      {/* ── SSH 服务器管理 ── */}
      <Card
        style={{ marginTop: 20 }}
        title={<Space><ApiOutlined />SSH 服务器管理</Space>}
        extra={
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => { setEditingServer(null); serverForm.resetFields(); setShowServerForm(true); }}
          >
            添加服务器
          </Button>
        }
      >
        {/* 服务器列表 */}
        {servers.length > 0 && (
          <Table<SshServer>
            dataSource={servers}
            rowKey="id"
            size="small"
            pagination={false}
            style={{ marginBottom: editingServer !== undefined ? 16 : 0 }}
            columns={[
              { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
              {
                title: '地址', key: 'addr', width: 200,
                render: (_: any, r: SshServer) => <Text code>{r.host}:{r.port || 22}</Text>,
              },
              { title: '用户名', dataIndex: 'username', key: 'username', width: 110 },
              {
                title: '连通测试', key: 'test', width: 130,
                render: (_: any, r: SshServer) => {
                  const tr = testResults[r.id];
                  return (
                    <Space size={4}>
                      <Button
                        size="small"
                        loading={testingId === r.id}
                        onClick={() => handleTestServer(r.id)}
                      >
                        测试
                      </Button>
                      {tr && (
                        tr.success
                          ? <Tag color="success">通</Tag>
                          : <Tag color="error" title={tr.message}>失败</Tag>
                      )}
                    </Space>
                  );
                },
              },
              {
                title: '操作', key: 'actions', width: 90,
                render: (_: any, r: SshServer) => (
                  <Space size={4}>
                    <Button
                      size="small" type="text" icon={<EditOutlined />}
                      onClick={() => {
                        setEditingServer(r);
                        setShowServerForm(true);
                        serverForm.setFieldsValue({ name: r.name, host: r.host, port: r.port, username: r.username, password: '' });
                      }}
                    />
                    <Popconfirm
                      title="确定删除此服务器？"
                      onConfirm={() => handleDeleteServer(r.id)}
                      okText="删除" cancelText="取消"
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}

        {/* 添加 / 编辑表单 */}
        {showServerForm && (
          <>
            {servers.length > 0 && <Divider style={{ margin: '12px 0' }} />}
            <Card
              size="small"
              title={editingServer ? `编辑：${editingServer.name}` : '添加服务器'}
              style={{ background: '#fafafa' }}
            >
              <Form form={serverForm} layout="vertical" size="small">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                    <Input placeholder="如：生产服务器" />
                  </Form.Item>
                  <Form.Item name="host" label="IP 地址" rules={[{ required: true, message: '请输入地址' }]}>
                    <Input placeholder="如：1.2.3.4" style={{ fontFamily: 'monospace' }} />
                  </Form.Item>
                  <Form.Item name="port" label="SSH 端口" initialValue={22}>
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                    <Input placeholder="如：root / ubuntu" />
                  </Form.Item>
                </div>
                <Form.Item
                  name="password"
                  label="密码"
                  rules={editingServer ? [] : [{ required: true, message: '请输入密码' }]}
                >
                  <Input.Password placeholder={editingServer ? '留空则保留原密码' : 'SSH 登录密码'} />
                </Form.Item>
                <Space>
                  <Button
                    type="primary"
                    icon={editingServer ? <EditOutlined /> : <PlusOutlined />}
                    loading={savingServer}
                    onClick={handleSaveServer}
                  >
                    {editingServer ? '保存修改' : '添加服务器'}
                  </Button>
                  <Button onClick={() => { setEditingServer(null); setShowServerForm(false); serverForm.resetFields(); }}>
                    取消
                  </Button>
                </Space>
              </Form>
            </Card>
          </>
        )}

        {servers.length === 0 && !showServerForm && (
          <Text type="secondary">暂无服务器，点击右上角「添加服务器」开始配置。</Text>
        )}
      </Card>

      {/* ── 同步操作 ── */}
      <Card style={{ marginTop: 16 }} title="从远程服务器拉取数据">
        <Space direction="vertical" style={{ width: '100%' }} size={18}>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>目标服务器</div>
            <Select
              style={{ width: '100%' }}
              placeholder={servers.length === 0 ? '请先在上方添加 SSH 服务器' : '选择要从哪台服务器同步'}
              value={serverId || undefined}
              onChange={v => setServerId(v)}
              options={servers.map(s => ({
                value: s.id,
                label: `${s.name}（${s.username}@${s.host}:${s.port || 22}）`,
              }))}
              notFoundContent="暂无已配置服务器"
            />
          </div>

          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>远程项目根路径</div>
            <Input
              value={remotePath}
              onChange={e => setRemotePath(e.target.value)}
              placeholder="如：/app 或 /home/ubuntu/IP-Range-Manager"
              style={{ fontFamily: 'monospace' }}
            />
            {selectedServerObj && (
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                将读取 <Text code style={{ fontSize: 11 }}>{selectedServerObj.username}@{selectedServerObj.host}:{remotePath.replace(/\/+$/, '')}/ip-data.json</Text>
              </div>
            )}
          </div>

          <div>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>同步文件</div>
            <Checkbox.Group
              value={selectedFiles}
              onChange={vals => setSelectedFiles(vals as string[])}
              options={FILE_OPTIONS}
            />
          </div>

          <Space>
            <Button
              icon={<EyeOutlined />}
              onClick={() => doSync(true)}
              loading={syncing}
              disabled={!serverId}
            >
              预览（不写入）
            </Button>
            <Button
              type="primary"
              danger
              icon={<CloudDownloadOutlined />}
              onClick={() => doSync(false)}
              loading={syncing}
              disabled={!serverId}
            >
              立即同步（覆盖本地）
            </Button>
          </Space>
        </Space>
      </Card>

      {/* 错误 */}
      {syncError && (
        <Alert type="error" message="同步失败" description={syncError} style={{ marginTop: 16 }} showIcon />
      )}

      {/* 同步结果 */}
      {syncResult && (
        <Card
          style={{ marginTop: 16 }}
          title={
            <Space>
              <CheckCircleOutlined style={{ color: '#52c41a' }} />
              {syncResult.dryRun ? '预览结果（未写入）' : '同步完成'}
              <Text type="secondary" style={{ fontSize: 13 }}>来源：{syncResult.server}</Text>
            </Space>
          }
        >
          {Object.entries(syncResult.results || {}).map(([filename, info]) => (
            <div key={filename} style={{ marginBottom: 8 }}>
              <Divider orientation="left" plain style={{ fontSize: 13 }}>{filename}</Divider>
              {info.success ? (
                <Descriptions column={2} size="small" bordered>
                  {filename === 'ip-data.json' && (
                    <>
                      <Descriptions.Item label="IP 段数"><Text strong>{info.segments ?? '-'}</Text></Descriptions.Item>
                      <Descriptions.Item label="ASN 数"><Text strong>{info.asns ?? '-'}</Text></Descriptions.Item>
                      <Descriptions.Item label="供应商数">{info.suppliers ?? '-'}</Descriptions.Item>
                      <Descriptions.Item label="项目组数">{info.projectGroups ?? '-'}</Descriptions.Item>
                    </>
                  )}
                  {filename === 'ipxo-cache.json' && (
                    <>
                      <Descriptions.Item label="缓存服务数"><Text strong>{info.count ?? '-'}</Text></Descriptions.Item>
                      <Descriptions.Item label="缓存时间">{info.cachedAt ? new Date(info.cachedAt).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
                    </>
                  )}
                  {filename === 'users.json' && (
                    <Descriptions.Item label="用户数" span={2}><Text strong>{info.userCount ?? '-'}</Text></Descriptions.Item>
                  )}
                  {filename === 'asn-standby-groups.json' && (
                    <>
                      <Descriptions.Item label="A 组条目数"><Text strong>{info.groupACount ?? '-'}</Text></Descriptions.Item>
                      <Descriptions.Item label="B 组条目数"><Text strong>{info.groupBCount ?? '-'}</Text></Descriptions.Item>
                    </>
                  )}
                  {filename === 'ipxo-upcoming-status.json' && (
                    <Descriptions.Item label="续租记录数" span={2}><Text strong>{info.upcomingCount ?? '-'}</Text></Descriptions.Item>
                  )}
                  <Descriptions.Item label="文件大小">{formatSize(info.size ?? 0)}</Descriptions.Item>
                  <Descriptions.Item label="状态">
                    {info.written ? (
                      <>
                        <Text type="success">已写入本地</Text>
                        {info.backupPath && (
                          <div style={{ fontSize: 11, color: '#888', marginTop: 2, fontFamily: 'monospace' }}>
                            备份：{info.backupPath}
                          </div>
                        )}
                      </>
                    ) : (
                      <Text type="warning">预览模式，未写入</Text>
                    )}
                  </Descriptions.Item>
                </Descriptions>
              ) : (
                <Alert
                  type="error"
                  message={`${filename} 同步失败`}
                  description={info.message}
                  showIcon
                  icon={<WarningOutlined />}
                />
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
};

export default RemoteDataSync;
