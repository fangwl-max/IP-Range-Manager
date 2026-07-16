import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Modal, Form, Input, Select, message, Popconfirm, Tag } from 'antd';
import { PlusOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import type { User } from '../types/auth';

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  editor: '编辑',
  viewer: '只读',
};

const UserManagement: React.FC = () => {
  const { user, hasPermission, token } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [form] = Form.useForm();

  const fetchUsers = async () => {
    if (!hasPermission('manage_users')) return;
    setLoading(true);
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setUsers(data.users || []);
      else message.error(data.message || '加载用户失败');
    } catch (e) {
      message.error('加载用户失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

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
      const url = '/api/users';
      const body: any = editingUser
        ? { action: 'update', id: editingUser.id, displayName: values.displayName, role: values.role }
        : { action: 'add', username: values.username, password: values.password, displayName: values.displayName, role: values.role };
      if (editingUser && values.password) body.password = values.password;
      const res = await fetch(url, {
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
    } catch (e) {
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
    } catch (e) {
      message.error('删除失败');
    }
  };

  if (!hasPermission('manage_users')) {
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
    { title: '角色', dataIndex: 'role', key: 'role', width: 100, render: (r: string) => <Tag color={r === 'admin' ? 'red' : r === 'editor' ? 'blue' : 'default'}>{ROLE_LABELS[r] || r}</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', width: 180, render: (t: string) => t ? new Date(t).toLocaleString() : '-' },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_: unknown, record: User) => (
        <span>
          <Button type="link" size="small" onClick={() => handleEdit(record)}>编辑</Button>
          {record.username !== 'admin' && (
            <Popconfirm title="确定删除此用户？" onConfirm={() => handleDelete(record.id)}>
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
          )}
        </span>
      ),
    },
  ];

  return (
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
            <Select
              options={[
                { value: 'admin', label: '管理员 - 全部权限' },
                { value: 'editor', label: '编辑 - 可增删改 IP 段' },
                { value: 'viewer', label: '只读 - 仅查看' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};

export default UserManagement;
