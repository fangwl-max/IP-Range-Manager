import React, { useState, useEffect } from 'react';
import {
  Card, Table, Button, Modal, Form, Input, Select, message, Popconfirm, Tag,
  Drawer, Tree, Space, Divider, Badge, Tooltip, Switch,
} from 'antd';
import { PlusOutlined, UserOutlined, KeyOutlined, SettingOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import type { User } from '../types/auth';
import { buildPermTree, ROLE_DEFAULTS, PAGE_PERMS } from '../lib/permissions';

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  editor: '编辑',
  viewer: '只读',
};

const PERM_TREE_DATA = buildPermTree();

// Bug 3 fix: remote-sync 不是管理员专属，编辑者可拥有此权限
const ADMIN_ONLY_KEYS = new Set(['user-management']);

function allTreeKeys(): string[] {
  const keys: string[] = [];
  PERM_TREE_DATA.forEach(node => {
    if (!ADMIN_ONLY_KEYS.has(node.key)) {
      keys.push(node.key);
      (node.children || []).forEach(c => keys.push(c.key));
    }
  });
  return keys;
}

const ALL_GRANTABLE_KEYS = allTreeKeys();

const UserManagement: React.FC = () => {
  const { user: currentUser, hasPermission, token, refreshUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form] = Form.useForm();

  // Permission editor state
  const [permDrawerOpen, setPermDrawerOpen] = useState(false);
  const [permTargetUser, setPermTargetUser] = useState<User | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<string[]>([]);
  const [savingPerms, setSavingPerms] = useState(false);

  // 平台设置
  const [restrictIpAccess, setRestrictIpAccess] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);

  const fetchPlatformSettings = async () => {
    try {
      const res = await fetch('/api/admin/platform-settings', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json.success) setRestrictIpAccess(!!json.settings?.restrict_ip_access);
    } catch {}
  };

  const handleRestrictIpToggle = async (checked: boolean) => {
    setSettingsLoading(true);
    try {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ restrict_ip_access: checked }),
      });
      const json = await res.json();
      if (json.success) {
        setRestrictIpAccess(checked);
        message.success(checked ? '已开启：仅域名可访问' : '已关闭：IP+端口访问已允许');
      } else {
        message.error(json.message || '设置失败');
      }
    } catch (e: any) {
      message.error('请求失败: ' + e.message);
    } finally {
      setSettingsLoading(false);
    }
  };

  const fetchUsers = async () => {
    if (!hasPermission('user-management')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setUsers(data.users || []);
      else message.error(data.message || '加载用户失败');
    } catch {
      message.error('加载用户失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchUsers(); fetchPlatformSettings(); }, []);

  const handleAdd = () => {
    setEditingUser(null);
    form.resetFields();
    setModalVisible(true);
  };

  const handleEdit = (record: User) => {
    setEditingUser(record);
    form.setFieldsValue({ username: record.username, displayName: record.displayName, role: record.role, password: '' });
    setModalVisible(true);
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      const body: any = editingUser
        ? { action: 'update', id: editingUser.id, displayName: values.displayName, role: values.role }
        : { action: 'add', username: values.username, password: values.password, displayName: values.displayName, role: values.role };
      if (editingUser && values.password) body.password = values.password;
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        message.success(editingUser ? '保存成功' : '添加成功');
        setModalVisible(false);
        fetchUsers();
      } else {
        message.error(data.message || '操作失败');
      }
    } catch {
      message.error('操作失败');
    }
  };

  const handleToggleDisabled = async (record: User) => {
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'toggle-disabled', id: record.id }),
      });
      const data = await res.json();
      if (data.success) {
        message.success(data.disabled ? `已禁用用户 ${record.username}` : `已启用用户 ${record.username}`);
        fetchUsers();
      } else {
        message.error(data.message || '操作失败');
      }
    } catch {
      message.error('操作失败');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const data = await res.json();
      if (data.success) {
        message.success('删除成功');
        fetchUsers();
      } else {
        message.error(data.message || '删除失败');
      }
    } catch {
      message.error('删除失败');
    }
  };

  const openPermDrawer = (record: User) => {
    setPermTargetUser(record);
    const raw = record.permissions ?? ROLE_DEFAULTS[record.role] ?? [];
    const permsSet = new Set(raw.filter((k: string) => !ADMIN_ONLY_KEYS.has(k)));
    // Bug 2 backward-compat fix: 若历史数据只存了页面 key 而无任何功能 key，
    // 自动补全所有功能 key（仅对显式设置过的 permissions 执行，ROLE_DEFAULTS 本身已正确）
    if (Array.isArray(record.permissions)) {
      for (const [pageKey, node] of Object.entries(PAGE_PERMS)) {
        if (!node.features || !permsSet.has(pageKey)) continue;
        const hasAnyFeature = Object.keys(node.features).some(fk => permsSet.has(`${pageKey}.${fk}`));
        if (!hasAnyFeature) {
          Object.keys(node.features).forEach(fk => permsSet.add(`${pageKey}.${fk}`));
        }
      }
    }
    setCheckedKeys([...permsSet]);
    setPermDrawerOpen(true);
  };

  const applyRolePreset = (role: string) => {
    const preset = (ROLE_DEFAULTS[role] ?? []).filter((k: string) => !ADMIN_ONLY_KEYS.has(k));
    setCheckedKeys(preset);
  };

  const handleSavePerms = async () => {
    if (!permTargetUser) return;
    setSavingPerms(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'set-permissions', id: permTargetUser.id, permissions: checkedKeys }),
      });
      const data = await res.json();
      if (data.success) {
        message.success('权限已保存');
        setPermDrawerOpen(false);
        fetchUsers();
        // 若修改的是当前登录用户，立即刷新 AuthContext 以更新前端权限
        if (permTargetUser.id === currentUser?.id) {
          await refreshUser();
        }
      } else {
        message.error(data.message || '保存失败');
      }
    } catch {
      message.error('保存失败');
    } finally {
      setSavingPerms(false);
    }
  };

  const handleResetPerms = async (record: User) => {
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'set-permissions', id: record.id, permissions: null }),
      });
      const data = await res.json();
      if (data.success) {
        message.success('已恢复角色默认权限');
        fetchUsers();
      } else {
        message.error(data.message || '操作失败');
      }
    } catch {
      message.error('操作失败');
    }
  };

  if (!hasPermission('user-management')) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>
          无权限查看用户管理
        </div>
      </Card>
    );
  }

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
      width: 120,
      render: (name: string, record: User) => (
        <Space size={4}>
          <span style={record.disabled ? { color: '#bbb', textDecoration: 'line-through' } : undefined}>{name}</span>
          {record.disabled && <Tag color="red" style={{ marginInlineStart: 0 }}>已禁用</Tag>}
        </Space>
      ),
    },
    { title: '显示名称', dataIndex: 'displayName', key: 'displayName', width: 120 },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 90,
      render: (r: string) => <Tag color={r === 'admin' ? 'red' : r === 'editor' ? 'blue' : 'default'}>{ROLE_LABELS[r] || r}</Tag>,
    },
    {
      title: '登录方式',
      key: 'loginType',
      width: 100,
      render: (_: unknown, record: User) => {
        if (record.loginType === 'google') {
          return (
            <Tooltip title={record.googleEmail}>
              <Tag color="geekblue">Google</Tag>
            </Tooltip>
          );
        }
        return <Tag>密码</Tag>;
      },
    },
    {
      title: '权限配置',
      key: 'permissions',
      width: 130,
      render: (_: unknown, record: User) => {
        if (record.role === 'admin') return <Tag color="red">管理员（全部）</Tag>;
        if (record.permissions) return <Tag color="purple">自定义（{record.permissions.length} 项）</Tag>;
        return <Tag color="default">角色默认</Tag>;
      },
    },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 160, render: (t: string) => t ? new Date(t).toLocaleString('zh-CN') : '-' },
    {
      title: '操作',
      key: 'action',
      width: 240,
      render: (_: unknown, record: User) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>编辑</Button>
          {record.role !== 'admin' && (
            <>
              <Divider type="vertical" />
              <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => openPermDrawer(record)}>
                设置权限
              </Button>
              {record.permissions && (
                <>
                  <Divider type="vertical" />
                  <Popconfirm title="恢复为角色默认权限？" onConfirm={() => handleResetPerms(record)} okText="恢复" cancelText="取消">
                    <Button type="link" size="small">重置</Button>
                  </Popconfirm>
                </>
              )}
            </>
          )}
          {record.username !== 'admin' && record.id !== currentUser?.id && (
            <>
              <Divider type="vertical" />
              <Popconfirm
                title={record.disabled ? `确定启用用户 ${record.username}？` : `确定禁用用户 ${record.username}？`}
                onConfirm={() => handleToggleDisabled(record)}
                okText={record.disabled ? '启用' : '禁用'}
                cancelText="取消"
                okButtonProps={{ danger: !record.disabled }}
              >
                <Button type="link" size="small" danger={!record.disabled} style={record.disabled ? { color: '#52c41a' } : undefined}>
                  {record.disabled ? '启用' : '禁用'}
                </Button>
              </Popconfirm>
            </>
          )}
          {record.username !== 'admin' && (
            <>
              <Divider type="vertical" />
              <Popconfirm title="确定删除此用户？" onConfirm={() => handleDelete(record.id)} okText="删除" cancelText="取消">
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  const isSelf = permTargetUser?.id === currentUser?.id;

  return (
    <>
      {currentUser?.role === 'admin' && (
        <Card
          title={<><SettingOutlined style={{ marginRight: 8 }} />平台设置</>}
          style={{ marginBottom: 16 }}
          size="small"
        >
          <Space align="center">
            <Switch
              checked={restrictIpAccess}
              loading={settingsLoading}
              onChange={handleRestrictIpToggle}
            />
            <span style={{ fontWeight: 500 }}>禁止通过 IP+端口直接访问</span>
            <span style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
              开启后仅允许通过域名访问，直接使用 IP 地址访问将返回 403
            </span>
          </Space>
        </Card>
      )}

      <Card
        title={<><UserOutlined style={{ marginRight: 8 }} />用户与权限管理</>}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
            添加用户
          </Button>
        }
      >
        <Table
          dataSource={users}
          columns={columns}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="small"
        />
      </Card>

      {/* 添加/编辑用户 Modal */}
      <Modal
        title={editingUser ? '编辑用户' : '添加用户'}
        open={modalVisible}
        onOk={handleSubmit}
        onCancel={() => setModalVisible(false)}
        okText="确定"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: !editingUser, message: '请输入用户名' }]}>
            <Input disabled={!!editingUser} placeholder="登录用户名" />
          </Form.Item>
          {editingUser?.loginType !== 'google' && (
            <Form.Item name="password" label={editingUser ? '新密码（留空不变）' : '密码'} rules={editingUser ? [] : [{ required: true, message: '请输入密码' }]}>
              <Input.Password placeholder={editingUser ? '留空则不修改' : '密码'} />
            </Form.Item>
          )}
          {editingUser?.loginType === 'google' && editingUser.googleEmail && (
            <Form.Item label="Google 邮箱">
              <Input disabled value={editingUser.googleEmail} />
            </Form.Item>
          )}
          <Form.Item name="displayName" label="显示名称">
            <Input placeholder="用于显示的昵称" />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]} initialValue="viewer">
            <Select options={[
              { value: 'admin', label: '管理员 — 全部权限' },
              { value: 'editor', label: '编辑 — 可增删改 IP 段' },
              { value: 'viewer', label: '只读 — 仅查看' },
            ]} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 权限设置 Drawer */}
      <Drawer
        title={
          <Space>
            <KeyOutlined />
            设置权限
            {permTargetUser && (
              <span style={{ fontWeight: 400, color: '#555' }}>— {permTargetUser.displayName || permTargetUser.username}</span>
            )}
          </Space>
        }
        placement="right"
        width={440}
        open={permDrawerOpen}
        onClose={() => setPermDrawerOpen(false)}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <Button onClick={() => setPermDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={savingPerms} onClick={handleSavePerms}>
              保存权限
            </Button>
          </div>
        }
      >
        {isSelf && (
          <div style={{ marginBottom: 12, color: '#faad14', fontSize: 13 }}>
            注意：修改自己的权限将在下次登录后生效。
          </div>
        )}

        {/* 快速预设 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ marginBottom: 8, fontWeight: 500, fontSize: 13 }}>按角色快速预设</div>
          <Space wrap>
            <Button size="small" onClick={() => applyRolePreset('editor')}>编辑者默认</Button>
            <Button size="small" onClick={() => applyRolePreset('viewer')}>只读默认</Button>
            <Divider type="vertical" />
            <Button size="small" onClick={() => setCheckedKeys(ALL_GRANTABLE_KEYS)}>全选</Button>
            <Button size="small" danger onClick={() => setCheckedKeys([])}>清空</Button>
          </Space>
        </div>

        <Divider style={{ margin: '12px 0' }} />

        <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>
          勾选页面 = 菜单可见 / 可进入；勾选功能 = 页面内操作可用
        </div>

        <Tree
          checkable
          checkStrictly
          defaultExpandAll
          treeData={PERM_TREE_DATA}
          checkedKeys={checkedKeys}
          onCheck={(rawKeys: any) => {
            // checkStrictly 模式下 rawKeys 为 { checked, halfChecked }
            const newKeys: string[] = Array.isArray(rawKeys) ? rawKeys : rawKeys.checked;
            const prevSet = new Set(checkedKeys);
            const newSet = new Set(newKeys);

            // 级联：勾选/取消页面 → 同步其所有功能 key
            for (const [pageKey, node] of Object.entries(PAGE_PERMS)) {
              if (!node.features || node.adminOnly) continue;
              const featureKeys = Object.keys(node.features).map(fk => `${pageKey}.${fk}`);
              if (newSet.has(pageKey) && !prevSet.has(pageKey)) {
                featureKeys.forEach(k => newSet.add(k));
              } else if (!newSet.has(pageKey) && prevSet.has(pageKey)) {
                featureKeys.forEach(k => newSet.delete(k));
              }
            }

            // 保证：有任意功能 key → 父页面 key 必须存在
            for (const [pageKey, node] of Object.entries(PAGE_PERMS)) {
              if (!node.features || node.adminOnly) continue;
              const featureKeys = Object.keys(node.features).map(fk => `${pageKey}.${fk}`);
              if (featureKeys.some(k => newSet.has(k)) && !newSet.has(pageKey)) {
                newSet.add(pageKey);
              }
            }

            setCheckedKeys([...newSet]);
          }}
        />

        <div style={{ marginTop: 16, fontSize: 12, color: '#aaa' }}>
          <Badge color="purple" text={`当前已选 ${checkedKeys.length} 项权限`} />
        </div>
      </Drawer>
    </>
  );
};

export default UserManagement;
