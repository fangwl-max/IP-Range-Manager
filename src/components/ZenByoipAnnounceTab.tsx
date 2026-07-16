import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Button, Input, Select, Switch, Space, Alert,
  Typography, Divider, Tag, message, Card, Tooltip, Badge, Table,
} from "antd";
import {
  PlusOutlined, DeleteOutlined, PlayCircleOutlined,
  CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined,
  SyncOutlined, DownOutlined, RightOutlined, CopyOutlined,
} from "@ant-design/icons";

const { Text } = Typography;
const { Option } = Select;

// ==================== 固定可用区 & VLAN 配置 ====================
const FIXED_ZONES = [
  { zoneId: "HEL-A", label: "HEL-A 赫尔辛基", publicVirtualInterfaceId: "1515609139647220845" },
  { zoneId: "IAD-G", label: "IAD-G 华盛顿",   publicVirtualInterfaceId: "1694787346844887149" },
  { zoneId: "MRS-B", label: "MRS-B 马赛",     publicVirtualInterfaceId: "1694787497261007981" },
] as const;

type ZoneId = typeof FIXED_ZONES[number]["zoneId"];
const ENABLED_ZONE_IDS = new Set(FIXED_ZONES.map(z => z.zoneId));

// 其他展示用（禁用）的可用区
const DISABLED_ZONES = [
  { zoneId: "FRA-A", label: "FRA-A 法兰克福" },
  { zoneId: "AMS-A", label: "AMS-A 阿姆斯特丹" },
  { zoneId: "LON-A", label: "LON-A 伦敦" },
  { zoneId: "SIN-A", label: "SIN-A 新加坡" },
  { zoneId: "TYO-A", label: "TYO-A 东京" },
  { zoneId: "SEL-A", label: "SEL-A 首尔" },
  { zoneId: "SYD-A", label: "SYD-A 悉尼" },
  { zoneId: "LAX-A", label: "LAX-A 洛杉矶" },
  { zoneId: "NYC-A", label: "NYC-A 纽约" },
  { zoneId: "CHI-A", label: "CHI-A 芝加哥" },
  { zoneId: "DFW-A", label: "DFW-A 达拉斯" },
  { zoneId: "MIA-A", label: "MIA-A 迈阿密" },
  { zoneId: "SEA-A", label: "SEA-A 西雅图" },
  { zoneId: "AKL-A", label: "AKL-A 奥克兰" },
  { zoneId: "GRU-A", label: "GRU-A 圣保罗" },
];

// ==================== 表单行 ====================
interface FormRow {
  key: string;
  cidrBlock: string;
  asn: number | "";
  zoneId: ZoneId | "";
  publicVirtualInterfaceId: string;
}

function getVlanForZone(zoneId: string): string {
  return FIXED_ZONES.find(z => z.zoneId === zoneId)?.publicVirtualInterfaceId ?? "";
}

function newRow(defaultZone: ZoneId | "" = ""): FormRow {
  return {
    key: String(Date.now() + Math.random()),
    cidrBlock: "",
    asn: "",
    zoneId: defaultZone,
    publicVirtualInterfaceId: getVlanForZone(defaultZone),
  };
}

// ==================== 执行状态 ====================
type JobStatus = "pending" | "running" | "done" | "error";
interface JobState {
  index: number;
  cidr: string;
  zoneId: string;
  status: JobStatus;
  step: string;
  logs: string[];
}

interface RegionOption { regionId: string; label: string; }
interface Props {
  onRegionsLoaded?: (options: RegionOption[]) => void;
  regionOptions?: RegionOption[];
}

