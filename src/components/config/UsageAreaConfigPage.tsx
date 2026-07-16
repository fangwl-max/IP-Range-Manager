import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Space, Tag, Row, Col, Typography, Divider, Empty, Modal, message, ColorPicker } from 'antd';
import { PlusOutlined, CheckCircleOutlined, EditOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { UsageAreaOption, PRESET_COLORS } from '../../types';
import { usageAreaStorage, ipSegmentStorage } from '../../utils/storage';
import { useAuth } from '../../contexts/AuthContext';
import { saveConfigDataToFile } from './saveConfigData';
import { checkUsageAreaInUse } from './configInUse';
import { ConfigListItemRow } from './ConfigListItemRow';
import { ConfigPageShell } from './ConfigPageShell';

const { Text } = Typography;

function getUnusedColor(): string {
  const existingAreas = usageAreaStorage.getAll();
  const usedColors = new Set(existingAreas.map((area) => area.color));
  for (const color of PRESET_COLORS) {
    if (!usedColors.has(color)) {
      return color;
    }
  }
  const generateRandomColor = () => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
      color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
  };
  let randomColor = generateRandomColor();
  while (usedColors.has(randomColor)) {
    randomColor = generateRandomColor();
  }
  return randomColor;
}

const UsageAreaConfigPage: React.FC = () => {
  const { hasPermission } = useAuth();
  const canManageConfig = hasPermission('manage_config');
  const [usageAreas, setUsageAreas] = useState<UsageAreaOption[]>([]);
  const [usageAreaForm] = Form.useForm();

  useEffect(() => {
    const loadFromFile = async () => {
      try {
        const res = await fetch('/api/get-data');
        if (res.ok) {
          const data = await res.json();
          if (data?.usageAreas) {
            const filtered = data.usageAreas.filter((a: any) => a.name !== '准备取消' && a.name !== '已取消');
            usageAreaStorage.save(filtered);
          }
        }
      } catch (_) { /* 降级使用 localStorage */ }
      setUsageAreas(usageAreaStorage.getAll());
    };
    void loadFromFile();
  }, []);

  const handleAddUsageArea = async () => {
    try {
      const values = await usageAreaForm.validateFields();
      const trimmedName = values.name.trim();
      const existingAreas = usageAreaStorage.getAll();
      if (existingAreas.find((a) => a.name === trimmedName)) {
        message.warning(`使用地区 "${trimmedName}" 已存在`);
        return;
      }
      const assignedColor =
        typeof values.color === 'string' && values.color.trim() ? values.color.trim() : getUnusedColor();
      const newArea: UsageAreaOption = {
        id: `area-${Date.now()}`,
        name: trimmedName,
        color: assignedColor,
      };
      usageAreaStorage.add(newArea);
      setUsageAreas(usageAreaStorage.getAll());
      usageAreaForm.resetFields();
      await saveConfigDataToFile();
      message.success('使用地区添加成功');
    } catch (error) {
      console.error('添加失败:', error);
    }
  };

  const handleDeleteUsageArea = (areaId: string, areaName: string) => {
    if (checkUsageAreaInUse(areaName)) {
      Modal.warning({
        title: '无法删除',
        icon: <ExclamationCircleOutlined />,
        content: `使用地区 "${areaName}" 正在被使用，无法删除。请先修改相关IP段的使用地区设置。`,
        okText: '知道了',
      });
      return;
    }
    Modal.confirm({
      title: '确认删除使用地区',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除使用地区 "${areaName}" 吗？此操作不可恢复。`,
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => {
        usageAreaStorage.delete(areaId);
        setUsageAreas(usageAreaStorage.getAll());
        void saveConfigDataToFile();
        message.success('使用地区删除成功');
      },
    });
  };

  const handleEditUsageArea = (areaId: string, oldArea: UsageAreaOption) => {
    let newName = oldArea.name;
    let newColor = oldArea.color;
    Modal.confirm({
      title: '编辑使用地区',
      icon: <EditOutlined />,
      width: 500,
      content: (
        <div>
          <div style={{ marginBottom: 12 }}>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>
              使用地区名称：
            </Text>
            <Input
              placeholder="输入新的使用地区名称"
              defaultValue={oldArea.name}
              onChange={(e) => {
                newName = e.target.value.trim();
              }}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              颜色（预设或自定义）：
            </Text>
            <ColorPicker
              key={oldArea.id}
              defaultValue={oldArea.color}
              showText
              format="hex"
              presets={[{ label: '预设', colors: [...PRESET_COLORS] }]}
              onChange={(_value, css) => {
                newColor = css;
              }}
            />
          </div>
        </div>
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: () => {
        if (!newName) {
          message.error('使用地区名称不能为空');
          return Promise.reject();
        }
        if (newName === oldArea.name && newColor === oldArea.color) {
          return Promise.resolve();
        }
        const existingAreas = usageAreaStorage.getAll();
        if (existingAreas.find((a) => a.name === newName && a.id !== areaId)) {
          message.error(`使用地区 "${newName}" 已存在`);
          return Promise.reject();
        }
        const area = existingAreas.find((a) => a.id === areaId);
        if (area) {
          usageAreaStorage.update(areaId, { ...area, name: newName, color: newColor });
          const segments = ipSegmentStorage.getAll();
          const updatedSegments = segments.map((seg) => {
            if (seg.usageArea === oldArea.name) {
              return { ...seg, usageArea: newName };
            }
            return seg;
          });
          ipSegmentStorage.save(updatedSegments);
          setUsageAreas(usageAreaStorage.getAll());
          void saveConfigDataToFile();
          message.success('使用地区编辑成功');
        }
        return Promise.resolve();
      },
    });
  };

  return (
    <ConfigPageShell
      title="使用地区"
      subtitle="管理使用地区与标签颜色；在 IP 段与列表高亮中展示。删除前请确保无 IP 段仍引用该地区。"
    >
      <Row justify="center">
        <Col xs={24} md={22} lg={16} xl={12}>
          <Card
            title={
              <Space>
                <CheckCircleOutlined style={{ color: '#722ed1', fontSize: 16 }} />
                <span style={{ fontSize: 16, fontWeight: 600 }}>使用地区列表</span>
                <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal', color: '#8c8c8c' }}>
                  ({usageAreas.length})
                </Text>
              </Space>
            }
            style={{ width: '100%' }}
            bodyStyle={{ padding: '16px' }}
          >
            {canManageConfig && (
              <Form form={usageAreaForm} layout="vertical" onFinish={handleAddUsageArea}>
                <Form.Item
                  name="name"
                  label="名称"
                  rules={[
                    { required: true, message: '请输入使用地区名称' },
                    {
                      validator: (_, value) => {
                        if (value && value.trim()) {
                          const trimmed = value.trim();
                          const existingAreas = usageAreaStorage.getAll();
                          if (existingAreas.find((a) => a.name === trimmed)) {
                            return Promise.reject(new Error(`使用地区 "${trimmed}" 已存在`));
                          }
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input placeholder="输入使用地区名称" prefix={<PlusOutlined />} allowClear />
                </Form.Item>
                <Form.Item
                  name="color"
                  label="标签颜色"
                  initialValue={PRESET_COLORS[0]}
                  getValueFromEvent={(_v, css) => css}
                  tooltip="可从预设中点选，或打开色板自由选取；支持 HEX"
                >
                  <ColorPicker showText format="hex" presets={[{ label: '预设', colors: [...PRESET_COLORS] }]} />
                </Form.Item>
                <Form.Item style={{ marginBottom: 16 }}>
                  <Button type="primary" block icon={<PlusOutlined />} htmlType="submit">
                    添加使用地区
                  </Button>
                </Form.Item>
              </Form>
            )}
            {canManageConfig && <Divider style={{ margin: '12px 0' }} />}
            <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
              {usageAreas.length > 0 ? (
                usageAreas.map((area) =>
                  ConfigListItemRow(
                    area,
                    checkUsageAreaInUse(area.name),
                    () => handleEditUsageArea(area.id, area),
                    () => handleDeleteUsageArea(area.id, area.name),
                    area.color,
                    !canManageConfig
                  )
                )
              ) : (
                <Empty description="暂无使用地区" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>
        </Col>
      </Row>
    </ConfigPageShell>
  );
};

export default UsageAreaConfigPage;
