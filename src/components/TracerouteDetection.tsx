import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card, Input, Button, Space, Typography, Tag, Collapse, Alert, message,
  Select, Modal, Form, InputNumber, Popconfirm, Checkbox, Table, Tooltip,
} from 'antd';
import { useAuth } from '../contexts/AuthContext';
import {
  PlayCircleOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, NodeIndexOutlined, SettingOutlined,
  PlusOutlined, DeleteOutlined, EditOutlined,
  CloudServerOutlined, DesktopOutlined, CopyOutlined, SyncOutlined,
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

const TracerouteDetection: React.FC<Props> = () => {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('irr-detection.ssh-manage');
  const [inputText, setInputText] = useState('');
  const [results, setResults] = useState<TracerouteResult[]>([]);
  const [running, setRunning] = useState(false);

  // 勾选
  const [checkedSet, setCheckedSet] = useState<Set<number>>(new Set());

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
  const [autoRetry, setAutoRetry] = useState(false);
  const [autoRetryInterval, setAutoRetryInterval] = useState(3);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);

  const autoRetryRef = useRef(false);
  const autoRetryIntervalRef = useRef(30);
  const resultsRef = useRef<TracerouteResult[]>([]);
  const prevRunningRef = useRef(false);
  const currentServerParamRef = useRef('');
  const currentServerLabelRef = useRef('');

  const loadServers = useCallback(async () => {
    try {
      const res = await fetch('/api/ssh-servers');
      const data = await res.json();
      if (data.success) setServers(data.servers || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadServers(); }, [loadServers]);
  useEffect(() => { autoRetryRef.current = autoRetry; }, [autoRetry]);
  useEffect(() => { autoRetryIntervalRef.current = autoRetryInterval; }, [autoRetryInterval]);
  useEffect(() => { resultsRef.current = results; }, [results]);

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

  const executeTraceroute = useCallback(async (targetIp: string, index: number) => {
    setResults(prev => prev.map((r, idx) => idx === index ? { ...r, status: 'running' } : r));
    try {
      const res = await fetch(`/api/traceroute/run?ip=${encodeURIComponent(targetIp)}${currentServerParamRef.current}`);
      const data = await res.json();
      if (data.success) {
        setResults(prev => prev.map((r, idx) =>
          idx === index ? {
            ...r,
            status: 'done',
            hops: data.hops || [],
            rawOutput: data.raw || '',
            partial: data.partial,
            reachable: data.reachable,
            serverName: data.serverName || currentServerLabelRef.current,
          } : r
        ));
      } else {
        setResults(prev => prev.map((r, idx) =>
          idx === index ? { ...r, status: 'error', error: data.message } : r
        ));
      }
    } catch (e: any) {
      setResults(prev => prev.map((r, idx) =>
        idx === index ? { ...r, status: 'error', error: e.message } : r
      ));
    }
  }, []);

  const handleRun = async () => {
    const targets = parseInputs(inputText);
    if (targets.length === 0) {
      message.warning('请输入至少一个有效的 IP 段');
      return;
    }
    setRetryCountdown(null);
    currentServerParamRef.current = selectedServer !== 'local' ? `&server=${encodeURIComponent(selectedServer)}` : '';
    currentServerLabelRef.current = selectedServer !== 'local'
      ? servers.find(s => s.id === selectedServer)?.name || selectedServer
      : '';
    const initResults: TracerouteResult[] = targets.map(t => ({
      raw: t.raw,
      targetIp: t.targetIp,
      status: 'pending',
      hops: [],
      rawOutput: '',
      serverName: currentServerLabelRef.current,
    }));
    setResults(initResults);
    setCheckedSet(new Set());
    setRunning(true);
    for (let i = 0; i < targets.length; i++) {
      await executeTraceroute(targets[i].targetIp, i);
    }
    setRunning(false);
  };

  const handleRetryFailed = useCallback(async () => {
    const cur = resultsRef.current;
    const failedIndices = cur.reduce<number[]>((acc, r, i) => {
      if (r.status === 'error') acc.push(i);
      return acc;
    }, []);
    if (failedIndices.length === 0) return;
    setRunning(true);
    for (const i of failedIndices) {
      await executeTraceroute(cur[i].targetIp, i);
    }
    setRunning(false);
  }, [executeTraceroute]);

  useEffect(() => {
    if (prevRunningRef.current && !running) {
      const failures = resultsRef.current.filter(r => r.status === 'error').length;
      if (autoRetryRef.current && failures > 0) {
        setRetryCountdown(autoRetryIntervalRef.current);
      }
    }
    prevRunningRef.current = running;
  }, [running]);

  useEffect(() => {
    if (retryCountdown === null) return;
    if (retryCountdown <= 0) {
      setRetryCountdown(null);
      handleRetryFailed();
      return;
    }
    const timer = setTimeout(() => setRetryCountdown(prev => prev !== null ? prev - 1 : null), 1000);
    return () => clearTimeout(timer);
  }, [retryCountdown, handleRetryFailed]);

  // ── 勾选逻辑 ──
  const doneResults = results.filter(r => r.status === 'done' || r.status === 'error');
  const doneIndices = results.map((r, i) => (r.status === 'done' || r.status === 'error') ? i : -1).filter(i => i >= 0);
  const allChecked = doneIndices.length > 0 && doneIndices.every(i => checkedSet.has(i));
  const someChecked = doneIndices.some(i => checkedSet.has(i));

  const toggleCheck = (idx: number) => {
    setCheckedSet(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allChecked) {
      setCheckedSet(new Set());
    } else {
      setCheckedSet(new Set(doneIndices));
    }
  };

  const handleCopySelected = () => {
    const rows = results
      .map((r, i) => ({ r, i }))
      .filter(({ i }) => checkedSet.has(i))
      .map(({ r }) => r.raw);
    if (rows.length === 0) {
      message.warning('请先勾选要复制的项');
      return;
    }
    navigator.clipboard.writeText(rows.join('\n')).then(
      () => message.success(`已复制 ${rows.length} 个 IP 段`),
      () => message.error('复制失败'),
    );
  };

  // 按检测状态批量追加勾选（不清空已有勾选）
  const selectByStatus = (type: 'reachable' | 'unreachable' | 'error') => {
    const indices = results.map((r, i) => {
      if (type === 'error' && r.status === 'error') return i;
      if (type === 'reachable' && r.status === 'done' && r.reachable === true) return i;
      if (type === 'unreachable' && r.status === 'done' && r.reachable === false) return i;
      return -1;
    }).filter(i => i >= 0);
    if (indices.length === 0) return;
    setCheckedSet(prev => {
      const next = new Set(prev);
      indices.forEach(i => next.add(i));
      return next;
    });
  };

  const reachableCount = doneResults.filter(r => r.reachable === true).length;
  const unreachableCount = doneResults.filter(r => r.reachable === false).length;

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
          {isAdmin ? (
            <Button
              icon={<SettingOutlined />}
              size="small"
              onClick={() => { setServerModalVisible(true); setEditingServer(null); serverForm.resetFields(); }}
            >
              管理服务器
            </Button>
          ) : (
            <Tooltip title="仅管理员可配置 SSH 服务器">
              <Button icon={<SettingOutlined />} size="small" disabled>管理服务器</Button>
            </Tooltip>
          )}
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={running}
              onClick={handleRun}
              style={{ borderRadius: 6, height: 36, padding: '0 24px' }}
            >
              开始检测
            </Button>
            {results.some(r => r.status === 'error') && !running && (
              <Button
                icon={<SyncOutlined />}
                onClick={handleRetryFailed}
                style={{ borderRadius: 6, height: 36 }}
              >
                仅重试失败项 ({results.filter(r => r.status === 'error').length})
              </Button>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Checkbox
              checked={autoRetry}
              onChange={e => { setAutoRetry(e.target.checked); if (!e.target.checked) setRetryCountdown(null); }}
            >
              自动循环重试失败项
            </Checkbox>
            {autoRetry && (
              <>
                <Text type="secondary" style={{ fontSize: 13 }}>间隔</Text>
                <InputNumber
                  min={1}
                  max={300}
                  value={autoRetryInterval}
                  onChange={v => setAutoRetryInterval(Math.max(1, v ?? 30))}
                  style={{ width: 72 }}
                  size="small"
                />
                <Text type="secondary" style={{ fontSize: 13 }}>秒</Text>
                {retryCountdown !== null && (
                  <>
                    <Tag color="orange" icon={<SyncOutlined spin />}>
                      {retryCountdown}s 后自动重试
                    </Tag>
                    <Button size="small" onClick={() => setRetryCountdown(null)}>取消</Button>
                  </>
                )}
              </>
            )}
          </div>
        </div>

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

            {/* 全选 + 状态批量勾选 + 复制工具栏 */}
            {doneIndices.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                marginBottom: 12, padding: '8px 12px',
                background: '#fafafa', borderRadius: 6, border: '1px solid #f0f0f0',
              }}>
                <Checkbox
                  checked={allChecked}
                  indeterminate={someChecked && !allChecked}
                  onChange={toggleSelectAll}
                >
                  全选
                </Checkbox>
                <Text type="secondary" style={{ fontSize: 12, marginRight: 4 }}>
                  已选 {checkedSet.size} / {doneIndices.length}
                </Text>

                {/* 按状态批量勾选 */}
                {reachableCount > 0 && (
                  <Button
                    size="small"
                    onClick={() => selectByStatus('reachable')}
                    style={{ color: '#389e0d', borderColor: '#b7eb8f', background: '#f6ffed' }}
                  >
                    选「通」({reachableCount})
                  </Button>
                )}
                {unreachableCount > 0 && (
                  <Button
                    size="small"
                    onClick={() => selectByStatus('unreachable')}
                    style={{ color: '#cf1322', borderColor: '#ffa39e', background: '#fff1f0' }}
                  >
                    选「不通」({unreachableCount})
                  </Button>
                )}
                {results.filter(r => r.status === 'error').length > 0 && (
                  <Button
                    size="small"
                    onClick={() => selectByStatus('error')}
                    style={{ color: '#d46b08', borderColor: '#ffd591', background: '#fff7e6' }}
                  >
                    选「失败」({results.filter(r => r.status === 'error').length})
                  </Button>
                )}

                {checkedSet.size > 0 && (
                  <Button size="small" onClick={() => setCheckedSet(new Set())}>
                    清空勾选
                  </Button>
                )}

                <Tooltip title="每行一个 IP 段，可直接粘贴">
                  <Button
                    size="small"
                    type="primary"
                    icon={<CopyOutlined />}
                    disabled={checkedSet.size === 0}
                    onClick={handleCopySelected}
                  >
                    复制 IP 段 ({checkedSet.size})
                  </Button>
                </Tooltip>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {results.map((r, i) => (
                <div
                  key={i}
                  style={{
                    border: '1px solid #f0f0f0',
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: checkedSet.has(i) ? '#e6f4ff' : '#fff',
                  }}
                >
                  {/* 结果行 */}
                  <div
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 14px',
                      cursor: (r.status === 'done' || r.status === 'error') ? 'pointer' : 'default',
                    }}
                    onClick={() => { if (r.status === 'done' || r.status === 'error') toggleCheck(i); }}
                  >
                    {(r.status === 'done' || r.status === 'error') ? (
                      <Checkbox
                        checked={checkedSet.has(i)}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleCheck(i)}
                      />
                    ) : (
                      <div style={{ width: 22 }} />
                    )}
                    <NodeIndexOutlined style={{ color: '#999' }} />
                    <Text code style={{ fontSize: 13 }}>{r.raw}</Text>
                    <Text type="secondary">→</Text>
                    <Text style={{ fontSize: 13 }}>traceroute {r.targetIp}</Text>
                    {r.serverName && <Tag color="blue" style={{ fontSize: 11 }}>{r.serverName}</Tag>}
                    <div style={{ flex: 1 }} />
                    {statusTag(r)}
                  </div>

                  {/* 可展开的原始输出 */}
                  {(r.rawOutput || r.error) && (
                    <div style={{ borderTop: '1px solid #f0f0f0' }}>
                      <Collapse
                        ghost
                        size="small"
                        items={[
                          ...(r.status === 'error' && r.error ? [{
                            key: 'error',
                            label: <Text type="danger" style={{ fontSize: 12 }}>错误信息</Text>,
                            children: <Alert type="error" message={r.error} style={{ margin: '0 12px 12px' }} />,
                          }] : []),
                          ...(r.rawOutput ? [{
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
                                margin: '0 12px 12px',
                              }}>
                                {r.rawOutput}
                              </pre>
                            ),
                          }] : []),
                        ]}
                      />
                    </div>
                  )}

                  {/* 执行中状态 */}
                  {r.status === 'running' && (
                    <div style={{ textAlign: 'center', padding: 16, borderTop: '1px solid #f0f0f0' }}>
                      <LoadingOutlined style={{ fontSize: 20, color: '#1677ff' }} />
                      <div style={{ marginTop: 6 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>正在执行 traceroute，请稍候...</Text>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
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