// ==================== 主组件 ====================
const ZenByoipAnnounceTab: React.FC<Props> = () => {
  const [rows, setRows] = useState<FormRow[]>([newRow()]);
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const checkConfig = useCallback(async () => {
    try {
      const r = await fetch("/api/zen/config");
      const d = await r.json();
      setConfigured(!!d.config?.configured);
    } catch { setConfigured(false); }
  }, []);

  useEffect(() => { checkConfig(); }, [checkConfig]);

  const addRow = () => {
    const lastZone = rows[rows.length - 1]?.zoneId ?? "";
    setRows(prev => [...prev, newRow(lastZone as ZoneId | "")]);
  };
  const removeRow = (key: string) => setRows(prev => prev.filter(r => r.key !== key));
  const copyRow = (key: string) => {
    const src = rows.find(r => r.key === key);
    if (!src) return;
    const copy: FormRow = { ...src, key: String(Date.now() + Math.random()) };
    setRows(prev => {
      const idx = prev.findIndex(r => r.key === key);
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  };
  const updateRow = (key: string, patch: Partial<FormRow>) =>
    setRows(prev => prev.map(r => {
      if (r.key !== key) return r;
      const updated = { ...r, ...patch };
      // 选了可用区后自动更新 VLAN
      if (patch.zoneId !== undefined) {
        updated.publicVirtualInterfaceId = getVlanForZone(patch.zoneId);
      }
      return updated;
    }));

  const handleRun = async () => {
    const validRows = rows.filter(r => r.cidrBlock.trim() && r.asn !== "" && r.zoneId);
    if (!validRows.length) {
      message.warning("请至少填写一条完整任务（CIDR、ASN、可用区）");
      return;
    }

    // 按可用区分组，同区合并
    const initJobs: JobState[] = validRows.map((r, i) => {
      const zone = FIXED_ZONES.find(z => z.zoneId === r.zoneId);
      return {
        index: i,
        cidr: r.cidrBlock.trim(),
        zoneId: r.zoneId,
        status: "pending" as JobStatus,
        step: "",
        logs: [],
      };
    });
    setJobs(initJobs);
    setRunning(true);

    let cancelled = false;
    abortRef.current = () => { cancelled = true; };

    const setJob = (index: number, patch: Partial<JobState>) =>
      setJobs(prev => prev.map(j => j.index === index ? { ...j, ...patch } : j));
    const addLog = (index: number, msg: string) =>
      setJobs(prev => prev.map(j => j.index === index ? { ...j, logs: [...j.logs.slice(-199), msg] } : j));

    try {
      const resp = await fetch("/api/zen/byoip-announce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs: validRows.map(r => ({
            cidrBlock: r.cidrBlock.trim(),
            asn: Number(r.asn),
            ipType: "IPV4",
            zones: [{ zoneId: r.zoneId, publicVirtualInterfaceId: r.publicVirtualInterfaceId }],
          })),
          dryRun,
        }),
      });
      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let currentJobIdx = 0;

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === "job_start") {
            currentJobIdx = ev.index;
            setJob(ev.index, { status: "running", step: "准备中" });
          } else if (ev.type === "step") {
            setJob(currentJobIdx, { step: ev.title });
            addLog(currentJobIdx, `[步骤] ${ev.title}${ev.detail ? `：${ev.detail}` : ""}`);
          } else if (ev.type === "log") {
            addLog(currentJobIdx, `[${ev.level}] ${ev.message}`);
          } else if (ev.type === "job_done") {
            setJob(ev.index, { status: "done", step: "完成" });
          } else if (ev.type === "error") {
            setJob(currentJobIdx, { status: "error", step: "失败" });
            addLog(currentJobIdx, `[error] ${ev.message}`);
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

  const handleStop = () => { abortRef.current?.(); setRunning(false); message.info("已中断"); };

  // 区分有效行和无效行
  const validCount = rows.filter(r => r.cidrBlock.trim() && r.asn !== "" && r.zoneId).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 14 }}>
          VOB 宣告（BMC CreateByoip）：支持同时宣告多个 IP 段到同一可用区
        </Text>
        <Space>
          {configured === false && <Tag color="error">未配置 API Key</Tag>}
          {configured === true && <Tag color="success">API 已配置</Tag>}
        </Space>
      </div>

      {/* 固定可用区说明 */}
      <Alert
        type="info"
        showIcon
        message={
          <Space size={16}>
            {FIXED_ZONES.map(z => (
              <span key={z.zoneId}>
                <Tag color="blue">{z.zoneId}</Tag>
                <Text style={{ fontSize: 12 }}>{z.label.split(" ")[1]}</Text>
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 4 }}>VLAN: {z.publicVirtualInterfaceId}</Text>
              </span>
            ))}
          </Space>
        }
        style={{ padding: "6px 12px" }}
      />

      {/* 宣告任务列表 */}
      <div>
        {/* 表头 */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "36px 1fr 120px 190px 1fr 72px",
          gap: 8,
          padding: "6px 8px",
          background: "#fafafa",
          borderRadius: "6px 6px 0 0",
          border: "1px solid #f0f0f0",
          fontWeight: 500,
          fontSize: 13,
          color: "rgba(0,0,0,0.55)",
        }}>
          <span style={{ textAlign: "center" }}>#</span>
          <span>CIDR 段</span>
          <span>ASN</span>
          <span>可用区</span>
          <span>公网 VLAN ID</span>
          <span></span>
        </div>
        {/* 行 */}
        {rows.map((row, idx) => (
          <div
            key={row.key}
            style={{
              display: "grid",
              gridTemplateColumns: "36px 1fr 120px 190px 1fr 72px",
              gap: 8,
              padding: "6px 8px",
              borderLeft: "1px solid #f0f0f0",
              borderRight: "1px solid #f0f0f0",
              borderBottom: "1px solid #f0f0f0",
              background: idx % 2 === 0 ? "#fff" : "#fafffe",
              alignItems: "center",
            }}
          >
            <Text type="secondary" style={{ textAlign: "center", fontSize: 13 }}>{idx + 1}</Text>
            <Input
              placeholder="203.0.113.0/24"
              value={row.cidrBlock}
              onChange={e => updateRow(row.key, { cidrBlock: e.target.value })}
              size="small"
            />
            <Input
              placeholder="如 138789"
              value={row.asn !== "" ? String(row.asn) : ""}
              onChange={e => {
                const raw = e.target.value.replace(/^[Aa][Ss]\s*/, "").replace(/[^\d]/g, "");
                updateRow(row.key, { asn: raw === "" ? "" : Number(raw) });
              }}
              size="small"
            />
            <Select
              value={row.zoneId || undefined}
              placeholder="选择可用区"
              onChange={v => updateRow(row.key, { zoneId: v as ZoneId })}
              size="small"
              style={{ width: "100%" }}
            >
              {/* 启用的可用区 */}
              {FIXED_ZONES.map(z => (
                <Option key={z.zoneId} value={z.zoneId}>{z.label}</Option>
              ))}
              {/* 禁用的可用区（变灰显示） */}
              {DISABLED_ZONES.map(z => (
                <Option key={z.zoneId} value={z.zoneId} disabled>
                  <Text type="secondary">{z.label}</Text>
                </Option>
              ))}
            </Select>
            <Input
              value={row.publicVirtualInterfaceId}
              onChange={e => updateRow(row.key, { publicVirtualInterfaceId: e.target.value })}
              placeholder="自动填充"
              size="small"
              style={{ fontFamily: "monospace", fontSize: 11 }}
            />
            <Space size={4}>
              <Tooltip title="复制此行">
                <Button
                  size="small" type="text" icon={<CopyOutlined />}
                  onClick={() => copyRow(row.key)}
                />
              </Tooltip>
              <Tooltip title="删除此行">
                <Button
                  size="small" type="text" danger icon={<DeleteOutlined />}
                  onClick={() => removeRow(row.key)}
                  disabled={rows.length === 1}
                />
              </Tooltip>
            </Space>
          </div>
        ))}
      </div>

      <Button type="dashed" icon={<PlusOutlined />} onClick={addRow} style={{ width: "100%" }}>
        添加 IP 段
      </Button>

      <Card size="small" style={{ borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
          <Space>
            <Switch checked={dryRun} onChange={setDryRun} size="small" />
            <Text style={{ fontSize: 14 }}>
              演练模式（不实际宣告）
              {dryRun && <Tag color="orange" style={{ marginLeft: 6, fontSize: 12 }}>已开启</Tag>}
            </Text>
          </Space>
          {validCount > 0 && (
            <Text type="secondary" style={{ fontSize: 13 }}>
              已填写 <Text strong>{validCount}</Text> 条任务
            </Text>
          )}
          <div style={{ marginLeft: "auto" }}>
            {running ? (
              <Space>
                <Button danger size="middle" icon={<CloseCircleOutlined />} onClick={handleStop}>中断</Button>
                <Tag color="processing" icon={<LoadingOutlined />} style={{ fontSize: 13, padding: "4px 10px" }}>执行中</Tag>
              </Space>
            ) : (
              <Button
                type="primary"
                size="middle"
                icon={<PlayCircleOutlined />}
                onClick={handleRun}
                disabled={!configured}
                style={dryRun ? { background: "#fa8c16", borderColor: "#fa8c16" } : undefined}
              >
                {dryRun ? "演练 VOB 宣告" : "开始 VOB 宣告"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {jobs.length > 0 && (
        <Card size="small" title="执行进度" style={{ borderRadius: 8 }}>
          {jobs.map(job => <JobCard key={job.index} job={job} />)}
        </Card>
      )}
    </div>
  );
};

// ==================== 单个任务进度卡 ====================
const JobCard: React.FC<{ job: JobState }> = ({ job }) => {
  const isDone = job.status === "done" || job.status === "error";
  const [collapsed, setCollapsed] = React.useState(false);
  React.useEffect(() => { if (isDone) setCollapsed(true); }, [isDone]);

  const zone = FIXED_ZONES.find(z => z.zoneId === job.zoneId);
  const statusIcon =
    job.status === "done"    ? <CheckCircleOutlined style={{ color: "#52c41a" }} /> :
    job.status === "error"   ? <CloseCircleOutlined style={{ color: "#ff4d4f" }} /> :
    job.status === "running" ? <LoadingOutlined     style={{ color: "#1677ff" }} /> :
    <Badge status="default" />;
  const statusColor =
    job.status === "done"    ? "success" :
    job.status === "error"   ? "error" :
    job.status === "running" ? "processing" : "default";
  const hasLogs = job.logs.length > 0;

  return (
    <div style={{ border: "1px solid #f0f0f0", borderRadius: 6, marginBottom: 10, overflow: "hidden" }}>
      <div
        style={{ display: "flex", alignItems: "center", padding: "8px 12px", background: "#fafafa", gap: 8, flexWrap: "wrap", cursor: hasLogs ? "pointer" : "default", userSelect: "none" }}
        onClick={() => hasLogs && setCollapsed(c => !c)}
      >
        {statusIcon}
        <Text strong style={{ fontSize: 14 }}>{job.cidr}</Text>
        {zone && <Tag color="blue" style={{ margin: 0 }}>{zone.label}</Tag>}
        <Tag color={statusColor} style={{ margin: 0 }}>
          {job.status === "pending" ? "等待中" : job.status === "running" ? (job.step || "执行中") : job.status === "done" ? "完成" : "失败"}
        </Tag>
        {hasLogs && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "rgba(0,0,0,0.45)" }}>
            {collapsed ? <><RightOutlined /> 展开日志</> : <><DownOutlined /> 收起日志</>}
          </span>
        )}
      </div>
      {hasLogs && !collapsed && (
        <div style={{ padding: "6px 12px", maxHeight: 240, overflowY: "auto", background: "#1a1a2e", fontFamily: "monospace", fontSize: 12 }}>
          {job.logs.map((l, i) => {
            const color = l.startsWith("[error]") ? "#ff6b6b" : l.startsWith("[warn]") ? "#ffd93d" : "#a8d8ea";
            return <div key={i} style={{ color, lineHeight: "1.6" }}>{l}</div>;
          })}
        </div>
      )}
    </div>
  );
};

export default ZenByoipAnnounceTab;
