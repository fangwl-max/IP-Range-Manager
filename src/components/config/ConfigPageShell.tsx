import React, { useState } from 'react';
import { Typography } from 'antd';
import { SettingOutlined, CaretRightOutlined, CaretDownOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

export function ConfigPageShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div style={{ padding: '24px', background: '#f0f2f5', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ margin: 0, marginBottom: 8 }}>
          <SettingOutlined style={{ marginRight: 8, color: '#1890ff' }} />
          {title}
        </Title>
        <button
          type="button"
          aria-expanded={detailOpen}
          onClick={() => setDetailOpen((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: '#1890ff',
            fontSize: 14,
            marginBottom: detailOpen ? 8 : 0,
          }}
        >
          {detailOpen ? <CaretDownOutlined aria-hidden /> : <CaretRightOutlined aria-hidden />}
          <span>{detailOpen ? '收起说明' : '查看页面说明'}</span>
        </button>
        {detailOpen ? (
          <div style={{ paddingLeft: 2 }}>
            <Text type="secondary" style={{ fontSize: 14, color: '#595959', display: 'block' }}>
              {subtitle}
            </Text>
            <div style={{ marginTop: 8 }}>
              <Text type="warning" style={{ fontSize: 13 }}>
                本页配置项仅可在此通过表单手动添加或编辑；从 IP 段导入、批量编辑等不会自动写入配置列表。
              </Text>
            </div>
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
