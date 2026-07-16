import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Button, Input, Select, Switch, Space, Alert,
  Typography, Divider, Progress, Tag, message,
  Card, Tooltip, Badge,
} from 'antd';
import {
  PlusOutlined, DeleteOutlined, PlayCircleOutlined,
  CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined,
  CopyOutlined, SyncOutlined,
} from '@ant-design/icons';

const { Text } = Typography;
const { Option } = Select;

// ── 类型 ──────────────────────────────────────────────────────────────────
type NetworkType = 'PremiumBGP' | 'StandardBGP';

interface FormRow {
  key: string;
  cidrBlock: string;
  networkType: NetworkType;
  regionId: string;
  asn: number | '';
  bandwidthClusterId?: string;
}

interface RegionOption { regionId: string; label: string; }
interface AsnOption { value: number; label: string; }

type JobStatus = 'pending' | 'running' | 'done' | 'error';
interface JobState {
  index: number;
  cidr: string;
  status: JobStatus;
  step: string;
  logs: string[];
  eipCurrent: number;
  eipTotal: number;
  cidrPoll: { attempt: number; max: number; status: string } | null;
}

interface Props {
  onRegionsLoaded?: (options: RegionOption[]) => void;
}

function newRow(): FormRow {
  return { key: String(Date.now() + Math.random()), cidrBlock: '', networkType: 'StandardBGP', regionId: '', asn: '' };
}

