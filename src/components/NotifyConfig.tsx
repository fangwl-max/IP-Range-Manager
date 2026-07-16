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

const NotifyConfig: React.FC = () => {
  const [form] = Form.useForm();
  const [config, setConfig] = useState<NotifyConfigData | null>(null);
  const [scheduleStatus, setScheduleStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sendingWeekly, setSendingWeekly] = useState(false);

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
  }, [loadConfig]);

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
