import React, { useState, useRef, useEffect } from 'react';
import { getAuthHeaders } from '../contexts/AuthContext';
import {
  Button, Input, Select, Switch, Space,
  Typography, Divider, Progress, Tag, message, Card, Tooltip,
} from 'antd';
import {
  PlayCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, CheckCircleOutlined, DownOutlined, RightOutlined,
} from '@ant-design/icons';

const { Text } = Typography;
const { TextArea } = Input;
const { Option } = Select;

// ── 类型 ──────────────────────────────────────────────────────────────────
interface RegionOption { regionId: string; label: string; }

interface SegmentProgress {
  cidr: string;
  phase: 'listing' | 'unbinding' | 'deleting' | 'done' | 'error';
  deleted: number;
  skippedBound: number;
  failed: number;
  deletableCount: number;
  dryRun: boolean;
  scanPage: {
    regionId: string; regionOrdinal: number; regionTotal: number;
    page: number; maxPages: number; matched: number; mergedTotal: number | null;
  } | null;
  deleteProgress: { current: number; total: number } | null;
  logs: string[];
}

// ── 组件 ──────────────────────────────────────────────────────────────────
const ZenEipDelete: React.FC<{ regionOptions: RegionOption[] }> = ({ regionOptions: regionOptionsProp }) => {
  // 批量文本输入：每行一个 CIDR
  const [batchInput, setBatchInput] = useState('');
  // 统一地域选择：所有 CIDR 使用同一个地域（留空=全地域扫描）
  const [selectedRegion, setSelectedRegion] = useState<string>('');
  // 地域列表：优先用父组件传入，若为空则自行加载
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>(regionOptionsProp || []);
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [unbindBeforeDelete, setUnbindBeforeDelete] = useState(false);
  const [running, setRunning] = useState(false);
  const [segments, setSegments] = useState<SegmentProgress[]>([]);
  const [globalLogs, setGlobalLogs] = useState<string[]>([]);
  // 每个 segment 的日志折叠状态：true=折叠，false=展开
  const [collapsedLogs, setCollapsedLogs] = useState<boolean[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  // 父组件传入有数据时同步
  useEffect(() => {
    if (regionOptionsProp?.length) setRegionOptions(regionOptionsProp);
  }, [regionOptionsProp]);

  // 若无地域数据则自行加载
  useEffect(() => {
    if (regionOptions.length > 0) return;
    let cancelled = false;
    setRegionsLoading(true);
    (async () => {
      try {
        const r = await fetch('/api/zen/meta/byoip');
        const d = await r.json();
        if (!cancelled && d.ok && d.regionOptions?.length) {
          setRegionOptions(d.regionOptions);
        }
      } catch { /* ignore */ } finally {
        if (!cancelled) setRegionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line

  // segment done 时自动折叠对应日志
  useEffect(() => {
    setCollapsedLogs(prev => {
      const next = [...prev];
      segments.forEach((seg, i) => {
        if (seg.phase === 'done' && next[i] === false) {
          next[i] = true; // done 后自动折叠
        }
      });
      return next;
    });
  }, [segments.map(s => s.phase).join(',')]); // eslint-disable-line

  // 从批量输入解析任务（每行一个 CIDR，使用统一地域）
  const parseTasks = (): { regionId: string; cidrBlock: string }[] =>
    batchInput.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(cidr => ({ cidrBlock: cidr, regionId: selectedRegion }));

  // ── 执行删除 ──
  const handleRun = async () => {
    const taskList = parseTasks();
    if (!taskList.length) { message.warning('请至少填写一行 CIDR'); return; }

    const initSegs: SegmentProgress[] = taskList.map(t => ({
      cidr: t.cidrBlock, phase: 'listing', deleted: 0, skippedBound: 0, failed: 0,
      deletableCount: 0, dryRun, scanPage: null, deleteProgress: null, logs: [],
    }));
    setSegments(initSegs);
    setCollapsedLogs(taskList.map(() => false)); // 初始全部展开
    setGlobalLogs([]);
    setRunning(true);

    let cancelled = false;
    abortRef.current = () => { cancelled = true; };

    const setSeg = (idx: number, patch: Partial<SegmentProgress>) =>
      setSegments(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s));
    const addSegLog = (idx: number, msg: string) =>
      setSegments(prev => prev.map((s, i) => i === idx ? { ...s, logs: [...s.logs.slice(-299), msg] } : s));

    try {
      const resp = await fetch('/api/zen/eip-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          tasks: taskList,
          scanRegionIds: regionOptions.map(r => r.regionId),
          dryRun,
          unbindBeforeDelete,
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
            if (ev.message?.includes('[delete]')) {
              const idx = initSegs.findIndex(s => ev.message?.includes(s.cidr));
              if (idx >= 0) addSegLog(idx, msg);
              else setGlobalLogs(p => [...p.slice(-199), msg]);
            } else {
              setGlobalLogs(p => [...p.slice(-199), msg]);
            }
          } else if (ev.type === 'segment_phase') {
            setSeg(ev.segmentIndex, { phase: ev.phase });
          } else if (ev.type === 'segment_scan_progress') {
            setSeg(ev.segmentIndex, {
              scanPage: {
                regionId: ev.regionId, regionOrdinal: ev.regionOrdinal, regionTotal: ev.regionTotal,
                page: ev.page, maxPages: ev.maxPages, matched: ev.matched, mergedTotal: ev.mergedTotal,
              },
            });
          } else if (ev.type === 'delete_progress') {
            setSeg(ev.segmentIndex, { deleteProgress: { current: ev.current, total: ev.total } });
          } else if (ev.type === 'delete_done') {
            setSeg(ev.segmentIndex, {
              phase: 'done', deleted: ev.deleted, skippedBound: ev.skippedBound,
              failed: ev.failed, deletableCount: ev.deletableCount, dryRun: ev.dryRun,
              scanPage: null, deleteProgress: null,
            });
          } else if (ev.type === 'error') {
            setGlobalLogs(p => [...p.slice(-199), `[error] ${ev.message}`]);
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

  const handleStop = () => { abortRef.current?.(); setRunning(false); };

  const phaseLabel: Record<string, string> = { listing: '扫描中', unbinding: '解绑中', deleting: '删除中', done: '完成', error: '出错' };
  const phaseColor: Record<string, string> = { listing: 'processing', unbinding: 'warning', deleting: 'error', done: 'success', error: 'error' };

  const cidrCount = batchInput.split('\n').map(l => l.trim()).filter(Boolean).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" style={{ borderRadius: 8 }}>

        {/* 地域选择 + 说明 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 13, whiteSpace: 'nowrap' }}>地域：</Text>
          <Select
            showSearch
            allowClear
            placeholder={regionsLoading ? '加载地域中...' : '留空 = 全地域扫描（较慢）'}
            loading={regionsLoading}
            value={selectedRegion || undefined}
            onChange={v => setSelectedRegion(v || '')}
            style={{ width: 260 }}
            filterOption={(input, opt) => String(opt?.children || '').toLowerCase().includes(input.toLowerCase())}
          >
            {regionOptions.map(r => <Option key={r.regionId} value={r.regionId}>{r.label}</Option>)}
          </Select>
          {!selectedRegion && !regionsLoading && regionOptions.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              未指定地域时将逐一扫描全部节点，速度较慢；建议指定地域加快筛选
            </Text>
          )}
          {!selectedRegion && !regionsLoading && regionOptions.length === 0 && (
            <Text type="warning" style={{ fontSize: 12 }}>
              地域列表为空，执行时将报错。请检查 API 配置或刷新页面。
            </Text>
          )}
        </div>

        {/* CIDR 批量输入 */}
        <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 13 }}>CIDR 列表（每行一条）</Text>
          {cidrCount > 0 && <Text type="secondary" style={{ fontSize: 12 }}>{cidrCount} 条</Text>}
        </div>
        <TextArea
          rows={8}
          placeholder={'203.0.113.0/24\n198.51.100.0/24\n…'}
          value={batchInput}
          onChange={e => setBatchInput(e.target.value)}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />

        <Divider style={{ margin: '12px 0' }} />

        {/* 选项 + 执行按钮 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <Space>
            <Switch checked={dryRun} onChange={setDryRun} size="small" />
            <Text style={{ fontSize: 13 }}>演练模式（只扫描，不删除）</Text>
          </Space>
          <Space>
            <Switch checked={unbindBeforeDelete} onChange={setUnbindBeforeDelete} size="small" />
            <Text style={{ fontSize: 13 }}>删除前先解绑</Text>
          </Space>
          <div style={{ marginLeft: 'auto' }}>
            {running ? (
              <Space>
                <Button danger icon={<CloseCircleOutlined />} onClick={handleStop}>中断</Button>
                <Tag color="processing" icon={<LoadingOutlined />}>执行中</Tag>
              </Space>
            ) : (
              <Button danger type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} disabled={!cidrCount}>
                {dryRun ? '演练扫描' : '开始删除'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* 进度区域 */}
      {segments.length > 0 && (
        <Card size="small" title="执行进度" style={{ borderRadius: 8 }}>
          {segments.map((seg, idx) => (
            <div key={idx} style={{ border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 12, overflow: 'hidden' }}>
              {/* 标题行：有日志时可点击折叠/展开 */}
              <div
                style={{
                  display: 'flex', alignItems: 'center', padding: '8px 12px',
                  background: '#fafafa', gap: 8, flexWrap: 'wrap',
                  cursor: seg.logs.length > 0 ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
                onClick={() => {
                  if (!seg.logs.length) return;
                  setCollapsedLogs(prev => {
                    const next = [...prev];
                    next[idx] = !next[idx];
                    return next;
                  });
                }}
              >
                {seg.phase === 'done' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> :
                  seg.phase === 'error' ? <CloseCircleOutlined style={{ color: '#ff4d4f' }} /> :
                  <LoadingOutlined style={{ color: '#1677ff' }} />}
                <Text strong style={{ fontSize: 13 }}>{seg.cidr}</Text>
                <Tag color={phaseColor[seg.phase] || 'default'} style={{ margin: 0 }}>
                  {phaseLabel[seg.phase] || seg.phase}
                </Tag>
                {seg.phase === 'done' && (
                  <Space size={4}>
                    <Tag color="success">已删 {seg.deleted}</Tag>
                    {seg.skippedBound > 0 && <Tag color="warning">跳过绑定 {seg.skippedBound}</Tag>}
                    {seg.failed > 0 && <Tag color="error">失败 {seg.failed}</Tag>}
                    {seg.dryRun && <Tag>演练：可删 {seg.deletableCount}</Tag>}
                  </Space>
                )}
                {seg.scanPage && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {seg.scanPage.regionTotal > 1 ? `地域 ${seg.scanPage.regionOrdinal}/${seg.scanPage.regionTotal} ` : ''}
                    翻页 {seg.scanPage.page}/{seg.scanPage.maxPages}
                    {seg.scanPage.mergedTotal != null
                      ? ` · 合并命中 ${seg.scanPage.mergedTotal}`
                      : ` · 命中 ${seg.scanPage.matched}`}
                  </Text>
                )}
                {seg.deleteProgress && (
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <Progress
                      percent={Math.round(seg.deleteProgress.current / seg.deleteProgress.total * 100)}
                      size="small"
                      format={() => `${seg.deleteProgress!.current}/${seg.deleteProgress!.total}`}
                    />
                  </div>
                )}
                {/* 折叠箭头：有日志时显示 */}
                {seg.logs.length > 0 && (
                  <span style={{ marginLeft: 'auto', color: '#8c8c8c', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {collapsedLogs[idx]
                      ? <><RightOutlined />  展开日志</>
                      : <><DownOutlined />  折叠日志</>}
                  </span>
                )}
              </div>
              {/* 日志区：折叠时隐藏 */}
              {seg.logs.length > 0 && !collapsedLogs[idx] && (
                <div style={{ padding: '6px 12px', maxHeight: 160, overflowY: 'auto', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 11 }}>
                  {seg.logs.map((l, i) => {
                    const color = l.startsWith('[error]') ? '#ff6b6b' : l.startsWith('[warn]') ? '#ffd93d' : '#a8d8ea';
                    return <div key={i} style={{ color, lineHeight: '1.6' }}>{l}</div>;
                  })}
                </div>
              )}
            </div>
          ))}
          {globalLogs.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>全局日志</Text>
              <div style={{ padding: '6px 12px', maxHeight: 120, overflowY: 'auto', background: '#1a1a2e', borderRadius: 4, fontFamily: 'monospace', fontSize: 11, marginTop: 4 }}>
                {globalLogs.map((l, i) => {
                  const color = l.startsWith('[error]') ? '#ff6b6b' : l.startsWith('[warn]') ? '#ffd93d' : '#a8d8ea';
                  return <div key={i} style={{ color, lineHeight: '1.6' }}>{l}</div>;
                })}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

export default ZenEipDelete;