// ── 主组件 ────────────────────────────────────────────────────────────────
const ZenAnnounceTab: React.FC<Props> = ({ onRegionsLoaded }) => {
  const [rows, setRows] = useState<FormRow[]>([newRow()]);
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);
  const [networksForRegion, setNetworksForRegion] = useState<Record<string, string[]>>({});
  const [asnOptions, setAsnOptions] = useState<AsnOption[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState('');
  const [skipByoip, setSkipByoip] = useState(false);
  // 演练模式默认开启
  const [dryRun, setDryRun] = useState(true);
  // 优质 BGP 开关：关闭时所有行强制 StandardBGP，线路列不可编辑
  const [allowPremiumBGP, setAllowPremiumBGP] = useState(false);
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [configSource, setConfigSource] = useState<'config' | 'env' | 'none' | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // 关闭优质 BGP 时，将所有 PremiumBGP 行重置为 StandardBGP
  useEffect(() => {
    if (!allowPremiumBGP) {
      setRows(prev => prev.map(r => r.networkType === 'PremiumBGP' ? { ...r, networkType: 'StandardBGP' } : r));
    }
  }, [allowPremiumBGP]);

  // ── 加载配置状态 ──
  const checkConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/zen/config');
      const d = await r.json();
      setConfigured(!!d.config?.configured);
      setConfigSource(d.config?.source || null);
    } catch { setConfigured(false); }
  }, []);

  // ── 加载地域和 ASN 元数据 ──
  const loadMeta = useCallback(async () => {
    setMetaLoading(true);
    setMetaError('');
    try {
      const [byoipRes, asnRes] = await Promise.all([
        fetch('/api/zen/meta/byoip'),
        fetch('/api/zen/meta/asns?probe=1'),
      ]);
      const byoip = await byoipRes.json();
      const asnData = await asnRes.json();
      if (!byoip.ok) throw new Error(byoip.error || '获取地域列表失败');
      setRegionOptions(byoip.regionOptions || []);
      setNetworksForRegion(byoip.networksForRegion || {});
      if (asnData.ok && asnData.asns?.length) setAsnOptions(asnData.asns);
      onRegionsLoaded?.(byoip.regionOptions || []);
    } catch (e: any) {
      setMetaError(e.message || '加载元数据失败');
    } finally {
      setMetaLoading(false);
    }
  }, [onRegionsLoaded]);

  useEffect(() => { checkConfig(); }, [checkConfig]);
  useEffect(() => { if (configured) loadMeta(); }, [configured, loadMeta]);

  // ── 保存配置（已移除配置弹窗，保留 API 检查逻辑）──

  // ── 行操作 ──
  const addRow = () => setRows(prev => [...prev, newRow()]);
  const removeRow = (key: string) => setRows(prev => prev.filter(r => r.key !== key));
  const updateRow = (key: string, patch: Partial<FormRow>) =>
    setRows(prev => prev.map(r => r.key === key ? { ...r, ...patch } : r));
  const duplicateRow = (key: string) => {
    const src = rows.find(r => r.key === key);
    if (!src) return;
    setRows(prev => {
      const i = prev.findIndex(r => r.key === key);
      // 复制行时不复制 CIDR 网段，置空让用户自行填写
      const copy = { ...src, key: String(Date.now() + Math.random()), cidrBlock: '' };
      const next = [...prev]; next.splice(i + 1, 0, copy); return next;
    });
  };

  // 地域下可用网络类型（受全局 allowPremiumBGP 开关约束）
  const networksForRow = (regionId: string): NetworkType[] => {
    const nets = (networksForRegion[regionId] || []) as NetworkType[];
    const all: NetworkType[] = nets.length ? nets : ['StandardBGP', 'PremiumBGP'];
    return allowPremiumBGP ? all : ['StandardBGP'];
  };

  // ── 执行流水线 ──
  const handleRun = async () => {
    const validRows = rows.filter(r => r.cidrBlock.trim() && r.regionId && r.asn !== '');
    if (!validRows.length) { message.warning('请至少填写一条完整的 IP 段任务（需填 CIDR、地域、ASN）'); return; }

    const initJobs: JobState[] = validRows.map((r, i) => ({
      index: i, cidr: r.cidrBlock, status: 'pending', step: '', logs: [], eipCurrent: 0, eipTotal: 0, cidrPoll: null,
    }));
    setJobs(initJobs);
    setRunning(true);

    let cancelled = false;
    abortRef.current = () => { cancelled = true; };

    const setJob = (index: number, patch: Partial<JobState>) =>
      setJobs(prev => prev.map(j => j.index === index ? { ...j, ...patch } : j));
    const addLog = (index: number, msg: string) =>
      setJobs(prev => prev.map(j => j.index === index ? { ...j, logs: [...j.logs.slice(-199), msg] } : j));

    try {
      const resp = await fetch('/api/zen/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobs: validRows.map(r => ({
            cidrBlock: r.cidrBlock.trim(),
            networkType: r.networkType,
            regionId: r.regionId,
            asn: Number(r.asn),
            bandwidthClusterId: r.bandwidthClusterId?.trim() || undefined,
          })),
          skipByoip,
          dryRun,
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let currentJobIdx = 0;

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
          if (ev.type === 'job_start') { currentJobIdx = ev.index; setJob(ev.index, { status: 'running', step: '准备中' }); }
          else if (ev.type === 'step') { setJob(currentJobIdx, { step: ev.title }); addLog(currentJobIdx, `[步骤] ${ev.title}${ev.detail ? `：${ev.detail}` : ''}`); }
          else if (ev.type === 'log') { addLog(currentJobIdx, `[${ev.level}] ${ev.message}`); }
          else if (ev.type === 'cidr_poll') { setJob(currentJobIdx, { cidrPoll: { attempt: ev.attempt, max: ev.max, status: ev.status || '' } }); }
          else if (ev.type === 'cidr_ready') { setJob(currentJobIdx, { cidrPoll: null, step: 'CIDR 就绪' }); addLog(currentJobIdx, `[info] CIDR 就绪 cidrId=${ev.cidrId} totalCount=${ev.totalCount ?? '-'} usedCount=${ev.usedCount ?? '-'}`); }
          else if (ev.type === 'eip_attempt') { setJob(currentJobIdx, { eipCurrent: ev.current, eipTotal: ev.total, step: `创建 EIP (${ev.current}/${ev.total})` }); }
          else if (ev.type === 'eip_progress') { setJob(currentJobIdx, { eipCurrent: ev.current, eipTotal: ev.total, step: `创建 EIP (${ev.current}/${ev.total})` }); addLog(currentJobIdx, `[info] 已创建 ${ev.current}/${ev.total} ${ev.ip} ${ev.name}`); }
          else if (ev.type === 'job_done') { setJob(ev.index, { status: 'done', step: '完成' }); }
          else if (ev.type === 'error') { setJob(currentJobIdx, { status: 'error', step: '出错' }); addLog(currentJobIdx, `[error] ${ev.message}`); }
        }
      }
    } catch (e: any) {
      message.error(`执行失败：${e.message}`);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => { abortRef.current?.(); setRunning(false); message.info('已中断，当前批次继续完成后停止'); };

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 顶部操作栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 14 }}>宣告自带 IP 段并在对应地域批量创建弹性 IPv4，流程自动完成</Text>
        <Space>
          {configured === false && <Tag color="error">未配置 API Key</Tag>}
          {configured === true && configSource === 'env' && (
            <Tooltip title="已从 ZEN-Auto-Announce/.env 自动读取"><Tag color="cyan">自动读取 .env</Tag></Tooltip>
          )}
          {configured === true && configSource === 'config' && <Tag color="success">API 已配置</Tag>}
          {configured && (
            <Button icon={<SyncOutlined spin={metaLoading} />} onClick={loadMeta} loading={metaLoading}>刷新地域</Button>
          )}
        </Space>
      </div>

      {metaError && <Alert type="error" message={metaError} showIcon closable onClose={() => setMetaError('')} />}

      {/* 任务表格 */}
      <Card
        size="small"
        title={<span>任务列表 <Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>（每行一个 IP 段）</Text></span>}
        extra={<Button icon={<PlusOutlined />} onClick={addRow}>添加行</Button>}
        style={{ borderRadius: 8 }}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa', fontSize: 13 }}>
                <th style={thStyle}>CIDR 网段</th>
                <th style={thStyle}>
                  <Space size={6}>
                    线路类型
                    <Tooltip title={allowPremiumBGP ? '点击关闭优质 BGP，所有行将重置为标准 BGP' : '开启后可选优质 BGP'}>
                      <Switch
                        size="small"
                        checked={allowPremiumBGP}
                        onChange={setAllowPremiumBGP}
                        checkedChildren="优质 BGP"
                        unCheckedChildren="仅标准"
                      />
                    </Tooltip>
                  </Space>
                </th>
                <th style={thStyle}>地域</th>
                <th style={thStyle}>ASN</th>
                <th style={{ ...thStyle, width: 80 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const nets = networksForRow(row.regionId);
                return (
                  <tr key={row.key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={tdStyle}>
                      <Input
                        placeholder="如 203.0.113.0/24"
                        value={row.cidrBlock}
                        onChange={e => updateRow(row.key, { cidrBlock: e.target.value })}
                        size="middle" style={{ width: 180 }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <Select
                        value={row.networkType}
                        onChange={v => updateRow(row.key, { networkType: v })}
                        size="middle"
                        style={{ width: 140 }}
                        disabled={!allowPremiumBGP}
                      >
                        <Option value="StandardBGP">标准 BGP</Option>
                        {allowPremiumBGP && <Option value="PremiumBGP">优质 BGP</Option>}
                      </Select>
                    </td>
                    <td style={tdStyle}>
                      <Select
                        showSearch
                        placeholder="选择地域"
                        value={row.regionId || undefined}
                        onChange={v => updateRow(row.key, {
                          regionId: v,
                          networkType: nets.includes(row.networkType) ? row.networkType : (nets[0] as NetworkType || 'StandardBGP'),
                        })}
                        size="middle" style={{ width: 210 }}
                        loading={metaLoading}
                        filterOption={(input, opt) => String(opt?.children || '').toLowerCase().includes(input.toLowerCase())}
                      >
                        {regionOptions.map(r => <Option key={r.regionId} value={r.regionId}>{r.label}</Option>)}
                      </Select>
                    </td>
                    <td style={tdStyle}>
                      {asnOptions.length > 0 ? (
                        <Select
                          showSearch placeholder="ASN"
                          value={row.asn !== '' ? row.asn : undefined}
                          onChange={v => updateRow(row.key, { asn: v })}
                          size="middle" style={{ width: 170 }}
                          filterOption={(input, opt) => String(opt?.children || '').toLowerCase().includes(input.toLowerCase())}
                        >
                          {asnOptions.map(a => <Option key={a.value} value={a.value}>{a.label}</Option>)}
                        </Select>
                      ) : (
                        <Input
                          placeholder="如 AS138789 或 138789"
                          value={row.asn !== '' ? String(row.asn) : ''}
                          onChange={e => {
                            // 自动去除 AS/as 前缀，只保留数字
                            const raw = e.target.value.replace(/^[Aa][Ss]\s*/,'').replace(/[^\d]/g,'');
                            updateRow(row.key, { asn: raw === '' ? '' : Number(raw) });
                          }}
                          size="middle" style={{ width: 140 }}
                        />
                      )}
                    </td>
                    {/* 带宽组 ID 列隐藏，保留数据字段 */}
                    <td style={{ ...tdStyle, display: 'none' }}>
                      <Input
                        placeholder="留空自动匹配"
                        value={row.bandwidthClusterId || ''}
                        onChange={e => updateRow(row.key, { bandwidthClusterId: e.target.value })}
                        size="small" style={{ width: 180 }}
                      />
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      <Space size={4}>
                        <Tooltip title="复制此行">
                          <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => duplicateRow(row.key)} />
                        </Tooltip>
                        <Tooltip title="删除此行">
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeRow(row.key)} disabled={rows.length === 1} />
                        </Tooltip>
                      </Space>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <Space>
            <Switch checked={skipByoip} onChange={setSkipByoip} size="small" />
            <Text style={{ fontSize: 14 }}>跳过宣告（CIDR 已存在）</Text>
          </Space>
          <Space>
            <Switch checked={dryRun} onChange={setDryRun} size="small" />
            <Text style={{ fontSize: 14 }}>
              演练模式（不实际创建）
              {dryRun && <Tag color="orange" style={{ marginLeft: 6, fontSize: 12 }}>已开启</Tag>}
            </Text>
          </Space>
          <div style={{ marginLeft: 'auto' }}>
            {running ? (
              <Space>
                <Button danger size="middle" icon={<CloseCircleOutlined />} onClick={handleStop}>中断</Button>
                <Tag color="processing" icon={<LoadingOutlined />} style={{ fontSize: 13, padding: '4px 10px' }}>执行中</Tag>
              </Space>
            ) : (
              <Button
                type="primary"
                size="middle"
                icon={<PlayCircleOutlined />}
                onClick={handleRun}
                disabled={!configured}
                style={dryRun ? { background: '#fa8c16', borderColor: '#fa8c16' } : undefined}
              >
                {dryRun ? '演练执行' : '开始执行'}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* 执行结果 */}
      {jobs.length > 0 && (
        <Card size="small" title="执行进度" style={{ borderRadius: 8 }}>
          {jobs.map(job => <JobCard key={job.index} job={job} />)}
        </Card>
      )}

      {/* 配置弹窗已移除 */}
    </div>
  );
};

// ── JobCard ───────────────────────────────────────────────────────────────
const JobCard: React.FC<{ job: JobState }> = ({ job }) => {
  // 完成/出错后自动折叠日志，运行中保持展开；点击头部可手动切换
  const isDone = job.status === 'done' || job.status === 'error';
  const [collapsed, setCollapsed] = React.useState(false);
  // 当任务变为完成/出错时自动折叠
  React.useEffect(() => {
    if (isDone) setCollapsed(true);
  }, [isDone]);

  const statusIcon =
    job.status === 'done' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> :
    job.status === 'error' ? <CloseCircleOutlined style={{ color: '#ff4d4f' }} /> :
    job.status === 'running' ? <LoadingOutlined style={{ color: '#1677ff' }} /> :
    <Badge status="default" />;
  const statusColor = job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : job.status === 'running' ? 'processing' : 'default';
  const hasLogs = job.logs.length > 0;

  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, marginBottom: 12, overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', background: '#fafafa', gap: 8, flexWrap: 'wrap', cursor: hasLogs ? 'pointer' : 'default', userSelect: 'none' }}
        onClick={() => hasLogs && setCollapsed(c => !c)}
      >
        {statusIcon}
        <Text strong style={{ fontSize: 14 }}>{job.cidr}</Text>
        <Tag color={statusColor} style={{ margin: 0 }}>
          {job.status === 'pending' ? '等待中' : job.status === 'running' ? (job.step || '执行中') : job.status === 'done' ? '完成' : '出错'}
        </Tag>
        {job.cidrPoll && (
          <Text type="secondary" style={{ fontSize: 13 }}>轮询 CIDR {job.cidrPoll.attempt}/{job.cidrPoll.max} 状态：{job.cidrPoll.status}</Text>
        )}
        {job.eipTotal > 0 && (
          <div style={{ flex: 1, minWidth: 120 }}>
            <Progress percent={Math.round(job.eipCurrent / job.eipTotal * 100)} size="small" format={() => `${job.eipCurrent}/${job.eipTotal}`} />
          </div>
        )}
        {hasLogs && (
          <Text type="secondary" style={{ marginLeft: 'auto', fontSize: 12 }}>
            {collapsed ? '▶ 展开日志' : '▼ 折叠日志'}
          </Text>
        )}
      </div>
      {hasLogs && !collapsed && (
        <div style={{ padding: '6px 12px', maxHeight: 200, overflowY: 'auto', background: '#1a1a2e', fontFamily: 'monospace', fontSize: 12 }}>
          {job.logs.map((l, i) => {
            const color = l.startsWith('[error]') ? '#ff6b6b' : l.startsWith('[warn]') ? '#ffd93d' : '#a8d8ea';
            return <div key={i} style={{ color, lineHeight: '1.6' }}>{l}</div>;
          })}
        </div>
      )}
    </div>
  );
};

const thStyle: React.CSSProperties = { padding: '8px 12px', textAlign: 'left', fontWeight: 500, fontSize: 14, color: 'rgba(0,0,0,0.65)', borderBottom: '1px solid #f0f0f0', whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: '8px 10px', verticalAlign: 'middle' };

export default ZenAnnounceTab;
