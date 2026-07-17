import React, { useState, useRef, useEffect } from 'react';
import { getAuthHeaders } from '../contexts/AuthContext';
import {
  Button, Input, Switch, Space, Alert,
  Typography, Divider, Tag, message, Card, Tabs,
} from 'antd';
import {
  PlayCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, CheckCircleOutlined, StopOutlined,
  DownOutlined, RightOutlined, NumberOutlined,
} from '@ant-design/icons';

const { Text } = Typography;
const { TextArea } = Input;

interface SegmentProgress {
  cidr: string;
  phase: 'lookup' | 'deleting' | 'done' | 'error' | 'skipped';
  deleted: boolean;
  dryRun: boolean;
  message?: string;
  cidrId?: string;
  regionId?: string;
  usedCount?: number;
  logs: string[];
}

interface IdProgress {
  cidrBlockId: string;
  status: 'pending' | 'running' | 'done' | 'error';
  deleted: boolean;
  dryRun: boolean;
  message?: string;
}

const ZenByoipWithdrawTab: React.FC<{ regionOptions?: any[] }> = () => {
  const [batchInput, setBatchInput] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [segments, setSegments] = useState<SegmentProgress[]>([]);
  const [globalLogs, setGlobalLogs] = useState<string[]>([]);
  const [collapsedLogs, setCollapsedLogs] = useState<boolean[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  // 按 ID 取消的状态
  const [idInput, setIdInput] = useState('');
  const [idDryRun, setIdDryRun] = useState(true);
  const [idRunning, setIdRunning] = useState(false);
  const [idResults, setIdResults] = useState<IdProgress[]>([]);
  const [idLogs, setIdLogs] = useState<string[]>([]);

  // 完成/跳过/报错后自动折叠日志
  useEffect(() => {
    setCollapsedLogs(prev => {
      const next = [...prev];
      segments.forEach((s, i) => {
        if ((s.phase === 'done' || s.phase === 'error' || s.phase === 'skipped') && next[i] === false) {
          next[i] = true;
        }
        if (next[i] === undefined) next[i] = false;
      });
      return next;
    });
  }, [segments.map(s => s.phase).join(',')]);

  const parseTasks = (): { cidrBlock: string }[] =>
    batchInput.split('\n').map(l => l.trim()).filter(Boolean).map(cidr => ({ cidrBlock: cidr }));

  const handleRun = async () => {
    const taskList = parseTasks();
    if (!taskList.length) { message.warning('请至少填写一个 CIDR'); return; }

    const initSegs: SegmentProgress[] = taskList.map(t => ({
      cidr: t.cidrBlock, phase: 'lookup', deleted: false, dryRun, logs: [],
    }));
    setSegments(initSegs);
    setCollapsedLogs(taskList.map(() => false));
    setGlobalLogs([]);
    setRunning(true);

    let cancelled = false;
    abortRef.current = () => { cancelled = true; };

    const setSeg = (idx: number, patch: Partial<SegmentProgress>) =>
      setSegments(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
    const addSegLog = (idx: number, msg: string) =>
      setSegments(prev => prev.map((s, i) => i === idx ? { ...s, logs: [...s.logs.slice(-299), msg] } : s));

    try {
      const resp = await fetch('/api/zen/byoip-withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ tasks: taskList, dryRun }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === 'log') {
            const logMsg = `[${ev.level}] ${ev.message}`;
            const idx = typeof ev.message === 'string'
              ? initSegs.findIndex(s => ev.message.includes(s.cidr))
              : -1;
            if (idx >= 0) addSegLog(idx, logMsg);
            else setGlobalLogs(p => [...p.slice(-199), logMsg]);
          } else if (ev.type === 'segment_phase') {
            setSeg(ev.segmentIndex, { phase: ev.phase });
          } else if (ev.type === 'segment_skipped') {
            setSeg(ev.segmentIndex, {
              phase: 'skipped',
              cidrId: ev.cidrId,
              regionId: ev.regionId,
              usedCount: ev.usedCount,
              message: ev.message,
            });
          } else if (ev.type === 'segment_done') {
            setSeg(ev.segmentIndex, {
              deleted: !!ev.deleted,
              dryRun: !!ev.dryRun,
              message: ev.message,
              cidrId: ev.cidrId,
              regionId: ev.regionId,
              phase: ev.deleted || (ev.dryRun && !ev.message?.includes('未找到'))
                ? 'done'
                : (ev.message ? 'error' : 'done'),
            });
          } else if (ev.type === 'error') {
            setGlobalLogs(p => [...p, `[error] ${ev.message}`]);
          }
        }
      }
    } catch (e: any) {
      message.error(`执行失败：${e.message}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => { abortRef.current?.(); setRunning(false); message.info('已中断'); };

  const handleRunById = async () => {
    const ids = idInput.split('\n').map(l => l.trim()).filter(Boolean);
    if (!ids.length) { message.warning('请至少填写一个 cidrBlockId'); return; }
    const init: IdProgress[] = ids.map(id => ({ cidrBlockId: id, status: 'pending', deleted: false, dryRun: idDryRun }));
    setIdResults(init);
    setIdLogs([]);
    setIdRunning(true);
    const addLog = (msg: string) => setIdLogs(p => [...p.slice(-299), msg]);
    try {
      const resp = await fetch('/api/zen/byoip-withdraw-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ cidrBlockIds: ids, dryRun: idDryRun }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'log') {
            addLog(`[${ev.level}] ${ev.message}`);
          } else if (ev.type === 'id_done') {
            setIdResults(prev => prev.map((r, i) => i === ev.index ? {
              ...r,
              status: ev.deleted ? 'done' : (ev.dryRun ? 'done' : (ev.message ? 'error' : 'done')),
              deleted: !!ev.deleted,
              dryRun: !!ev.dryRun,
              message: ev.message,
            } : r));
          }
        }
      }
    } catch (e: any) {
      message.error(`执行失败：${e.message}`);
    } finally {
      setIdRunning(false);
    }
  };

  const phaseTag = (s: SegmentProgress) => {
    if (s.phase === 'lookup') return <Tag color="processing" icon={<LoadingOutlined />}>查询中</Tag>;
    if (s.phase === 'deleting') return <Tag color="processing" icon={<LoadingOutlined />}>取消宣告中</Tag>;
    if (s.phase === 'skipped') return <Tag color="warning" icon={<StopOutlined />}>已跳过（有实例）</Tag>;
    if (s.phase === 'done') {
      if (s.dryRun && !s.deleted) return <Tag color="orange">演练完成</Tag>;
      return s.deleted
        ? <Tag color="success" icon={<CheckCircleOutlined />}>已取消宣告</Tag>
        : <Tag color="default">完成</Tag>;
    }
    return <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Alert
        type="warning"
        showIcon
        message="取消宣告不可逆"
        description="TerminateCidrBlock 成功后资源立即回收。执行前请确认已解绑该 CIDR 下全部实例。"
      />

      <Tabs
        defaultActiveKey="by-cidr"
        items={[
          {
            key: 'by-cidr',
            label: '按 CIDR 取消',
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  系统将自动查询 DescribeCidrBlocks 找到对应记录，再调用 TerminateCidrBlock 取消宣告。
                </Text>
                <Card size="small" title="取消宣告任务" style={{ borderRadius: 8 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <div>
                      <Text style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>CIDR 列表（每行一个）</Text>
                      <TextArea
                        rows={6}
                        value={batchInput}
                        onChange={e => setBatchInput(e.target.value)}
                        placeholder={'203.0.113.0/24\n198.51.100.0/24'}
                        style={{ fontFamily: 'monospace' }}
                      />
                    </div>
                    <Divider style={{ margin: '4px 0' }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                      <Space>
                        <Switch checked={dryRun} onChange={setDryRun} size="small" />
                        <Text style={{ fontSize: 14 }}>
                          演练模式（不实际取消）
                          {dryRun && <Tag color="orange" style={{ marginLeft: 6, fontSize: 12 }}>已开启</Tag>}
                        </Text>
                      </Space>
                      <div style={{ marginLeft: 'auto' }}>
                        {running ? (
                          <Space>
                            <Button danger icon={<CloseCircleOutlined />} onClick={handleStop}>中断</Button>
                            <Tag color="processing" icon={<LoadingOutlined />}>执行中</Tag>
                          </Space>
                        ) : (
                          <Button
                            type="primary" danger={!dryRun} icon={<PlayCircleOutlined />} onClick={handleRun}
                            style={dryRun ? { background: '#fa8c16', borderColor: '#fa8c16' } : undefined}
                          >
                            {dryRun ? '演练取消宣告' : '开始取消宣告'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </Space>
                </Card>

                {segments.length > 0 && (
                  <Card size="small" title="执行进度" style={{ borderRadius: 8 }}>
                    {segments.map((s, idx) => {
                      const collapsed = collapsedLogs[idx] ?? false;
                      return (
                        <div key={idx} style={{ border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 12, overflow: 'hidden' }}>
                          <div
                            style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', background: '#fafafa', gap: 8, flexWrap: 'wrap', cursor: s.logs.length > 0 ? 'pointer' : 'default' }}
                            onClick={() => { if (s.logs.length > 0) setCollapsedLogs(prev => { const n = [...prev]; n[idx] = !n[idx]; return n; }); }}
                          >
                            {s.logs.length > 0 && <span style={{ color: '#999', fontSize: 12 }}>{collapsed ? <RightOutlined /> : <DownOutlined />}</span>}
                            <Text strong style={{ fontFamily: 'monospace' }}>{s.cidr}</Text>
                            {phaseTag(s)}
                            {s.cidrId && <Text type="secondary" style={{ fontSize: 12 }}>cidrId={s.cidrId}</Text>}
                            {s.regionId && <Tag>{s.regionId}</Tag>}
                            {s.phase === 'skipped' && s.usedCount !== undefined && (
                              <Text type="warning" style={{ fontSize: 12 }}>绑定实例：{s.usedCount} 个，请先解绑后再操作</Text>
                            )}
                            {s.phase === 'skipped' && s.message && !s.usedCount && (
                              <Text type="warning" style={{ fontSize: 12 }}>{s.message}</Text>
                            )}
                            {s.phase !== 'skipped' && s.message && (
                              <Text type="secondary" style={{ fontSize: 12 }}>{s.message}</Text>
                            )}
                          </div>
                          {s.logs.length > 0 && !collapsed && (
                            <div style={{ padding: '6px 12px', maxHeight: 160, overflowY: 'auto', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12 }}>
                              {s.logs.map((l, j) => {
                                const color = l.startsWith('[error]') ? '#ff6b6b' : l.startsWith('[warn]') ? '#ffd93d' : '#a8d8ea';
                                return <div key={j} style={{ color, lineHeight: '1.6' }}>{l}</div>;
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </Card>
                )}

                {globalLogs.length > 0 && (
                  <Card size="small" title="全局日志" style={{ borderRadius: 8 }}>
                    <div style={{ padding: 8, maxHeight: 160, overflowY: 'auto', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12 }}>
                      {globalLogs.map((l, i) => (
                        <div key={i} style={{ color: l.startsWith('[error]') ? '#ff6b6b' : '#a8d8ea', lineHeight: '1.6' }}>{l}</div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            ),
          },
          {
            key: 'by-id',
            label: <span><NumberOutlined /> 按 cidrBlockId 取消</span>,
            children: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  当按 CIDR 查询失败或被跳过时，可直接填写 cidrBlockId 强制调用 TerminateCidrBlock。
                  cidrBlockId 可从上方执行进度的"cidrId="或 Zenlayer 控制台获取。
                </Text>

                <Card size="small" title="按 cidrBlockId 取消宣告" style={{ borderRadius: 8 }}>
                  <Space direction="vertical" style={{ width: '100%' }} size={12}>
                    <div>
                      <Text style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>
                        cidrBlockId 列表（每行一个，纯数字 ID）
                      </Text>
                      <TextArea
                        rows={6}
                        value={idInput}
                        onChange={e => setIdInput(e.target.value)}
                        placeholder={'1729589956546007080\n1730333589842833046'}
                        style={{ fontFamily: 'monospace' }}
                      />
                    </div>
                    <Divider style={{ margin: '4px 0' }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                      <Space>
                        <Switch checked={idDryRun} onChange={setIdDryRun} size="small" />
                        <Text style={{ fontSize: 14 }}>
                          演练模式（不实际取消）
                          {idDryRun && <Tag color="orange" style={{ marginLeft: 6, fontSize: 12 }}>已开启</Tag>}
                        </Text>
                      </Space>
                      <div style={{ marginLeft: 'auto' }}>
                        {idRunning ? (
                          <Tag color="processing" icon={<LoadingOutlined />}>执行中</Tag>
                        ) : (
                          <Button
                            type="primary" danger={!idDryRun} icon={<PlayCircleOutlined />} onClick={handleRunById}
                            style={idDryRun ? { background: '#fa8c16', borderColor: '#fa8c16' } : undefined}
                          >
                            {idDryRun ? '演练（按 ID）' : '按 ID 取消宣告'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </Space>
                </Card>

                {idResults.length > 0 && (
                  <Card size="small" title="执行结果" style={{ borderRadius: 8 }}>
                    {idResults.map((r, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: i < idResults.length - 1 ? '1px solid #f0f0f0' : undefined, flexWrap: 'wrap' }}>
                        <Text strong style={{ fontFamily: 'monospace', fontSize: 13 }}>{r.cidrBlockId}</Text>
                        {r.status === 'pending' && <Tag color="default">等待中</Tag>}
                        {r.status === 'running' && <Tag color="processing" icon={<LoadingOutlined />}>执行中</Tag>}
                        {r.status === 'done' && r.deleted && <Tag color="success" icon={<CheckCircleOutlined />}>已取消宣告</Tag>}
                        {r.status === 'done' && !r.deleted && r.dryRun && <Tag color="orange">演练完成</Tag>}
                        {r.status === 'done' && !r.deleted && !r.dryRun && <Tag color="default">完成</Tag>}
                        {r.status === 'error' && <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>}
                        {r.message && <Text type="secondary" style={{ fontSize: 12 }}>{r.message}</Text>}
                      </div>
                    ))}
                  </Card>
                )}

                {idLogs.length > 0 && (
                  <Card size="small" title="执行日志" style={{ borderRadius: 8 }}>
                    <div style={{ padding: 8, maxHeight: 200, overflowY: 'auto', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12 }}>
                      {idLogs.map((l, i) => (
                        <div key={i} style={{ color: l.startsWith('[error]') ? '#ff6b6b' : l.startsWith('[warn]') ? '#ffd93d' : '#a8d8ea', lineHeight: '1.6' }}>{l}</div>
                      ))}
                    </div>
                  </Card>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
};

export default ZenByoipWithdrawTab;