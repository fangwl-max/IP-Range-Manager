import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Form,
  Input,
  InputNumber,
  Switch,
  Button,
  Space,
  Typography,
  Alert,
  Divider,
  Tag,
  message,
  Row,
  Col,
  Descriptions,
  Badge,
  TimePicker,
  Collapse,
  Select,
  Checkbox,
  Tooltip,
  Popconfirm,
  Empty,
} from 'antd';
import {
  SaveOutlined,
  SendOutlined,
  QuestionCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  CalendarOutlined,
  MessageOutlined,
  MailOutlined,
  DatabaseOutlined,
  PlusOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';

const { Title, Text, Paragraph, Link } = Typography;

interface NotifyConfigData {
  gmailUser: string;
  gmailAppPasswordSet: boolean;
  recipients: string[];
  notifyDaysAhead: number;
  enabled: boolean;
  scheduledEnabled: boolean;
  notifyTime: string;
  notifyIntervalHours?: number;
  lastSentDate?: string | null;
  lastSentAt?: number | null;
  googleChatWebhook?: string;
  backupEnabled?: boolean;
  lastBackupAt?: string | null;
  lastBackupDate?: string | null;
  weeklyReportEnabled?: boolean;
  lastWeeklyReportDate?: string | null;
  serverBaseUrl?: string;
}

interface PurchaseReportTask {
  groupBy: 'project' | 'supplier' | 'region' | 'overall';
  includeRegions?: boolean;
  includeBlocked?: boolean;
}

interface ScheduledPurchaseReport {
  id: string;
  label: string;
  time: string;
  frequency?: 'daily' | 'weekly' | 'monthly';
  weekdays?: number[];  // 0=周日 1=周一…6=周六，可多选
  monthDay?: number;    // 1-31
  enabled: boolean;
  lastSentDate?: string;
  tasks: PurchaseReportTask[];
}

const GROUP_BY_OPTIONS = [
  { value: 'project', label: '按项目组' },
  { value: 'supplier', label: '按供应商' },
  { value: 'region', label: '按计费地区' },
  { value: 'overall', label: '整体汇总' },
];

const NotifyConfig: React.FC = () => {
  const [form] = Form.useForm();
  const [config, setConfig] = useState<NotifyConfigData | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sendingWeekly, setSendingWeekly] = useState(false);
  const [purchaseReports, setPurchaseReports] = useState<ScheduledPurchaseReport[]>([]);
  const [reportsSaving, setReportsSaving] = useState(false);
  const [triggering, setTriggering] = useState<Record<string, boolean>>({});

  const loadPurchaseReports = useCallback(async () => {
    try {
      const res = await fetch('/api/notify/purchase-reports');
      const json = await res.json();
      if (json.success) setPurchaseReports(json.data || []);
    } catch { /* ignore */ }
  }, []);

  const savePurchaseReports = useCallback(async (reports: ScheduledPurchaseReport[]) => {
    setReportsSaving(true);
    try {
      const res = await fetch('/api/notify/purchase-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reports }),
      });
      const json = await res.json();
      if (json.success) {
        setPurchaseReports(reports);
        message.success('定时推送配置已保存');
      } else {
        message.error('保存失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('保存失败: ' + e.message);
    } finally {
      setReportsSaving(false);
    }
  }, []);

  const triggerReport = useCallback(async (id: string) => {
    setTriggering(prev => ({ ...prev, [id]: true }));
    try {
      const res = await fetch('/api/notify/purchase-reports/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (json.success) message.success(json.message || '发送成功');
      else message.error(json.message || '发送失败');
    } catch (e: any) {
      message.error('发送失败: ' + e.message);
    } finally {
      setTriggering(prev => ({ ...prev, [id]: false }));
    }
  }, []);

  const addReport = useCallback(() => {
    const id = `rpt-${Date.now()}`;
    const newReport: ScheduledPurchaseReport = {
      id,
      label: '购买统计定时推送',
      time: '09:00',
      frequency: 'daily',
      enabled: true,
      tasks: [{ groupBy: 'project', includeRegions: true, includeBlocked: true }],
    };
    const updated = [...purchaseReports, newReport];
    savePurchaseReports(updated);
  }, [purchaseReports, savePurchaseReports]);

  const removeReport = useCallback((id: string) => {
    savePurchaseReports(purchaseReports.filter(r => r.id !== id));
  }, [purchaseReports, savePurchaseReports]);

  const updateReport = useCallback((id: string, changes: Partial<ScheduledPurchaseReport>) => {
    const updated = purchaseReports.map(r => r.id === id ? { ...r, ...changes } : r);
    savePurchaseReports(updated);
  }, [purchaseReports, savePurchaseReports]);

  const addTask = useCallback((reportId: string) => {
    const updated = purchaseReports.map(r =>
      r.id === reportId
        ? { ...r, tasks: [...r.tasks, { groupBy: 'project' as const }] }
        : r,
    );
    savePurchaseReports(updated);
  }, [purchaseReports, savePurchaseReports]);

  const removeTask = useCallback((reportId: string, taskIdx: number) => {
    const updated = purchaseReports.map(r =>
      r.id === reportId
        ? { ...r, tasks: r.tasks.filter((_, i) => i !== taskIdx) }
        : r,
    );
    savePurchaseReports(updated);
  }, [purchaseReports, savePurchaseReports]);

  const updateTask = useCallback((reportId: string, taskIdx: number, changes: Partial<PurchaseReportTask>) => {
    const updated = purchaseReports.map(r =>
      r.id === reportId
        ? {
            ...r,
            tasks: r.tasks.map((t, i) => i === taskIdx ? { ...t, ...changes } : t),
          }
        : r,
    );
    savePurchaseReports(updated);
  }, [purchaseReports, savePurchaseReports]);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [cfgRes, schedRes] = await Promise.all([
        fetch('/api/notify/config'),
        fetch('/api/notify/schedule/status'),
      ]);
      const cfgJson = await cfgRes.json();
      const schedJson = await schedRes.json();

      if (schedJson.success) setScheduleStatus(schedJson);

      if (cfgJson.success && cfgJson.data) {
        setConfig(cfgJson.data);
        form.setFieldsValue({
          gmailUser: cfgJson.data.gmailUser,
          gmailAppPassword: '',
          recipients: cfgJson.data.recipients,
          notifyDaysAhead: cfgJson.data.notifyDaysAhead,
          enabled: cfgJson.data.enabled,
          scheduledEnabled: cfgJson.data.scheduledEnabled,
          notifyTime: cfgJson.data.notifyTime
            ? dayjs(cfgJson.data.notifyTime, 'HH:mm')
            : dayjs('09:00', 'HH:mm'),
          notifyIntervalHours: cfgJson.data.notifyIntervalHours ?? 0,
          googleChatWebhook: cfgJson.data.googleChatWebhook || '',
          backupEnabled: cfgJson.data.backupEnabled !== false,
          weeklyReportEnabled: cfgJson.data.weeklyReportEnabled !== false,
          serverBaseUrl: cfgJson.data.serverBaseUrl || '',
        });
      } else {
        form.setFieldsValue({
          notifyDaysAhead: 14,
          enabled: true,
          scheduledEnabled: false,
          recipients: [],
          notifyTime: dayjs('09:00', 'HH:mm'),
          googleChatWebhook: '',
        });
      }
    } catch (e: any) {
      message.error('加载配置失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    loadConfig();
    loadPurchaseReports();
  }, [loadConfig, loadPurchaseReports]);

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const notifyTimeStr = values.notifyTime
        ? (dayjs.isDayjs(values.notifyTime) ? values.notifyTime.format('HH:mm') : values.notifyTime)
        : '09:00';

      const res = await fetch('/api/notify/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gmailUser: values.gmailUser || '',
          gmailAppPassword: values.gmailAppPassword || '',
          recipients: values.recipients || [],
          notifyDaysAhead: values.notifyDaysAhead || 14,
          enabled: values.enabled !== false,
          scheduledEnabled: values.scheduledEnabled === true,
          notifyTime: notifyTimeStr,
          notifyIntervalHours: Number(values.notifyIntervalHours) || 0,
          googleChatWebhook: values.googleChatWebhook || '',
          backupEnabled: values.backupEnabled !== false,
          weeklyReportEnabled: values.weeklyReportEnabled !== false,
          serverBaseUrl: values.serverBaseUrl || '',
        }),
      });
      const json = await res.json();
      if (json.success) {
        message.success('配置已保存');
        loadConfig();
      } else {
        message.error('保存失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('保存失败: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleTestSend = async () => {
    setTesting(true);
    try {
      // 先获取近期续费数据和已续费数据，再发送，保证内容与近期续费页一致
      const daysAhead = config?.notifyDaysAhead || 14;
      const [upcomingRes, renewedRes] = await Promise.all([
        fetch(`/api/ipxo/services/upcoming?days=${daysAhead}`),
        fetch(`/api/ipxo/services/renewed?days=3`),
      ]);
      const upcomingJson = await upcomingRes.json();
      const renewedJson = await renewedRes.json();
      const items = upcomingJson.success ? (upcomingJson.data ?? []) : [];
      const renewedItems = renewedJson.success ? (renewedJson.data ?? []) : [];

      const res = await fetch('/api/notify/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, renewedItems }),
      });
      const json = await res.json();
      if (json.success) {
        message.success(json.message);
      } else {
        message.error('发送失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('发送失败: ' + e.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSendWeeklyReport = async () => {
    setSendingWeekly(true);
    try {
      const res = await fetch('/api/notify/send-weekly-report', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        message.success('周报已发送到 Google Chat');
        // 刷新配置以更新上次发送日期
        await loadConfig();
      } else {
        message.error('周报发送失败: ' + json.message);
      }
    } catch (e: any) {
      message.error('周报发送失败: ' + e.message);
    } finally {
      setSendingWeekly(false);
    }
  };

  const webhookConfigured = !!(config?.googleChatWebhook);

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: '24px 0' }}>
      <Title level={4} style={{ marginBottom: 4 }}>
        <MessageOutlined style={{ marginRight: 8 }} />
        通知配置
      </Title>
      <Text type="secondary">配置 Google Chat Webhook，自动推送 IP 段续费提醒消息</Text>

      {/* 当前状态概览 */}
      {config && (
        <Card size="small" style={{ marginTop: 16, marginBottom: 24 }} title="当前配置状态">
          <Descriptions column={2} size="small">
            <Descriptions.Item label="通知状态">
              <Badge
                status={config.enabled ? 'processing' : 'default'}
                text={config.enabled ? '已启用' : '已禁用'}
              />
            </Descriptions.Item>
            <Descriptions.Item label="Google Chat">
              {webhookConfigured
                ? <Tag color="green"><CheckCircleOutlined /> 已配置</Tag>
                : <Tag color="red"><CloseCircleOutlined /> 未配置</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="提前提醒">
              {config.notifyDaysAhead} 天
            </Descriptions.Item>
            <Descriptions.Item label="定时发送">
              <Badge
                status={config.scheduledEnabled && config.enabled ? 'processing' : 'default'}
                text={config.scheduledEnabled && config.enabled
                  ? (config.notifyIntervalHours && config.notifyIntervalHours > 0
                    ? `每 ${config.notifyIntervalHours} 小时推送`
                    : `每日 ${config.notifyTime || '09:00'} 推送`)
                  : '未启用'}
              />
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {/* 定时任务状态 */}
      {scheduleStatus && (
        <Card
          size="small"
          style={{ marginBottom: 24 }}
          title={<Space><ClockCircleOutlined />定时发送状态</Space>}
        >
          <Descriptions column={2} size="small">
            <Descriptions.Item label="运行状态">
              <Badge
                status={scheduleStatus.scheduledEnabled && scheduleStatus.enabled ? 'processing' : 'default'}
                text={scheduleStatus.scheduledEnabled && scheduleStatus.enabled ? '运行中' : '未启用'}
              />
            </Descriptions.Item>
            <Descriptions.Item label="发送模式">
              {scheduleStatus.notifyIntervalHours > 0
                ? <Tag color="blue">每 {scheduleStatus.notifyIntervalHours} 小时</Tag>
                : <Tag color="purple">每日 {scheduleStatus.notifyTime || '09:00'}（北京时间）</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="上次发送">
              {scheduleStatus.lastSentAt
                ? <Space><CalendarOutlined />{new Date(scheduleStatus.lastSentAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</Space>
                : scheduleStatus.lastSentDate
                  ? <Space><CalendarOutlined />{scheduleStatus.lastSentDate}</Space>
                  : <Text type="secondary">尚未发送过</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="下次发送">
              {scheduleStatus.nextSendIn
                ? <Tag color="green">{scheduleStatus.nextSendIn}</Tag>
                : scheduleStatus.scheduledEnabled && scheduleStatus.enabled
                  ? <Tag color="default">按计划运行</Tag>
                  : <Text type="secondary">-</Text>}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {/* 购买统计定时推送 */}
      <Card
        style={{ marginBottom: 24 }}
        title={<Space><BarChartOutlined />购买统计定时推送</Space>}
        extra={
          <Button
            type="primary"
            ghost
            size="small"
            icon={<PlusOutlined />}
            onClick={addReport}
            loading={reportsSaving}
            disabled={!config?.googleChatWebhook}
          >
            添加任务
          </Button>
        }
      >
        {!config?.googleChatWebhook && (
          <Alert type="warning" showIcon message="请先配置 Google Chat Webhook URL 后再添加定时推送任务" style={{ marginBottom: 12 }} />
        )}
        {purchaseReports.length === 0 ? (
          <Empty description="暂无定时推送任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            {purchaseReports.map((report) => (
              <div
                key={report.id}
                style={{
                  border: '1px solid #d9d9d9',
                  borderRadius: 8,
                  padding: '12px 16px',
                  background: report.enabled ? '#fafafa' : '#f5f5f5',
                }}
              >
                {/* 报告头部 */}
                <Row gutter={8} align="middle" style={{ marginBottom: 10 }}>
                  <Col>
                    <Switch
                      size="small"
                      checked={report.enabled}
                      onChange={(v) => updateReport(report.id, { enabled: v })}
                    />
                  </Col>
                  <Col flex="auto">
                    <Input
                      size="small"
                      defaultValue={report.label}
                      style={{ fontWeight: 600, maxWidth: 220 }}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || '购买统计定时推送';
                        if (v !== report.label) updateReport(report.id, { label: v });
                      }}
                    />
                  </Col>
                  <Col>
                    <Space size={8} wrap>
                      {/* 频率选择 */}
                      <Space size={4}>
                        <span style={{ fontSize: 12, color: '#666' }}>频率</span>
                        <Select
                          size="small"
                          style={{ width: 72 }}
                          value={report.frequency ?? 'daily'}
                          onChange={(v) => updateReport(report.id, { frequency: v })}
                          options={[
                            { value: 'daily', label: '每天' },
                            { value: 'weekly', label: '每周' },
                            { value: 'monthly', label: '每月' },
                          ]}
                        />
                      </Space>
                      {/* 每周：多选星期几 */}
                      {(report.frequency ?? 'daily') === 'weekly' && (
                        <Select
                          size="small"
                          mode="multiple"
                          style={{ minWidth: 120, maxWidth: 260 }}
                          placeholder="选择星期"
                          value={report.weekdays?.length ? report.weekdays : [1]}
                          onChange={(v: number[]) => updateReport(report.id, { weekdays: v })}
                          maxTagCount="responsive"
                          options={[
                            { value: 1, label: '周一' },
                            { value: 2, label: '周二' },
                            { value: 3, label: '周三' },
                            { value: 4, label: '周四' },
                            { value: 5, label: '周五' },
                            { value: 6, label: '周六' },
                            { value: 0, label: '周日' },
                          ]}
                        />
                      )}
                      {/* 每月：选几号 */}
                      {(report.frequency ?? 'daily') === 'monthly' && (
                        <InputNumber
                          size="small"
                          style={{ width: 80 }}
                          min={1}
                          max={31}
                          value={report.monthDay ?? 1}
                          onChange={(v) => v != null && updateReport(report.id, { monthDay: v })}
                          addonAfter="日"
                        />
                      )}
                      {/* 发送时间 */}
                      <Space size={4}>
                        <span style={{ fontSize: 12, color: '#666' }}>时间</span>
                        <TimePicker
                          size="small"
                          format="HH:mm"
                          minuteStep={5}
                          value={dayjs(report.time, 'HH:mm')}
                          onChange={(v) => v && updateReport(report.id, { time: v.format('HH:mm') })}
                          allowClear={false}
                          style={{ width: 90 }}
                        />
                      </Space>
                    </Space>
                  </Col>
                  <Col>
                    <Tooltip title="立即按当前配置发送">
                      <Button
                        size="small"
                        icon={<ThunderboltOutlined />}
                        loading={triggering[report.id]}
                        onClick={() => triggerReport(report.id)}
                        disabled={!report.tasks.length}
                      >
                        立即发送
                      </Button>
                    </Tooltip>
                  </Col>
                  <Col>
                    <Popconfirm
                      title="确认删除此定时任务？"
                      onConfirm={() => removeReport(report.id)}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Col>
                </Row>

                {/* 任务列表 */}
                <div style={{ marginLeft: 8 }}>
                  <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>发送内容：</div>
                  <Space direction="vertical" style={{ width: '100%' }} size={6}>
                    {report.tasks.map((task, taskIdx) => (
                      <Row
                        key={taskIdx}
                        gutter={8}
                        align="middle"
                        style={{
                          background: '#fff',
                          border: '1px solid #e8e8e8',
                          borderRadius: 6,
                          padding: '6px 10px',
                        }}
                      >
                        <Col>
                          <Select
                            size="small"
                            value={task.groupBy}
                            options={GROUP_BY_OPTIONS}
                            onChange={(v) => updateTask(report.id, taskIdx, { groupBy: v })}
                            style={{ width: 120 }}
                          />
                        </Col>
                        <Col>
                          <Checkbox
                            checked={task.includeRegions ?? false}
                            onChange={(e) => updateTask(report.id, taskIdx, { includeRegions: e.target.checked })}
                          >
                            <span style={{ fontSize: 12 }}>包含计费地区</span>
                          </Checkbox>
                        </Col>
                        <Col>
                          <Checkbox
                            checked={task.includeBlocked ?? false}
                            onChange={(e) => updateTask(report.id, taskIdx, { includeBlocked: e.target.checked })}
                          >
                            <span style={{ fontSize: 12 }}>包含被墙信息</span>
                          </Checkbox>
                        </Col>
                        <Col flex="auto" />
                        <Col>
                          <Popconfirm
                            title="删除此发送项？"
                            onConfirm={() => removeTask(report.id, taskIdx)}
                            okText="删除"
                            cancelText="取消"
                          >
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Col>
                      </Row>
                    ))}
                  </Space>
                  <Button
                    size="small"
                    type="dashed"
                    icon={<PlusOutlined />}
                    style={{ marginTop: 8 }}
                    onClick={() => addTask(report.id)}
                  >
                    添加发送项
                  </Button>
                </div>

                {/* 上次发送 */}
                {report.lastSentDate && (
                  <div style={{ marginTop: 8, fontSize: 12, color: '#999' }}>
                    上次发送：{report.lastSentDate}
                  </div>
                )}
              </div>
            ))}
          </Space>
        )}
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 16 }}
          message="每条任务在指定时间（北京时间）按顺序发送每个发送项，多项之间间隔 1.5 秒。定时任务由服务端执行，无需浏览器保持打开。"
        />
      </Card>

      {/* 编辑表单 */}
      <Card title="编辑配置" loading={loading}>
        <Form form={form} layout="vertical" onFinish={handleSave}>

          {/* Google Chat Webhook */}
          <Form.Item
            name="googleChatWebhook"
            label="Google Chat Webhook URL"
            rules={[{ required: true, message: '请填写 Google Chat Webhook URL' }]}
            tooltip="在 Google Chat 群中右键点击群名称 → 管理 Webhook → 添加，复制 URL 填入此处"
          >
            <Input
              placeholder="https://chat.googleapis.com/v1/spaces/..."
              allowClear
              prefix={<MessageOutlined />}
            />
          </Form.Item>

          <Row gutter={16} align="middle">
            <Col span={8}>
              <Form.Item
                name="notifyDaysAhead"
                label="提前提醒天数"
                tooltip="推送消息中会包含未来 N 天内到期的 IP 段"
              >
                <InputNumber min={1} max={30} addonAfter="天" style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="enabled" label="启用通知" valuePropName="checked">
                <Switch checkedChildren="已启用" unCheckedChildren="已禁用" />
              </Form.Item>
            </Col>
          </Row>

          <Divider orientation="left" plain>
            <Space><ClockCircleOutlined />定时自动发送</Space>
          </Divider>

          <Row gutter={16} align="middle">
            <Col span={6}>
              <Form.Item name="scheduledEnabled" label="启用定时发送" valuePropName="checked">
                <Switch checkedChildren="已启用" unCheckedChildren="已禁用" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="notifyIntervalHours"
                label="发送间隔（小时）"
                tooltip="设为 0 则使用每日固定时间模式；设为 N 则每隔 N 小时发送一次，不限每日次数"
              >
                <InputNumber
                  min={0}
                  max={168}
                  step={1}
                  addonAfter="小时"
                  style={{ width: '100%' }}
                  placeholder="0 = 每日固定时间"
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                name="notifyTime"
                label="每日发送时间（间隔=0 时生效）"
                tooltip="仅在间隔为 0 时使用，每天只发一次"
              >
                <TimePicker
                  format="HH:mm"
                  minuteStep={5}
                  style={{ width: '100%' }}
                  placeholder="选择发送时间"
                />
              </Form.Item>
            </Col>
          </Row>

          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="发送模式说明"
            description="间隔 > 0：每隔 N 小时自动推送一次（例如 3 表示每 3 小时发送）。间隔 = 0：每天在指定时间发送一次（北京时间）。每次发送前会检查 IPXO 缓存中近期续费的 IP 段。"
          />

          {/* 定时备份配置 */}
          <Divider orientation="left" plain>
            <Space><DatabaseOutlined />定时数据备份</Space>
          </Divider>

          <Row gutter={16} align="middle">
            <Col span={6}>
              <Form.Item name="backupEnabled" label="启用每日备份" valuePropName="checked">
                <Switch checkedChildren="已启用" unCheckedChildren="已禁用" />
              </Form.Item>
            </Col>
            <Col flex="auto">
              <Alert
                type="info"
                showIcon
                message="每天 03:00（北京时间）自动备份 ip-data.json、users.json 等数据文件到 backups/ 目录，文件名含前一天日期。备份完成后发送 Google Chat 通知。"
                style={{ fontSize: 12 }}
              />
            </Col>
          </Row>

          {config && (
            <div style={{ marginBottom: 16, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6, fontSize: 13, color: '#555' }}>
              上次备份：{config.lastBackupAt
                ? new Date(config.lastBackupAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                : <span style={{ color: '#999' }}>尚未备份</span>}
            </div>
          )}

          {/* 每周汇总通知 */}
          <Divider orientation="left" plain>
            <Space>📊 每周 IP 段汇总</Space>
          </Divider>

          <Row gutter={16} align="middle">
            <Col span={6}>
              <Form.Item name="weeklyReportEnabled" label="启用每周汇总" valuePropName="checked">
                <Switch checkedChildren="已启用" unCheckedChildren="已禁用" />
              </Form.Item>
            </Col>
            <Col flex="auto">
              <Alert
                type="info"
                showIcon
                message="每周一 09:00（北京时间）自动统计上周/上月新购买和续费的 IP 段，以表格形式发送到 Google Chat。"
                style={{ fontSize: 12 }}
              />
            </Col>
          </Row>

          <Form.Item
            name="serverBaseUrl"
            label="服务器访问地址"
            extra="用于在 Chat 通知中生成 Excel 下载链接，如 http://192.168.1.100:8081（留空则不生成链接）"
          >
            <Input placeholder="http://your-server-ip:8081" allowClear />
          </Form.Item>

          {config && (
            <div style={{ marginBottom: 16, padding: '8px 12px', background: '#f5f5f5', borderRadius: 6, fontSize: 13, color: '#555', display: 'flex', alignItems: 'center', gap: 16 }}>
              <span>上次周报：{config.lastWeeklyReportDate
                ? config.lastWeeklyReportDate
                : <span style={{ color: '#999' }}>尚未发送</span>}
              </span>
              <Button
                size="small"
                type="primary"
                ghost
                loading={sendingWeekly}
                disabled={!webhookConfigured}
                onClick={handleSendWeeklyReport}
              >
                立即发送周报
              </Button>
            </div>
          )}

          {/* 邮件配置（折叠，可选） */}
          <Collapse
            ghost
            style={{ marginBottom: 16 }}
            items={[{
              key: 'email',
              label: <Space><MailOutlined /><Text type="secondary">邮件通知（可选，不配置则跳过）</Text></Space>,
              children: (
                <>
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Gmail App Password 说明"
                    description={
                      <Paragraph style={{ margin: 0, fontSize: 12 }}>
                        需要使用「应用专用密码」：前往 <Link href="https://myaccount.google.com/security" target="_blank">Google 安全设置</Link> → 开启两步验证 → 生成应用专用密码（16 位）
                      </Paragraph>
                    }
                  />
                  <Row gutter={16}>
                    <Col span={12}>
                      <Form.Item name="gmailUser" label="Gmail 发件账户">
                        <Input placeholder="example@gmail.com" prefix={<MailOutlined />} />
                      </Form.Item>
                    </Col>
                    <Col span={12}>
                      <Form.Item name="gmailAppPassword" label="App Password">
                        <Input.Password placeholder="留空保留现有密码" autoComplete="new-password" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item
                    name="recipients"
                    label="收件人邮箱"
                    tooltip="输入邮箱地址后按回车添加，可多个"
                  >
                    <Form.Item name="recipients" noStyle>
                      <Input placeholder="输入邮箱后按回车" />
                    </Form.Item>
                  </Form.Item>
                </>
              ),
            }]}
          />

          <Divider />

          <Space>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
              保存配置
            </Button>
            <Button
              icon={<SendOutlined />}
              loading={testing}
              onClick={handleTestSend}
              disabled={!webhookConfigured}
            >
              立即发送提醒
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              <QuestionCircleOutlined style={{ marginRight: 4 }} />
              「立即发送」会根据 IPXO 缓存数据推送近期续费 IP 段
            </Text>
          </Space>
        </Form>
      </Card>
    </div>
  );
};

export default NotifyConfig;
