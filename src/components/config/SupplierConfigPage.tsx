import React, { useState, useEffect } from 'react';
import { Card, Form, Input, Button, Space, Tag, Row, Col, Typography, Divider, Empty, Modal, message } from 'antd';
import { PlusOutlined, CheckCircleOutlined, EditOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { Supplier } from '../../types';
import { supplierStorage, ipSegmentStorage } from '../../utils/storage';
import { useAuth } from '../../contexts/AuthContext';
import { saveConfigDataToFile } from './saveConfigData';
import { checkSupplierInUse } from './configInUse';
import { ConfigListItemRow } from './ConfigListItemRow';
import { ConfigPageShell } from './ConfigPageShell';

const { Text } = Typography;

const SupplierConfigPage: React.FC = () => {
  const { hasPermission } = useAuth();
  const canManageConfig = hasPermission('manage_config');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierForm] = Form.useForm();

  useEffect(() => {
    setSuppliers(supplierStorage.getAll());
  }, []);

  const handleAddSupplier = async () => {
    try {
      const values = await supplierForm.validateFields();
      const trimmedName = values.name.trim();
      const existingSuppliers = supplierStorage.getAll();
      if (existingSuppliers.find((s) => s.name === trimmedName)) {
        message.warning(`供应商 "${trimmedName}" 已存在`);
        return;
      }
      const newSupplier: Supplier = { id: `sup-${Date.now()}`, name: trimmedName };
      supplierStorage.add(newSupplier);
      setSuppliers(supplierStorage.getAll());
      supplierForm.resetFields();
      await saveConfigDataToFile();
      message.success('供应商添加成功');
    } catch (error) {
      console.error('添加失败:', error);
    }
  };

  const handleDeleteSupplier = (supplierId: string, supplierName: string) => {
    if (checkSupplierInUse(supplierName)) {
      Modal.warning({
        title: '无法删除',
        icon: <ExclamationCircleOutlined />,
        content: `供应商 "${supplierName}" 正在被使用，无法删除。请先修改相关IP段的供应商设置。`,
        okText: '知道了',
      });
      return;
    }
    Modal.confirm({
      title: '确认删除供应商',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除供应商 "${supplierName}" 吗？此操作不可恢复。`,
      okText: '确定删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => {
        supplierStorage.delete(supplierId);
        setSuppliers(supplierStorage.getAll());
        void saveConfigDataToFile();
        message.success('供应商删除成功');
      },
    });
  };

  const handleEditSupplier = (supplierId: string, oldName: string) => {
    let inputValue = oldName;
    Modal.confirm({
      title: '编辑供应商',
      icon: <EditOutlined />,
      width: 400,
      content: (
        <Input
          placeholder="输入新的供应商名称"
          defaultValue={oldName}
          autoFocus
          onChange={(e) => {
            inputValue = e.target.value.trim();
          }}
          onPressEnter={() => {
            if (!inputValue) {
              message.error('供应商名称不能为空');
              return;
            }
            if (inputValue === oldName) {
              Modal.destroyAll();
              return;
            }
            const existingSuppliers = supplierStorage.getAll();
            if (existingSuppliers.find((s) => s.name === inputValue && s.id !== supplierId)) {
              message.error(`供应商 "${inputValue}" 已存在`);
              return;
            }
            const supplier = existingSuppliers.find((s) => s.id === supplierId);
            if (supplier) {
              supplierStorage.update(supplierId, { ...supplier, name: inputValue });
              const segments = ipSegmentStorage.getAll();
              const updatedSegments = segments.map((seg) => {
                if (seg.supplier === oldName) {
                  return { ...seg, supplier: inputValue };
                }
                return seg;
              });
              ipSegmentStorage.save(updatedSegments);
              setSuppliers(supplierStorage.getAll());
              void saveConfigDataToFile();
              message.success('供应商编辑成功');
            }
            Modal.destroyAll();
          }}
        />
      ),
      okText: '保存',
      cancelText: '取消',
      onOk: () => {
        if (!inputValue) {
          message.error('供应商名称不能为空');
          return Promise.reject();
        }
        if (inputValue === oldName) {
          return Promise.resolve();
        }
        const existingSuppliers = supplierStorage.getAll();
        if (existingSuppliers.find((s) => s.name === inputValue && s.id !== supplierId)) {
          message.error(`供应商 "${inputValue}" 已存在`);
          return Promise.reject();
        }
        const supplier = existingSuppliers.find((s) => s.id === supplierId);
        if (supplier) {
          supplierStorage.update(supplierId, { ...supplier, name: inputValue });
          const segments = ipSegmentStorage.getAll();
          const updatedSegments = segments.map((seg) => {
            if (seg.supplier === oldName) {
              return { ...seg, supplier: inputValue };
            }
            return seg;
          });
          ipSegmentStorage.save(updatedSegments);
          setSuppliers(supplierStorage.getAll());
          void saveConfigDataToFile();
          message.success('供应商编辑成功');
        }
        return Promise.resolve();
      },
    });
  };

  return (
    <ConfigPageShell
      title="供应商"
      subtitle="管理 IP 段供应商名称；在 IP 段编辑等界面供选择。删除前请确保无 IP 段仍引用该名称。"
    >
      <Row justify="center">
        <Col xs={24} md={22} lg={16} xl={12}>
          <Card
            title={
              <Space>
                <CheckCircleOutlined style={{ color: '#1890ff', fontSize: 16 }} />
                <span style={{ fontSize: 16, fontWeight: 600 }}>供应商列表</span>
                <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal', color: '#8c8c8c' }}>
                  ({suppliers.length})
                </Text>
              </Space>
            }
            style={{ width: '100%' }}
            bodyStyle={{ padding: '16px' }}
          >
            {canManageConfig && (
              <Form form={supplierForm} layout="vertical" onFinish={handleAddSupplier}>
                <Form.Item
                  name="name"
                  rules={[
                    { required: true, message: '请输入供应商名称' },
                    {
                      validator: (_, value) => {
                        if (value && value.trim()) {
                          const trimmed = value.trim();
                          const existingSuppliers = supplierStorage.getAll();
                          if (existingSuppliers.find((s) => s.name === trimmed)) {
                            return Promise.reject(new Error(`供应商 "${trimmed}" 已存在`));
                          }
                        }
                        return Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input
                    placeholder="输入供应商名称"
                    prefix={<PlusOutlined />}
                    allowClear
                    onPressEnter={handleAddSupplier}
                  />
                </Form.Item>
                <Form.Item style={{ marginBottom: 16 }}>
                  <Button type="primary" block icon={<PlusOutlined />} htmlType="submit">
                    添加供应商
                  </Button>
                </Form.Item>
              </Form>
            )}
            {canManageConfig && <Divider style={{ margin: '12px 0' }} />}
            <div style={{ maxHeight: 480, overflowY: 'auto', paddingRight: 4 }}>
              {suppliers.length > 0 ? (
                suppliers.map((supplier) =>
                  ConfigListItemRow(
                    supplier,
                    checkSupplierInUse(supplier.name),
                    () => handleEditSupplier(supplier.id, supplier.name),
                    () => handleDeleteSupplier(supplier.id, supplier.name),
                    undefined,
                    !canManageConfig
                  )
                )
              ) : (
                <Empty description="暂无供应商" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </div>
          </Card>
        </Col>
      </Row>
    </ConfigPageShell>
  );
};

export default SupplierConfigPage;
