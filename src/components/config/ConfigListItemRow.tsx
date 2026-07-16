import React from 'react';
import { Button, Popconfirm, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, ExclamationCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

export function ConfigListItemRow(
  item: { id: string; name: string },
  inUse: boolean,
  onEdit: () => void,
  onDelete: () => void,
  color?: string,
  readOnly?: boolean
) {
  return (
    <div
      key={item.id}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 12px',
        marginBottom: 6,
        background: '#fff',
        borderRadius: 6,
        border: '1px solid #f0f0f0',
        transition: 'all 0.2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#d9d9d9';
        e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#f0f0f0';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <Space>
        {color && (
          <Tag
            color={color}
            style={{
              margin: 0,
              minWidth: 40,
              fontSize: 15,
              fontWeight: 600,
              color: '#000',
              border: '1px solid rgba(0,0,0,0.1)',
              padding: '4px 12px',
            }}
          >
            {item.name}
          </Tag>
        )}
        {!color && (
          <Tag
            color={inUse ? 'blue' : 'default'}
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 600,
              padding: '4px 12px',
              minWidth: 40,
            }}
          >
            {item.name}
          </Tag>
        )}
        {inUse && (
          <Text type="secondary" style={{ fontSize: 14, color: '#1890ff', fontWeight: 500 }}>
            使用中
          </Text>
        )}
      </Space>
      {!readOnly && (
        <Space>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={onEdit}
            style={{ color: '#1890ff', fontSize: 14 }}
          >
            编辑
          </Button>
          <Popconfirm
            title="确认删除"
            description={`确定要删除 "${item.name}" 吗？`}
            onConfirm={onDelete}
            okText="确定删除"
            okType="danger"
            cancelText="取消"
            icon={<ExclamationCircleOutlined />}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger style={{ fontSize: 14 }}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )}
    </div>
  );
}
