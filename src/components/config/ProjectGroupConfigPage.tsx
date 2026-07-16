import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Space, Tag, Row, Col, Typography, Divider, Empty, Modal, message } from 'antd';
import { PlusOutlined, CheckCircleOutlined, EditOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { ProjectGroup } from '../../types';
import { projectGroupStorage, ipSegmentStorage } from '../../utils/storage';
import { useAuth } from '../../contexts/AuthContext';
import { saveConfigDataToFile } from './saveConfigData';
import { checkProjectGroupInUse } from './configInUse';
import { ConfigListItemRow } from './ConfigListItemRow';
import { ConfigPageShell } from './ConfigPageShell';

const { Text } = Typography;

const ProjectGroupConfigPage: React.FC = () => {
  const { hasPermission } = useAuth();
  const canManageConfig = hasPermission('manage_config');
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [projectGroupForm] = Form.useForm();

  // 从文件加载最新数据，确保配置页数据与 ip-data.json 同步
  useEffect(() => {
    const loadFromFile = async () => {
      try {
        const res = await fetch('/api/get-data');
        if (res.ok) {
          const data = await res.json();
          if (data?.projectGroups) {
            projectGroupStorage.save(data.projectGroups);
          }
        }
      } catch (_) { /* 降级使用 localStorage */ }
      setProjectGroups(projectGroupStorage.getAll());
    };
    void loadFromFile();
  }, []);

  const handleAddProjectGroup = async () => {
    try {
      const values = await projectGroupForm.validateFields();
      const trimmedName = values.name.trim();
      const existingGroups = projectGroupStorage.getAll();
      if (existingGroups.find((g) => g.name === trimmedName)) {
        message.warning(`项目组 "${trimmedName}" 已存在`);
        return;
      }
      const newGroup: ProjectGroup = { id: `pg-${Date.now()}`, name: trimmedName };
      projectGroupStorage.add(newGroup);
      setProjectGroups(projectGroupStorage.getAll());
      projectGroupForm.resetFields();
      await saveConfigDataToFile();
      message.success('项目组添加成功');
    } catch (error) {
      console.error('添加失败:', error);
    }
  };

  const handleDeleteProjectGroup = (groupId: string, groupName: string) => {
    if (checkProjectGroupInUse(groupName)) {
      Modal.warning({
        title: '无法删除',
        icon: <ExclamationCircleOutlined />,
        content: `项目组 "${groupName}" 正在被使用，无法删除。请先修改相关IP段的项目组设置。`,
        okText: '知道了',
      });
      return;
    }
    Modal.confirm({
      title: '确认删除项目组',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除项目组 "${groupName}" 吗？此操作不可恢复。`,
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => {
        projectGroupStorage.delete(groupId);
        setProjectGroups(projectGroupStorage.getAll());
        void saveConfigDataToFile();
        message.success('项目组删除成功');
      },
    });
  };

  const handleEditProjectGroup = (groupId: string, oldName: string) => {
    let inputValue = oldName;
    Modal.confirm({
      title: '编辑项目组',
      icon: <EditOutlined />,
      width: 400,
      content: (
        <Input
          placeholder="输入新的项目组名称"
          defaultValue={oldName}
          autoFocus
          onChange={(e) => {
            inputValue = e.target.value.trim();
          }}
          onPressEnter={() => {
            if (!inputValue) {
              message.error('项目组名称不能为空');
              return;
            }
            if (inputValue === oldName) {
              Modal.destroyAll();
              return;
            }
            const existingGroups = projectGroupStorage.getAll();
            if (existingGroups.find((g) => g.name === inputValue && g.id !== groupId)) {
              message.error(`项目组 "${inputValue}" 已存在`);
              return;
            }
            const group = existingGroups.find((g) => g.id === groupId);
            if (group) {
              projectGroupStorage.update(groupId, { ...group, name: inputValue });
              const segments = ipSegmentStorage.getAll();
              const updatedSegments = segments.map((seg) => {
                if (seg.projectGroups && seg.projectGroups.includes(oldName)) {
                  return {
                    ...seg,
                    projectGroups: seg.projectGroups.map((pg) => (pg === oldName ? inputValue : pg)),
                  };
                }
                return seg;
              });
              ipSegmentStorage.save(updatedSegments);
              setProjectGroups(projectGroupStorage.getAll());
              void saveConfigDataToFile();
              message.success('项目组编辑成功');
            }
            Modal.destroyAll();
          }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: () => {
        if (!inputValue) {
          message.error('项目组名称不能为空');
          return Promise.reject();
        }
        if (inputValue === oldName) {
          return Promise.resolve();
        }
        const existingGroups = projectGroupStorage.getAll();
        if (existingGroups.find((g) => g.name === inputValue && g.id !== groupId)) {
          message.error(`项目组 "${inputValue}" 已存在`);
          return Promise.reject();
        }
        const group = existingGroups.find((g) => g.id === groupId);
        if (group) {
          projectGroupStorage.update(groupId, { ...group, name: inputValue });
          const segments = ipSegmentStorage.getAll();
          const updatedSegments = segments.map((seg) => {
            if (seg.projectGroups && seg.projectGroups.includes(oldName)) {
              return {
                ...seg,
                projectGroups: seg.projectGroups.map((pg) => (pg === oldName ? inputValue : pg)),
              };
            }
            return seg;
          });
          ipSegmentStorage.save(updatedSegments);
          setProjectGroups(projectGroupStorage.getAll());
          void saveConfigDataToFile();
          message.success('项目组编辑成功');
        }
        return Promise.resolve();
      },
    });
  };

  return (
    <ConfigPageShell
      title="项目组"
      subtitle="管理 IP 段可选的项目组名称；在 IP 段与历程中供选择。删除前请确保无 IP 段仍引用该名称。"
    >
      <Row justify="center">
        <Col xs={24} md={22} lg={16} xl={12}>
          <Card
            title={
              <Space>
                <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 16 }} />
                <span style={{ fontSize: 16, fontWeight: 600 }}>项目组列表</span>
                <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal', color: '#8c8c8c' }}>
                  ({projectGroups.length})
                </Text>
              </Space>
            }
            style={{ width: '100%' }}
            bodyStyle={{ padding: '16px' }}
          >
            {canManageConfig && (
              <Form form={projectGroupForm} layout="vertical" onFinish={handleAddProjectGroup}>
                <Form.Item
                  name="name"
                  rules={[
                    { required: true, message: '请输入项目组名称' },
                    {
                      validator: (_, value) => {
                        if (value && value.trim()) {
                          const trimmed = value.trim();
                          const existingGroups = projectGroupStorage.getAll();
                          if (existingGroups.find((g) => g.name === trimmed)) {
                            return Promise.reject(new Error(`项目组 "${trimmed}" 已存在`));
                          }
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input
                    placeholder="输入项目组名称"
                    prefix={<PlusOutlined />}
                    allowClear
                    onPressEnter={handleAddProjectGroup}
                  />
                </Form.Item>
                <Form.Item style={{ marginBottom: 16 }}>
                  <Button type="primary" block icon={<PlusOutlined />} htmlType="submit">
                    添加项目组
                  </Button>
                </Form.Item>
              </Form>
            )}
            {canManageConfig && <Divider style={{ margin: '12px 0' }} />}
            <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
              {projectGroups.length > 0 ? (
                projectGroups.map((group) =>
                  ConfigListItemRow(
                    group,
                    checkProjectGroupInUse(group.name),
                    () => handleEditProjectGroup(group.id, group.name),
                    () => handleDeleteProjectGroup(group.id, group.name),
                    undefined,
                    !canManageConfig
                  )
                )
              ) : (
                <Empty description="暂无项目组" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>
        </Col>
      </Row>
    </ConfigPageShell>
  );
};

export default ProjectGroupConfigPage;
