import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card, Form, Input, Button, Space, Typography, Alert, Divider, Tag, message,
  Table, Modal, Switch, Select, Popconfirm, Tooltip, Badge, Spin, Tabs, Empty,
  Row, Col, Collapse,
} from 'antd';
import {
  MailOutlined, PlusOutlined, DeleteOutlined, SaveOutlined, SyncOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ExclamationCircleOutlined,
  FilterOutlined, SendOutlined, EditOutlined, CopyOutlined, EyeOutlined,
  QuestionCircleOutlined, ReloadOutlined, SettingOutlined, UserOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

/* ------------------------------------------------------------------ */
/*  types                                                              */
/* ------------------------------------------------------------------ */
interface FilterCriteria {
  from?: string;
  subject?: string;
  has_words?: string;
}

interface FilterActions {
  forward?: boolean;
  label?: string;
  mark_read?: boolean;
  archive?: boolean;
  star?: boolean;
}

interface FilterRule {
  name: string;
  criteria: FilterCriteria;
  actions: FilterActions;
}

interface GmailFilterConfig {
  forward_to: string;
  accounts: string[];
  filter_rules: FilterRule[];
  credentials_set?: boolean;
}

interface AccountStatus {
  account: string;
  authed: boolean;
  forwarding_verified: boolean;
  filters_count: number;
}

interface SetupResult {
  account: string;
  status: 'success' | 'auth_failed' | 'forwarding_pending' | 'error';
  filters: { name: string; success: boolean }[];
  errors: string[];
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */
function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('auth_token') || '';
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function api<T = any>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...opts?.headers } });
  const json = await res.json();
  if (!json.success) throw new Error(json.message || '请求失败');
  return json;
}

/* ------------------------------------------------------------------ */
/*  default filter rules template                                      */
/* ------------------------------------------------------------------ */
const DEFAULT_RULES: FilterRule[] = [
  {
    name: 'OVH Abuse / Ticket',
    criteria: { from: '(@ovh.com OR @ovhcloud.com)' },
    actions: { forward: true, label: 'Abuse/OVH', mark_read: false, archive: false },
  },
  {
    name: 'Hetzner Abuse',
    criteria: { from: 'abuse@hetzner.com' },
    actions: { forward: true, label: 'Abuse/Hetzner', mark_read: false, archive: false },
  },
  {
    name: 'Leaseweb Abuse',
    criteria: { from: '(@leaseweb.com)' },
    actions: { forward: true, label: 'Abuse/Leaseweb', mark_read: false, archive: false },
  },
];

