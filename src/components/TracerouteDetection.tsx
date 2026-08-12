import React, { useState, useEffect, useCallback } from 'react';
import {
  Card, Input, Button, Space, Typography, Table, Tag, Collapse, Alert, message,
  Select, Modal, Form, InputNumber, Popconfirm,
} from 'antd';
import {
  PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, NodeIndexOutlined, SettingOutlined,
  PlusOutlined, DeleteOutlined, EditOutlined,
  CloudServerOutlined, DesktopOutlined,
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
  raw: string;
  targetIp: string;
  status: 'pending' | 'running' | 'done' | 'error';
  hops: TracerouteHop[];
  rawOutput: string;
  error?: string;
  partial?: boolean;
  reachable?: boolean;
  serverName?: string;
}

interface SshServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

interface Props {
  embedded?: boolean;
}

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

  // 服务器选择
  const [servers, setServers] = useState<SshServer[]>([]);
  const [selectedServer, setSelectedServer] = useState('local');

  // 服务器管理弹窗
  const [serverModalVisible, setServerModalVisible] = useState(false);
  const [editingServer, setEditingServer] = useState<SshServer | null>(null);
  const [serverForm] = Form.useForm();
  const [savingServer, setSavingServer] = useState(false);

  // 服务器验证
  const [testingServer, setTestingServer] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; output?: string; message?: string; serverName?: string } | null>(null);

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
        message.success(editingServer ? '服务器已更新' : '服务器已添加');
        setEditingServer(null);
        serverForm.resetFields();
        loadServers();
      } else {
        message.error(data.message || '保存失败');
      }
    } catch (e: any) {
      if (e?.errorFields) return; // form validation
      message.error(e.message);
    } finally {
      setSavingServer(false);
    }
  };

  const handleDeleteServer = async (id: string) => {
    try {
      const res = await fetch(`/api/ssh-servers?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        message.success('已删除');
        if (selectedServer === id) setSelectedServer('local');
        loadServers();
      }
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const handleTestServer = async () => {
    if (selectedServer === 'local') {
      message.info('本机无需验证');
      return;
    }
    setTestingServer(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/ssh-servers/test?id=${encodeURIComponent(selectedServer)}`);
      const data = await res.json();
      setTestResult(data);
      if (data.success) {
        message.success('验证成功');
      } else {
        message.error(data.message || '验证失败');
      }
    } catch (e: any) {
      setTestResult({ success: false, message: e.message });
      message.error(e.message);
    } finally {
      setTestingServer(false);
    }
  };

  const handleRun = async () => {
    const targets = parseInputs(inputText);
    if (targets.length === 0) {
      message.warning('请输入至少一个有效的 IP 段');
      return;
    }

    const serverParam = selectedServer !== 'local' ? `&server=${encodeURIComponent(selectedServer)}` : '';
    const serverLabel = selectedServer !== 'local'
      ? servers.find(s => s.id === selectedServer)?.name || selectedServer
      : '';

    const initResults: TracerouteResult[] = targets.map(t => ({
      raw: t.raw,
      targetIp: t.targetIp,
      status: 'pending',
      hops: [],
      rawOutput: '',
      serverName: serverLabel,
    }));
    setResults(initResults);
    setRunning(true);

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      setResults(prev => prev.map((r, idx) =>
        idx === i ? { ...r, status: 'running' } : r
      ));

      try {
        const res = await fetch(`/api/traceroute/run?ip=${encodeURIComponent(target.targetIp)}${serverParam}`);
        const data = await res.json();
        if (data.success) {
          setResults(prev => prev.map((r, idx) =>
            idx === i ? {
              ...r,
              status: 'done',
              hops: data.hops || [],
              rawOutput: data.raw || '',
              partial: data.partial,
              reachable: data.reachable,
              serverName: data.serverName || serverLabel,
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
        return <>
          <Tag color="success" icon={<CheckCircleOutlined />}>
            {r.partial ? '部分完成' : '完成'} ({r.hops.length} 跳)
          </Tag>
          {r.reachable != null && (
            <Tag color={r.reachable ? 'green' : 'red'} style={{ fontWeight: 600 }}>
              {r.reachable ? '通' : '不通'}
            </Tag>
          )}
        </>;
      case 'error':
        return <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>;
    }
  };

  const doneResults = results.filter(r => r.status === 'done');
  const reachableCount = doneResults.filter(r => r.reachable === true).length;
  const unreachableCount = doneResults.filter(r => r.reachable === false).length;

  return (
    <Card style={{ borderRadius: 6 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Alert
          type="info"
          showIcon
          message="使用说明"
          description={
            <div style={{ fontSize: 13 }}>
              <div style={{ marginBottom: 6 }}>
                <Text strong>1、</Text>
                <Text code>curl cip.cc</Text>
                <Text type="secondary" style={{ marginLeft: 8 }}>查看是否是当地网络 / 有无开启VPN / 是否存在网络故障</Text>
              </div>
              <div>
                <Text strong>2、</Text>
                <Text code>traceroute x.x.x.1</Text>
                <Text type="secondary" style={{ marginLeft: 8 }}>查看最后一跳是否是公网IP</Text>
              </div>
            </div>
          }
          style={{ borderRadius: 6 }}
        />
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

        {/* 服务器选择 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Text strong style={{ fontSize: 13 }}>执行服务器：</Text>
          <Select
            value={selectedServer}
            onChange={v => { setSelectedServer(v); setTestResult(null); }}
            style={{ minWidth: 200 }}
          >
            <Select.Option value="local">
              <Space><DesktopOutlined /> 本机</Space>
            </Select.Option>
            {servers.map(s => (
              <Select.Option key={s.id} value={s.id}>
                <Space><CloudServerOutlined /> {s.name} <Text type="secondary" style={{ fontSize: 11 }}>({s.host})</Text></Space>
              </Select.Option>
            ))}
          </Select>
          <Button
            icon={<SettingOutlined />}
            size="small"
            onClick={() => { setServerModalVisible(true); setEditingServer(null); serverForm.resetFields(); }}
          >
            管理服务器
          </Button>
          {selectedServer !== 'local' && (
            <Button
              size="small"
              loading={testingServer}
              onClick={handleTestServer}
              icon={<CheckCircleOutlined />}
            >
              验证连接
            </Button>
          )}
          {selectedServer !== 'local' && !testResult && (
            <Tag color="blue" icon={<CloudServerOutlined />}>
              将通过 SSH 在远程服务器执行 traceroute
            </Tag>
          )}
        </div>

        {/* 服务器验证结果 */}
        {testResult && (
          <Alert
            type={testResult.success ? 'success' : 'error'}
            showIcon
            closable
            onClose={() => setTestResult(null)}
            message={testResult.success
              ? `${testResult.serverName || '远程服务器'} 连接正常`
              : `${testResult.serverName || '远程服务器'} 连接失败: ${testResult.message}`
            }
            description={testResult.success && testResult.output ? (
              <pre style={{
                background: '#f6f8fa',
                padding: 10,
                borderRadius: 6,
                fontSize: 12,
                fontFamily: 'monospace',
                margin: '8px 0 0',
                whiteSpace: 'pre-wrap',
              }}>
                {testResult.output}
              </pre>
            ) : undefined}
            style={{ borderRadius: 6 }}
          />
        )}

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
                  共 {results.length} 个目标
                  {results[0]?.serverName ? ` · 服务器: ${results[0].serverName}` : ' · 本机'}
                  ，已完成 {doneResults.length}
                  {reachableCount > 0 && <Tag color="green" style={{ marginLeft: 8 }}>通 {reachableCount}</Tag>}
                  {unreachableCount > 0 && <Tag color="red" style={{ marginLeft: 4 }}>不通 {unreachableCount}</Tag>}
                  {results.filter(r => r.status === 'error').length > 0 &&
                    `，失败 ${results.filter(r => r.status === 'error').length}`}
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
                    {r.serverName && <Tag color="blue" style={{ fontSize: 11 }}>{r.serverName}</Tag>}
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

      {/* 服务器管理弹窗 */}
      <Modal
        title="管理远程服务器"
        open={serverModalVisible}
        onCancel={() => { setServerModalVisible(false); setEditingServer(null); serverForm.resetFields(); }}
        footer={null}
        width={600}
      >
        {/* 已有服务器列表 */}
        {servers.length > 0 && (
          <Table
            dataSource={servers}
            rowKey="id"
            size="small"
            pagination={false}
            style={{ marginBottom: 16 }}
            columns={[
              { title: '名称', dataIndex: 'name', key: 'name', width: 120 },
              {
                title: '地址', key: 'addr', width: 180,
                render: (_: any, r: SshServer) => <Text code>{r.host}:{r.port}</Text>,
              },
              { title: '用户名', dataIndex: 'username', key: 'username', width: 100 },
              {
                title: '操作', key: 'actions', width: 100,
                render: (_: any, r: SshServer) => (
                  <Space size={4}>
                    <Button
                      size="small" type="text" icon={<EditOutlined />}
                      onClick={() => {
                        setEditingServer(r);
                        serverForm.setFieldsValue({ name: r.name, host: r.host, port: r.port, username: r.username, password: '' });
                      }}
                    />
                    <Popconfirm title="确定删除此服务器?" onConfirm={() => handleDeleteServer(r.id)} okText="删除" cancelText="取消">
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}

        {/* 添加/编辑表单 */}
        <Card size="small" title={editingServer ? `编辑: ${editingServer.name}` : '添加服务器'} style={{ borderRadius: 6 }}>
          <Form form={serverForm} layout="vertical" size="small">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                <Input placeholder="如：土库曼服务器" />
              </Form.Item>
              <Form.Item name="host" label="地址 (IP)" rules={[{ required: true, message: '请输入地址' }]}>
                <Input placeholder="如：1.2.3.4" />
              </Form.Item>
              <Form.Item name="port" label="端口" initialValue={22}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input placeholder="如：root" />
              </Form.Item>
            </div>
            <Form.Item
              name="password"
              label="密码"
              rules={editingServer ? [] : [{ required: true, message: '请输入密码' }]}
            >
              <Input.Password placeholder={editingServer ? '留空则保留原密码' : '输入SSH密码'} />
            </Form.Item>
            <Button
              type="primary"
              icon={editingServer ? <EditOutlined /> : <PlusOutlined />}
              loading={savingServer}
              onClick={handleSaveServer}
            >
              {editingServer ? '保存修改' : '添加服务器'}
            </Button>
            {editingServer && (
              <Button style={{ marginLeft: 8 }} onClick={() => { setEditingServer(null); serverForm.resetFields(); }}>
                取消编辑
              </Button>
            )}
          </Form>
        </Card>
      </Modal>
    </Card>
  );
};

export default TracerouteDetection;
