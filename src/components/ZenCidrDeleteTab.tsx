import React, { useState, useRef, useEffect } from 'react';
import {
  Button, Input, Select, Switch, Space, Alert,
  Typography, Divider, Tag, message, Card,
} from 'antd';
import {
  PlayCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, CheckCircleOutlined,
  DownOutlined, RightOutlined, DeleteOutlined,
  StopOutlined,
} from '@ant-design/icons';

const { Text } = Typography;
const { TextArea } = Input;
const { Option } = Select;

interface RegionOption { regionId: string; label: string; }

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

const ZenCidrDeleteTab: React.FC<{ regionOptions: RegionOption[] }> = ({ regionOptions: regionOptionsProp }) => {
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>(regionOptionsProp || []);
  const [batchInput, setBatchInput] = useState('');
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [segments, setSegments] = useState<SegmentProgress[]>([]);
  const [globalLogs, setGlobalLogs] = useState<string[]>([]);
  // 每个 segment 的日志折叠状态：true=折叠，false=展开
  const [collapsedLogs, setCollapsedLogs] = useState<boolean[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  // segment done/error/skipped 时自动折叠日志
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
  }, [segments]);

  useEffect(() => {
    if (regionOptionsProp?.length) setRegionOptions(regionOptionsProp);
  }, [regionOptionsProp]);

  useEffect(() => {
    if (regionOptions.length) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/zen/meta/byoip');
        const d = await r.json();
        if (!cancelled && d.ok) setRegionOptions(d.regionOptions || []);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [regionOptions.length]);

  const parseTasks = (): { regionId: string; cidrBlock: string }[] =>
    batchInput.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(cidr => ({ cidrBlock: cidr, regionId: selectedRegion }));

  const handleRun = async () => {
    const taskList = parseTasks();
    if (!taskList.length) { message.warning('请至少填写一行 CIDR'); return; }

    const initSegs: SegmentProgress[] = taskList.map(t => ({
      cidr: t.cidrBlock, phase: 'lookup', deleted: false, dryRun, logs: [],
    }));
    setSegments(initSegs);
    setCollapsedLogs(initSegs.map(() => false));
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tasks: taskList,
          scanRegionIds: regionOptions.map(r => r.regionId),
          dryRun,
        }),
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
            const msg = `[${ev.level}] ${ev.message}`;
            const idx = typeof ev.message === 'string'
              ? initSegs.findIndex(s => ev.message.includes(s.cidr))
              : -1;
            if (idx >= 0) addSegLog(idx, msg);
            else setGlobalLogs(p => [...p.slice(-199), msg]);
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

  const toggleLog = (i: number) =>
    setCollapsedLogs(prev => prev.map((v, idx) => idx === i ? !v : v));

  const phaseTag = (s: SegmentProgress) => {
    if (s.phase === 'lookup') return <Tag color="processing" icon={<LoadingOutlined />}>查询中</Tag>;
    if (s.phase === 'deleting') return <Tag color="processing" icon={<LoadingOutlined />}>删除中</Tag>;
    if (s.phase === 'skipped') return <Tag color="warning" icon={<StopOutlined />}>已跳过（有EIP）</Tag>;
    if (s.phase === 'done') {
      if (s.dryRun && !s.deleted) return <Tag color="orange">演练完成</Tag>;
      return s.deleted
        ? <Tag color="success" icon={<CheckCircleOutlined />}>已删除</Tag>
        : <Tag color="default">完成</Tag>;
    }
    return <Tag color="error" icon={<CloseCircleOutlined />}>失败</Tag>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Text type="secondary" style={{ fontSize: 14 }}>
        删除 ZEC CIDR 地址块（DeleteCidr）。仅支持删除<strong>没有弹性 IP</strong>的 IP 段；若仍有已分配 EIP，请先前往「EIP 删除」释放后再操作。
      </Text>

      <Alert
        type="warning"
        showIcon
        message="删除不可逆"
        description="DeleteCidr 成功后 CIDR 资源立即回收，宣告路由随即撤销。请确认该段下已无任何弹性 IP 再执行。"
      />

      <Card size="small" title="CIDR 删除任务" style={{ borderRadius: 8 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <div>
            <Text style={{ fontSize: 13, display: 'block', marginBottom: 6 }}>地域（可选，留空则全地域查找）</Text>
            <Select
              allowClear
              showSearch
              placeholder="留空则在全部可宣告地域中查找"
              value={selectedRegion || undefined}
              onChange={v => setSelectedRegion(v || '')}
              style={{ width: '100%', maxWidth: 420 }}
              filterOption={(input, opt) => String(opt?.children || '').toLowerCase().includes(input.toLowerCase())}
            >
              {regionOptions.map(r => <Option key={r.regionId} value={r.regionId}>{r.label}</Option>)}
            </Select>
          </div>

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
                演练模式（不实际删除）
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
                  type="primary"
                  danger={!dryRun}
                  icon={<DeleteOutlined />}
                  onClick={handleRun}
                  style={dryRun ? { background: '#fa8c16', borderColor: '#fa8c16' } : undefined}
                >
                  {dryRun ? '演练删除' : '开始删除'}
                </Button>
              )}
            </div>
          </div>
        </Space>
      </Card>

      {segments.length > 0 && (
        <Card size="small" title="执行进度" style={{ borderRadius: 8 }}>
          {segments.map((s, i) => {
            const isDone = s.phase === 'done' || s.phase === 'error' || s.phase === 'skipped';
            const collapsed = collapsedLogs[i] ?? false;
            return (
              <div key={i} style={{ border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 12, overflow: 'hidden' }}>
                {/* 标题行：点击可展开/折叠日志 */}
                <div
                  style={{
                    display: 'flex', alignItems: 'center', padding: '8px 12px',
                    background: '#fafafa', gap: 8, flexWrap: 'wrap',
                    cursor: s.logs.length > 0 ? 'pointer' : 'default',
                  }}
                  onClick={() => s.logs.length > 0 && toggleLog(i)}
                >
                  <Text strong style={{ fontFamily: 'monospace' }}>{s.cidr}</Text>
                  {phaseTag(s)}
                  {s.cidrId && <Text type="secondary" style={{ fontSize: 12 }}>cidrId={s.cidrId}</Text>}
                  {s.regionId && <Tag>{s.regionId}</Tag>}
                  {s.phase === 'skipped' && s.usedCount !== undefined && (
                    <Text type="warning" style={{ fontSize: 12 }}>已分配 EIP：{s.usedCount} 个，请先在「EIP 删除」中释放</Text>
                  )}
                  {s.phase !== 'skipped' && s.message && <Text type="secondary" style={{ fontSize: 12 }}>{s.message}</Text>}
                  {s.logs.length > 0 && (
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: '#888', display: 'flex', alignItems: 'center', gap: 4, userSelect: 'none' }}>
                      {collapsed ? <RightOutlined /> : <DownOutlined />}
                      {collapsed ? '展开日志' : '折叠日志'}
                    </span>
                  )}
                </div>
                {/* 日志区：完成后自动折叠 */}
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
  );
};

export default ZenCidrDeleteTab;