/* ================================================================== */
/*  Component                                                          */
/* ================================================================== */
const GmailFilterSetup: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<GmailFilterConfig>({
    forward_to: '',
    accounts: [],
    filter_rules: DEFAULT_RULES,
  });
  const [accountStatuses, setAccountStatuses] = useState<AccountStatus[]>([]);
  const [setupResults, setSetupResults] = useState<SetupResult[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployingAccount, setDeployingAccount] = useState<string | null>(null);

  /* rule edit modal */
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRuleIdx, setEditingRuleIdx] = useState<number | null>(null);
  const [ruleForm] = Form.useForm();

  /* account add */
  const [addAccountVal, setAddAccountVal] = useState('');

  /* credentials upload */
  const fileRef = useRef<HTMLInputElement>(null);

  /* ---------------------------------------------------------------- */
  /*  load config                                                      */
  /* ---------------------------------------------------------------- */
  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api<{ config: GmailFilterConfig }>('/api/gmail-filter/config');
      setConfig(data.config);
    } catch {
      /* first time — use defaults */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStatuses = useCallback(async () => {
    try {
      const data = await api<{ statuses: AccountStatus[] }>('/api/gmail-filter/status');
      setAccountStatuses(data.statuses);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConfig(); loadStatuses(); }, [loadConfig, loadStatuses]);

  /* ---------------------------------------------------------------- */
  /*  save config                                                      */
  /* ---------------------------------------------------------------- */
  const saveConfig = async () => {
    if (!config.forward_to) { message.warning('请填写转发目标邮箱'); return; }
    if (config.accounts.length === 0) { message.warning('请添加至少一个 Gmail 账号'); return; }
    try {
      setSaving(true);
      await api('/api/gmail-filter/config', { method: 'POST', body: JSON.stringify(config) });
      message.success('配置已保存');
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  upload credentials.json                                          */
  /* ---------------------------------------------------------------- */
  const handleCredentialsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      JSON.parse(text); // validate JSON
      await api('/api/gmail-filter/credentials', { method: 'POST', body: JSON.stringify({ credentials: text }) });
      message.success('OAuth 凭证已上传');
      loadConfig();
    } catch (err: any) {
      message.error('上传失败: ' + (err.message || '无效的 JSON 文件'));
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  /* ---------------------------------------------------------------- */
  /*  account management                                               */
  /* ---------------------------------------------------------------- */
  const addAccount = () => {
    const email = addAccountVal.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { message.warning('邮箱格式不正确'); return; }
    if (config.accounts.includes(email)) { message.warning('该账号已存在'); return; }
    setConfig(c => ({ ...c, accounts: [...c.accounts, email] }));
    setAddAccountVal('');
  };

  const addAccountsBatch = () => {
    Modal.confirm({
      title: '批量添加账号',
      icon: <PlusOutlined />,
      content: (
        <div>
          <Text type="secondary" style={{ marginBottom: 8, display: 'block' }}>每行一个 Gmail 地址</Text>
          <TextArea id="batch-emails" rows={8} placeholder={'account1@gmail.com\naccount2@gmail.com'} />
        </div>
      ),
      onOk: () => {
        const el = document.getElementById('batch-emails') as HTMLTextAreaElement;
        if (!el) return;
        const lines = el.value.split('\n').map(l => l.trim().toLowerCase()).filter(l => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(l));
        const unique = [...new Set([...config.accounts, ...lines])];
        setConfig(c => ({ ...c, accounts: unique }));
        message.success(`已添加 ${unique.length - config.accounts.length} 个新账号`);
      },
    });
  };

  const removeAccount = (email: string) => {
    setConfig(c => ({ ...c, accounts: c.accounts.filter(a => a !== email) }));
  };

  /* ---------------------------------------------------------------- */
  /*  rule management                                                  */
  /* ---------------------------------------------------------------- */
  const openRuleModal = (idx?: number) => {
    if (idx !== undefined) {
      setEditingRuleIdx(idx);
      const rule = config.filter_rules[idx];
      ruleForm.setFieldsValue({
        name: rule.name,
        from: rule.criteria.from || '',
        subject: rule.criteria.subject || '',
        has_words: rule.criteria.has_words || '',
        forward: rule.actions.forward ?? true,
        label: rule.actions.label || '',
        mark_read: rule.actions.mark_read ?? false,
        archive: rule.actions.archive ?? false,
        star: rule.actions.star ?? false,
      });
    } else {
      setEditingRuleIdx(null);
      ruleForm.resetFields();
      ruleForm.setFieldsValue({ forward: true, mark_read: false, archive: false, star: false });
    }
    setRuleModalOpen(true);
  };

  const saveRule = () => {
    ruleForm.validateFields().then(vals => {
      const rule: FilterRule = {
        name: vals.name,
        criteria: {
          ...(vals.from ? { from: vals.from } : {}),
          ...(vals.subject ? { subject: vals.subject } : {}),
          ...(vals.has_words ? { has_words: vals.has_words } : {}),
        },
        actions: {
          forward: vals.forward,
          label: vals.label || undefined,
          mark_read: vals.mark_read,
          archive: vals.archive,
          star: vals.star,
        },
      };
      setConfig(c => {
        const rules = [...c.filter_rules];
        if (editingRuleIdx !== null) {
          rules[editingRuleIdx] = rule;
        } else {
          rules.push(rule);
        }
        return { ...c, filter_rules: rules };
      });
      setRuleModalOpen(false);
    });
  };

  const removeRule = (idx: number) => {
    setConfig(c => ({ ...c, filter_rules: c.filter_rules.filter((_, i) => i !== idx) }));
  };

  /* ---------------------------------------------------------------- */
  /*  deploy to Gmail                                                  */
  /* ---------------------------------------------------------------- */
  const deployAll = async () => {
    if (!config.credentials_set) { message.error('请先上传 OAuth 凭证'); return; }
    try {
      setDeploying(true);
      setSetupResults([]);
      await saveConfig();
      const data = await api<{ results: SetupResult[] }>('/api/gmail-filter/deploy', { method: 'POST' });
      setSetupResults(data.results);
      const ok = data.results.filter(r => r.status === 'success').length;
      const fail = data.results.length - ok;
      if (fail === 0) message.success(`全部 ${ok} 个账号配置成功`);
      else message.warning(`${ok} 成功，${fail} 失败/待验证`);
      loadStatuses();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDeploying(false);
    }
  };

  const deploySingle = async (account: string) => {
    if (!config.credentials_set) { message.error('请先上传 OAuth 凭证'); return; }
    try {
      setDeployingAccount(account);
      await saveConfig();
      const data = await api<{ result: SetupResult }>('/api/gmail-filter/deploy', {
        method: 'POST',
        body: JSON.stringify({ account }),
      });
      setSetupResults(prev => {
        const others = prev.filter(r => r.account !== account);
        return [...others, data.result];
      });
      if (data.result.status === 'success') message.success(`${account} 配置成功`);
      else message.warning(`${account}: ${data.result.errors.join('; ') || data.result.status}`);
      loadStatuses();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDeployingAccount(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  get auth URL for account                                         */
  /* ---------------------------------------------------------------- */
  const getAuthUrl = async (account: string) => {
    try {
      const data = await api<{ url: string }>('/api/gmail-filter/auth-url', {
        method: 'POST',
        body: JSON.stringify({ account }),
      });
      window.open(data.url, '_blank');
    } catch (e: any) {
      message.error(e.message);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  render: rule columns                                             */
  /* ---------------------------------------------------------------- */
  const ruleColumns = [
    {
      title: '规则名称',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: '过滤条件',
      key: 'criteria',
      render: (_: any, r: FilterRule) => (
        <Space direction="vertical" size={0}>
          {r.criteria.from && <Text><Tag color="blue">From</Tag>{r.criteria.from}</Text>}
          {r.criteria.subject && <Text><Tag color="orange">Subject</Tag>{r.criteria.subject}</Text>}
          {r.criteria.has_words && <Text><Tag color="green">Contains</Tag>{r.criteria.has_words}</Text>}
        </Space>
      ),
    },
    {
      title: '动作',
      key: 'actions',
      width: 260,
      render: (_: any, r: FilterRule) => (
        <Space wrap>
          {r.actions.forward && <Tag icon={<SendOutlined />} color="processing">转发</Tag>}
          {r.actions.label && <Tag icon={<FilterOutlined />} color="default">{r.actions.label}</Tag>}
          {r.actions.mark_read && <Tag color="default">标记已读</Tag>}
          {r.actions.archive && <Tag color="default">归档</Tag>}
          {r.actions.star && <Tag color="gold">加星</Tag>}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, __: FilterRule, idx: number) => (
        <Space>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openRuleModal(idx)} />
          <Popconfirm title="确定删除此规则？" onConfirm={() => removeRule(idx)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  /* ---------------------------------------------------------------- */
  /*  render: account columns                                          */
  /* ---------------------------------------------------------------- */
  const statusMap: Record<string, AccountStatus> = {};
  accountStatuses.forEach(s => { statusMap[s.account] = s; });

  const accountColumns = [
    {
      title: '账号',
      dataIndex: 'email',
      key: 'email',
      render: (v: string) => <Text copyable>{v}</Text>,
    },
    {
      title: '授权状态',
      key: 'auth',
      width: 120,
      render: (_: any, r: { email: string }) => {
        const s = statusMap[r.email];
        if (!s) return <Tag>未检测</Tag>;
        return s.authed
          ? <Tag icon={<CheckCircleOutlined />} color="success">已授权</Tag>
          : <Tag icon={<CloseCircleOutlined />} color="error">未授权</Tag>;
      },
    },
    {
      title: '转发验证',
      key: 'fwd',
      width: 120,
      render: (_: any, r: { email: string }) => {
        const s = statusMap[r.email];
        if (!s) return <Tag>未检测</Tag>;
        return s.forwarding_verified
          ? <Tag icon={<CheckCircleOutlined />} color="success">已验证</Tag>
          : <Tag icon={<ExclamationCircleOutlined />} color="warning">待验证</Tag>;
      },
    },
    {
      title: '已部署规则',
      key: 'filters',
      width: 100,
      render: (_: any, r: { email: string }) => {
        const s = statusMap[r.email];
        return s ? <Text>{s.filters_count} 条</Text> : <Text type="secondary">-</Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_: any, r: { email: string }) => {
        const s = statusMap[r.email];
        const result = setupResults.find(sr => sr.account === r.email);
        return (
          <Space>
            {(!s || !s.authed) && (
              <Tooltip title="在新标签页中打开 Google 授权页面">
                <Button size="small" icon={<UserOutlined />} onClick={() => getAuthUrl(r.email)}>授权</Button>
              </Tooltip>
            )}
            <Button
              size="small"
              type="primary"
              icon={<SyncOutlined spin={deployingAccount === r.email} />}
              loading={deployingAccount === r.email}
              onClick={() => deploySingle(r.email)}
            >
              部署
            </Button>
            <Popconfirm title={`移除 ${r.email}？`} onConfirm={() => removeAccount(r.email)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
            {result && (
              <Tooltip title={result.errors.length ? result.errors.join('\n') : '全部成功'}>
                {result.status === 'success'
                  ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                  : <ExclamationCircleOutlined style={{ color: '#faad14' }} />}
              </Tooltip>
            )}
          </Space>
        );
      },
    },
  ];

  /* ---------------------------------------------------------------- */
  /*  render                                                           */
  /* ---------------------------------------------------------------- */
  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <MailOutlined style={{ marginRight: 8 }} />Gmail 邮件转发规则
          </Title>
          <Text type="secondary">批量为多个 Gmail 账号配置过滤器，自动转发 Abuse 邮件到统一邮箱</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { loadConfig(); loadStatuses(); }}>刷新</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={saveConfig}>保存配置</Button>
        </Space>
      </div>

      {/* ---- Step 1: OAuth 凭证 ---- */}
      <Card
        size="small"
        title={<><SettingOutlined /> 步骤一：OAuth 凭证</>}
        style={{ marginBottom: 16 }}
        extra={
          config.credentials_set
            ? <Tag icon={<CheckCircleOutlined />} color="success">已配置</Tag>
            : <Tag icon={<CloseCircleOutlined />} color="error">未配置</Tag>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="如何获取 OAuth 凭证"
          description={
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>打开 <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a></li>
              <li>创建项目 → 启用 <strong>Gmail API</strong></li>
              <li>创建凭据 → OAuth 客户端 ID → 应用类型选 <strong>Web 应用</strong></li>
              <li>
                添加已获授权的重定向 URI：<br />
                <Text code copyable>{`${window.location.origin}/api/gmail-filter/oauth-callback`}</Text>
              </li>
              <li>配置 OAuth 同意屏幕，添加测试用户（你的所有 Gmail 地址）</li>
              <li>下载凭证 JSON 并上传到此处</li>
            </ol>
          }
        />
        <Space>
          <input
            type="file"
            accept=".json"
            ref={fileRef}
            style={{ display: 'none' }}
            onChange={handleCredentialsUpload}
          />
          <Button
            icon={<SettingOutlined />}
            onClick={() => fileRef.current?.click()}
          >
            {config.credentials_set ? '重新上传凭证' : '上传 credentials.json'}
          </Button>
        </Space>
      </Card>

      {/* ---- Step 2: 转发目标 ---- */}
      <Card size="small" title={<><SendOutlined /> 步骤二：转发目标</>} style={{ marginBottom: 16 }}>
        <Form layout="inline">
          <Form.Item label="统一接收邮箱" style={{ flex: 1 }}>
            <Input
              placeholder="abuse@yourdomain.com"
              value={config.forward_to}
              onChange={e => setConfig(c => ({ ...c, forward_to: e.target.value }))}
              style={{ maxWidth: 400 }}
            />
          </Form.Item>
        </Form>
        <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
          <InfoCircleOutlined /> 所有匹配规则的邮件将自动转发到此邮箱。首次部署时 Gmail 会向该邮箱发送验证邮件，需点击确认。
        </Text>
      </Card>

      {/* ---- Step 3: 账号管理 ---- */}
      <Card
        size="small"
        title={<><UserOutlined /> 步骤三：Gmail 账号 ({config.accounts.length})</>}
        style={{ marginBottom: 16 }}
        extra={
          <Space>
            <Button size="small" icon={<PlusOutlined />} onClick={addAccountsBatch}>批量添加</Button>
          </Space>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <Space.Compact style={{ width: '100%', maxWidth: 500 }}>
            <Input
              placeholder="输入 Gmail 地址"
              value={addAccountVal}
              onChange={e => setAddAccountVal(e.target.value)}
              onPressEnter={addAccount}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={addAccount}>添加</Button>
          </Space.Compact>
        </div>

        {config.accounts.length === 0 ? (
          <Empty description="暂无账号" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            dataSource={config.accounts.map(email => ({ email, key: email }))}
            columns={accountColumns}
            pagination={false}
            size="small"
            scroll={{ x: 700 }}
          />
        )}
      </Card>

      {/* ---- Step 4: 过滤规则 ---- */}
      <Card
        size="small"
        title={<><FilterOutlined /> 步骤四：过滤规则 ({config.filter_rules.length})</>}
        style={{ marginBottom: 16 }}
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openRuleModal()}>
            新增规则
          </Button>
        }
      >
        <Table
          dataSource={config.filter_rules.map((r, i) => ({ ...r, key: i }))}
          columns={ruleColumns}
          pagination={false}
          size="small"
          scroll={{ x: 600 }}
        />
      </Card>

      {/* ---- Deploy ---- */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <Title level={5} style={{ margin: 0 }}>部署到 Gmail</Title>
            <Text type="secondary">将上述过滤规则批量写入每个 Gmail 账号</Text>
          </div>
          <Button
            type="primary"
            size="large"
            icon={<SyncOutlined spin={deploying} />}
            loading={deploying}
            onClick={deployAll}
            disabled={!config.credentials_set || config.accounts.length === 0}
          >
            一键部署全部账号
          </Button>
        </div>

        {setupResults.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <Divider style={{ margin: '12px 0' }} />
            <Title level={5}>部署结果</Title>
            {setupResults.map(r => (
              <div key={r.account} style={{ marginBottom: 8 }}>
                <Space>
                  {r.status === 'success'
                    ? <Badge status="success" />
                    : r.status === 'forwarding_pending'
                      ? <Badge status="warning" />
                      : <Badge status="error" />}
                  <Text strong>{r.account}</Text>
                  <Text type="secondary">
                    {r.status === 'success' && `${r.filters.filter(f => f.success).length}/${r.filters.length} 规则创建成功`}
                    {r.status === 'forwarding_pending' && '转发地址待验证'}
                    {r.status === 'auth_failed' && '授权失败'}
                    {r.status === 'error' && (r.errors[0] || '未知错误')}
                  </Text>
                </Space>
                {r.errors.length > 0 && (
                  <div style={{ marginLeft: 24, marginTop: 4 }}>
                    {r.errors.map((err, i) => (
                      <Text key={i} type="warning" style={{ display: 'block', fontSize: 12 }}>⚠ {err}</Text>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ---- Rule Edit Modal ---- */}
      <Modal
        title={editingRuleIdx !== null ? '编辑规则' : '新增规则'}
        open={ruleModalOpen}
        onOk={saveRule}
        onCancel={() => setRuleModalOpen(false)}
        width={560}
        destroyOnClose
      >
        <Form form={ruleForm} layout="vertical">
          <Form.Item label="规则名称" name="name" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input placeholder="如: OVH Abuse" />
          </Form.Item>
          <Divider orientation="left">过滤条件</Divider>
          <Form.Item label="发件人 (From)" name="from"
            tooltip="支持 Gmail 语法，如 (@ovh.com OR @ovhcloud.com)"
          >
            <Input placeholder="abuse@ovh.com 或 (@ovh.com OR @ovhcloud.com)" />
          </Form.Item>
          <Form.Item label="主题包含 (Subject)" name="subject">
            <Input placeholder="如: abuse" />
          </Form.Item>
          <Form.Item label="正文包含" name="has_words">
            <Input placeholder="如: IP address" />
          </Form.Item>
          <Divider orientation="left">执行动作</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="转发到目标邮箱" name="forward" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="加星标" name="star" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="添加标签" name="label"
            tooltip="支持嵌套标签，如 Abuse/OVH"
          >
            <Input placeholder="如: Abuse/OVH" />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="标记已读" name="mark_read" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="跳过收件箱(归档)" name="archive" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
};

export default GmailFilterSetup;
