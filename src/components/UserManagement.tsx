import React, { useState, useEffect, useRef } from 'react';
import {
  Card, Table, Button, Modal, Form, Input, Select, message, Popconfirm, Tag,
  Drawer, Tree, Space, Divider, Badge, Tooltip,
} from 'antd';
import { PlusOutlined, UserOutlined, KeyOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import type { User } from '../types/auth';
import { buildPermTree, ROLE_DEFAULTS } from '../lib/permissions';

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  editor: '编辑',
  viewer: '只读',
};

const PERM_TREE_DATA = buildPermTree();

const ADMIN_ONLY_KEYS = new Set(['user-management', 'remote-sync']);

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
  const { user: currentUser, hasPermission, token } = useAuth();
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
  // For checkStrictly:true, halfCheckedKeys is irrelevant but we track it for the prop
  const halfCheckedRef = useRef<string[]>([]);

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

  useEffect(() => { fetchUsers(); }, []);

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
    const initial = record.permissions ?? ROLE_DEFAULTS[record.role] ?? [];
    setCheckedKeys(initial.filter(k => !ADMIN_ONLY_KEYS.has(k)));
    setPermDrawerOpen(true);
  };

  const applyRolePreset = (role: string) => {
    const preset = (ROLE_DEFAULTS[role] ?? []).filter(k => !ADMIN_ONLY_KEYS.has(k));
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
    { title: '用户名', dataIndex: 'username', key: 'username', width: 120 },
    { title: '显示名称', dataIndex: 'displayName', key: 'displayName', width: 120 },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 100,
      render: (r: string) => <Tag color={r === 'admin' ? 'red' : r === 'editor' ? 'blue' : 'default'}>{ROLE_LABELS[r] || r}</Tag>,
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
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 170, render: (t: string) => t ? new Date(t).toLocaleString('zh-CN') : '-' },
    {
      title: '操作',
      key: 'action',
      width: 200,
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
          <Form.Item name="password" label={editingUser ? '新密码（留空不变）' : '密码'} rules={editingUser ? [] : [{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder={editingUser ? '留空则不修改' : '密码'} />
          </Form.Item>
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
          checkedKeys={{ checked: checkedKeys, halfChecked: halfCheckedRef.current }}
          onCheck={(keys: any) => {
            setCheckedKeys((keys as { checked: string[]; halfChecked: string[] }).checked);
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
